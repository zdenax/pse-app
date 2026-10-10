import Foundation

/// An IPv4 address.
struct IPv4: Hashable, Comparable, CustomStringConvertible {
    let value: UInt32

    init(_ value: UInt32) { self.value = value }

    /// Parses dotted decimal ("192.168.1.10"); nil for anything else.
    init?(_ text: String) {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var value: UInt32 = 0
        for part in parts {
            guard !part.isEmpty, part.count <= 3, part.allSatisfy({ $0.isASCII && $0.isNumber }),
                  let octet = UInt32(part), octet <= 255 else { return nil }
            value = value << 8 | octet
        }
        self.value = value
    }

    var description: String {
        "\(value >> 24).\(value >> 16 & 0xFF).\(value >> 8 & 0xFF).\(value & 0xFF)"
    }

    static func < (lhs: IPv4, rhs: IPv4) -> Bool { lhs.value < rhs.value }

    /// The netmask of a prefix length: 24 -> 255.255.255.0.
    static func mask(prefix: Int) -> IPv4 {
        prefix <= 0 ? IPv4(0) : IPv4(UInt32.max << UInt32(32 - min(prefix, 32)))
    }

    /// The prefix length of a contiguous netmask; nil for masks like 255.0.255.0.
    var prefixLength: Int? {
        let ones = value.nonzeroBitCount
        return IPv4.mask(prefix: ones) == self ? ones : nil
    }
}

/// An address with its prefix ("192.168.1.10/24"), or a network ("192.168.1.0/24").
struct IPv4Prefix: Hashable, CustomStringConvertible {
    let address: IPv4
    let length: Int

    init(address: IPv4, length: Int) {
        self.address = address
        self.length = min(max(length, 0), 32)
    }

    /// "A.B.C.D/NN".
    init?(cidr text: String) {
        let parts = text.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, let address = IPv4(String(parts[0])),
              parts[1].count <= 2, parts[1].allSatisfy({ $0.isASCII && $0.isNumber }),
              let length = Int(parts[1]), (0...32).contains(length) else { return nil }
        self.init(address: address, length: length)
    }

    /// "A.B.C.D" and "M.M.M.M" (a contiguous mask).
    init?(address text: String, mask maskText: String) {
        guard let address = IPv4(text), let mask = IPv4(maskText), let length = mask.prefixLength else { return nil }
        self.init(address: address, length: length)
    }

    /// Either "A.B.C.D/NN" or "A.B.C.D M.M.M.M" in `words` (one or two words).
    init?(words: [String]) {
        if words.count == 1, let value = IPv4Prefix(cidr: words[0]) {
            self = value
        } else if words.count == 2, let value = IPv4Prefix(address: words[0], mask: words[1]) {
            self = value
        } else {
            return nil
        }
    }

    var mask: IPv4 { IPv4.mask(prefix: length) }
    var network: IPv4 { IPv4(address.value & mask.value) }
    var broadcast: IPv4 { IPv4(network.value | ~mask.value) }
    var networkPrefix: IPv4Prefix { IPv4Prefix(address: network, length: length) }

    func contains(_ ip: IPv4) -> Bool { ip.value & mask.value == network.value }

    /// A usable host address: not the network or broadcast address of a /0-/30 network.
    var isHostAddress: Bool {
        if length >= 31 { return true }
        return address != network && address != broadcast
    }

    var description: String { "\(address)/\(length)" }
}
