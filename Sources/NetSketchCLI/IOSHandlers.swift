import Foundation
import NetSketchCore

// Handlers of the configuration commands. Each one maps a command onto `ProjectStore`
// operations (through `DeviceAccess`); one command is one undo step.

extension IOSEngine {
    // MARK: EXEC

    func enterPrivileged() -> String {
        if case .userExec = mode { mode = .privilegedExec }
        return ""
    }

    func leavePrivileged() -> String {
        if case .privilegedExec = mode { mode = .userExec }
        return ""
    }

    func enterGlobalConfig() -> String {
        mode = .globalConfig
        return isDell ? "" : "Enter configuration commands, one per line.  End with CNTL/Z."
    }

    func endConfig() -> String {
        mode = .privilegedExec
        return ""
    }

    func exitCommand() -> String {
        exitOneLevel()
        return ""
    }

    // MARK: Global configuration

    func setHostname(_ command: ParsedCommand) -> String {
        guard let name = command.text("name") else { return "" }
        access.rename(to: name)
        return ""
    }

    func resetHostname() -> String {
        let fallback: String
        if isDell {
            fallback = "Dell"
        } else {
            fallback = access.category == .router ? "Router" : "Switch"
        }
        access.rename(to: fallback)
        return ""
    }

    func enterInterface(_ command: ParsedCommand) -> String {
        guard let selection = command.interfaces("interface") else { return "" }
        switch selection.target {
        case .ports:
            mode = .interface(selection)
            return ""
        case .vlan(let id) where !isDell:
            // IOS: the switch virtual interface of a switch; routers have none in the diagram.
            guard let category = access.category, NetworkSimulator.isSwitching(category) else {
                return Notices.virtualInterface
            }
            mode = .vlanInterface(id)
            return ""
        case .vlan(let id):
            if id != 1, !access.vlans.contains(where: { $0.id == id }) {
                access.setVLANs(access.vlans + [VLANEntry(id: id)])
            }
            mode = .vlanInterface(id)
            return ""
        case .portChannel:
            return Notices.lagIsDrawn
        case .loopback:
            return Notices.virtualInterface
        }
    }

    /// `no interface X`: on Dell `no interface vlan N` deletes the VLAN.
    func removeInterface(_ command: ParsedCommand) -> String {
        guard let selection = command.interfaces("interface") else { return "" }
        switch selection.target {
        case .vlan(let id) where isDell:
            return dellDeleteVLAN(id)
        case .ports:
            return "NetSketch: fyzický port nelze z CLI odstranit, patří k modelu zařízení. Nic se nezměnilo."
        case .portChannel:
            return Notices.lagIsDrawn
        default:
            return Notices.virtualInterface
        }
    }

    /// `default interface X`: back to an unconfigured port.
    func defaultInterface(_ command: ParsedCommand) -> String {
        guard let selection = command.interfaces("interface"), case .ports(let ids) = selection.target else {
            return Notices.virtualInterface
        }
        let ports = access.interfaces.filter { ids.contains($0.id) }
        access.transaction {
            for port in ports {
                access.setDescription("", port: port.id)
                access.setVLANText("", port: port.id)
                access.setAdminDown(false, port: port.id)
            }
        }
        return ports.map { "Interface \(namer.longName($0.name)) set to default configuration" }.joined(separator: "\n")
    }

    func enterLine(_ command: ParsedCommand) -> String {
        let rest = (command.text("rest") ?? "").lowercased()
        let kind = rest.hasPrefix("v") ? "vty" : (rest.hasPrefix("a") ? "aux" : "console")
        mode = .line(kind)
        return Notices.lineMode
    }

    /// `banner motd #text#`: the text may continue on following lines until the delimiter.
    func bannerCommand(_ command: ParsedCommand) -> String {
        let words = (command.text("rest") ?? "").split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        let kinds = ["motd", "login", "exec", "incoming"]
        var text = command.text("rest") ?? ""
        if let first = words.first, kinds.contains(where: { $0.hasPrefix(first.lowercased()) }) {
            text = words.count > 1 ? String(words[1]) : ""
        }
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard let delimiter = trimmed.first else { return isDell ? "% Error: Incomplete command." : "% Incomplete command." }
        if trimmed.dropFirst().contains(delimiter) { return Notices.bannerNotStored }
        beginBanner(until: delimiter)
        return "Enter TEXT message.  End with the character '\(delimiter)'."
    }

    // MARK: VLAN database (IOS)

    private func isFixedVLAN(_ id: Int) -> Bool {
        id == 1 || (dialect == .ios && (1002...1005).contains(id))
    }

    func enterVLANConfig(_ command: ParsedCommand) -> String {
        guard let ids = command.intList("vlans") else { return "" }
        let existing = Set(access.vlans.map(\.id))
        let missing = ids.filter { !isFixedVLAN($0) && !existing.contains($0) }
        if !missing.isEmpty { access.setVLANs(access.vlans + missing.map { VLANEntry(id: $0) }) }
        mode = .vlan(ids)
        return ""
    }

    func deleteVLANs(_ command: ParsedCommand) -> String {
        guard let ids = command.intList("vlans") else { return "" }
        var messages: [String] = []
        for id in ids where isFixedVLAN(id) { messages.append("%Default VLAN \(id) may not be deleted.") }
        let doomed = Set(ids.filter { !isFixedVLAN($0) })
        let remaining = access.vlans.filter { !doomed.contains($0.id) }
        if remaining.count != access.vlans.count { access.setVLANs(remaining) }
        return messages.joined(separator: "\n")
    }

    func setVLANName(_ command: ParsedCommand) -> String {
        renameVLAN(to: command.text("name") ?? "")
    }

    func resetVLANName() -> String {
        renameVLAN(to: "")
    }

    private func renameVLAN(to name: String) -> String {
        let id: Int
        switch mode {
        case .vlan(let ids):
            guard ids.count == 1 else { return Notices.singleVLANOnly }
            id = ids[0]
            if isFixedVLAN(id) { return "%Default VLAN \(id) may not have its name changed." }
        case .vlanInterface(let vlan):
            id = vlan
        default:
            return ""
        }
        var table = access.vlans
        if let index = table.firstIndex(where: { $0.id == id }) {
            table[index].name = name
        } else {
            // The VLAN was removed elsewhere while this mode was open (or is the Dell default VLAN).
            table.append(VLANEntry(id: id, name: name))
        }
        access.setVLANs(table)
        return ""
    }

    // MARK: Interface configuration

    /// Runs `body` for the ports of the current interface mode as one undo step.
    private func withSelectedPorts(_ body: ([PortSnapshot]) -> [String]) -> String {
        let ports = selectedPorts()
        guard !ports.isEmpty else {
            mode = .globalConfig
            return Notices.interfaceGone
        }
        var messages: [String] = []
        access.transaction { messages = body(ports) }
        return messages.joined(separator: "\n")
    }

    func setDescription(_ command: ParsedCommand) -> String {
        let text = command.text("text") ?? ""
        return withSelectedPorts { ports in
            ports.forEach { access.setDescription(text, port: $0.id) }
            return []
        }
    }

    func clearDescription() -> String {
        withSelectedPorts { ports in
            ports.forEach { access.setDescription("", port: $0.id) }
            return []
        }
    }

    func setShutdown(_ down: Bool) -> String {
        withSelectedPorts { ports in
            ports.forEach { access.setAdminDown(down, port: $0.id) }
            return []
        }
    }

    /// Applies a change to the switchport configuration of every selected port.
    /// `ensuringVLAN` creates a missing access VLAN first, with the IOS message.
    func updateSwitchport(ensuringVLAN: Int? = nil, _ change: @escaping (inout SwitchportConfig) -> Void) -> String {
        withSelectedPorts { ports in
            var messages: [String] = []
            if let vlan = ensuringVLAN, vlan != 1, !access.vlans.contains(where: { $0.id == vlan }),
               ports.contains(where: \.isSwitchport) {
                messages.append("% Access VLAN does not exist. Creating vlan \(vlan)")
                access.setVLANs(access.vlans + [VLANEntry(id: vlan)])
            }
            var managementNoted = false
            for port in ports {
                guard port.isSwitchport else {
                    if !managementNoted { messages.append(Notices.managementPort) }
                    managementNoted = true
                    continue
                }
                var config = SwitchportConfig()
                if let parsed = port.switchport {
                    config = parsed
                } else {
                    messages.append(Notices.replacedVLANText(namer.shortName(port.name), singleLine(port.vlanText)))
                }
                change(&config)
                access.setVLANText(config.canonicalText, port: port.id)
            }
            return messages
        }
    }

    func setSwitchportMode(_ mode: SwitchportConfig.Mode) -> String {
        updateSwitchport { $0.mode = mode }
    }

    func setAccessVLAN(_ command: ParsedCommand) -> String {
        guard let vlan = command.int("vlan") else { return "" }
        return updateSwitchport(ensuringVLAN: vlan) { $0.accessVLAN = vlan }
    }

    func setNativeVLAN(_ command: ParsedCommand) -> String {
        guard let vlan = command.int("vlan") else { return "" }
        return updateSwitchport { $0.nativeVLAN = vlan }
    }

    enum AllowedChange {
        case replace, add, remove, except, all, none
    }

    func setAllowedVLANs(_ kind: AllowedChange, _ command: ParsedCommand) -> String {
        let list = command.intList("vlans") ?? []
        let everything = Array(SwitchportConfig.allVLANs)
        return updateSwitchport { config in
            switch kind {
            case .replace:
                config.allowedVLANs = list
            case .add:
                if let current = config.allowedVLANs { config.allowedVLANs = Array(Set(current + list)).sorted() }
            case .remove:
                let doomed = Set(list)
                config.allowedVLANs = (config.allowedVLANs ?? everything).filter { !doomed.contains($0) }
            case .except:
                let doomed = Set(list)
                config.allowedVLANs = everything.filter { !doomed.contains($0) }
            case .all:
                config.allowedVLANs = nil
            case .none:
                config.allowedVLANs = []
            }
            if config.allowedVLANs?.count == everything.count { config.allowedVLANs = nil }
        }
    }

    // MARK: Dell OS9 VLAN interfaces

    func dellDeleteVLAN(_ id: Int) -> String {
        guard id != 1 else { return "NetSketch: výchozí VLAN 1 nelze smazat. Nic se nezměnilo." }
        let defined = dellVLANRows.map(\.id)
        access.transaction {
            for port in access.interfaces where port.isSwitchport {
                guard var config = port.switchport else { continue }
                let before = config
                DellMembership.removeUntagged(&config, vlan: id)
                if DellMembership.isTagged(config, in: id) {
                    DellMembership.removeTagged(&config, vlan: id, definedVLANs: defined)
                }
                if config != before { access.setVLANText(config.canonicalText, port: port.id) }
            }
            access.setVLANs(access.vlans.filter { $0.id != id })
        }
        if case .vlanInterface(let current) = mode, current == id { mode = .globalConfig }
        return ""
    }

    enum DellMembershipChange {
        case tagged, untagged, noTagged, noUntagged
    }

    /// `tagged X`, `untagged X` and their `no` forms inside `interface vlan N`.
    func dellChangeMembership(_ change: DellMembershipChange, _ command: ParsedCommand) -> String {
        guard case .vlanInterface(let vlan) = mode,
              let selection = command.interfaces("interface"), case .ports(let ids) = selection.target else {
            return Notices.virtualInterface
        }
        if change == .tagged, vlan == 1 {
            return "NetSketch: výchozí VLAN 1 nemá na Dell OS9 tagované členy. Nic se nezměnilo."
        }
        let live = access.interfaces
        let ports = ids.compactMap { id in live.first { $0.id == id } }
        let defined = dellVLANRows.map(\.id)
        var messages: [String] = []
        access.transaction {
            for port in ports {
                guard port.isSwitchport else {
                    messages.append(Notices.managementPort)
                    continue
                }
                var config = SwitchportConfig()
                if let parsed = port.switchport {
                    config = parsed
                } else {
                    messages.append(Notices.replacedVLANText(namer.shortName(port.name), singleLine(port.vlanText)))
                }
                switch change {
                case .tagged: DellMembership.addTagged(&config, vlan: vlan)
                case .untagged: DellMembership.addUntagged(&config, vlan: vlan)
                case .noTagged: DellMembership.removeTagged(&config, vlan: vlan, definedVLANs: defined)
                case .noUntagged: DellMembership.removeUntagged(&config, vlan: vlan)
                }
                access.setVLANText(config.canonicalText, port: port.id)
            }
        }
        return messages.joined(separator: "\n")
    }
}
