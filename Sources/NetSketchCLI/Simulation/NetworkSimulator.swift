import Foundation
import NetSketchCore

/// A static, reachability-level IPv4 simulation of the project.
///
/// What it models:
/// - Layer 2: every switch (and access point) bridges its ports per VLAN according to the
///   canonical switchport text of each port (`SwitchportConfig`): access ports carry their VLAN
///   untagged, trunks carry the allowed VLANs tagged and the native VLAN untagged. A cable joins
///   what both ends carry; a shut-down port carries nothing. Routers, PCs and servers end the
///   layer-2 domain at each port. Loops do no harm (no STP, no flooding: only reachability).
/// - Layer 3: interface addresses, connected networks, static routes and default gateways.
///   Routers and layer-3 switches forward packets; PCs, servers and layer-2 switches do not.
///   A next hop must exist as an address in the layer-2 domain of the outgoing interface (ARP).
///
/// What it does not model: timing, MAC learning, STP, DHCP, dynamic routing, ACLs, NAT.
/// It is rebuilt from the project for every command, so it always matches the diagram.
struct NetworkSimulator {
    /// One addressed, working layer-3 interface.
    struct Interface {
        let deviceID: UUID
        let id: L3InterfaceID
        let prefix: IPv4Prefix
        /// The layer-2 domain the interface sits in.
        let domain: Int
        let name: String
    }

    enum RouteKind { case connected, local, staticRoute }

    struct Route {
        let destination: IPv4Prefix
        let kind: RouteKind
        /// Next hop of a static route; nil for connected networks.
        let nextHop: IPv4?
        let interface: Interface
    }

    /// Why a packet did not arrive.
    enum Failure: Equatable {
        /// The device has no route to the destination.
        case noRoute(deviceID: UUID)
        /// The next hop (or the destination on a connected network) does not answer ARP.
        case unreachableNextHop(deviceID: UUID, nextHop: IPv4)
        /// A PC, server or layer-2 switch got a packet that is not for it.
        case notForwarding(deviceID: UUID)
        case ttlExceeded
    }

    struct Delivery {
        /// The addresses at which the packet entered each next device, the last one being the destination.
        var hops: [IPv4] = []
        var failure: Failure?
        var delivered: Bool { failure == nil }
    }

    struct PingResult {
        let source: IPv4?
        let destination: IPv4
        let forward: Delivery
        let back: Delivery?
        /// The sender has no usable address towards the destination.
        var noSource: Bool { source == nil }
        var success: Bool { forward.delivered && (back?.delivered ?? false) }
        var hopCount: Int { forward.hops.count }
    }

    let project: Project
    private(set) var interfaces: [Interface] = []
    private var devicesByID: [UUID: Device] = [:]
    private var interfacesByDevice: [UUID: [Interface]] = [:]

    init(project: Project) {
        self.project = project
        for device in project.devices { devicesByID[device.id] = device }
        buildInterfaces()
    }

    // MARK: Device roles

    static func isSwitching(_ category: DeviceCategory) -> Bool {
        category == .switch || category == .l3switch || category == .accessPoint
    }

    static func isForwarding(_ category: DeviceCategory) -> Bool {
        category == .router || category == .l3switch
    }

    // MARK: Layer 2

    private enum Node: Hashable {
        /// The bridge of one VLAN inside a switch.
        case bridge(UUID, Int)
        /// A routed port (router, PC, server, switch management port).
        case port(UUID, UUID)
    }

    private enum Channel: Hashable {
        case untagged
        case tagged(Int)
    }

    /// Union-find over layer-2 nodes.
    private final class Domains {
        private var parent: [Node: Node] = [:]

        func find(_ node: Node) -> Node {
            var root = node
            while let next = parent[root], next != root { root = next }
            var current = node
            while let next = parent[current], next != root {
                parent[current] = root
                current = next
            }
            return root
        }

        func union(_ a: Node, _ b: Node) {
            let rootA = find(a)
            let rootB = find(b)
            if rootA != rootB { parent[rootA] = rootB }
        }
    }

    private static func isRouted(_ port: Port, on device: Device) -> Bool {
        !isSwitching(device.category) || port.connector == .mgmt
    }

    /// What a port puts on its cable, and where each channel leads inside the device.
    private static func channels(of port: Port, on device: Device, vlans: Set<Int>) -> [Channel: Node] {
        guard port.connector != .console, !port.adminDown else { return [:] }
        if isRouted(port, on: device) { return [.untagged: .port(device.id, port.id)] }
        let config = SwitchportConfig.parse(port.vlan) ?? SwitchportConfig()
        switch config.mode {
        case .access, .unset:
            return [.untagged: .bridge(device.id, config.accessVLAN)]
        case .trunk:
            var result: [Channel: Node] = [:]
            if config.allows(config.nativeVLAN) { result[.untagged] = .bridge(device.id, config.nativeVLAN) }
            let carried = config.allowedVLANs.map { Set($0) } ?? vlans
            for vlan in carried where vlan != config.nativeVLAN {
                result[.tagged(vlan)] = .bridge(device.id, vlan)
            }
            return result
        }
    }

    /// The VLAN numbers that occur anywhere: what an unrestricted trunk has to carry.
    private func knownVLANs() -> Set<Int> {
        var vlans: Set<Int> = [1]
        for device in project.devices {
            vlans.formUnion(device.vlans.map(\.id))
            for address in device.addresses {
                if case .vlan(let number) = address.interface { vlans.insert(number) }
            }
            for port in device.ports {
                guard let config = SwitchportConfig.parse(port.vlan) else { continue }
                vlans.insert(config.accessVLAN)
                vlans.insert(config.nativeVLAN)
                vlans.formUnion(config.allowedVLANs ?? [])
            }
        }
        return vlans
    }

    /// True when the port has a cable whose far end is not shut down.
    private func isLinkUp(_ device: Device, _ port: Port) -> Bool {
        guard !port.adminDown, let peer = project.peer(of: PortRef(deviceID: device.id, portID: port.id)) else { return false }
        return !peer.port.adminDown
    }

    private mutating func buildInterfaces() {
        let vlans = knownVLANs()
        let domains = Domains()
        var channelMaps: [PortRef: [Channel: Node]] = [:]
        for device in project.devices {
            for port in device.ports {
                channelMaps[PortRef(deviceID: device.id, portID: port.id)] = NetworkSimulator.channels(of: port, on: device, vlans: vlans)
            }
        }
        for link in project.links {
            guard let a = channelMaps[link.a], let b = channelMaps[link.b] else { continue }
            for (channel, nodeA) in a {
                if let nodeB = b[channel] { domains.union(nodeA, nodeB) }
            }
        }

        var domainIDs: [Node: Int] = [:]
        func domainID(_ node: Node) -> Int {
            let root = domains.find(node)
            if let id = domainIDs[root] { return id }
            let id = domainIDs.count
            domainIDs[root] = id
            return id
        }

        for device in project.devices {
            var list: [Interface] = []
            for entry in device.addresses {
                guard let prefix = IPv4Prefix(cidr: entry.address) else { continue }
                switch entry.interface {
                case .port(let portID):
                    guard let port = device.port(id: portID), NetworkSimulator.isRouted(port, on: device),
                          isLinkUp(device, port) else { continue }
                    list.append(Interface(deviceID: device.id, id: entry.interface, prefix: prefix,
                                          domain: domainID(.port(device.id, portID)), name: port.name))
                case .vlan(let number):
                    guard NetworkSimulator.isSwitching(device.category) else { continue }
                    // Like a Cisco SVI: up while at least one cabled port carries the VLAN.
                    let carried = device.ports.contains { port in
                        guard isLinkUp(device, port),
                              let map = channelMaps[PortRef(deviceID: device.id, portID: port.id)] else { return false }
                        return map.values.contains(.bridge(device.id, number))
                    }
                    guard carried else { continue }
                    list.append(Interface(deviceID: device.id, id: entry.interface, prefix: prefix,
                                          domain: domainID(.bridge(device.id, number)), name: "Vlan\(number)"))
                }
            }
            interfacesByDevice[device.id] = list
            interfaces.append(contentsOf: list)
        }
    }

    // MARK: Layer 3

    func interfaces(of deviceID: UUID) -> [Interface] { interfacesByDevice[deviceID] ?? [] }

    func device(_ id: UUID) -> Device? { devicesByID[id] }

    /// The routing table of a device: connected networks, then static routes and the default
    /// gateway whose next hop lies on a connected network.
    func routes(of deviceID: UUID) -> [Route] {
        guard let device = devicesByID[deviceID] else { return [] }
        let own = interfaces(of: deviceID)
        var routes: [Route] = []
        for interface in own {
            routes.append(Route(destination: interface.prefix.networkPrefix, kind: .connected, nextHop: nil, interface: interface))
            routes.append(Route(destination: IPv4Prefix(address: interface.prefix.address, length: 32),
                                kind: .local, nextHop: nil, interface: interface))
        }
        func connectedInterface(for hop: IPv4) -> Interface? {
            own.filter { $0.prefix.contains(hop) }.max { $0.prefix.length < $1.prefix.length }
        }
        for entry in device.staticRoutes {
            guard let destination = IPv4Prefix(cidr: entry.destination), let hop = IPv4(entry.nextHop),
                  let interface = connectedInterface(for: hop) else { continue }
            routes.append(Route(destination: destination.networkPrefix, kind: .staticRoute, nextHop: hop, interface: interface))
        }
        if let gateway = IPv4(device.defaultGateway), let interface = connectedInterface(for: gateway),
           !routes.contains(where: { $0.destination.length == 0 }) {
            routes.append(Route(destination: IPv4Prefix(address: IPv4(0), length: 0), kind: .staticRoute,
                                nextHop: gateway, interface: interface))
        }
        return routes
    }

    /// Longest-prefix match.
    func lookup(_ destination: IPv4, on deviceID: UUID) -> Route? {
        routes(of: deviceID)
            .filter { $0.destination.contains(destination) }
            .max { $0.destination.length < $1.destination.length }
    }

    /// The interface that owns `address` in the layer-2 domain `domain` (ARP).
    func owner(of address: IPv4, in domain: Int) -> Interface? {
        interfaces.first { $0.domain == domain && $0.prefix.address == address }
    }

    func owns(_ deviceID: UUID, _ address: IPv4) -> Bool {
        interfaces(of: deviceID).contains { $0.prefix.address == address }
    }

    /// Follows a packet from `deviceID` to `destination`, hop by hop.
    func deliver(from deviceID: UUID, to destination: IPv4) -> Delivery {
        var delivery = Delivery()
        var current = deviceID
        for _ in 0..<32 {
            if owns(current, destination) { return delivery }
            if current != deviceID, let device = devicesByID[current], !NetworkSimulator.isForwarding(device.category) {
                delivery.failure = .notForwarding(deviceID: current)
                return delivery
            }
            guard let route = lookup(destination, on: current) else {
                delivery.failure = .noRoute(deviceID: current)
                return delivery
            }
            let hop = route.nextHop ?? destination
            guard let next = owner(of: hop, in: route.interface.domain) else {
                delivery.failure = .unreachableNextHop(deviceID: current, nextHop: hop)
                return delivery
            }
            delivery.hops.append(next.prefix.address)
            current = next.deviceID
        }
        delivery.failure = .ttlExceeded
        return delivery
    }

    /// The address a device sends from towards `destination` (that of the outgoing interface).
    func sourceAddress(of deviceID: UUID, towards destination: IPv4) -> IPv4? {
        if owns(deviceID, destination) { return destination }
        return lookup(destination, on: deviceID)?.interface.prefix.address
    }

    /// An echo request and its reply.
    func ping(from deviceID: UUID, to destination: IPv4) -> PingResult {
        guard let source = sourceAddress(of: deviceID, towards: destination) else {
            return PingResult(source: nil, destination: destination,
                              forward: Delivery(hops: [], failure: .noRoute(deviceID: deviceID)), back: nil)
        }
        let forward = deliver(from: deviceID, to: destination)
        guard forward.delivered else {
            return PingResult(source: source, destination: destination, forward: forward, back: nil)
        }
        let target = interfaces.first { $0.prefix.address == destination }?.deviceID ?? deviceID
        let back = deliver(from: target, to: source)
        return PingResult(source: source, destination: destination, forward: forward, back: back)
    }

    // MARK: Explanations

    private func name(_ deviceID: UUID) -> String { devicesByID[deviceID]?.hostname ?? "?" }

    /// A Czech sentence that says where and why a ping failed.
    func explain(_ result: PingResult) -> String {
        if result.noSource {
            return "NetSketch: zařízení nemá IP adresu na funkčním rozhraní ani trasu do \(result.destination) "
                + "(chybí adresa, kabel, výchozí brána nebo statická trasa)."
        }
        if let failure = result.forward.failure {
            return "NetSketch: požadavek nedošel – " + explain(failure, destination: result.destination)
        }
        if let failure = result.back?.failure {
            return "NetSketch: požadavek došel, ale odpověď ne – " + explain(failure, destination: result.source ?? result.destination)
        }
        return ""
    }

    private func explain(_ failure: Failure, destination: IPv4) -> String {
        switch failure {
        case .noRoute(let device):
            return "\(name(device)) nemá trasu do sítě s adresou \(destination) (chybí statická trasa nebo výchozí brána)."
        case .unreachableNextHop(let device, let hop):
            return "\(name(device)) nenašel \(hop) ve své síti (zkontrolujte kabel, shutdown, VLAN a adresy)."
        case .notForwarding(let device):
            return "\(name(device)) nesměruje pakety (není router), ale dostal paket pro \(destination)."
        case .ttlExceeded:
            return "paket koloval ve smyčce tras (TTL vypršelo)."
        }
    }
}
