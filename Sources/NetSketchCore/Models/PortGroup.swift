import Foundation

/// A run of similar ports on a device template, e.g. "Fa0/1 ... Fa0/24".
///
/// Port names are `prefix + number + suffix` for every `step`-th number in
/// `rangeStart...rangeEnd`, unless explicit `names` are given (they win).
/// A placeholder group has no ports at all; it only reserves an empty slot on
/// the front panel (e.g. an unpopulated NIM bay).
///
/// JSON keys: `prefix`, `rangeStart`, `rangeEnd`, `step` (default 1), `suffix` (default ""),
/// `names` (optional), `speed`, `connector`, `verified` (default false), `label` (optional),
/// `placeholder` (default false).
public struct PortGroup: Codable, Equatable, Hashable, Sendable {
    /// Text in front of the port number, e.g. "Fa0/" or "GigabitEthernet 1/".
    public var prefix: String
    /// First port number (inclusive).
    public var rangeStart: Int
    /// Last port number (inclusive).
    public var rangeEnd: Int
    /// Distance between consecutive port numbers; 2 gives 53, 55, ...
    public var step: Int
    /// Text behind the port number; usually empty.
    public var suffix: String
    /// Explicit port names. When set, prefix/range/step/suffix are ignored.
    public var names: [String]?
    /// Free-form nominal speed: "100M", "1G", "10G", "40G"; empty when not applicable (console).
    public var speed: String
    public var connector: ConnectorType
    /// False until someone has checked the group against real hardware.
    public var verified: Bool
    /// Optional short caption for the panel section, e.g. "PoE+", "Uplink", "NIM".
    public var label: String?
    /// True for an empty module bay: generates no ports, only reserves panel space.
    public var isPlaceholder: Bool

    /// A numbered group: `prefix + n + suffix` for n in `range` (every `step`-th).
    public init(
        prefix: String,
        range: ClosedRange<Int>,
        step: Int = 1,
        suffix: String = "",
        speed: String,
        connector: ConnectorType,
        verified: Bool = false,
        label: String? = nil
    ) {
        self.prefix = prefix
        self.rangeStart = range.lowerBound
        self.rangeEnd = range.upperBound
        self.step = max(1, step)
        self.suffix = suffix
        self.names = nil
        self.speed = speed
        self.connector = connector
        self.verified = verified
        self.label = label
        self.isPlaceholder = false
    }

    /// A group of explicitly named ports, e.g. `["Console"]` or `["WAN", "WAN SFP+"]`.
    public init(
        names: [String],
        speed: String,
        connector: ConnectorType,
        verified: Bool = false,
        label: String? = nil
    ) {
        self.prefix = ""
        self.rangeStart = 1
        self.rangeEnd = max(1, names.count)
        self.step = 1
        self.suffix = ""
        self.names = names
        self.speed = speed
        self.connector = connector
        self.verified = verified
        self.label = label
        self.isPlaceholder = false
    }

    /// An empty module bay that only reserves space on the panel.
    public static func placeholder(
        label: String,
        connector: ConnectorType = .rj45,
        verified: Bool = false
    ) -> PortGroup {
        var group = PortGroup(names: [], speed: "", connector: connector, verified: verified, label: label)
        group.isPlaceholder = true
        return group
    }

    /// Generated port names, in panel order. Empty for a placeholder.
    public var portNames: [String] {
        if isPlaceholder { return [] }
        if let names { return names }
        guard rangeStart <= rangeEnd else { return [] }
        return stride(from: rangeStart, through: rangeEnd, by: max(1, step)).map {
            prefix + String($0) + suffix
        }
    }

    /// Number of ports the group generates.
    public var portCount: Int { portNames.count }

    // MARK: Codable

    private enum CodingKeys: String, CodingKey {
        case prefix, rangeStart, rangeEnd, step, suffix, names, speed, connector, verified, label
        case isPlaceholder = "placeholder"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        names = try c.decodeIfPresent([String].self, forKey: .names)
        prefix = try c.decodeIfPresent(String.self, forKey: .prefix) ?? ""
        rangeStart = try c.decodeIfPresent(Int.self, forKey: .rangeStart) ?? 1
        rangeEnd = try c.decodeIfPresent(Int.self, forKey: .rangeEnd)
            ?? names.map { max(1, $0.count) }
            ?? rangeStart
        step = max(1, try c.decodeIfPresent(Int.self, forKey: .step) ?? 1)
        suffix = try c.decodeIfPresent(String.self, forKey: .suffix) ?? ""
        speed = try c.decodeIfPresent(String.self, forKey: .speed) ?? ""
        connector = try c.decode(ConnectorType.self, forKey: .connector)
        verified = try c.decodeIfPresent(Bool.self, forKey: .verified) ?? false
        label = try c.decodeIfPresent(String.self, forKey: .label)
        isPlaceholder = try c.decodeIfPresent(Bool.self, forKey: .isPlaceholder) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(prefix, forKey: .prefix)
        try c.encode(rangeStart, forKey: .rangeStart)
        try c.encode(rangeEnd, forKey: .rangeEnd)
        if step != 1 { try c.encode(step, forKey: .step) }
        if !suffix.isEmpty { try c.encode(suffix, forKey: .suffix) }
        try c.encodeIfPresent(names, forKey: .names)
        try c.encode(speed, forKey: .speed)
        try c.encode(connector, forKey: .connector)
        try c.encode(verified, forKey: .verified)
        try c.encodeIfPresent(label, forKey: .label)
        if isPlaceholder { try c.encode(true, forKey: .isPlaceholder) }
    }
}
