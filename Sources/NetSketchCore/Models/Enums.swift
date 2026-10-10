import Foundation

/// Physical connector (or medium) of a port.
public enum ConnectorType: String, Codable, CaseIterable, Hashable, Sendable {
    case rj45 = "RJ45"
    case sfp = "SFP"
    case sfpPlus = "SFP+"
    case qsfpPlus = "QSFP+"
    case console
    case mgmt
    case wireless

    /// True for pluggable cages (SFP, SFP+, QSFP+).
    public var isModular: Bool {
        self == .sfp || self == .sfpPlus || self == .qsfpPlus
    }

    /// False for wireless interfaces, which have no jack on the panel.
    public var isPhysical: Bool { self != .wireless }
}

/// Coarse device class. Drives the palette grouping, the icon and the default hostname.
public enum DeviceCategory: String, Codable, CaseIterable, Hashable, Sendable {
    case `switch` = "switch"
    case router = "router"
    case l3switch = "L3 switch"
    case accessPoint = "AP"
    case pc = "PC"
    case server = "server"

    /// Prefix of automatically generated hostnames ("SW1", "R1", "AP1", "PC1", "SRV1").
    /// L2 and L3 switches share the "SW" numbering.
    public var hostnamePrefix: String {
        switch self {
        case .switch, .l3switch: return "SW"
        case .router: return "R"
        case .accessPoint: return "AP"
        case .pc: return "PC"
        case .server: return "SRV"
        }
    }
}

/// Kind of cable drawn for a link. Purely visual; nothing is validated against the ports.
public enum CableType: String, Codable, CaseIterable, Hashable, Sendable {
    case straight
    case crossover
    case console
    case fiber
}

/// Colour of the status dot at one end of a link. Toggled manually; never computed.
public enum LinkStatus: String, Codable, CaseIterable, Hashable, Sendable {
    case none
    case green
    case orange
    case red

    /// The next status in the manual cycle none -> green -> orange -> red -> none.
    public var next: LinkStatus {
        switch self {
        case .none: return .green
        case .green: return .orange
        case .orange: return .red
        case .red: return .none
        }
    }
}

/// One of the two ends of a link.
public enum LinkEnd: String, Codable, CaseIterable, Hashable, Sendable {
    case a
    case b

    public var opposite: LinkEnd { self == .a ? .b : .a }
}

/// How the canvas presents the project.
public enum ViewMode: String, Codable, CaseIterable, Hashable, Sendable {
    /// Front panels with ports, cables plugged into ports, port labels at the cable ends.
    case physical
    /// Device icons and plain links only.
    case logical
}
