import Foundation
import NetSketchCore

/// How Dell OS9 VLAN membership maps onto the canonical switchport text.
///
/// OS9 has no access/trunk modes: a VLAN interface lists its `untagged` and `tagged` ports.
/// NetSketch stores the same facts in the one canonical `Port.vlan` format:
///
///     untagged in VLAN N only            -> "access N"   (the default VLAN 1: "")
///     tagged in VLANs A,B                -> "trunk A,B"
///     tagged in A,B + untagged in N      -> "trunk A,B native N"   (OS9 hybrid port)
enum DellMembership {
    /// The VLAN the port is an untagged member of; nil for a port that is only tagged.
    static func untaggedVLAN(_ config: SwitchportConfig) -> Int? {
        if config.mode != .trunk { return config.accessVLAN }
        return config.nativeVLAN == 1 ? nil : config.nativeVLAN
    }

    /// The default VLAN never has tagged members on OS9.
    static func isTagged(_ config: SwitchportConfig, in vlan: Int) -> Bool {
        guard config.mode == .trunk, vlan != 1, vlan != config.nativeVLAN else { return false }
        return config.allows(vlan)
    }

    static func addUntagged(_ config: inout SwitchportConfig, vlan: Int) {
        if config.mode == .trunk {
            config.nativeVLAN = vlan
            if let allowed = config.allowedVLANs { config.allowedVLANs = allowed.filter { $0 != vlan } }
        } else if vlan == 1 {
            config = SwitchportConfig()
        } else {
            config.mode = .access
            config.accessVLAN = vlan
        }
    }

    static func addTagged(_ config: inout SwitchportConfig, vlan: Int) {
        if config.mode == .trunk {
            if let allowed = config.allowedVLANs, !allowed.contains(vlan) {
                config.allowedVLANs = (allowed + [vlan]).sorted()
            }
            if config.nativeVLAN == vlan { config.nativeVLAN = 1 }
        } else {
            let untagged = config.accessVLAN
            config = SwitchportConfig()
            config.mode = .trunk
            config.allowedVLANs = [vlan]
            if untagged != 1, untagged != vlan { config.nativeVLAN = untagged }
        }
    }

    static func removeUntagged(_ config: inout SwitchportConfig, vlan: Int) {
        if config.mode == .trunk {
            if config.nativeVLAN == vlan { config.nativeVLAN = 1 }
        } else if config.accessVLAN == vlan {
            config = SwitchportConfig()
        }
    }

    /// `definedVLANs` spells out "all VLANs" when the trunk was unrestricted.
    static func removeTagged(_ config: inout SwitchportConfig, vlan: Int, definedVLANs: [Int]) {
        guard config.mode == .trunk else { return }
        let current = config.allowedVLANs ?? definedVLANs.filter { $0 != 1 && $0 != config.nativeVLAN }
        let remaining = current.filter { $0 != vlan }
        if remaining.isEmpty {
            // No tagged membership is left: the port falls back to a plain untagged port.
            let native = config.nativeVLAN
            config = SwitchportConfig()
            if native != 1 {
                config.mode = .access
                config.accessVLAN = native
            }
        } else {
            config.allowedVLANs = remaining
        }
    }
}

extension IOSEngine {
    private func dellJoined(_ lines: [String]) -> String {
        lines.map { $0.trimmingTrailingWhitespace() }.joined(separator: "\n")
    }

    /// The VLAN table as OS9 sees it: VLAN 1 always exists, names are never invented.
    var dellVLANRows: [VLANRow] {
        var rows = access.vlans.filter { (1...4094).contains($0.id) }.map {
            VLANRow(id: $0.id, name: $0.name.trimmingCharacters(in: .whitespaces))
        }
        if !rows.contains(where: { $0.id == 1 }) { rows.append(VLANRow(id: 1, name: "")) }
        return rows.sorted { $0.id < $1.id }
    }

    /// Compact OS9 port lists, one string per interface type:
    /// ["GigabitEthernet 1/1-1/3,1/7", "TenGigabitEthernet 1/49"].
    func dellPortLists(_ ports: [PortSnapshot], short: Bool) -> [String] {
        var order: [String] = []
        var groups: [String: [InterfaceNameParts]] = [:]
        for port in ports {
            let name = short ? namer.shortName(port.name) : namer.longName(port.name)
            let word = String(name.prefix(while: { !$0.isNumber })).trimmingCharacters(in: .whitespaces)
            if groups[word] == nil { order.append(word) }
            groups[word, default: []].append(InterfaceNameParts(port.name))
        }
        return order.map { word in
            let members = groups[word] ?? []
            var parts: [String] = []
            var index = 0
            while index < members.count {
                var end = index
                while end + 1 < members.count, follows(members[end + 1], members[end]) { end += 1 }
                parts.append(end == index ? members[index].number : "\(members[index].number)-\(members[end].number)")
                index = end + 1
            }
            let list = parts.joined(separator: ",")
            return word.isEmpty ? list : "\(word) \(list)"
        }
    }

    /// True when `next` is the port right behind `previous` in the same slot.
    private func follows(_ next: InterfaceNameParts, _ previous: InterfaceNameParts) -> Bool {
        let a = previous.components
        let b = next.components
        guard a.count == b.count, a.dropLast().elementsEqual(b.dropLast()),
              let last = a.last.flatMap({ Int($0) }), let following = b.last.flatMap({ Int($0) }) else { return false }
        return following == last + 1
    }

    private func dellMembers(of vlan: Int) -> (untagged: [PortSnapshot], tagged: [PortSnapshot]) {
        var untagged: [PortSnapshot] = []
        var tagged: [PortSnapshot] = []
        for port in access.interfaces where port.isSwitchport {
            guard let config = port.switchport else { continue }
            if DellMembership.untaggedVLAN(config) == vlan { untagged.append(port) }
            if DellMembership.isTagged(config, in: vlan) { tagged.append(port) }
        }
        return (untagged, tagged)
    }

    // MARK: show running-config

    func dellInterfaceConfigLines(_ port: PortSnapshot) -> [String] {
        var lines = ["interface \(namer.longName(port.name))"]
        if !port.description.isEmpty { lines.append(" description \(singleLine(port.description))") }
        if port.isSwitchport { lines.append(" switchport") }
        if port.switchport == nil { lines.append(" ! \(Notices.customVLANText(singleLine(port.vlanText)))") }
        lines.append(port.adminDown ? " shutdown" : " no shutdown")
        return lines
    }

    func dellRunningConfig() -> String {
        var lines = ["Current Configuration ...", "!", "hostname \(hostname)", "!"]
        for port in access.interfaces {
            lines.append(contentsOf: dellInterfaceConfigLines(port))
            lines.append("!")
        }
        for row in dellVLANRows {
            lines.append("interface Vlan \(row.id)")
            if !row.name.isEmpty { lines.append(" name \(row.name)") }
            let members = dellMembers(of: row.id)
            for list in dellPortLists(members.tagged, short: false) { lines.append(" tagged \(list)") }
            for list in dellPortLists(members.untagged, short: false) {
                // OS9 lists the members of the default VLAN as comments.
                lines.append(row.id == 1 ? "!untagged \(list)" : " untagged \(list)")
            }
            lines.append("!")
        }
        lines.append("end")
        return dellJoined(lines)
    }

    // MARK: show interfaces ...

    func dellInterfacesStatus(_ ports: [PortSnapshot]) -> String {
        var lines = ["Port                 Description  Status Speed        Duplex Vlan"]
        let defined = dellVLANRows.map(\.id)
        for port in ports {
            let vlan: String
            if !port.isSwitchport {
                vlan = "--"
            } else if let config = port.switchport {
                var ids = defined.filter { DellMembership.isTagged(config, in: $0) }
                if let untagged = DellMembership.untaggedVLAN(config) { ids.append(untagged) }
                vlan = ids.isEmpty ? "--" : VLANListParser.format(ids)
            } else {
                vlan = singleLine(port.vlanText)
            }
            lines.append(
                namer.shortName(port.name).padded(20) + " "
                    + singleLine(port.description).column(12) + " "
                    + (port.linkState == .up ? "Up" : "Down").padded(6) + " "
                    + "Auto".padded(12) + " "
                    + "Auto".padded(6) + " "
                    + vlan
            )
        }
        return dellJoined(lines)
    }

    func dellInterfacesDescription(_ ports: [PortSnapshot]) -> String {
        var lines = ["Interface                   OK  Status     Protocol Description"]
        for port in ports {
            let status: String
            switch port.linkState {
            case .adminDown: status = "admin down"
            case .up: status = "up"
            case .down: status = "down"
            }
            lines.append(
                namer.longName(port.name).padded(27) + " "
                    + (port.linkState == .up ? "YES" : "NO").padded(3) + " "
                    + status.padded(10) + " "
                    + (port.linkState == .up ? "up" : "down").padded(8) + " "
                    + singleLine(port.description)
            )
        }
        return dellJoined(lines)
    }

    // MARK: show vlan

    func dellShowVLAN(only: Int?) -> String {
        let rows = dellVLANRows
        if let only, !rows.contains(where: { $0.id == only }) {
            return "NetSketch: VLAN \(only) v tabulce VLAN zařízení není."
        }
        var lines = [
            "",
            "Codes: * - Default VLAN",
            "Q: U - Untagged, T - Tagged",
            "",
            "    NUM    Status    Description                     Q Ports",
        ]
        var remarks: [String] = []
        for row in rows where only == nil || only == row.id {
            let members = dellMembers(of: row.id)
            let anyUp = (members.untagged + members.tagged).contains { $0.linkState == .up }
            var portLines = dellPortLists(members.untagged, short: true).map { "U \($0)" }
            portLines.append(contentsOf: dellPortLists(members.tagged, short: true).map { "T \($0)" })
            let head = (row.id == 1 ? "*   " : "    ") + "\(row.id)".padded(6) + " "
                + (anyUp ? "Active" : "Inactive").padded(9) + " " + row.name.column(31) + " "
            lines.append(head + (portLines.first ?? ""))
            for extra in portLines.dropFirst() { lines.append(String(repeating: " ", count: 53) + extra) }
        }
        if only == nil {
            for port in access.interfaces where port.isSwitchport {
                let short = namer.shortName(port.name)
                guard let config = port.switchport else {
                    remarks.append(Notices.unreadableVLANText(short, singleLine(port.vlanText)))
                    continue
                }
                if let untagged = DellMembership.untaggedVLAN(config), !rows.contains(where: { $0.id == untagged }) {
                    remarks.append(Notices.missingVLAN(short, untagged))
                }
            }
            lines.append("")
            lines.append("NetSketch: Status (Active/Inactive) plyne z kabeláže v diagramu; sloupec Description ukazuje název VLAN.")
            lines.append(contentsOf: remarks)
        }
        return dellJoined(lines)
    }

    // MARK: show lldp neighbors

    func dellLLDPNeighbors(_ neighbors: [(port: PortSnapshot, peer: PeerSnapshot)]) -> String {
        let nameWidth = max(17, neighbors.map(\.peer.hostname.count).max() ?? 0)
        var lines = [
            Notices.neighborsFromDiagram,
            " " + "Loc PortID".padded(13) + " " + "Rem Host Name".padded(nameWidth) + " Rem Port Id",
            " " + String(repeating: "-", count: 13 + 1 + nameWidth + 1 + 24),
        ]
        for (port, peer) in neighbors {
            lines.append(" " + namer.shortName(port.name).padded(13) + " " + peer.hostname.padded(nameWidth) + " " + peer.portName)
        }
        return dellJoined(lines)
    }
}
