import Foundation
import NetSketchCore

/// A small, accurate subset of the MikroTik RouterOS console.
///
/// Menus: `/interface`, `/interface ethernet`, `/ip address`, `/ip route`, `/system identity`.
/// Commands: `print`, `set`, `enable`, `disable`, `comment`, `add`, `remove`, `export`, `/ping`,
/// `/quit`, `..` and `/`. Words and argument names may be abbreviated to any unique prefix, as
/// on RouterOS. Like the IOS engine it keeps no state of its own: reads come from the project,
/// writes go through `ProjectStore`; `/ping` asks the network simulation.
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
        case print, set, enable, disable, comment, add, remove, export, ping, quit
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

    private static let exportCommand =
        Command(name: "export", help: "Print or save an export script that can be used to restore configuration", action: .export)

    private static let itemCommands = [
        Command(name: "print", help: "Print values of item properties", action: .print),
        Command(name: "set", help: "Change item properties", action: .set),
        Command(name: "enable", help: "Enable items", action: .enable),
        Command(name: "disable", help: "Disable items", action: .disable),
        Command(name: "comment", help: "Set comment for items", action: .comment),
        exportCommand,
    ]

    /// Commands of the list menus `/ip address` and `/ip route`.
    private static let listCommands = [
        Command(name: "add", help: "Create a new item", action: .add),
        Command(name: "print", help: "Print values of item properties", action: .print),
        Command(name: "remove", help: "Remove item", action: .remove),
        exportCommand,
    ]

    private static let addressMenu = ["ip", "address"]
    private static let routeMenu = ["ip", "route"]

    private static let rootMenu = Menu(
        name: "",
        help: "",
        submenus: [
            Menu(name: "interface", help: "Interface configuration", submenus: [
                Menu(name: "ethernet", help: "Ethernet interface configuration", commands: itemCommands),
            ], commands: itemCommands),
            Menu(name: "ip", help: "IP options", submenus: [
                Menu(name: "address", help: "Address management", commands: listCommands),
                Menu(name: "route", help: "Route management", commands: listCommands),
            ], commands: [exportCommand]),
            Menu(name: "system", help: "System information and utilities", submenus: [
                Menu(name: "identity", help: "System identity (the name of the router)", commands: [
                    Command(name: "print", help: "Print values of item properties", action: .print),
                    Command(name: "set", help: "Change item properties", action: .set),
                    exportCommand,
                ]),
            ]),
        ],
        commands: [
            exportCommand,
            Command(name: "ping", help: "Send ICMP Echo packets", action: .ping),
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
        if action == .ping { return ping(arguments) }
        if location == ["system", "identity"] {
            return action == .print ? printIdentity(arguments) : setIdentity(arguments)
        }
        if location == RouterOSEngine.addressMenu {
            switch action {
            case .add: return addAddress(arguments)
            case .remove: return removeAddresses(arguments)
            default: return printAddresses(arguments)
            }
        }
        if location == RouterOSEngine.routeMenu {
            switch action {
            case .add: return addRoute(arguments)
            case .remove: return removeRoutes(arguments)
            default: return printRoutes(arguments)
            }
        }
        let ports = items(in: location)
        switch action {
        case .print: return printInterfaces(ports, ethernetMenu: location.last == "ethernet", arguments: arguments)
        case .set: return setItems(ports, arguments: arguments)
        case .enable: return setDisabled(false, ports, arguments: arguments)
        case .disable: return setDisabled(true, ports, arguments: arguments)
        case .comment: return setComment(ports, arguments: arguments)
        case .add, .remove, .export, .ping, .quit: return ""
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

    // MARK: Arguments of add, remove and ping

    private enum NamedArguments {
        case values([String: String])
        case failure(String)
    }

    /// `key=value` arguments; keys may be abbreviated to a unique prefix, as on RouterOS. A bare
    /// word is the value of `positional` (`/ping 10.0.0.1`) when the command has one.
    private func namedArguments(_ arguments: [Word], keys: [String], positional: String? = nil) -> NamedArguments {
        var values: [String: String] = [:]
        for word in arguments {
            if !word.text.hasPrefix("\""), let equals = word.text.firstIndex(of: "=") {
                let key = String(word.text[..<equals])
                guard !key.isEmpty, let name = RouterOSEngine.resolve(key, in: keys, name: { $0 }) else {
                    return .failure(endOfCommand(word))
                }
                values[name] = RouterOSEngine.unquoted(String(word.text[word.text.index(after: equals)...]))
            } else if let positional, values[positional] == nil {
                values[positional] = RouterOSEngine.unquoted(word.text)
            } else {
                return .failure(endOfCommand(word))
            }
        }
        return .values(values)
    }

    private enum ItemNumbers {
        case items([Int])
        case failure(String)
    }

    /// The items of `remove` in a list of `count` rows: "0", "0,2", "numbers=1" or "[find]"
    /// (all), numbered as `print` shows them.
    private func itemNumbers(_ arguments: [Word], count: Int) -> ItemNumbers {
        let parsed = parse(arguments)
        if let stray = parsed.stray { return .failure(endOfCommand(stray)) }
        if let property = parsed.properties.first { return .failure(endOfCommand(property.word)) }
        guard let spec = parsed.spec else { return .failure("missing value(s) of argument(s) numbers") }
        let text = RouterOSEngine.unquoted(spec)
        if text.hasPrefix("[") {
            let inner = text.dropFirst().dropLast(text.hasSuffix("]") ? 1 : 0)
            guard inner.split(whereSeparator: { $0.isWhitespace }).map({ $0.lowercased() }) == ["find"] else {
                return .failure("NetSketch: zde je podporováno jen [find] bez podmínek; použijte čísla z příkazu print.")
            }
            return .items(Array(0..<count))
        }
        var selected: [Int] = []
        for piece in text.split(separator: ",", omittingEmptySubsequences: true) {
            let item = piece.trimmingCharacters(in: .whitespaces)
            guard !item.isEmpty, item.count <= 6, item.allSatisfy({ $0.isASCII && $0.isNumber }), let number = Int(item) else {
                return .failure("input does not match any value of numbers")
            }
            guard number < count else { return .failure("no such item") }
            if !selected.contains(number) { selected.append(number) }
        }
        return selected.isEmpty ? .failure("missing value(s) of argument(s) numbers") : .items(selected)
    }

    // MARK: /ip address

    /// True on a switch (CRS): its ports are bridged, so the address belongs to the bridge.
    private var isSwitch: Bool {
        access.category.map { NetworkSimulator.isSwitching($0) } ?? false
    }

    /// The RouterOS name of a layer-3 interface ("ether2", "bridge"); nil when it is gone.
    private func interfaceName(of interface: L3InterfaceID) -> String? {
        switch interface {
        case .port(let id): return access.device?.port(id: id)?.name
        case .vlan(let number): return isSwitch ? (number == 1 ? "bridge" : "vlan\(number)") : nil
        }
    }

    /// The names `interface=` accepts: the bridge (and management ports) of a switch, every port of a router.
    private var addressInterfaceNames: [String] {
        let ports = access.interfaces
        guard isSwitch else { return ports.map(\.name) }
        return ["bridge"] + ports.filter { $0.connector == .mgmt }.map(\.name)
    }

    private enum InterfaceLookup {
        case found(L3InterfaceID, String)
        case failure(String)
    }

    /// Resolves `interface=`: a port name (any case), or `bridge`/`bridge1` on a switch, where
    /// the bridge stands for VLAN 1 of the simulation.
    private func l3Interface(named text: String) -> InterfaceLookup {
        let lower = text.lowercased()
        let noSuchInterface = "input does not match any value of interface"
        if lower == "bridge" || lower == "bridge1" {
            guard isSwitch else {
                return .failure(noSuchInterface
                    + "\nNetSketch: router v NetSketch nemá bridge, adresu nastavte přímo na port (např. interface=ether2).")
            }
            return .found(.vlan(1), "bridge")
        }
        guard let port = access.interfaces.first(where: { $0.name.lowercased() == lower }) else {
            return .failure(noSuchInterface)
        }
        if isSwitch, port.connector != .mgmt {
            return .failure("NetSketch: na přepínači nastavte adresu na interface=bridge.")
        }
        return .found(.port(port.id), port.name)
    }

    /// `add address=A.B.C.D/NN interface=NAME`.
    ///
    /// Simplification: NetSketch keeps one address per interface, so a second `add` on the same
    /// interface replaces the first one (RouterOS would keep both); a notice says so.
    private func addAddress(_ arguments: [Word]) -> String {
        let values: [String: String]
        switch namedArguments(arguments, keys: ["address", "interface"]) {
        case .failure(let message): return message
        case .values(let found): values = found
        }
        guard let text = values["address"] else { return "missing value(s) of argument(s) address" }
        guard let interfaceText = values["interface"] else { return "missing value(s) of argument(s) interface" }

        var notes: [String] = []
        let prefix: IPv4Prefix
        if let parsed = IPv4Prefix(cidr: text) {
            prefix = parsed
        } else if let host = IPv4(text) {
            // RouterOS takes an address without a prefix length as /32.
            prefix = IPv4Prefix(address: host, length: 32)
            notes.append("NetSketch: adresa bez délky prefixu se uloží jako /32 (jako na RouterOS); síť zadejte např. jako \(host)/24.")
        } else {
            return "invalid value for argument address"
        }
        guard prefix.isHostAddress else {
            return "invalid value for argument address\nNetSketch: \(prefix.address) je adresa sítě nebo broadcast "
                + "sítě \(prefix.networkPrefix), zadejte adresu hostitele."
        }

        let interface: L3InterfaceID
        let name: String
        switch l3Interface(named: interfaceText) {
        case .failure(let message): return message
        case .found(let found, let foundName):
            interface = found
            name = foundName
        }
        if let previous = access.addresses.first(where: { $0.interface == interface }) {
            if previous.address == prefix.description { return "failure: already have such address" }
            notes.append("NetSketch: rozhraní \(name) má v NetSketch jen jednu adresu, původní \(previous.address) byla nahrazena.")
        }
        if let other = access.addressConflict(prefix.address, except: interface) {
            notes.append("NetSketch: pozor, adresa \(prefix.address) je už nastavena na zařízení \(other).")
        }
        access.setAddress(prefix, on: interface)
        return notes.joined(separator: "\n")
    }

    /// Rows in the order of the device's addresses; that order also numbers `remove`.
    private func printAddresses(_ arguments: [Word]) -> String {
        if let extra = arguments.first { return endOfCommand(extra) }
        var lines = ["Flags: X - disabled, I - invalid, D - dynamic", " #   ADDRESS            NETWORK         INTERFACE"]
        for (index, entry) in access.addresses.enumerated() {
            let name = interfaceName(of: entry.interface)
            let network = IPv4Prefix(cidr: entry.address)?.network.description
            // I (invalid): the interface no longer exists or the stored text is not an address.
            let flag = name == nil || network == nil ? "I" : " "
            let columns = ["\(index)".leftPadded(2), flag, entry.address.padded(18), (network ?? "").padded(15), name ?? "unknown"]
            lines.append(columns.joined(separator: " "))
        }
        return lines.map { $0.trimmingTrailingWhitespace() }.joined(separator: "\n")
    }

    private func removeAddresses(_ arguments: [Word]) -> String {
        let entries = access.addresses
        switch itemNumbers(arguments, count: entries.count) {
        case .failure(let message):
            return message
        case .items(let selected):
            access.transaction { selected.forEach { access.setAddress(nil, on: entries[$0].interface) } }
            return ""
        }
    }

    // MARK: /ip route

    /// One row of `/ip route print`.
    private struct RouteRow {
        enum Source: Equatable {
            /// A connected network (dynamic): goes away with its address.
            case connected
            /// `staticRoutes[index]` of the device.
            case stored(Int)
            /// The device's default gateway (set outside RouterOS), shown as a static default route.
            case defaultGateway
        }

        /// "ADC", "A S" or "  S" (inactive static route).
        let flags: String
        let destination: String
        let preferredSource: String
        let gateway: String
        let distance: Int
        let source: Source
    }

    /// The routing table of the simulation without the local /32 routes, then the stored static
    /// routes that are not active (their gateway is not on a connected network).
    private func routeRows() -> [RouteRow] {
        let stored = access.staticRoutes
        var used = Set<Int>()
        var rows: [RouteRow] = []
        for route in access.simulator.routes(of: access.deviceID) {
            switch route.kind {
            case .local:
                continue
            case .connected:
                rows.append(RouteRow(flags: "ADC", destination: route.destination.description,
                                     preferredSource: route.interface.prefix.address.description,
                                     gateway: interfaceName(of: route.interface.id) ?? route.interface.name,
                                     distance: 0, source: .connected))
            case .staticRoute:
                guard let hop = route.nextHop else { continue }
                let index = stored.indices.first { candidate in
                    !used.contains(candidate) && IPv4(stored[candidate].nextHop) == hop
                        && IPv4Prefix(cidr: stored[candidate].destination)?.networkPrefix == route.destination
                }
                let source: RouteRow.Source
                if let index {
                    used.insert(index)
                    source = .stored(index)
                } else {
                    source = .defaultGateway
                }
                rows.append(RouteRow(flags: "A S", destination: route.destination.description, preferredSource: "",
                                     gateway: hop.description, distance: 1, source: source))
            }
        }
        for (index, route) in stored.enumerated() where !used.contains(index) {
            rows.append(RouteRow(flags: "  S", destination: route.destination, preferredSource: "",
                                 gateway: route.nextHop, distance: 1, source: .stored(index)))
        }
        return rows
    }

    /// `add [dst-address=A.B.C.D/NN] gateway=A.B.C.D`; the destination defaults to 0.0.0.0/0.
    /// A route whose gateway is not on a connected network yet is stored all the same (the
    /// addresses may come later), with a notice.
    private func addRoute(_ arguments: [Word]) -> String {
        let values: [String: String]
        switch namedArguments(arguments, keys: ["dst-address", "gateway"]) {
        case .failure(let message): return message
        case .values(let found): values = found
        }
        guard let gatewayText = values["gateway"] else { return "missing value(s) of argument(s) gateway" }
        let destinationText = values["dst-address"] ?? "0.0.0.0/0"
        guard let destination = IPv4Prefix(cidr: destinationText)
                ?? IPv4(destinationText).map({ IPv4Prefix(address: $0, length: 32) }) else {
            return "invalid value for argument dst-address"
        }
        guard let gateway = IPv4(gatewayText) else {
            let lower = gatewayText.lowercased()
            guard lower.hasPrefix("bridge") || access.interfaces.contains(where: { $0.name.lowercased() == lower }) else {
                return "invalid value for argument gateway"
            }
            return "invalid value for argument gateway\n"
                + "NetSketch: bránu zadejte jako IP adresu sousedního routeru (rozhraní jako brána se nemodeluje)."
        }
        let route = StaticRoute(destination: destination.networkPrefix.description, nextHop: gateway.description)
        let routes = access.staticRoutes
        guard !routes.contains(route) else { return "failure: already have such route" }
        access.setStaticRoutes(routes + [route])
        let connected = access.simulator.interfaces(of: access.deviceID).contains { $0.prefix.contains(gateway) }
        return connected ? ""
            : "NetSketch: trasa je uložena, ale zatím není aktivní – brána \(gateway) neleží v žádné připojené síti "
                + "(adresa na zapojeném rozhraní)."
    }

    private func printRoutes(_ arguments: [Word]) -> String {
        if let extra = arguments.first { return endOfCommand(extra) }
        let rows = routeRows()
        var lines = [
            "Flags: X - disabled, A - active, D - dynamic, C - connect, S - static",
            " #      DST-ADDRESS        PREF-SRC        GATEWAY            DISTANCE",
        ]
        for (index, row) in rows.enumerated() {
            // The flags column is three wide and followed by two spaces.
            let columns = [
                "\(index)".leftPadded(2), row.flags.padded(3) + " ", row.destination.padded(18),
                row.preferredSource.padded(15), row.gateway.padded(18), "\(row.distance)".leftPadded(8),
            ]
            lines.append(columns.joined(separator: " "))
        }
        if rows.contains(where: { !$0.flags.hasPrefix("A") }) {
            lines.append("NetSketch: trasa bez příznaku A není aktivní – její brána neleží v žádné připojené síti.")
        }
        return lines.map { $0.trimmingTrailingWhitespace() }.joined(separator: "\n")
    }

    /// Removes static routes by their number in `print`. Connected routes are refused (as
    /// dynamic routes on RouterOS); nothing is removed then.
    private func removeRoutes(_ arguments: [Word]) -> String {
        let rows = routeRows()
        let sources: [RouteRow.Source]
        switch itemNumbers(arguments, count: rows.count) {
        case .failure(let message): return message
        case .items(let selected): sources = selected.map { rows[$0].source }
        }
        guard !sources.contains(.connected) else {
            return "failure: cannot remove dynamic route\n"
                + "NetSketch: připojená síť (příznak C) zmizí odebráním adresy v /ip address."
        }
        var removed = Set<Int>()
        for case .stored(let index) in sources { removed.insert(index) }
        let remaining = access.staticRoutes.enumerated().filter { !removed.contains($0.offset) }.map { $0.element }
        access.transaction {
            if !removed.isEmpty { access.setStaticRoutes(remaining) }
            if sources.contains(.defaultGateway) { access.setDefaultGateway(nil) }
        }
        return ""
    }

    // MARK: /ping

    private static let maxPingCount = 20

    /// `/ping A.B.C.D [count=N]` or `/ping address=A.B.C.D`: echo requests through the network
    /// simulation. Only reachability is simulated, so every reply takes 0ms.
    private func ping(_ arguments: [Word]) -> String {
        let values: [String: String]
        switch namedArguments(arguments, keys: ["address", "count"], positional: "address") {
        case .failure(let message): return message
        case .values(let found): values = found
        }
        guard let text = values["address"] else { return "missing value(s) of argument(s) address" }
        guard let destination = IPv4(text) else { return "invalid value for argument address" }
        var count = 4
        var notes: [String] = []
        if let countText = values["count"] {
            guard !countText.isEmpty, countText.count <= 6, countText.allSatisfy({ $0.isASCII && $0.isNumber }),
                  let value = Int(countText), value > 0 else { return "invalid value for argument count" }
            count = min(value, RouterOSEngine.maxPingCount)
            if value > count { notes.append("NetSketch: odesláno jen \(count) paketů (víc NetSketch neposílá).") }
        }

        let simulator = access.simulator
        let result = simulator.ping(from: access.deviceID, to: destination)
        // Every router on the way back lowers the TTL of the reply by one.
        let ttl = max(1, 64 - max(0, result.hopCount - 1))
        let host = destination.description.padded(40)
        var lines = ["  SEQ HOST                                     SIZE TTL TIME       STATUS"]
        for sequence in 0..<count {
            let head = "\(sequence)".leftPadded(5) + " " + host
            if result.success {
                lines.append([head, "56".leftPadded(4), "\(ttl)".leftPadded(3), "0ms"].joined(separator: " "))
            } else {
                lines.append(head + String(repeating: " ", count: 19) + "timeout")
            }
        }
        if result.success {
            lines.append("    sent=\(count) received=\(count) packet-loss=0% min-rtt=0ms avg-rtt=0ms max-rtt=0ms")
        } else {
            lines.append("    sent=\(count) received=0 packet-loss=100%")
            let reason = simulator.explain(result)
            if !reason.isEmpty { lines.append(reason) }
        }
        lines.append(contentsOf: notes)
        return lines.joined(separator: "\n")
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
        // `/ip export` writes both sections, `/ip address export` and `/ip route export` one each.
        let wantsIP = location.isEmpty || location.first == "ip"
        if wantsIP, location.last != "route", !access.addresses.isEmpty {
            lines.append("/ip address")
            for entry in access.addresses {
                let name = interfaceName(of: entry.interface) ?? "unknown"
                lines.append("add address=\(RouterOSEngine.exportValue(entry.address)) interface=\(RouterOSEngine.exportValue(name))")
            }
        }
        if wantsIP, location.last != "address" {
            var rows = access.staticRoutes.map {
                "add dst-address=\(RouterOSEngine.exportValue($0.destination)) gateway=\(RouterOSEngine.exportValue($0.nextHop))"
            }
            // A default gateway set outside RouterOS is shown by `print` as a static default route.
            let gateway = access.defaultGateway
            if !gateway.isEmpty, !access.staticRoutes.contains(where: { $0.destination == "0.0.0.0/0" }) {
                rows.append("add dst-address=0.0.0.0/0 gateway=\(RouterOSEngine.exportValue(gateway))")
            }
            if !rows.isEmpty {
                lines.append("/ip route")
                lines.append(contentsOf: rows)
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
            case .add where context.location == RouterOSEngine.addressMenu:
                // While a value of interface= is typed, the interface names complete the word.
                if context.lastWord.lowercased().hasPrefix("interface=") {
                    entries.append(contentsOf: addressInterfaceNames.map { ("interface=" + $0, "Interface") })
                } else {
                    entries.append(("address=", "Local IP address with prefix length (A.B.C.D/NN)"))
                    entries.append(("interface=", "Interface name"))
                }
            case .add:
                entries.append(("dst-address=", "Destination network (A.B.C.D/NN, default 0.0.0.0/0)"))
                entries.append(("gateway=", "IP address of the next router"))
            case .remove where context.location == RouterOSEngine.addressMenu:
                for (index, entry) in access.addresses.enumerated() {
                    let name = interfaceName(of: entry.interface) ?? "unknown"
                    entries.append(("\(index)", entry.address + " " + name))
                }
            case .remove:
                for (index, row) in routeRows().enumerated() {
                    entries.append(("\(index)", row.destination + " " + row.gateway))
                }
            case .ping:
                entries.append(("address=", "Destination IP address"))
                entries.append(("count=", "How many packets to send (1-\(RouterOSEngine.maxPingCount))"))
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
