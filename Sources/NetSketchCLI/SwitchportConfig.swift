import Foundation

/// The switchport configuration of one port, stored in the free-text `Port.vlan` field.
///
/// Canonical text format (the ONLY format the CLI writes; documented for the inspector too):
///
///     ""                        no switchport configuration (access VLAN 1, mode not set)
///     "10"                      switchport access vlan 10            (mode not set)
///     "access 10"               switchport mode access + switchport access vlan 10
///     "trunk"                   switchport mode trunk                (all VLANs, native 1)
///     "trunk 10,20,30-40"       ... + switchport trunk allowed vlan 10,20,30-40
///     "trunk native 99"         ... + switchport trunk native vlan 99
///     "trunk 10,20 native 99"   both
///     "trunk none"              ... + switchport trunk allowed vlan none
///
/// Settings of the mode that is currently NOT active are kept behind a semicolon, so that the
/// order in which the commands are typed does not matter:
///
///     "trunk 10,20; access 30"          mode trunk, access VLAN 30 remembered
///     "access 30; trunk 10,20 native 99"   mode access, trunk settings remembered
///     "30; trunk 10,20"                 mode not set, both remembered
///
/// The first clause decides the mode: a bare number means "mode not set". Keywords are
/// case-insensitive and extra spaces are ignored when reading. Anything else (for example a
/// note typed by hand into the inspector) is NOT canonical: `parse` returns nil and the CLI
/// shows the text unchanged in a remark line instead of interpreting it.
struct SwitchportConfig: Equatable {
    enum Mode: Equatable {
        /// No `switchport mode` line (IOS default).
        case unset
        case access
        case trunk
    }

    var mode: Mode = .unset
    var accessVLAN: Int = 1
    /// VLANs allowed on the trunk; nil means all (1-4094), an empty array means none.
    var allowedVLANs: [Int]?
    var nativeVLAN: Int = 1

    static let allVLANs = 1...4094

    var hasTrunkSettings: Bool { allowedVLANs != nil || nativeVLAN != 1 }

    var isDefault: Bool { self == SwitchportConfig() }

    /// The VLANs a trunk carries according to the configuration (all when unrestricted).
    func allows(_ vlan: Int) -> Bool {
        guard let allowedVLANs else { return true }
        return allowedVLANs.contains(vlan)
    }

    // MARK: Writing

    /// The canonical text for `Port.vlan`.
    var canonicalText: String {
        switch mode {
        case .unset:
            if !hasTrunkSettings { return accessVLAN == 1 ? "" : "\(accessVLAN)" }
            return "\(accessVLAN); \(trunkClause)"
        case .access:
            return hasTrunkSettings ? "access \(accessVLAN); \(trunkClause)" : "access \(accessVLAN)"
        case .trunk:
            return accessVLAN == 1 ? trunkClause : "\(trunkClause); access \(accessVLAN)"
        }
    }

    private var trunkClause: String {
        var text = "trunk"
        if let allowedVLANs {
            text += allowedVLANs.isEmpty ? " none" : " " + VLANListParser.format(allowedVLANs)
        }
        if nativeVLAN != 1 { text += " native \(nativeVLAN)" }
        return text
    }

    // MARK: Reading

    /// Parses canonical text. Returns nil for anything that is not in the documented format.
    static func parse(_ text: String) -> SwitchportConfig? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return SwitchportConfig() }
        guard trimmed.count <= 600 else { return nil }

        let clauses = trimmed.lowercased().split(separator: ";", omittingEmptySubsequences: false).map {
            $0.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        }
        guard (1...2).contains(clauses.count), clauses.allSatisfy({ !$0.isEmpty }) else { return nil }

        var config = SwitchportConfig()
        let first = clauses[0]
        switch first[0] {
        case "access":
            config.mode = .access
            guard config.readAccess(first) else { return nil }
        case "trunk":
            config.mode = .trunk
            guard config.readTrunk(first) else { return nil }
        default:
            guard first.count == 1, let vlan = vlanID(first[0]) else { return nil }
            config.mode = .unset
            config.accessVLAN = vlan
        }

        if clauses.count == 2 {
            let second = clauses[1]
            switch (config.mode, second[0]) {
            case (.trunk, "access"):
                // The remembered access VLAN must be explicit here.
                guard second.count == 2, config.readAccess(second) else { return nil }
            case (.access, "trunk"), (.unset, "trunk"):
                guard config.readTrunk(second) else { return nil }
            default:
                return nil
            }
        }
        return config
    }

    /// Reads `access [N]`.
    private mutating func readAccess(_ words: [String]) -> Bool {
        switch words.count {
        case 1:
            accessVLAN = 1
            return true
        case 2:
            guard let vlan = SwitchportConfig.vlanID(words[1]) else { return false }
            accessVLAN = vlan
            return true
        default:
            return false
        }
    }

    /// Reads `trunk [LIST|all|none] [native N]`.
    private mutating func readTrunk(_ words: [String]) -> Bool {
        var rest = words.dropFirst()
        if let next = rest.first, next != "native" {
            switch next {
            case "all": allowedVLANs = nil
            case "none": allowedVLANs = []
            default:
                guard let list = VLANListParser.parse(next) else { return false }
                allowedVLANs = list.count == SwitchportConfig.allVLANs.count ? nil : list
            }
            rest = rest.dropFirst()
        }
        if rest.first == "native" {
            rest = rest.dropFirst()
            guard let word = rest.first, let vlan = SwitchportConfig.vlanID(word) else { return false }
            nativeVLAN = vlan
            rest = rest.dropFirst()
        }
        return rest.isEmpty
    }

    private static func vlanID(_ text: String) -> Int? {
        guard !text.isEmpty, text.count <= 4, text.allSatisfy({ $0.isASCII && $0.isNumber }),
              let value = Int(text), allVLANs.contains(value) else { return nil }
        return value
    }
}
