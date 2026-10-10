import Foundation
import NetSketchCore

// IPv4 configuration and the network commands (ping, traceroute, show ip route) of the
// IOS-style dialects. Addresses, routes and the default gateway are stored in the project;
// ping and traceroute ask `NetworkSimulator`, which follows the drawn cabling.

extension IOSEngine {
    // MARK: Parsing

    /// "A.B.C.D M.M.M.M" (IOS) or "A.B.C.D/NN" (Dell OS9, accepted everywhere).
    func parseAddress(_ text: String) -> IPv4Prefix? {
        IPv4Prefix(words: text.split(whereSeparator: { $0.isWhitespace }).map(String.init))
    }

    private var badAddress: String {
        isDell ? "% Error: Invalid IP address." : "% Invalid input detected: bad IP address or mask."
    }

    /// The layer-3 interface of the current mode, or a message why there is none.
    private func currentL3Interface() -> Result<L3InterfaceID, L3Refusal> {
        switch mode {
        case .vlanInterface(let vlan):
            return .success(.vlan(vlan))
        case .interface:
            let ports = selectedPorts()
            guard !ports.isEmpty else {
                mode = .globalConfig
                return .failure(L3Refusal(message: Notices.interfaceGone))
            }
            guard ports.count == 1, let port = ports.first else {
                return .failure(L3Refusal(message: "NetSketch: IP adresu lze nastavit jen jednomu rozhraní, ne rozsahu."))
            }
            if let category = access.category, NetworkSimulator.isSwitching(category), port.isSwitchport {
                return .failure(L3Refusal(message: Notices.switchPortHasNoAddress))
            }
            return .success(.port(port.id))
        default:
            return .failure(L3Refusal(message: ""))
        }
    }

    struct L3Refusal: Error {
        let message: String
    }

    // MARK: Interface addresses

    func setIPAddress(_ command: ParsedCommand) -> String {
        let text = command.text("address") ?? ""
        if text.lowercased().hasPrefix("dhcp") { return Notices.dhcpNotSimulated }
        guard let prefix = parseAddress(text) else { return badAddress }
        guard prefix.isHostAddress else { return isDell ? "% Error: Invalid IP address." : "Bad mask /\(prefix.length) for address \(prefix.address)" }
        let interface: L3InterfaceID
        switch currentL3Interface() {
        case .success(let value): interface = value
        case .failure(let refusal): return refusal.message
        }
        // IOS refuses a second interface in a network that is already connected.
        let overlap = access.addresses.first { entry in
            guard entry.interface != interface, let other = IPv4Prefix(cidr: entry.address) else { return false }
            return other.contains(prefix.address) || prefix.contains(other.address)
        }
        if let overlap, let other = IPv4Prefix(cidr: overlap.address) {
            return isDell
                ? "% Error: \(other.networkPrefix) overlaps with \(l3Name(overlap.interface))."
                : "% \(other.network) overlaps with \(l3Name(overlap.interface))"
        }
        access.setAddress(prefix, on: interface)
        if let owner = access.addressConflict(prefix.address, except: interface) {
            return Notices.duplicateAddress(prefix.address.description, owner)
        }
        return ""
    }

    func clearIPAddress() -> String {
        switch currentL3Interface() {
        case .success(let interface):
            access.setAddress(nil, on: interface)
            return ""
        case .failure(let refusal):
            return refusal.message
        }
    }

    /// The interface name used in messages and listings: "GigabitEthernet0/0/0", "Vlan10".
    func l3Name(_ interface: L3InterfaceID) -> String {
        switch interface {
        case .vlan(let number):
            return isDell ? "Vlan \(number)" : "Vlan\(number)"
        case .port(let id):
            guard let port = access.device?.port(id: id) else { return "?" }
            return namer.longName(port.name)
        }
    }

    // MARK: Routes and gateway

    /// `ip route NET MASK NEXTHOP` (IOS) or `ip route NET/NN NEXTHOP` (Dell OS9).
    private func parseRoute(_ text: String) -> (IPv4Prefix, IPv4)? {
        let words = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        if words.count >= 2, let network = IPv4Prefix(cidr: words[0]), let hop = IPv4(words[1]) {
            return (network.networkPrefix, hop)
        }
        if words.count >= 3, let network = IPv4Prefix(address: words[0], mask: words[1]), let hop = IPv4(words[2]) {
            return (network.networkPrefix, hop)
        }
        return nil
    }

    func addStaticRoute(_ command: ParsedCommand) -> String {
        guard let (network, hop) = parseRoute(command.text("route") ?? "") else {
            if (command.text("route") ?? "").split(separator: " ").count < 2 {
                return isDell ? "% Error: Incomplete command." : "% Incomplete command."
            }
            return isDell ? "% Error: Invalid route." : "%Inconsistent address and mask"
        }
        let route = StaticRoute(destination: network.description, nextHop: hop.description)
        if !access.staticRoutes.contains(route) { access.setStaticRoutes(access.staticRoutes + [route]) }
        return ""
    }

    func removeStaticRoute(_ command: ParsedCommand) -> String {
        let words = (command.text("route") ?? "").split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let network: IPv4Prefix?
        let rest: [String]
        if let first = words.first, let cidr = IPv4Prefix(cidr: first) {
            network = cidr.networkPrefix
            rest = Array(words.dropFirst())
        } else if words.count >= 2, let prefix = IPv4Prefix(address: words[0], mask: words[1]) {
            network = prefix.networkPrefix
            rest = Array(words.dropFirst(2))
        } else {
            network = nil
            rest = []
        }
        guard let network else { return isDell ? "% Error: Invalid route." : "%Inconsistent address and mask" }
        let hop = rest.first.flatMap { IPv4($0) }
        let remaining = access.staticRoutes.filter { route in
            guard IPv4Prefix(cidr: route.destination) == network else { return true }
            if let hop { return route.nextHop != hop.description }
            return false
        }
        if remaining.count == access.staticRoutes.count {
            return isDell ? "% Error: Route not found." : "%No matching route to delete"
        }
        access.setStaticRoutes(remaining)
        return ""
    }

    func setDefaultGateway(_ command: ParsedCommand) -> String {
        guard let gateway = IPv4(command.text("gateway") ?? "") else { return badAddress }
        access.setDefaultGateway(gateway)
        return ""
    }

    func clearDefaultGateway() -> String {
        access.setDefaultGateway(nil)
        return ""
    }

    // MARK: ping and traceroute

    func ping(_ command: ParsedCommand) -> String {
        let words = (command.text("target") ?? "").split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard let first = words.first else { return isDell ? "% Error: Incomplete command." : "% Incomplete command." }
        guard let destination = IPv4(first) else {
            return isDell ? "% Error: Invalid host address." : "% Unrecognized host or address, or protocol not running."
        }
        var count = 5
        if let index = words.firstIndex(where: { $0.lowercased() == "repeat" || $0.lowercased() == "count" }),
           index + 1 < words.count, let value = Int(words[index + 1]), (1...100).contains(value) {
            count = value
        }
        let simulator = access.simulator
        let result = simulator.ping(from: access.deviceID, to: destination)
        let marks: String
        if result.success {
            marks = String(repeating: "!", count: count)
        } else if case .noRoute(let device)? = result.forward.failure, device != access.deviceID, !result.noSource {
            // A router on the way answers "destination unreachable".
            marks = String((0..<count).map { $0 % 2 == 0 ? Character("U") : Character(".") })
        } else {
            marks = String(repeating: ".", count: count)
        }
        let received = result.success ? count : 0
        var lines = [
            isDell ? "Type Ctrl-C to abort." : "Type escape sequence to abort.",
            "Sending \(count), 100-byte ICMP Echos to \(destination), timeout is 2 seconds:",
            marks,
        ]
        let percent = isDell ? String(format: "%.1f", Double(received * 100) / Double(count)) : "\(received * 100 / count)"
        if result.success {
            lines.append("Success rate is \(percent) percent (\(received)/\(count)), round-trip min/avg/max = 1/1/1 ms")
        } else {
            lines.append("Success rate is \(percent) percent (\(received)/\(count))")
            let reason = simulator.explain(result)
            if !reason.isEmpty { lines.append(reason) }
        }
        return lines.joined(separator: "\n")
    }

    func traceroute(_ command: ParsedCommand) -> String {
        let words = (command.text("target") ?? "").split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard let first = words.first else { return isDell ? "% Error: Incomplete command." : "% Incomplete command." }
        guard let destination = IPv4(first) else {
            return isDell ? "% Error: Invalid host address." : "% Unrecognized host or address, or protocol not running."
        }
        let simulator = access.simulator
        let delivery = simulator.deliver(from: access.deviceID, to: destination)
        var lines = [
            isDell ? "Type Ctrl-C to abort." : "Type escape sequence to abort.",
            "Tracing the route to \(destination)",
            "",
        ]
        for (index, hop) in delivery.hops.enumerated() {
            lines.append("\(index + 1)".leftPadded(3) + " \(hop) 0 msec 0 msec 0 msec")
        }
        if !delivery.delivered {
            let next = delivery.hops.count + 1
            lines.append("\(next)".leftPadded(3) + "  *  *  *")
            let result = simulator.ping(from: access.deviceID, to: destination)
            let reason = simulator.explain(result)
            if !reason.isEmpty { lines.append(reason) }
        }
        return lines.joined(separator: "\n")
    }

    // MARK: show

    func showIPRoute(_ command: ParsedCommand) -> String {
        let routes = access.simulator.routes(of: access.deviceID)
        var lines: [String] = []
        if isDell {
            lines.append("Codes: C - connected, S - static")
            lines.append("")
            lines.append("  Destination        Gateway                      Dist/Metric Last Change")
            lines.append("  -----------        -------                      ----------- -----------")
            for route in routes where route.kind != .local {
                let code = route.kind == .connected ? "C" : "S"
                let gateway = route.nextHop.map { "via \($0), \(l3Name(route.interface.id))" }
                    ?? "Direct, \(l3Name(route.interface.id))"
                let distance = route.kind == .connected ? "0/0" : "1/0"
                lines.append("\(code) " + route.destination.description.padded(18) + " " + gateway.padded(28) + " "
                             + distance.padded(11) + " 00:00:00")
            }
        } else {
            lines.append("Codes: L - local, C - connected, S - static")
            lines.append("")
            let gateway = routes.first { $0.destination.length == 0 }?.nextHop
            lines.append(gateway.map { "Gateway of last resort is \($0) to network 0.0.0.0" } ?? "Gateway of last resort is not set")
            lines.append("")
            for route in routes {
                switch route.kind {
                case .connected:
                    lines.append("C        \(route.destination) is directly connected, \(l3Name(route.interface.id))")
                case .local:
                    lines.append("L        \(route.destination) is directly connected, \(l3Name(route.interface.id))")
                case .staticRoute:
                    let code = route.destination.length == 0 ? "S*" : "S "
                    lines.append("\(code)       \(route.destination) [1/0] via \(route.nextHop.map(\.description) ?? "?")")
                }
            }
        }
        let inactive = access.staticRoutes.filter { stored in
            !routes.contains { $0.kind == .staticRoute && $0.destination.description == stored.destination && $0.nextHop?.description == stored.nextHop }
        }
        if !inactive.isEmpty {
            lines.append("")
            lines.append(Notices.inactiveRoutes(inactive.map { "\($0.destination) via \($0.nextHop)" }))
        }
        return lines.map { $0.trimmingTrailingWhitespace() }.joined(separator: "\n")
    }

    /// Rows of `show ip interface brief`: every physical port and every VLAN interface with an address.
    func ipInterfaceRows() -> [(name: String, address: String, status: String, proto: String)] {
        let simulator = access.simulator
        let working = Set(simulator.interfaces(of: access.deviceID).map(\.id))
        var rows: [(name: String, address: String, status: String, proto: String)] = []
        for port in access.interfaces {
            let address = access.address(of: .port(port.id))?.address.description ?? "unassigned"
            let status: String
            switch port.linkState {
            case .adminDown: status = "administratively down"
            case .up: status = "up"
            case .down: status = "down"
            }
            rows.append((namer.longName(port.name), address, status, port.linkState == .up ? "up" : "down"))
        }
        for entry in access.addresses {
            guard case .vlan = entry.interface else { continue }
            let up = working.contains(entry.interface)
            rows.append((l3Name(entry.interface), IPv4Prefix(cidr: entry.address)?.address.description ?? "unassigned",
                         up ? "up" : "down", up ? "up" : "down"))
        }
        return rows
    }

    // MARK: running-config

    /// " ip address A.B.C.D M.M.M.M" (IOS) or " ip address A.B.C.D/NN" (Dell) for an interface.
    func addressLine(_ interface: L3InterfaceID) -> String? {
        guard let prefix = access.address(of: interface) else { return nil }
        return isDell ? " ip address \(prefix)" : " ip address \(prefix.address) \(prefix.mask)"
    }

    /// The global IP lines: default gateway and static routes.
    func globalIPLines() -> [String] {
        var lines: [String] = []
        if let gateway = IPv4(access.defaultGateway) { lines.append("ip default-gateway \(gateway)") }
        for route in access.staticRoutes {
            guard let network = IPv4Prefix(cidr: route.destination) else { continue }
            lines.append(isDell
                ? "ip route \(network) \(route.nextHop)"
                : "ip route \(network.address) \(network.mask) \(route.nextHop)")
        }
        return lines
    }

    /// VLAN interfaces with an address, as configuration blocks.
    func sviConfigBlocks() -> [[String]] {
        access.addresses.compactMap { entry in
            guard case .vlan(let number) = entry.interface, let line = addressLine(entry.interface) else { return nil }
            return [isDell ? "interface Vlan \(number)" : "interface Vlan\(number)", line]
        }
    }
}
