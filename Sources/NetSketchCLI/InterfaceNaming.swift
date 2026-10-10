import Foundation

/// An interface type the IOS-like dialects know how to abbreviate and expand.
struct InterfaceType {
    /// Long spelling used in the running configuration, e.g. "FastEthernet".
    let full: String
    /// Two/three-letter spelling of `show interfaces status`, e.g. "Fa".
    let short: String
    /// Three-letter spelling of `show cdp neighbors`, e.g. "Fas".
    let cdp: String
    /// Description shown by `interface ?`.
    let help: String
}

/// How a dialect writes interface names.
enum InterfaceNameStyle {
    /// "FastEthernet0/1", "Fa0/1".
    case ios
    /// "GigabitEthernet 1/1", "Gi 1/1".
    case dell
}

/// An interface name split into its type and its numbering.
///
/// "GigabitEthernet 1/1" -> ("gigabitethernet", "1/1"), "Fa0/1" -> ("fa", "0/1"),
/// "ether1" -> ("ether", "1"), "WAN" -> ("wan", "").
struct InterfaceNameParts: Equatable {
    /// Everything before the first digit, lowercased, without whitespace.
    let type: String
    /// Everything from the first digit on, lowercased, without whitespace.
    let number: String

    init(_ raw: String) {
        let compact = raw.lowercased().filter { !$0.isWhitespace }
        if let index = compact.firstIndex(where: { $0.isNumber }) {
            type = String(compact[..<index])
            number = String(compact[index...])
        } else {
            type = compact
            number = ""
        }
    }

    var normalized: String { type + number }

    /// The numbering split at slashes: "1/0/24" -> ["1", "0", "24"].
    var components: [String] { number.split(separator: "/", omittingEmptySubsequences: false).map(String.init) }
}

enum InterfaceTypes {
    static let ios: [InterfaceType] = [
        InterfaceType(full: "Ethernet", short: "Et", cdp: "Eth", help: "IEEE 802.3"),
        InterfaceType(full: "FastEthernet", short: "Fa", cdp: "Fas", help: "FastEthernet IEEE 802.3"),
        InterfaceType(full: "GigabitEthernet", short: "Gi", cdp: "Gig", help: "GigabitEthernet IEEE 802.3z"),
        InterfaceType(full: "TwoGigabitEthernet", short: "Tw", cdp: "Two", help: "Two Gigabit Ethernet"),
        InterfaceType(full: "FiveGigabitEthernet", short: "Fi", cdp: "Fiv", help: "Five Gigabit Ethernet"),
        InterfaceType(full: "TenGigabitEthernet", short: "Te", cdp: "Ten", help: "Ten Gigabit Ethernet"),
        InterfaceType(full: "TwentyFiveGigE", short: "Twe", cdp: "Twe", help: "Twenty Five Gigabit Ethernet"),
        InterfaceType(full: "FortyGigabitEthernet", short: "Fo", cdp: "For", help: "Forty Gigabit Ethernet"),
        InterfaceType(full: "HundredGigE", short: "Hu", cdp: "Hun", help: "Hundred Gigabit Ethernet"),
        InterfaceType(full: "Serial", short: "Se", cdp: "Ser", help: "Serial"),
    ]

    /// Dell OS9 spellings; looked up before the IOS ones in the Dell dialect.
    static let dell: [InterfaceType] = [
        InterfaceType(full: "GigabitEthernet", short: "Gi", cdp: "Gi", help: "Gigabit Ethernet interface"),
        InterfaceType(full: "TenGigabitEthernet", short: "Te", cdp: "Te", help: "TenGigabit Ethernet interface"),
        InterfaceType(full: "fortyGigE", short: "Fo", cdp: "Fo", help: "FortyGigabit Ethernet interface"),
        InterfaceType(full: "hundredGigE", short: "Hu", cdp: "Hu", help: "HundredGigabit Ethernet interface"),
        InterfaceType(full: "ManagementEthernet", short: "Ma", cdp: "Ma", help: "Management Ethernet interface"),
    ]

    /// Lowercased long names of every known type, for prefix matching of user input.
    static let allFullNames: [String] = Array(Set((ios + dell).map { $0.full.lowercased() })).sorted()

    /// The known types a (lowercased) user or port prefix may stand for.
    static func candidates(for prefix: String) -> Set<String> {
        guard !prefix.isEmpty else { return [] }
        return Set(allFullNames.filter { $0.hasPrefix(prefix) })
    }
}

/// Formats interface names the way one dialect prints them.
struct InterfaceNamer {
    let style: InterfaceNameStyle

    private var table: [InterfaceType] {
        style == .dell ? InterfaceTypes.dell + InterfaceTypes.ios : InterfaceTypes.ios + InterfaceTypes.dell
    }

    /// The known type a port name is written with, when its prefix is exactly a long or a
    /// short spelling. Other prefixes ("ether", "LAN", "Port") are left alone on purpose:
    /// the CLI never renames a port into something the diagram does not show.
    func knownType(of portName: String) -> InterfaceType? {
        let parts = InterfaceNameParts(portName)
        guard !parts.type.isEmpty, !parts.number.isEmpty else { return nil }
        if let exact = table.first(where: { $0.full.lowercased() == parts.type }) { return exact }
        if parts.type == "eth" { return table.first { $0.full == "Ethernet" } }
        return table.first { $0.short.lowercased() == parts.type }
    }

    /// The numbering of a port name with its original spelling ("0/1", "1/0/24").
    private func numbering(of portName: String) -> String {
        guard let index = portName.firstIndex(where: { $0.isNumber }) else { return "" }
        return String(portName[index...]).filter { !$0.isWhitespace }
    }

    /// Long name: "Fa0/1" -> "FastEthernet0/1" (IOS) or "GigabitEthernet 1/1" (Dell).
    /// A port that is already spelled long keeps the catalog's capitalization.
    func longName(_ portName: String) -> String {
        guard let type = knownType(of: portName) else { return portName.trimmingCharacters(in: .whitespaces) }
        let number = numbering(of: portName)
        return style == .dell ? "\(type.full) \(number)" : "\(type.full)\(number)"
    }

    /// Short name: "GigabitEthernet 1/1" -> "Gi1/1" (IOS) or "Gi 1/1" (Dell).
    func shortName(_ portName: String) -> String {
        guard let type = knownType(of: portName) else { return portName.trimmingCharacters(in: .whitespaces) }
        let number = numbering(of: portName)
        return style == .dell ? "\(type.short) \(number)" : "\(type.short)\(number)"
    }

    /// The spelling of `show cdp neighbors`: "Fas 0/1", "Gig 0/1".
    func cdpName(_ portName: String) -> String {
        guard let type = knownType(of: portName) else { return portName.trimmingCharacters(in: .whitespaces) }
        return "\(type.cdp) \(numbering(of: portName))"
    }

    /// The type word of a port for `interface ?` and `show version`: the long spelling of a
    /// known type, otherwise the port's own prefix as the diagram writes it.
    func typeWord(of portName: String) -> String {
        if let type = knownType(of: portName) { return type.full }
        let trimmed = portName.trimmingCharacters(in: .whitespaces)
        guard let index = trimmed.firstIndex(where: { $0.isNumber }) else { return trimmed }
        return String(trimmed[..<index]).trimmingCharacters(in: .whitespaces)
    }

    /// Lowercase two-letter tag of Dell prompts: "GigabitEthernet 1/1" -> "gi".
    func promptTag(of portName: String) -> String {
        if let type = knownType(of: portName) { return type.short.lowercased() }
        return InterfaceNameParts(portName).type
    }
}

/// Resolves what the user typed to the ports the device really has.
enum InterfaceResolver {
    enum Lookup {
        case found(PortSnapshot)
        /// More than one port fits (e.g. "t1/1" with both Te1/1 and Twe1/1).
        case ambiguous
        /// No port has a type that fits the typed prefix.
        case unknownType
        /// The type fits but no such number exists; `offset` is the offending position
        /// inside the typed numbering.
        case unknownNumber(offset: Int)
    }

    /// True when a typed type prefix may stand for the type prefix of a port.
    static func typeMatches(user: String, port: String) -> Bool {
        if user == port { return true }
        if user.isEmpty { return false }
        if port.hasPrefix(user) { return true }
        return !InterfaceTypes.candidates(for: user).isDisjoint(with: InterfaceTypes.candidates(for: port))
    }

    static func lookup(_ spec: String, in ports: [PortSnapshot]) -> Lookup {
        let user = InterfaceNameParts(spec)
        guard !user.normalized.isEmpty else { return .unknownType }

        // The exact name always wins, whatever it looks like.
        if let exact = ports.first(where: { InterfaceNameParts($0.name).normalized == user.normalized }) {
            return .found(exact)
        }
        let sameType = ports.filter { typeMatches(user: user.type, port: InterfaceNameParts($0.name).type) }
        guard !sameType.isEmpty, !user.type.isEmpty else { return .unknownType }

        let matches = sameType.filter { InterfaceNameParts($0.name).number == user.number }
        if matches.count == 1 { return .found(matches[0]) }
        if matches.count > 1 {
            let identical = matches.filter { InterfaceNameParts($0.name).type == user.type }
            return identical.count == 1 ? .found(identical[0]) : .ambiguous
        }
        return .unknownNumber(offset: mismatchOffset(of: user, among: sameType.map { InterfaceNameParts($0.name) }))
    }

    /// Position inside the typed numbering of the first slash-separated component that no
    /// port shares; real IOS puts its caret there ("fa0/99" -> under the first 9).
    private static func mismatchOffset(of user: InterfaceNameParts, among ports: [InterfaceNameParts]) -> Int {
        var candidates = ports.map(\.components)
        var offset = 0
        for (index, component) in user.components.enumerated() {
            candidates = candidates.filter { index < $0.count && $0[index] == component }
            if candidates.isEmpty { return offset }
            offset += component.count + 1
        }
        return max(0, min(offset, user.number.count) - 1)
    }
}
