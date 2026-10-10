import Foundation
import NetSketchCore

/// A small, accurate subset of the MikroTik RouterOS console.
///
/// Menus: `/interface`, `/interface ethernet`, `/system identity`. Commands: `print`, `set`,
/// `enable`, `disable`, `comment`, `export`, `/quit`, `..` and `/`. Words may be abbreviated
/// to any unique prefix, as on RouterOS. Like the IOS engine it keeps no state of its own:
/// reads come from the project, writes go through `ProjectStore`.
final class RouterOSEngine: ConsoleEngine {
    private let access: DeviceAccess
    private(set) var isClosed = false
    /// The current menu, e.g. ["interface", "ethernet"]; empty at the top level.
    private var path: [String] = []
    private var lastHostname: String

    init(access: DeviceAccess) {
        self.access = access
        self.lastHostname = access.hostname
    }

    // MARK: Menu tree (the single definition used by execution, help and completion)

    private enum Action {
        case print, set, enable, disable, comment, export, quit
    }

    private struct Command {
        let name: String
        let help: String
        let action: Action
    }

    private struct Menu {
        let name: String
        let help: String
        var submenus: [Menu] = []
        var commands: [Command] = []
    }

    private static let itemCommands = [
        Command(name: "print", help: "Print values of item properties", action: .print),
        Command(name: "set", help: "Change item properties", action: .set),
        Command(name: "enable", help: "Enable items", action: .enable),
        Command(name: "disable", help: "Disable items", action: .disable),
        Command(name: "comment", help: "Set comment for items", action: .comment),
        Command(name: "export", help: "Print or save an export script that can be used to restore configuration", action: .export),
    ]

    private static let rootMenu = Menu(
        name: "",
        help: "",
        submenus: [
            Menu(name: "interface", help: "Interface configuration", submenus: [
                Menu(name: "ethernet", help: "Ethernet interface configuration", commands: itemCommands),
            ], commands: itemCommands),
            Menu(name: "system", help: "System information and utilities", submenus: [
                Menu(name: "identity", help: "System identity (the name of the router)", commands: [
                    Command(name: "print", help: "Print values of item properties", action: .print),
                    Command(name: "set", help: "Change item properties", action: .set),
                    Command(name: "export", help: "Print or save an export script that can be used to restore configuration", action: .export),
                ]),
            ]),
        ],
        commands: [
            Command(name: "export", help: "Print or save an export script that can be used to restore configuration", action: .export),
            Command(name: "quit", help: "Quit console", action: .quit),
        ]
    )

    private func menu(at path: [String]) -> Menu {
        var menu = RouterOSEngine.rootMenu
        for name in path {
            guard let next = menu.submenus.first(where: { $0.name == name }) else { break }
            menu = next
        }
        return menu
    }

    /// Exact name first, otherwise a unique prefix.
    private static func resolve<T>(_ word: String, in items: [T], name: (T) -> String) -> T? {
        let lower = word.lowercased()
        if let exact = items.first(where: { name($0) == lower }) { return exact }
        let matches = items.filter { name($0).hasPrefix(lower) }
        return matches.count == 1 ? matches[0] : nil
    }

    // MARK: Banner and prompt

    var hostname: String {
        if let device = access.device { lastHostname = device.hostname }
        return lastHostname
    }

    var banner: String {
        let model = [access.vendor, access.model].filter { !$0.isEmpty }.joined(separator: " ")
        return Notices.banner(hostname: hostname, model: model, dialect: "MikroTik RouterOS", unknownCLI: false)
    }

    /// "[admin@R1] > " at the top level, "[admin@R1] /interface> " inside a menu. The trailing
    /// space is part of the real prompt.
    var prompt: String {
        let location = path.isEmpty ? "" : "/" + path.joined(separator: " ")
        return "[admin@\(hostname)] \(location)> "
    }

    // MARK: Tokens

    private struct Word {
        let text: String
        /// One-based column, as RouterOS reports it.
        let column: Int
    }

    /// Splits a line into words. Quotes and `[ ... ]` keep their spaces; slashes separate
    /// menu names ("/interface/ethernet/print") until the first `key=value` word.
    private static func words(of line: String) -> (words: [Word], absolute: Bool) {
        var result: [Word] = []
        var current = ""
        var start = 1
        var column = 0
        var inQuotes = false
        var depth = 0
        var absolute = false
        var seenContent = false

        func flush() {
            if !current.isEmpty { result.append(Word(text: current, column: start)) }
            current = ""
        }
        for character in line {
            column += 1
            if inQuotes {
                current.append(character)
                if character == "\"" { inQuotes = false }
                continue
            }
            if depth > 0 {
                current.append(character)
                if character == "[" { depth += 1 }
                if character == "]" { depth -= 1 }
                continue
            }
            if character.isWhitespace {
                flush()
                continue
            }
            if character == "/", !current.contains("=") {
                if !seenContent { absolute = true }
                flush()
                seenContent = true
                continue
            }
            if current.isEmpty { start = column }
            seenContent = true
            if character == "\"" { inQuotes = true }
            if character == "[" { depth = 1 }
            current.append(character)
        }
        flush()
        return (result, absolute)
    }

    private static func unquoted(_ text: String) -> String {
        var value = text
        if value.count >= 2, value.hasPrefix("\""), value.hasSuffix("\"") {
            value = String(value.dropFirst().dropLast())
        } else if value.hasPrefix("\"") {
            value = String(value.dropFirst())
        }
        return value.replacingOccurrences(of: "\\\"", with: "\"")
    }

    // MARK: Execution

    func execute(_ line: String) -> String {
        if line.contains(where: \.isNewline) {
            let outputs = line.split(whereSeparator: \.isNewline).map { execute(String($0)) }
            return outputs.filter { !$0.isEmpty }.joined(separator: "\n")
        }
        guard !isClosed else { return "" }
        guard access.exists else {
            isClosed = true
            return Notices.deviceGone
        }
        guard line.count <= CLILimits.maxLineLength else { return Notices.lineTooLong }
        // Ctrl-Z has no meaning on RouterOS; ignore it instead of reporting a bad command.
        if line.contains("\u{1A}") { return "" }

        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty || trimmed.hasPrefix("#") { return "" }
        if trimmed.hasSuffix("?") {
            return help(String(line[..<(line.lastIndex(of: "?") ?? line.endIndex)]))
        }

        let (words, absolute) = RouterOSEngine.words(of: line)
        var location = absolute ? [] : path
        var index = 0
        while index < words.count {
            let word = words[index]
            if word.text == ".." {
                if !location.isEmpty { location.removeLast() }
                index += 1
                continue
            }
            let current = menu(at: location)
            if let submenu = RouterOSEngine.resolve(word.text, in: current.submenus, name: { $0.name }) {
                location.append(submenu.name)
                index += 1
                continue
            }
            if let command = RouterOSEngine.resolve(word.text, in: current.commands, name: { $0.name }) {
                return run(command.action, in: location, arguments: Array(words[(index + 1)...]))
            }
            return "bad command name \(word.text) (line 1 column \(word.column))"
        }
        // Only menu names: that is navigation.
        path = location
        return ""
    }

    private func run(_ action: Action, in location: [String], arguments: [Word]) -> String {
        if action == .quit {
            if let extra = arguments.first { return endOfCommand(extra) }
            isClosed = true
            return ""
        }
        if action == .export {
            if let extra = arguments.first { return endOfCommand(extra) }
            return export(location)
        }
        if location == ["system", "identity"] {
            return action == .print ? printIdentity(arguments) : setIdentity(arguments)
        }
        let ports = items(in: location)
        switch action {
        case .print: return printInterfaces(ports, ethernetMenu: location.last == "ethernet", arguments: arguments)
        case .set: return setItems(ports, arguments: arguments)
        case .enable: return setDisabled(false, ports, arguments: arguments)
        case .disable: return setDisabled(true, ports, arguments: arguments)
        case .comment: return setComment(ports, arguments: arguments)
        case .export, .quit: return ""
        }
    }

    private func endOfCommand(_ word: Word) -> String {
        "expected end of command (line 1 column \(word.column))"
    }

    /// The interfaces a menu lists: all of them in `/interface`, the wired ones in `/interface ethernet`.
    private func items(in location: [String]) -> [PortSnapshot] {
        let all = access.interfaces
        return location.last == "ethernet" ? all.filter { $0.connector != .wireless } : all
    }

    // MARK: /system identity

    private func printIdentity(_ arguments: [Word]) -> String {
        if let extra = arguments.first { return endOfCommand(extra) }
        return "  name: \(hostname)"
    }

    private func setIdentity(_ arguments: [Word]) -> String {
        for word in arguments {
            guard let equals = word.text.firstIndex(of: "="),
                  word.text[..<equals].lowercased() == "name" else { return endOfCommand(word) }
            let name = RouterOSEngine.unquoted(String(word.text[word.text.index(after: equals)...]))
            guard !name.trimmingCharacters(in: .whitespaces).isEmpty else {
                return "NetSketch: název zařízení nesmí být prázdný, nic se nezměnilo."
            }
            access.rename(to: name)
        }
        return ""
    }

    // MARK: /interface

    private func typeName(_ port: PortSnapshot) -> String {
        port.connector == .wireless ? "wlan" : "ether"
    }

    private func printInterfaces(_ ports: [PortSnapshot], ethernetMenu: Bool, arguments: [Word]) -> String {
        if let extra = arguments.first { return endOfCommand(extra) }
        var lines = ["Flags: X - disabled, R - running"]
        lines.append(ethernetMenu ? " #    NAME" : " #    NAME                                TYPE")
        for (index, port) in ports.enumerated() {
            let flags = (port.adminDown ? "X" : (port.linkState == .up ? "R" : " ")) + " "
            let head = "\(index)".leftPadded(2) + " " + flags + " "
            let name = ethernetMenu ? port.name : port.name.padded(35) + " " + typeName(port)
            if port.description.isEmpty {
                lines.append(head + name)
            } else {
                let comment = port.description.split(whereSeparator: \.isNewline).joined(separator: " ")
                lines.append(head + ";;; " + comment)
                lines.append(String(repeating: " ", count: head.count) + name)
            }
        }
        lines.append("NetSketch: příznak R (running) plyne jen z kabeláže v diagramu a z příznaku disabled.")
        return lines.map { $0.trimmingTrailingWhitespace() }.joined(separator: "\n")
    }

    private enum Selection {
        case ports([PortSnapshot])
        case failure(String)
    }

    /// Resolves an item specification: "ether1", "0", "0,2", "ether1,ether2", "[find]",
    /// "[ find default-name=ether1 ]".
    private func select(_ spec: String, from ports: [PortSnapshot]) -> Selection {
        let text = RouterOSEngine.unquoted(spec)
        if text.hasPrefix("[") {
            let inner = text.dropFirst().dropLast(text.hasSuffix("]") ? 1 : 0)
            let parts = inner.split(whereSeparator: { $0.isWhitespace }).map(String.init)
            guard parts.first?.lowercased() == "find" else { return .failure("NetSketch: v hranatých závorkách je podporováno jen [find ...].") }
            var matches = ports
            for condition in parts.dropFirst() {
                let pieces = condition.split(separator: "=", maxSplits: 1).map(String.init)
                guard pieces.count == 2, ["name", "default-name"].contains(pieces[0].lowercased()) else {
                    return .failure("NetSketch: find podporuje jen podmínky name=... a default-name=....")
                }
                let wanted = RouterOSEngine.unquoted(pieces[1]).lowercased()
                matches = matches.filter { $0.name.lowercased() == wanted }
            }
            return .ports(matches)
        }
        var selected: [PortSnapshot] = []
        for piece in text.split(separator: ",", omittingEmptySubsequences: true) {
            let name = piece.trimmingCharacters(in: .whitespaces)
            if !name.isEmpty, name.count <= 6, name.allSatisfy({ $0.isASCII && $0.isNumber }), let number = Int(name) {
                guard ports.indices.contains(number) else { return .failure("no such item") }
                selected.append(ports[number])
            } else if let port = ports.first(where: { $0.name.lowercased() == name.lowercased() }) {
                selected.append(port)
            } else {
                return .failure("input does not match any value of numbers")
            }
        }
        return selected.isEmpty ? .failure("missing value(s) of argument(s) numbers") : .ports(selected)
    }

    /// Splits arguments into the item specification and `key=value` properties.
    private func parse(_ arguments: [Word]) -> (spec: String?, properties: [(key: String, value: String, word: Word)], stray: Word?) {
        var spec: String?
        var properties: [(key: String, value: String, word: Word)] = []
        for word in arguments {
            if !word.text.hasPrefix("["), !word.text.hasPrefix("\""), let equals = word.text.firstIndex(of: "=") {
                let key = word.text[..<equals].lowercased()
                let value = RouterOSEngine.unquoted(String(word.text[word.text.index(after: equals)...]))
                if key == "numbers" { spec = value } else { properties.append((key, value, word)) }
            } else if spec == nil, properties.isEmpty {
                spec = word.text
            } else {
                return (spec, properties, word)
            }
        }
        return (spec, properties, nil)
    }

    /// Ethernet properties RouterOS knows but the diagram has no field for.
    private static let unstoredProperties: Set<String> = [
        "mtu", "l2mtu", "arp", "speed", "auto-negotiation", "full-duplex", "mac-address", "advertise",
        "poe-out", "rx-flow-control", "tx-flow-control", "bandwidth", "mdix-enable", "loop-protect",
    ]

    private func setItems(_ ports: [PortSnapshot], arguments: [Word]) -> String {
        let parsed = parse(arguments)
        if let stray = parsed.stray { return endOfCommand(stray) }
        guard let spec = parsed.spec else { return "missing value(s) of argument(s) numbers" }
        guard case .ports(let selected) = select(spec, from: ports) else {
            if case .failure(let message) = select(spec, from: ports) { return message }
            return ""
        }

        var comment: String?
        var disabled: Bool?
        var notes: [String] = []
        for property in parsed.properties {
            switch property.key {
            case "comment":
                comment = property.value
            case "disabled":
                switch property.value.lowercased() {
                case "yes", "true": disabled = true
                case "no", "false": disabled = false
                default: return "invalid value for argument disabled"
                }
            case "name":
                notes.append("NetSketch: přejmenování portu z CLI není podporováno (název patří k modelu zařízení).")
            case let key where RouterOSEngine.unstoredProperties.contains(key):
                notes.append(Notices.notStored(key))
            default:
                return endOfCommand(property.word)
            }
        }
        access.transaction {
            for port in selected {
                if let comment { access.setDescription(comment, port: port.id) }
                if let disabled { access.setAdminDown(disabled, port: port.id) }
            }
        }
        return notes.joined(separator: "\n")
    }

    private func setDisabled(_ disabled: Bool, _ ports: [PortSnapshot], arguments: [Word]) -> String {
        let parsed = parse(arguments)
        if let stray = parsed.stray { return endOfCommand(stray) }
        if let property = parsed.properties.first { return endOfCommand(property.word) }
        guard let spec = parsed.spec else { return "missing value(s) of argument(s) numbers" }
        switch select(spec, from: ports) {
        case .failure(let message):
            return message
        case .ports(let selected):
            access.transaction { selected.forEach { access.setAdminDown(disabled, port: $0.id) } }
            return ""
        }
    }

    /// `comment ether1 comment="text"` or `comment ether1 "text"`.
    private func setComment(_ ports: [PortSnapshot], arguments: [Word]) -> String {
        guard let first = arguments.first else { return "missing value(s) of argument(s) numbers" }
        var spec = first.text
        var text: String?
        for word in arguments.dropFirst() {
            if text != nil { return endOfCommand(word) }
            if word.text.lowercased().hasPrefix("comment=") {
                text = RouterOSEngine.unquoted(String(word.text.dropFirst("comment=".count)))
            } else {
                text = RouterOSEngine.unquoted(word.text)
            }
        }
        if spec.lowercased().hasPrefix("numbers=") { spec = String(spec.dropFirst("numbers=".count)) }
        guard let text else { return "missing value(s) of argument(s) comment" }
        switch select(spec, from: ports) {
        case .failure(let message):
            return message
        case .ports(let selected):
            access.transaction { selected.forEach { access.setDescription(text, port: $0.id) } }
            return ""
        }
    }

    // MARK: /export

    private static func exportValue(_ value: String) -> String {
        let plain = value.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "-_./:@".contains($0)) }
        if plain, !value.isEmpty { return value }
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "$", with: "\\$")
        return "\"\(escaped)\""
    }

    private func export(_ location: [String]) -> String {
        let model = [access.vendor, access.model].filter { !$0.isEmpty }.joined(separator: " ")
        var lines = ["# NetSketch: export z dat diagramu (\(model)); nic se nesimuluje"]
        let wantsInterfaces = location.isEmpty || location.first == "interface"
        let wantsIdentity = location.isEmpty || location.first == "system"

        if wantsInterfaces {
            func section(_ title: String, _ ports: [PortSnapshot]) {
                var rows: [String] = []
                for port in ports {
                    var properties: [String] = []
                    if !port.description.isEmpty {
                        let comment = port.description.split(whereSeparator: \.isNewline).joined(separator: " ")
                        properties.append("comment=\(RouterOSEngine.exportValue(comment))")
                    }
                    if port.adminDown { properties.append("disabled=yes") }
                    if !properties.isEmpty {
                        rows.append("set [ find default-name=\(port.name) ] " + properties.joined(separator: " "))
                    }
                    let vlan = port.vlanText.split(whereSeparator: \.isNewline).joined(separator: " ")
                    if !vlan.trimmingCharacters(in: .whitespaces).isEmpty {
                        rows.append("# \(port.name): text VLAN z diagramu „\(vlan)“ (VLAN se z konzole RouterOS v NetSketch nenastavují)")
                    }
                }
                if !rows.isEmpty {
                    lines.append(title)
                    lines.append(contentsOf: rows)
                }
            }
            let all = access.interfaces
            section("/interface ethernet", all.filter { $0.connector != .wireless })
            if location.last != "ethernet" {
                section("/interface wireless", all.filter { $0.connector == .wireless })
            }
        }
        if wantsIdentity {
            lines.append("/system identity")
            lines.append("set name=\(RouterOSEngine.exportValue(hostname))")
        }
        return lines.joined(separator: "\n")
    }

    // MARK: Help and completion

    /// The menu a partial line has reached, and the command if one was already typed.
    private func context(of partial: String) -> (menu: Menu, command: Command?, location: [String], lastWord: String)? {
        let (allWords, absolute) = RouterOSEngine.words(of: partial)
        let endsWithSeparator = partial.last.map { $0.isWhitespace || $0 == "/" } ?? true
        let complete = endsWithSeparator ? allWords : Array(allWords.dropLast())
        let lastWord = endsWithSeparator ? "" : (allWords.last?.text ?? "")
        var location = absolute ? [] : path
        var command: Command?
        for word in complete {
            if command != nil { continue }
            if word.text == ".." {
                if !location.isEmpty { location.removeLast() }
                continue
            }
            let current = menu(at: location)
            if let submenu = RouterOSEngine.resolve(word.text, in: current.submenus, name: { $0.name }) {
                location.append(submenu.name)
            } else if let found = RouterOSEngine.resolve(word.text, in: current.commands, name: { $0.name }) {
                command = found
            } else {
                return nil
            }
        }
        return (menu(at: location), command, location, lastWord)
    }

    /// Words that may follow: (word, description).
    private func candidates(for partial: String) -> [(String, String)]? {
        guard let context = context(of: partial) else { return nil }
        var entries: [(String, String)] = []
        if let command = context.command {
            let identity = context.location == ["system", "identity"]
            switch command.action {
            case .set where identity:
                entries.append(("name=", "Name of the router"))
            case .set, .comment:
                entries.append(contentsOf: items(in: context.location).map { ($0.name, "Interface") })
                entries.append(("comment=", "Short description of the item"))
                if command.action == .set { entries.append(("disabled=", "Defines whether item is ignored or used (yes | no)")) }
            case .enable, .disable:
                entries.append(contentsOf: items(in: context.location).map { ($0.name, "Interface") })
            case .print, .export, .quit:
                break
            }
        } else {
            if !context.location.isEmpty { entries.append(("..", "Go up to the parent menu")) }
            entries.append(contentsOf: context.menu.submenus.map { ($0.name, $0.help) })
            entries.append(contentsOf: context.menu.commands.map { ($0.name, $0.help) })
        }
        let prefix = context.lastWord.lowercased()
        return entries.filter { prefix.isEmpty || $0.0.lowercased().hasPrefix(prefix) }
    }

    func help(_ partial: String) -> String {
        guard access.exists, !isClosed, partial.count <= CLILimits.maxLineLength else { return "" }
        guard let entries = candidates(for: partial) else { return "NetSketch: k tomuto vstupu není nápověda (neznámý příkaz)." }
        return entries.map { $0.1.isEmpty ? $0.0 : "\($0.0) -- \($0.1)" }.joined(separator: "\n")
    }

    func complete(_ partial: String) -> [String] {
        guard access.exists, !isClosed, partial.count <= CLILimits.maxLineLength else { return [] }
        return (candidates(for: partial) ?? []).map(\.0).filter { $0 != ".." }
    }
}
