import Foundation

/// Helpers for interface names.
public enum PortNaming {
    /// Long interface-name prefixes and their conventional abbreviations.
    /// Matched case-insensitively, longest first, and only when a digit follows.
    private static let rules: [(long: String, short: String)] = [
        ("TwentyFiveGigabitEthernet", "Twe"),
        ("HundredGigabitEthernet", "Hu"),
        ("FortyGigabitEthernet", "Fo"),
        ("TenGigabitEthernet", "Te"),
        ("FiveGigabitEthernet", "Fi"),
        ("TwoGigabitEthernet", "Tw"),
        ("ManagementEthernet", "Ma"),
        ("GigabitEthernet", "Gi"),
        ("TwentyFiveGigE", "Twe"),
        ("FastEthernet", "Fa"),
        ("Port-channel", "Po"),
        ("HundredGigE", "Hu"),
        ("FortyGigE", "Fo"),
        ("Loopback", "Lo"),
        ("Ethernet", "Eth"),
        ("TenGigE", "Te"),
        ("Serial", "Se"),
        ("Vlan", "Vl"),
    ]

    /// Short form of an interface name for cable-end labels.
    ///
    /// "GigabitEthernet 1/1" -> "Gi1/1", "TenGigabitEthernet 1/49" -> "Te1/49",
    /// "fortyGigE 1/53" -> "Fo1/53", "FastEthernet0/1" -> "Fa0/1".
    /// Names that are already short ("Fa0/1", "ether1", "LAN 3", "Console") are returned unchanged.
    public static func shortName(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        for rule in rules {
            guard let range = trimmed.range(of: rule.long, options: [.caseInsensitive, .anchored]) else {
                continue
            }
            let tail = trimmed[range.upperBound...].drop(while: { $0 == " " })
            guard let first = tail.first, ("0"..."9").contains(first) else { continue }
            return rule.short + tail
        }
        return trimmed
    }
}
