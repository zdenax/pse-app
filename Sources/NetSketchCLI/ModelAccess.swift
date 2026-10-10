import Foundation
import NetSketchCore

/// What is plugged into the far end of a port's cable.
struct PeerSnapshot {
    let hostname: String
    let vendor: String
    let model: String
    let category: DeviceCategory
    let portName: String
    let adminDown: Bool
}

/// Static link state of a port. Derived ONLY from the diagram: the shutdown flags of both
/// ends and whether a cable is drawn. Nothing is negotiated or simulated.
enum StaticLinkState {
    /// The port itself is shut down.
    case adminDown
    /// A cable is drawn and neither end is shut down.
    case up
    /// No cable, or the far end is shut down.
    case down
}

/// A read-only copy of one interface of the console's device.
struct PortSnapshot {
    let id: UUID
    let name: String
    let description: String
    let vlanText: String
    let adminDown: Bool
    let speed: String
    let connector: ConnectorType
    let peer: PeerSnapshot?

    var linkState: StaticLinkState {
        if adminDown { return .adminDown }
        guard let peer else { return .down }
        return peer.adminDown ? .down : .up
    }

    /// The parsed switchport configuration, nil when `vlanText` is not in the canonical format.
    var switchport: SwitchportConfig? { SwitchportConfig.parse(vlanText) }

    /// Management ports are not switched ports: they take no VLAN configuration.
    var isSwitchport: Bool { connector != .mgmt }
}

/// A bundle (LAG) drawn in the diagram that the console's device takes part in.
struct BundleSnapshot {
    let label: String
    /// Names of this device's member ports.
    let localPorts: [String]
    let peerHostname: String
    let peerPorts: [String]
}

/// The only place of the CLI that touches `ProjectStore`.
///
/// Reads go straight to the current project, so changes made on the canvas or in the inspector
/// while a console is open are visible immediately. Every write is a `ProjectStore` operation
/// (undoable, observed by the UI); `transaction` turns one command into one undo step.
final class DeviceAccess {
    let store: ProjectStore
    let deviceID: UUID

    init(store: ProjectStore, deviceID: UUID) {
        self.store = store
        self.deviceID = deviceID
    }

    var device: Device? { store.project.device(id: deviceID) }
    var exists: Bool { device != nil }
    var hostname: String { device?.hostname ?? "" }
    var vendor: String { device?.vendor ?? "" }
    var model: String { device?.model ?? "" }
    var category: DeviceCategory? { device?.category }

    /// The interfaces of the device: every port except serial console jacks, in panel order.
    var interfaces: [PortSnapshot] {
        guard let device else { return [] }
        let project = store.project
        return device.ports.filter { $0.connector != .console }.map { port in
            let peer = project.peer(of: PortRef(deviceID: device.id, portID: port.id)).map {
                PeerSnapshot(
                    hostname: $0.device.hostname,
                    vendor: $0.device.vendor,
                    model: $0.device.model,
                    category: $0.device.category,
                    portName: $0.port.name,
                    adminDown: $0.port.adminDown
                )
            }
            return PortSnapshot(
                id: port.id,
                name: port.name,
                description: port.description,
                vlanText: port.vlan,
                adminDown: port.adminDown,
                speed: port.speed,
                connector: port.connector,
                peer: peer
            )
        }
    }

    func interface(id: UUID) -> PortSnapshot? { interfaces.first { $0.id == id } }

    /// The VLAN table as stored (VLAN 1 is implicit and normally absent), sorted by number.
    var vlans: [VLANEntry] { (device?.vlans ?? []).sorted { $0.id < $1.id } }

    /// Bundles with at least one member link on this device, in project order.
    var bundles: [BundleSnapshot] {
        guard let device else { return [] }
        let project = store.project
        return project.bundles.compactMap { bundle in
            var local: [String] = []
            var remote: [String] = []
            var peerName = ""
            for linkID in bundle.linkIDs {
                guard let link = project.link(id: linkID), let end = link.end(onDevice: device.id),
                      let near = project.resolve(link.ref(end)),
                      let far = project.resolve(link.ref(end.opposite)) else { continue }
                local.append(near.port.name)
                remote.append(far.port.name)
                peerName = far.device.hostname
            }
            return local.isEmpty ? nil
                : BundleSnapshot(label: bundle.label, localPorts: local, peerHostname: peerName, peerPorts: remote)
        }
    }

    // MARK: Writes

    /// Runs `body` as ONE undo step.
    func transaction(_ body: () -> Void) {
        store.beginUndoGroup()
        body()
        store.endUndoGroup()
    }

    /// Renames the device. Returns false when the store refused (empty name, device gone).
    @discardableResult
    func rename(to hostname: String) -> Bool {
        (try? store.renameDevice(id: deviceID, to: hostname)) != nil
    }

    @discardableResult
    func setDescription(_ text: String, port: UUID) -> Bool {
        (try? store.setPortDescription(PortRef(deviceID: deviceID, portID: port), text)) != nil
    }

    @discardableResult
    func setVLANText(_ text: String, port: UUID) -> Bool {
        (try? store.setPortVLAN(PortRef(deviceID: deviceID, portID: port), text)) != nil
    }

    @discardableResult
    func setAdminDown(_ down: Bool, port: UUID) -> Bool {
        (try? store.setPortAdminDown(PortRef(deviceID: deviceID, portID: port), down)) != nil
    }

    @discardableResult
    func setVLANs(_ vlans: [VLANEntry]) -> Bool {
        (try? store.setVLANs(deviceID: deviceID, vlans)) != nil
    }

    // MARK: IP configuration

    var addresses: [InterfaceAddress] { device?.addresses ?? [] }
    var defaultGateway: String { device?.defaultGateway ?? "" }
    var staticRoutes: [StaticRoute] { device?.staticRoutes ?? [] }

    /// The address of a layer-3 interface, parsed; nil when none (or a malformed one) is set.
    func address(of interface: L3InterfaceID) -> IPv4Prefix? {
        device?.address(of: interface).flatMap { IPv4Prefix(cidr: $0.address) }
    }

    /// Sets (or with nil removes) the address of an interface.
    @discardableResult
    func setAddress(_ prefix: IPv4Prefix?, on interface: L3InterfaceID) -> Bool {
        (try? store.setAddress(deviceID: deviceID, interface: interface, prefix?.description)) != nil
    }

    @discardableResult
    func setDefaultGateway(_ gateway: IPv4?) -> Bool {
        (try? store.setDefaultGateway(deviceID: deviceID, gateway?.description ?? "")) != nil
    }

    @discardableResult
    func setStaticRoutes(_ routes: [StaticRoute]) -> Bool {
        (try? store.setStaticRoutes(deviceID: deviceID, routes)) != nil
    }

    /// Another device's interface that already uses `address`, as "hostname interface".
    func addressConflict(_ address: IPv4, except interface: L3InterfaceID) -> String? {
        for other in store.project.devices {
            for entry in other.addresses {
                guard let prefix = IPv4Prefix(cidr: entry.address), prefix.address == address else { continue }
                if other.id == deviceID && entry.interface == interface { continue }
                return other.hostname
            }
        }
        return nil
    }

    /// The network simulation of the current project.
    var simulator: NetworkSimulator { NetworkSimulator(project: store.project) }
}
