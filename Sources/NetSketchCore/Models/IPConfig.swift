import Foundation

/// A layer-3 interface of a device: a physical port (router port, management port, PC network
/// card) or a VLAN interface of a switch (Cisco `interface vlan N`, Dell `interface vlan N`,
/// the MikroTik bridge).
///
/// Stored in JSON as a string: `"port:<UUID>"` or `"vlan:<N>"`.
public enum L3InterfaceID: Hashable, Codable, Sendable, CustomStringConvertible {
    case port(UUID)
    case vlan(Int)

    public var description: String {
        switch self {
        case .port(let id): return "port:" + id.uuidString
        case .vlan(let number): return "vlan:\(number)"
        }
    }

    public init?(string: String) {
        if string.hasPrefix("port:"), let id = UUID(uuidString: String(string.dropFirst(5))) {
            self = .port(id)
        } else if string.hasPrefix("vlan:"), let number = Int(string.dropFirst(5)), (1...4094).contains(number) {
            self = .vlan(number)
        } else {
            return nil
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let text = try container.decode(String.self)
        guard let value = L3InterfaceID(string: text) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid interface \"\(text)\"")
        }
        self = value
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(description)
    }
}

/// An IPv4 address with its prefix on one interface, e.g. `192.168.1.1/24`.
///
/// `address` is kept as the text the console wrote; the network simulation of NetSketchCLI
/// parses it. A malformed text is simply ignored there.
public struct InterfaceAddress: Codable, Equatable, Hashable, Sendable {
    public var interface: L3InterfaceID
    /// CIDR form: "192.168.1.1/24".
    public var address: String

    public init(interface: L3InterfaceID, address: String) {
        self.interface = interface
        self.address = address
    }
}

/// A static route: packets for `destination` (CIDR, e.g. "10.0.2.0/24", "0.0.0.0/0") are sent
/// to the router `nextHop`.
public struct StaticRoute: Codable, Equatable, Hashable, Sendable {
    public var destination: String
    public var nextHop: String

    public init(destination: String, nextHop: String) {
        self.destination = destination
        self.nextHop = nextHop
    }
}
