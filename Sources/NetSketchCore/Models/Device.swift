import Foundation
import CoreGraphics

/// One port of a placed device.
///
/// Decoding is lenient: `description`, `vlan`, `verified`, `groupIndex` and `adminDown`
/// may be missing in the file and then take their defaults.
public struct Port: Codable, Identifiable, Equatable, Hashable, Sendable {
    public var id: UUID
    /// Full interface name, e.g. "Fa0/1" or "GigabitEthernet 1/1".
    public var name: String
    public var connector: ConnectorType
    /// Free-form nominal speed ("100M", "1G", ...); empty when not applicable.
    public var speed: String
    /// False until the port has been checked against real hardware.
    public var verified: Bool
    /// User text shown in the inspector (like an interface description).
    public var description: String
    /// Free text, e.g. "10" or "trunk 10,20". No logic is attached to it.
    public var vlan: String
    /// Index of the template port group this port came from; used by `PanelLayout`.
    public var groupIndex: Int
    /// Administratively shut down (IOS `shutdown`). Stored only; nothing is simulated.
    public var adminDown: Bool

    public init(
        id: UUID = UUID(),
        name: String,
        connector: ConnectorType,
        speed: String,
        verified: Bool = false,
        description: String = "",
        vlan: String = "",
        groupIndex: Int = 0,
        adminDown: Bool = false
    ) {
        self.id = id
        self.name = name
        self.connector = connector
        self.speed = speed
        self.verified = verified
        self.description = description
        self.vlan = vlan
        self.groupIndex = groupIndex
        self.adminDown = adminDown
    }

    /// Abbreviated name for cable-end labels, see `PortNaming.shortName(_:)`.
    public var shortName: String { PortNaming.shortName(name) }

    private enum CodingKeys: String, CodingKey {
        case id, name, connector, speed, verified, description, vlan, groupIndex, adminDown
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        connector = try c.decode(ConnectorType.self, forKey: .connector)
        speed = try c.decodeIfPresent(String.self, forKey: .speed) ?? ""
        verified = try c.decodeIfPresent(Bool.self, forKey: .verified) ?? false
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        vlan = try c.decodeIfPresent(String.self, forKey: .vlan) ?? ""
        groupIndex = try c.decodeIfPresent(Int.self, forKey: .groupIndex) ?? 0
        adminDown = try c.decodeIfPresent(Bool.self, forKey: .adminDown) ?? false
    }
}

/// One row of a device's VLAN table. `id` is the VLAN number. Stored only; no logic.
public struct VLANEntry: Codable, Identifiable, Equatable, Hashable, Sendable {
    /// VLAN number.
    public var id: Int
    public var name: String

    public init(id: Int, name: String = "") {
        self.id = id
        self.name = name
    }

    private enum CodingKeys: String, CodingKey { case id, name }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
    }
}

/// A device placed on the canvas.
///
/// It carries a snapshot of its template (vendor, model, ports, panel layout), so a project
/// keeps opening even when the catalog entry changes or disappears.
/// Decoding is lenient: `note`, `layout`, `verified` and `vlans` may be missing in the file.
public struct Device: Codable, Identifiable, Equatable, Hashable, Sendable {
    public var id: UUID
    /// Slug of the catalog template the device was created from.
    public var templateID: String
    public var vendor: String
    public var model: String
    public var category: DeviceCategory
    /// Editable name shown on the canvas.
    public var hostname: String
    /// Centre of the device in canvas coordinates (stable across view modes).
    public var position: CGPoint
    public var ports: [Port]
    public var note: String
    /// Snapshot of the template's (normalized) front-panel layout.
    public var layout: PanelLayout
    /// Snapshot of the template's `verified` flag.
    public var verified: Bool
    /// VLAN table edited through the configuration CLI. Stored only; no logic.
    public var vlans: [VLANEntry]

    public init(
        id: UUID = UUID(),
        templateID: String,
        vendor: String,
        model: String,
        category: DeviceCategory,
        hostname: String,
        position: CGPoint,
        ports: [Port],
        note: String = "",
        layout: PanelLayout = PanelLayout(),
        verified: Bool = false,
        vlans: [VLANEntry] = []
    ) {
        self.id = id
        self.templateID = templateID
        self.vendor = vendor
        self.model = model
        self.category = category
        self.hostname = hostname
        self.position = position
        self.ports = ports
        self.note = note
        self.layout = layout
        self.verified = verified
        self.vlans = vlans
    }

    /// "Vendor Model".
    public var displayModel: String {
        [vendor, model].filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// True when the device or any of its ports is still unverified
    /// (the UI shows the "ověřit podle hardwaru" warning).
    public var needsVerification: Bool {
        !verified || ports.contains { !$0.verified }
    }

    /// Front panel in cell units; `slots[i]` belongs to `ports[i]`.
    public var panelGrid: PanelGrid { layout.grid(for: ports) }

    public func port(id: UUID) -> Port? { ports.first { $0.id == id } }

    /// The port with exactly this full name, or failing that this short name.
    public func port(named name: String) -> Port? {
        ports.first { $0.name == name } ?? ports.first { $0.shortName == name }
    }

    public func portIndex(id: UUID) -> Int? { ports.firstIndex { $0.id == id } }

    /// Reference to one of this device's ports.
    public func ref(_ port: Port) -> PortRef { PortRef(deviceID: id, portID: port.id) }

    /// Reference to the port called `name` (full or short), if it exists.
    public func ref(portNamed name: String) -> PortRef? {
        port(named: name).map { PortRef(deviceID: id, portID: $0.id) }
    }

    public func hash(into hasher: inout Hasher) { hasher.combine(id) }

    // MARK: Codable

    private enum CodingKeys: String, CodingKey {
        case id, templateID, vendor, model, category, hostname, position, ports, note, layout, verified, vlans
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        templateID = try c.decodeIfPresent(String.self, forKey: .templateID) ?? ""
        vendor = try c.decodeIfPresent(String.self, forKey: .vendor) ?? ""
        model = try c.decodeIfPresent(String.self, forKey: .model) ?? ""
        category = try c.decode(DeviceCategory.self, forKey: .category)
        hostname = try c.decode(String.self, forKey: .hostname)
        position = try c.decode(CodablePoint.self, forKey: .position).point
        ports = try c.decodeIfPresent([Port].self, forKey: .ports) ?? []
        note = try c.decodeIfPresent(String.self, forKey: .note) ?? ""
        layout = try c.decodeIfPresent(PanelLayout.self, forKey: .layout) ?? PanelLayout()
        verified = try c.decodeIfPresent(Bool.self, forKey: .verified) ?? false
        vlans = try c.decodeIfPresent([VLANEntry].self, forKey: .vlans) ?? []
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(templateID, forKey: .templateID)
        try c.encode(vendor, forKey: .vendor)
        try c.encode(model, forKey: .model)
        try c.encode(category, forKey: .category)
        try c.encode(hostname, forKey: .hostname)
        try c.encode(CodablePoint(position), forKey: .position)
        try c.encode(ports, forKey: .ports)
        try c.encode(note, forKey: .note)
        try c.encode(layout, forKey: .layout)
        try c.encode(verified, forKey: .verified)
        try c.encode(vlans, forKey: .vlans)
    }
}

/// JSON form of a canvas point: `{"x": 120, "y": 80}`.
struct CodablePoint: Codable {
    var x: Double
    var y: Double

    init(_ point: CGPoint) {
        x = Double(point.x)
        y = Double(point.y)
    }

    var point: CGPoint { CGPoint(x: x, y: y) }
}
