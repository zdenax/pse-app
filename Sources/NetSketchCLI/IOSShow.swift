import Foundation
import NetSketchCore

// `show` output of the IOS dialect. Everything printed here follows from static data of the
// diagram (ports, their texts, the shutdown flag, drawn cables and bundles, the VLAN table).
// Columns copy the real IOS layout; fields a real switch would learn from a running protocol
// are either left out or replaced by the configured value, and a NetSketch line says so.

struct VLANRow {
    let id: Int
    let name: String
}

extension IOSEngine {
    // MARK: Shared lookups

    static func defaultVLANName(_ id: Int) -> String {
        id == 1 ? "default" : "VLAN" + String(repeating: "0", count: max(0, 4 - String(id).count)) + String(id)
    }

    /// The VLAN table with the implicit VLAN 1 and default names filled in, sorted by number.
    var vlanRows: [VLANRow] {
        var rows: [VLANRow] = []
        var hasDefault = false
        for entry in access.vlans where (1...4094).contains(entry.id) {
            if entry.id == 1 { hasDefault = true }
            let name = entry.name.trimmingCharacters(in: .whitespaces)
            rows.append(VLANRow(id: entry.id, name: name.isEmpty ? IOSEngine.defaultVLANName(entry.id) : name))
        }
        if !hasDefault { rows.append(VLANRow(id: 1, name: "default")) }
        return rows.sorted { $0.id < $1.id }
    }

    func vlanName(_ id: Int) -> String? { vlanRows.first { $0.id == id }?.name }

    /// One-line form of a free text (inspector texts may contain line breaks).
    func singleLine(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline).joined(separator: " ")
    }

    private func statusWord(_ port: PortSnapshot) -> String {
        switch port.linkState {
        case .adminDown: return "disabled"
        case .up: return "connected"
        case .down: return "notconnect"
        }
    }

    private func mediaType(_ port: PortSnapshot) -> String {
        switch port.connector {
        case .rj45, .mgmt:
            switch port.speed.uppercased() {
            case "10M": return "10BaseT"
            case "100M": return "10/100BaseTX"
            case "1G": return "10/100/1000BaseTX"
            default: return port.speed.isEmpty ? "RJ45" : "RJ45 \(port.speed)"
            }
        case .sfp, .sfpPlus, .qsfpPlus:
            return port.connector.rawValue
        case .wireless:
            return "wireless"
        case .console:
            return ""
        }
    }

    private func vlanColumn(_ port: PortSnapshot) -> String {
        guard port.isSwitchport else { return "routed" }
        guard let config = port.switchport else { return singleLine(port.vlanText) }
        return config.mode == .trunk ? "trunk" : "\(config.accessVLAN)"
    }

    private func joined(_ lines: [String]) -> String {
        lines.map { $0.trimmingTrailingWhitespace() }.joined(separator: "\n")
    }

    /// The physical ports a show command was asked about; nil when the argument names a
    /// virtual interface, which the diagram does not store.
    private func ports(of command: ParsedCommand) -> [PortSnapshot]? {
        guard let selection = command.interfaces("interface") else { return access.interfaces }
        guard case .ports(let ids) = selection.target else { return nil }
        let live = access.interfaces
        return ids.compactMap { id in live.first { $0.id == id } }
    }

    // MARK: show running-config

    func interfaceConfigLines(_ port: PortSnapshot) -> [String] {
        var lines = ["interface \(namer.longName(port.name))"]
        if !port.description.isEmpty { lines.append(" description \(singleLine(port.description))") }
        if let config = port.switchport {
            if config.accessVLAN != 1 { lines.append(" switchport access vlan \(config.accessVLAN)") }
            if config.nativeVLAN != 1 { lines.append(" switchport trunk native vlan \(config.nativeVLAN)") }
            if let allowed = config.allowedVLANs {
                lines.append(" switchport trunk allowed vlan \(allowed.isEmpty ? "none" : VLANListParser.format(allowed))")
            }
            switch config.mode {
            case .access: lines.append(" switchport mode access")
            case .trunk: lines.append(" switchport mode trunk")
            case .unset: break
            }
        } else {
            lines.append(" ! \(Notices.customVLANText(singleLine(port.vlanText)))")
        }
        if port.adminDown { lines.append(" shutdown") }
        return lines
    }

    private func withConfigHeader(_ body: [String]) -> String {
        let text = body.joined(separator: "\n")
        return joined(["Building configuration...", "", "Current configuration : \(text.utf8.count) bytes"] + body)
    }

    func showRunningConfig(_ command: ParsedCommand) -> String {
        if isDell { return dellRunningConfig() }
        var body = ["!", "hostname \(hostname)", "!"]
        for row in vlanRows where row.id != 1 {
            body.append("vlan \(row.id)")
            if row.name != IOSEngine.defaultVLANName(row.id) { body.append(" name \(row.name)") }
            body.append("!")
        }
        for port in access.interfaces {
            body.append(contentsOf: interfaceConfigLines(port))
            body.append("!")
        }
        body.append("end")
        return withConfigHeader(body)
    }

    func showRunningConfigInterface(_ command: ParsedCommand) -> String {
        guard let ports = ports(of: command) else { return Notices.virtualInterface }
        if isDell { return joined(ports.flatMap { ["!"] + dellInterfaceConfigLines($0) }) }
        var body: [String] = []
        for port in ports {
            body.append("!")
            body.append(contentsOf: interfaceConfigLines(port))
        }
        body.append("end")
        return withConfigHeader(body)
    }

    // MARK: show interfaces ...

    func showInterfacesStatus(_ command: ParsedCommand) -> String {
        guard let ports = ports(of: command) else { return Notices.virtualInterface }
        if isDell { return dellInterfacesStatus(ports) }
        var lines = ["Port      Name               Status       Vlan       Duplex  Speed Type"]
        for port in ports {
            lines.append(
                namer.shortName(port.name).padded(9) + " "
                    + singleLine(port.description).column(18) + " "
                    + statusWord(port).padded(12) + " "
                    + vlanColumn(port).column(10) + " "
                    + "auto".leftPadded(6) + " "
                    + "auto".leftPadded(6) + " "
                    + mediaType(port)
            )
        }
        return joined(lines)
    }

    func showInterfacesDescription(_ command: ParsedCommand) -> String {
        guard let ports = ports(of: command) else { return Notices.virtualInterface }
        if isDell { return dellInterfacesDescription(ports) }
        var lines = ["Interface                      Status         Protocol Description"]
        for port in ports {
            let status: String
            switch port.linkState {
            case .adminDown: status = "admin down"
            case .up: status = "up"
            case .down: status = "down"
            }
            lines.append(
                namer.shortName(port.name).padded(30) + " "
                    + status.padded(14) + " "
                    + (port.linkState == .up ? "up" : "down").padded(8) + " "
                    + singleLine(port.description)
            )
        }
        return joined(lines)
    }

    /// `show interfaces [X]`: only the lines that follow from the diagram.
    func showInterfaces(_ command: ParsedCommand) -> String {
        guard let ports = ports(of: command) else { return Notices.virtualInterface }
        var lines: [String] = []
        for port in ports {
            let name = namer.longName(port.name)
            switch port.linkState {
            case .adminDown:
                lines.append("\(name) is administratively down, line protocol is down" + (isDell ? "" : " (disabled)"))
            case .up:
                lines.append("\(name) is up, line protocol is up" + (isDell ? "" : " (connected)"))
            case .down:
                lines.append("\(name) is down, line protocol is down" + (isDell ? "" : " (notconnect)"))
            }
            if !port.description.isEmpty { lines.append("  Description: \(singleLine(port.description))") }
        }
        lines.append(Notices.interfaceStatic)
        return joined(lines)
    }

    func showInterfacesTrunk(_ command: ParsedCommand) -> String {
        guard let ports = ports(of: command) else { return Notices.virtualInterface }
        let trunks = ports.compactMap { port -> (PortSnapshot, SwitchportConfig)? in
            guard port.isSwitchport, let config = port.switchport, config.mode == .trunk else { return nil }
            return (port, config)
        }
        guard !trunks.isEmpty else { return "" }
        let existing = vlanRows.map(\.id)

        var lines = ["Port        Mode             Encapsulation  Status        Native vlan"]
        for (port, config) in trunks {
            lines.append(
                namer.shortName(port.name).padded(11) + " "
                    + "on".padded(16) + " "
                    + "802.1q".padded(14) + " "
                    + (port.linkState == .up ? "trunking" : "not-trunking").padded(13) + " "
                    + "\(config.nativeVLAN)"
            )
        }
        lines.append("")
        lines.append("Port        Vlans allowed on trunk")
        for (port, config) in trunks {
            let allowed: String
            if let list = config.allowedVLANs {
                allowed = list.isEmpty ? "none" : VLANListParser.format(list)
            } else {
                allowed = "1-4094"
            }
            lines.append(namer.shortName(port.name).padded(11) + " " + allowed)
        }
        lines.append("")
        lines.append("Port        Vlans allowed and active in management domain")
        for (port, config) in trunks {
            let active = existing.filter { config.allows($0) }
            lines.append(namer.shortName(port.name).padded(11) + " " + (active.isEmpty ? "none" : VLANListParser.format(active)))
        }
        lines.append("")
        lines.append(Notices.trunkStatic)
        return joined(lines)
    }

    /// `show interfaces [X] switchport`: the administrative (configured) fields only.
    func showInterfacesSwitchport(_ command: ParsedCommand) -> String {
        guard let ports = ports(of: command) else { return Notices.virtualInterface }
        var lines: [String] = []
        for port in ports {
            if !lines.isEmpty { lines.append("") }
            lines.append("Name: \(namer.shortName(port.name))")
            guard port.isSwitchport else {
                lines.append("Switchport: Disabled")
                continue
            }
            lines.append("Switchport: Enabled")
            guard let config = port.switchport else {
                lines.append("! \(Notices.customVLANText(singleLine(port.vlanText)))")
                continue
            }
            switch config.mode {
            case .access: lines.append("Administrative Mode: static access")
            case .trunk: lines.append("Administrative Mode: trunk")
            case .unset: lines.append("Administrative Mode: dynamic auto")
            }
            lines.append("Administrative Trunking Encapsulation: dot1q")
            lines.append("Access Mode VLAN: \(config.accessVLAN) (\(vlanName(config.accessVLAN) ?? "Inactive"))")
            lines.append("Trunking Native Mode VLAN: \(config.nativeVLAN) (\(vlanName(config.nativeVLAN) ?? "Inactive"))")
            if let allowed = config.allowedVLANs {
                lines.append("Trunking VLANs Enabled: \(allowed.isEmpty ? "NONE" : VLANListParser.format(allowed))")
            } else {
                lines.append("Trunking VLANs Enabled: ALL")
            }
        }
        return joined(lines)
    }

    func showIPInterfaceBrief(_ command: ParsedCommand) -> String {
        var lines = ["Interface              IP-Address      OK? Method Status                Protocol"]
        for port in access.interfaces {
            let status: String
            switch port.linkState {
            case .adminDown: status = "administratively down"
            case .up: status = "up"
            case .down: status = "down"
            }
            lines.append(
                namer.longName(port.name).padded(22) + " "
                    + "unassigned".padded(15) + " "
                    + "YES unset  "
                    + status.padded(21) + " "
                    + (port.linkState == .up ? "up" : "down")
            )
        }
        lines.append(Notices.noAddresses)
        return joined(lines)
    }

    // MARK: show vlan

    func showVLAN(_ command: ParsedCommand) -> String {
        if isDell { return dellShowVLAN(only: command.int("vlan")) }
        let only = command.int("vlan")
        let rows = vlanRows
        if let only, !rows.contains(where: { $0.id == only }) {
            return "VLAN id \(only) not found in current VLAN database"
        }

        var members: [Int: [String]] = [:]
        var remarks: [String] = []
        for port in access.interfaces where port.isSwitchport {
            let short = namer.shortName(port.name)
            guard let config = port.switchport else {
                remarks.append(Notices.unreadableVLANText(short, singleLine(port.vlanText)))
                continue
            }
            guard config.mode != .trunk else { continue }
            if rows.contains(where: { $0.id == config.accessVLAN }) {
                members[config.accessVLAN, default: []].append(short)
            } else {
                remarks.append(Notices.missingVLAN(short, config.accessVLAN))
            }
        }

        var lines = [
            "",
            "VLAN Name                             Status    Ports",
            "---- -------------------------------- --------- -------------------------------",
        ]
        func append(id: Int, name: String, status: String, ports: [String]) {
            let wrapped = wrap(ports, width: 31)
            let head = "\(id)".padded(4) + " " + name.column(32) + " " + status.padded(9) + " "
            lines.append(head + (wrapped.first ?? ""))
            for extra in wrapped.dropFirst() { lines.append(String(repeating: " ", count: 48) + extra) }
        }
        for row in rows where only == nil || only == row.id {
            append(id: row.id, name: row.name, status: "active", ports: members[row.id] ?? [])
        }
        if dialect == .ios, only == nil {
            // The four fixed legacy VLANs every Catalyst lists.
            let legacy = [(1002, "fddi-default"), (1003, "token-ring-default"), (1004, "fddinet-default"), (1005, "trnet-default")]
            for (id, name) in legacy where !rows.contains(where: { $0.id == id }) {
                append(id: id, name: name, status: "act/unsup", ports: [])
            }
        }
        if only == nil { lines.append(contentsOf: remarks) }
        return joined(lines)
    }

    /// Breaks a comma-separated port list into lines of at most `width` characters.
    func wrap(_ items: [String], width: Int) -> [String] {
        var lines: [String] = []
        var current = ""
        for (index, item) in items.enumerated() {
            let piece = index == items.count - 1 ? item : item + ","
            if current.isEmpty {
                current = piece
            } else if current.count + 1 + piece.count <= width {
                current += " " + piece
            } else {
                lines.append(current)
                current = piece
            }
        }
        if !current.isEmpty { lines.append(current) }
        return lines.map { $0.hasSuffix(",") ? String($0.dropLast()) : $0 }
    }

    // MARK: Neighbors (from the drawn cabling)

    private func cabledNeighbors() -> [(port: PortSnapshot, peer: PeerSnapshot)] {
        access.interfaces.compactMap { port in
            guard port.linkState == .up, let peer = port.peer else { return nil }
            return (port, peer)
        }
    }

    private func peerUsesIOSNames(_ peer: PeerSnapshot) -> Bool {
        CLI.dialect(vendor: peer.vendor, model: peer.model, category: peer.category) == .ios
    }

    private func cdpCapability(_ category: DeviceCategory) -> String {
        switch category {
        case .router: return "R"
        case .switch: return "S"
        case .l3switch: return "R S"
        case .accessPoint: return "T"
        case .pc, .server: return "H"
        }
    }

    func showCDPNeighbors(_ command: ParsedCommand) -> String {
        let neighbors = cabledNeighbors()
        let iosNamer = InterfaceNamer(style: .ios)
        if command.has("detail") {
            var lines = [Notices.neighborsFromDiagram]
            for (port, peer) in neighbors {
                let capability: String
                switch peer.category {
                case .router: capability = "Router"
                case .switch: capability = "Switch"
                case .l3switch: capability = "Router Switch"
                case .accessPoint: capability = "Trans-Bridge"
                case .pc, .server: capability = "Host"
                }
                let remote = peerUsesIOSNames(peer) ? iosNamer.longName(peer.portName) : peer.portName
                lines.append("-------------------------")
                lines.append("Device ID: \(peer.hostname)")
                lines.append("Platform: \(platform(of: peer)),  Capabilities: \(capability)")
                lines.append("Interface: \(namer.longName(port.name)),  Port ID (outgoing port): \(remote)")
            }
            lines.append("")
            lines.append("Total cdp entries displayed : \(neighbors.count)")
            return joined(lines)
        }

        let platforms = neighbors.map { platform(of: $0.peer) }
        let platformWidth = max(8, platforms.map(\.count).max() ?? 0)
        let nameWidth = max(16, neighbors.map(\.peer.hostname.count).max() ?? 0)
        var lines = [
            Notices.neighborsFromDiagram,
            "Capability Codes: R - Router, T - Trans Bridge, S - Switch, H - Host",
            "",
            "Device ID".padded(nameWidth) + " " + "Local Intrfce".padded(17) + " " + "Capability".padded(11) + " "
                + "Platform".padded(platformWidth) + "  Port ID",
        ]
        for (index, neighbor) in neighbors.enumerated() {
            let remote = peerUsesIOSNames(neighbor.peer) ? iosNamer.cdpName(neighbor.peer.portName) : neighbor.peer.portName
            lines.append(
                neighbor.peer.hostname.padded(nameWidth) + " "
                    + namer.cdpName(neighbor.port.name).padded(17) + " "
                    + cdpCapability(neighbor.peer.category).padded(11) + " "
                    + platforms[index].padded(platformWidth) + "  "
                    + remote
            )
        }
        lines.append("")
        lines.append("Total cdp entries displayed : \(neighbors.count)")
        return joined(lines)
    }

    private func platform(of peer: PeerSnapshot) -> String {
        let text = [peer.vendor, peer.model].filter { !$0.isEmpty }.joined(separator: " ")
        return text.isEmpty ? "-" : text
    }

    func showLLDPNeighbors(_ command: ParsedCommand) -> String {
        let neighbors = cabledNeighbors()
        if isDell { return dellLLDPNeighbors(neighbors) }
        let iosNamer = InterfaceNamer(style: .ios)
        let nameWidth = max(19, neighbors.map(\.peer.hostname.count).max() ?? 0)
        var lines = [
            Notices.neighborsFromDiagram,
            "Capability codes:",
            "    (R) Router, (B) Bridge, (W) WLAN Access Point, (S) Station",
            "",
            "Device ID".padded(nameWidth) + " " + "Local Intf".padded(14) + " " + "Capability".padded(15) + " Port ID",
        ]
        for (port, peer) in neighbors {
            let capability: String
            switch peer.category {
            case .router: capability = "R"
            case .switch: capability = "B"
            case .l3switch: capability = "B,R"
            case .accessPoint: capability = "W"
            case .pc, .server: capability = "S"
            }
            let remote = peerUsesIOSNames(peer) ? iosNamer.shortName(peer.portName) : peer.portName
            lines.append(
                peer.hostname.padded(nameWidth) + " " + namer.shortName(port.name).padded(14) + " "
                    + capability.padded(15) + " " + remote
            )
        }
        lines.append("")
        lines.append("Total entries displayed: \(neighbors.count)")
        return joined(lines)
    }

    // MARK: Bundles, version, inventory, history

    func showEtherchannelSummary(_ command: ParsedCommand) -> String {
        let bundles = access.bundles
        var lines = [
            Notices.bundlesFromDiagram,
            "Number of channel-groups in use: \(bundles.count)",
            "",
        ]
        let labelWidth = max(12, bundles.map(\.label.count).max() ?? 0)
        lines.append("Group  " + "Port-channel".padded(labelWidth) + "  Ports")
        lines.append("------+" + String(repeating: "-", count: labelWidth + 1) + "+" + String(repeating: "-", count: 46))
        for (index, bundle) in bundles.enumerated() {
            let local = bundle.localPorts.map { namer.shortName($0) }.joined(separator: " ")
            let remote = bundle.peerPorts.joined(separator: " ")
            lines.append(
                "\(index + 1)".padded(6) + " " + bundle.label.padded(labelWidth) + "  "
                    + local + "  -> \(bundle.peerHostname): \(remote)"
            )
        }
        return joined(lines)
    }

    func showVersion(_ command: ParsedCommand) -> String {
        var lines: [String] = []
        let vendor = access.vendor.isEmpty ? "-" : access.vendor
        let model = access.model.isEmpty ? "-" : access.model
        if isDell {
            lines.append("System Name: \(hostname)")
            lines.append("System Type: \(model)")
            lines.append("Vendor: \(vendor)")
        } else {
            lines.append("\(vendor) \(model)")
            lines.append("Hostname: \(hostname)")
        }
        lines.append("")
        for (word, count) in interfaceCounts() {
            if isDell {
                let label = word.replacingOccurrences(of: "TenGigabitEthernet", with: "Ten GigabitEthernet")
                lines.append("\(count)".leftPadded(4) + " \(label)/IEEE 802.3 interface(s)")
            } else {
                let label: String
                switch word {
                case "GigabitEthernet": label = "Gigabit Ethernet"
                case "TenGigabitEthernet": label = "Ten Gigabit Ethernet"
                case "FortyGigabitEthernet": label = "Forty Gigabit Ethernet"
                default: label = word
                }
                lines.append("\(count) \(label) interface" + (count == 1 ? "" : "s"))
            }
        }
        lines.append("")
        lines.append(Notices.versionStatic)
        return joined(lines)
    }

    /// Interface type words with the number of ports of each, in panel order.
    private func interfaceCounts() -> [(String, Int)] {
        var order: [String] = []
        var counts: [String: Int] = [:]
        for port in access.interfaces {
            let word = namer.typeWord(of: port.name)
            if counts[word] == nil { order.append(word) }
            counts[word, default: 0] += 1
        }
        return order.map { ($0, counts[$0] ?? 0) }
    }

    func showInventory(_ command: ParsedCommand) -> String {
        let description = [access.vendor, access.model].filter { !$0.isEmpty }.joined(separator: " ")
        return joined([
            "NAME: \"\(hostname)\", DESCR: \"\(description)\"",
            "PID: \(access.model.isEmpty ? "-" : access.model)",
            "",
            Notices.versionStatic,
        ])
    }

    func showHistory(_ command: ParsedCommand) -> String {
        history.map { "  " + $0 }.joined(separator: "\n")
    }
}
