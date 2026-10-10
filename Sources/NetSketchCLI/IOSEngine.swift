import Foundation
import NetSketchCore

/// What every dialect engine offers to `CLISession`.
protocol ConsoleEngine: AnyObject {
    var banner: String { get }
    var prompt: String { get }
    var isClosed: Bool { get }
    func execute(_ line: String) -> String
    func complete(_ partial: String) -> [String]
    func help(_ partial: String) -> String
}

/// The interfaces a command refers to.
struct InterfaceSelection: Equatable {
    enum Target: Equatable {
        /// Physical ports of the device, by id.
        case ports([UUID])
        case vlan(Int)
        case portChannel(Int)
        case loopback(Int)
    }

    var target: Target
    var isRange = false
    /// The part of a Dell prompt that names the selection, e.g. "gi-1/1" or "range-gi-1/1-4".
    var promptLabel = ""
}

/// The IOS-style engine. It also drives the Dell OS9 dialect (same parser, other command
/// tables, prompts and output layouts) and the generic dialect.
///
/// The engine holds no copy of the configuration: every command reads the current project and
/// writes through `ProjectStore`, so the canvas, the inspector and undo stay in step.
final class IOSEngine: ConsoleEngine {
    enum Mode: Equatable {
        case userExec
        case privilegedExec
        case globalConfig
        /// Interface configuration of one or more physical ports.
        case interface(InterfaceSelection)
        /// IOS `vlan N` configuration.
        case vlan([Int])
        /// `interface vlan N`: Dell OS9 VLAN membership and address, IOS switch virtual interface.
        case vlanInterface(Int)
        /// Line configuration; accepted formally, nothing is stored.
        case line(String)
    }

    let access: DeviceAccess
    let dialect: CLIDialect
    let namer: InterfaceNamer
    var mode: Mode = .userExec
    private(set) var isClosed = false
    private(set) var history: [String] = []
    /// Set while a multi-line `banner` text is being typed; lines are swallowed until it shows up.
    private var bannerDelimiter: Character?
    private var lastHostname: String
    private lazy var tables = CommandTables(dialect: dialect)

    init(access: DeviceAccess, dialect: CLIDialect) {
        self.access = access
        self.dialect = dialect
        self.namer = InterfaceNamer(style: dialect == .dellOS9 ? .dell : .ios)
        self.lastHostname = access.hostname
    }

    var isDell: Bool { dialect == .dellOS9 }

    // MARK: Banner and prompt

    var banner: String {
        let name: String
        switch dialect {
        case .ios: name = "Cisco IOS"
        case .dellOS9: name = "Dell OS9"
        case .routerOS: name = "RouterOS"
        case .generic: name = "obecný (styl IOS)"
        case .host: name = "příkazový řádek"
        }
        let model = [access.vendor, access.model].filter { !$0.isEmpty }.joined(separator: " ")
        return Notices.banner(hostname: hostname, model: model, dialect: name, unknownCLI: dialect == .generic)
    }

    /// The current hostname; the last known one once the device has been deleted.
    var hostname: String {
        if let device = access.device { lastHostname = device.hostname }
        return lastHostname
    }

    var prompt: String {
        if bannerDelimiter != nil { return "" }
        let host = hostname
        switch mode {
        case .userExec:
            return host + ">"
        case .privilegedExec:
            return host + "#"
        case .globalConfig:
            return host + (isDell ? "(conf)#" : "(config)#")
        case .interface(let selection):
            if isDell { return host + "(conf-if-\(selection.promptLabel))#" }
            return host + (selection.isRange ? "(config-if-range)#" : "(config-if)#")
        case .vlan:
            return host + "(config-vlan)#"
        case .vlanInterface(let id):
            return host + (isDell ? "(conf-if-vl-\(id))#" : "(config-if)#")
        case .line(let kind):
            return host + (isDell ? "(config-line-\(kind))#" : "(config-line)#")
        }
    }

    var isConfigMode: Bool {
        switch mode {
        case .userExec, .privilegedExec: return false
        default: return true
        }
    }

    private var isSubConfigMode: Bool {
        switch mode {
        case .userExec, .privilegedExec, .globalConfig: return false
        default: return true
        }
    }

    private var currentTree: CommandNode {
        switch mode {
        case .userExec: return tables.userExec
        case .privilegedExec: return tables.privilegedExec
        case .globalConfig: return tables.globalConfig
        case .interface: return tables.interfaceConfig
        case .vlan: return tables.vlanConfig
        case .vlanInterface: return isDell ? tables.vlanInterfaceConfig : tables.sviConfig
        case .line: return tables.lineConfig
        }
    }

    // MARK: Mode changes used by handlers

    func close() { isClosed = true }

    func leaveToPrivileged() { mode = .privilegedExec }

    /// `exit`: one level up; at the top level the session ends.
    func exitOneLevel() {
        switch mode {
        case .userExec, .privilegedExec: isClosed = true
        case .globalConfig: mode = .privilegedExec
        default: mode = .globalConfig
        }
    }

    func beginBanner(until delimiter: Character) { bannerDelimiter = delimiter }

    // MARK: Execution

    func execute(_ line: String) -> String {
        // A pasted block: run it line by line.
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

        if let delimiter = bannerDelimiter {
            guard line.contains(delimiter) else { return "" }
            bannerDelimiter = nil
            return Notices.bannerNotStored
        }

        // Ctrl-Z typed as a character ends configuration, like on a real console.
        if line.contains("\u{1A}") {
            if isConfigMode { mode = .privilegedExec }
            return ""
        }

        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return "" }
        if trimmed.hasSuffix("?") {
            // "?" never reaches the parser on a real device: it asks for help right away.
            let untilMark = line[..<(line.lastIndex(of: "?") ?? line.endIndex)]
            return help(String(untilMark))
        }
        remember(trimmed)
        if trimmed.hasPrefix("!") { return "" }

        let promptWidth = prompt.count
        let input = ParseInput(line)
        return run(input, promptWidth: promptWidth)
    }

    private func remember(_ command: String) {
        history.append(command)
        if history.count > CLILimits.historySize { history.removeFirst(history.count - CLILimits.historySize) }
    }

    private func run(_ input: ParseInput, promptWidth: Int) -> String {
        let parser = CommandParser(engine: self)
        var result = parser.parse(input, tree: currentTree)

        // Like IOS, a sub-mode accepts global configuration commands and leaves the sub-mode
        // ("no vlan 20" inside "interface fa0/1" too). When both fail, the error of the parse
        // that got further is reported.
        if isSubConfigMode, case .invalid(let column) = result, let first = input.tokens.first {
            let firstWordFailed = column < first.column + first.text.count
            let global = parser.parse(input, tree: tables.globalConfig)
            switch global {
            case .run:
                mode = .globalConfig
                result = global
            case .incomplete, .ambiguous:
                if firstWordFailed { result = global }
            case .invalid(let globalColumn):
                if globalColumn > column { result = global }
            }
        }

        switch result {
        case .run(let node, let command):
            return node.handler?(self, command) ?? ""
        case .incomplete:
            return isDell ? "% Error: Incomplete command." : "% Incomplete command."
        case .ambiguous:
            return ambiguousMessage(input.source)
        case .invalid(let column):
            let caret = String(repeating: " ", count: promptWidth + column) + "^"
            let message = isDell ? "% Error: Invalid input at \"^\" marker." : "% Invalid input detected at '^' marker."
            return caret + "\n" + message
        }
    }

    private func ambiguousMessage(_ line: String) -> String {
        if isDell { return "% Error: Ambiguous command." }
        return "% Ambiguous command:  \"\(line.trimmingCharacters(in: .whitespaces))\""
    }

    // MARK: Help and completion

    func help(_ partial: String) -> String {
        guard access.exists, !isClosed, partial.count <= CLILimits.maxLineLength else { return "" }
        let parser = CommandParser(engine: self)
        let input = ParseInput(partial)
        let tree = currentTree

        if input.tokens.isEmpty || input.endsWithSeparator {
            switch parser.position(after: input.tokens, input: input, tree: tree) {
            case .at(let node):
                let entries = parser.helpEntries(for: node)
                return entries.isEmpty ? "% Unrecognized command" : HelpFormatter.table(entries)
            case .insideArgument(let argument, let pending):
                return HelpFormatter.table(argument.continuationHelp(self, pending))
            case .ambiguous:
                return ambiguousMessage(partial)
            case .invalid:
                return "% Unrecognized command"
            }
        }

        // The last word is still being typed: list what it may become.
        let complete = Array(input.tokens.dropLast())
        let last = input.tokens[input.tokens.count - 1]
        switch parser.position(after: complete, input: input, tree: tree) {
        case .at(let node):
            if case .line = node.kind { return HelpFormatter.table(parser.helpEntries(for: node)) }
            let words = parser.completionWords(for: node)
                .filter { $0.lowercased().hasPrefix(last.lower) }
                .sorted { $0.lowercased() < $1.lowercased() }
            if !words.isEmpty { return HelpFormatter.words(words) }
            // Not a keyword: the word may be an argument (a number, a name, free text).
            let arguments = parser.helpEntries(for: node).filter { entry in
                !node.children.contains { $0.keyword == entry.name } && entry.name != "<cr>"
            }
            return arguments.isEmpty ? "% Unrecognized command" : HelpFormatter.table(arguments)
        case .insideArgument(let argument, let pending):
            return HelpFormatter.table(argument.continuationHelp(self, pending))
        case .ambiguous:
            return ambiguousMessage(partial)
        case .invalid:
            return "% Unrecognized command"
        }
    }

    func complete(_ partial: String) -> [String] {
        guard access.exists, !isClosed, partial.count <= CLILimits.maxLineLength else { return [] }
        let parser = CommandParser(engine: self)
        let input = ParseInput(partial)
        let startsNewWord = input.tokens.isEmpty || input.endsWithSeparator
        let complete = startsNewWord ? input.tokens : Array(input.tokens.dropLast())
        guard case .at(let node) = parser.position(after: complete, input: input, tree: currentTree) else { return [] }
        var words = parser.completionWords(for: node)
        if !startsNewWord {
            let prefix = input.tokens[input.tokens.count - 1].lower
            words = words.filter { $0.lowercased().hasPrefix(prefix) }
        }
        var seen = Set<String>()
        return words.filter { seen.insert($0.lowercased()).inserted }.sorted { $0.lowercased() < $1.lowercased() }
    }

    // MARK: Ports of the current mode

    /// The live ports of the interface mode. When they are gone the mode is left.
    func selectedPorts() -> [PortSnapshot] {
        guard case .interface(let selection) = mode, case .ports(let ids) = selection.target else { return [] }
        let live = access.interfaces
        return ids.compactMap { id in live.first { $0.id == id } }
    }
}

// MARK: - Interface arguments

extension IOSEngine {
    /// One interface: "fa0/1", "Fa 0/1", "GigabitEthernet 1/1", "vlan 10".
    static let interfaceArgument = CustomArgument(
        name: "interface",
        match: { engine, input, index in engine.matchInterface(input, index) },
        helpEntries: { $0.interfaceTypeHelp() },
        continuationHelp: { engine, pending in engine.interfaceNumberHelp(pending) },
        completions: { $0.interfaceTypeHelp().map(\.name) }
    )

    /// One or more interfaces: "fa0/1 - 4", "fa0/1-4 , gi0/1", "gigabitethernet 1/1 - 1/4".
    static let interfaceRangeArgument = CustomArgument(
        name: "interface",
        match: { engine, input, index in engine.matchInterfaceRange(input, index) },
        helpEntries: { $0.interfaceTypeHelp(includingVirtual: false) },
        continuationHelp: { engine, pending in engine.interfaceNumberHelp(pending) },
        completions: { $0.interfaceTypeHelp(includingVirtual: false).map(\.name) }
    )

    private static let virtualTypes: [(name: String, word: String, help: String, range: ClosedRange<Int>)] = [
        ("vlan", "Vlan", "Catalyst Vlans", 1...4094),
        ("port-channel", "Port-channel", "Ethernet Channel of interfaces", 1...4096),
        ("loopback", "Loopback", "Loopback interface", 0...2_147_483_647),
    ]

    /// The interface type words `interface ?` lists for this device.
    func interfaceTypeHelp(includingVirtual: Bool = true) -> [HelpEntry] {
        var entries: [HelpEntry] = []
        var seen = Set<String>()
        for port in access.interfaces {
            let word = namer.typeWord(of: port.name)
            guard !word.isEmpty, !word.contains(" "), seen.insert(word.lowercased()).inserted else { continue }
            entries.append(HelpEntry(name: word, text: namer.knownType(of: port.name)?.help ?? "Interface"))
        }
        if includingVirtual {
            entries.append(HelpEntry(name: "Vlan", text: isDell ? "VLAN interface" : "Catalyst Vlans"))
        }
        return entries
    }

    /// Help after an interface type without a number ("interface fastethernet ?").
    func interfaceNumberHelp(_ pending: [CLIToken]) -> [HelpEntry] {
        guard let typed = pending.first.map({ InterfaceNameParts($0.text).type }) else { return [] }
        let ports = access.interfaces.filter {
            InterfaceResolver.typeMatches(user: typed, port: InterfaceNameParts($0.name).type)
        }
        guard let first = ports.first, let last = ports.last else {
            if let virtual = IOSEngine.virtualTypes.first(where: { $0.name.hasPrefix(typed) }) {
                return [HelpEntry(name: "<\(virtual.range.lowerBound)-\(virtual.range.upperBound)>",
                                  text: "\(virtual.word) interface number")]
            }
            return []
        }
        let range = "<\(InterfaceNameParts(first.name).number)-\(InterfaceNameParts(last.name).number)>"
        return [HelpEntry(name: range, text: "\(namer.typeWord(of: first.name)) interface number")]
    }

    private func typeIsPlausible(_ type: String) -> Bool {
        guard !type.isEmpty else { return false }
        if IOSEngine.virtualTypes.contains(where: { $0.name.hasPrefix(type) }) { return true }
        return access.interfaces.contains {
            InterfaceResolver.typeMatches(user: type, port: InterfaceNameParts($0.name).type)
        }
    }

    /// Number of leading characters of a typed type that still fit some type of this device.
    private func typePrefixLength(_ type: String) -> Int {
        var words = IOSEngine.virtualTypes.map(\.name)
        for port in access.interfaces {
            words.append(InterfaceNameParts(port.name).type)
            if let known = namer.knownType(of: port.name) { words.append(known.full.lowercased()) }
        }
        var best = 0
        for word in words {
            var length = 0
            for (a, b) in zip(type, word) {
                if a != b { break }
                length += 1
            }
            best = max(best, length)
        }
        return min(best, max(0, type.count - 1))
    }

    private func virtualInterface(_ parts: InterfaceNameParts) -> InterfaceSelection? {
        guard !parts.type.isEmpty, parts.number.count <= 10, parts.number.allSatisfy({ $0.isASCII && $0.isNumber }),
              let number = Int(parts.number),
              let virtual = IOSEngine.virtualTypes.first(where: { $0.name.hasPrefix(parts.type) }),
              virtual.range.contains(number) else { return nil }
        switch virtual.name {
        case "vlan": return InterfaceSelection(target: .vlan(number), promptLabel: "vl-\(number)")
        case "port-channel": return InterfaceSelection(target: .portChannel(number), promptLabel: "po-\(number)")
        default: return InterfaceSelection(target: .loopback(number), promptLabel: "lo-\(number)")
        }
    }

    private func selection(for port: PortSnapshot) -> InterfaceSelection {
        let label = "\(namer.promptTag(of: port.name))-\(InterfaceNameParts(port.name).number)"
        return InterfaceSelection(target: .ports([port.id]), promptLabel: label)
    }

    func matchInterface(_ input: ParseInput, _ index: Int) -> CustomMatch {
        let tokens = input.tokens
        let ports = access.interfaces

        // Names made of several words first ("LAN 3", "WAN SFP+"): they must match word by word.
        for count in stride(from: min(3, tokens.count - index), through: 2, by: -1) {
            let typed = tokens[index..<(index + count)].map(\.lower)
            let match = ports.first { port in
                port.name.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init) == typed
            }
            if let match { return .matched(.interfaces(selection(for: match)), consumed: count) }
        }
        if let exact = ports.first(where: { InterfaceNameParts($0.name).normalized == tokens[index].lower }) {
            return .matched(.interfaces(selection(for: exact)), consumed: 1)
        }

        let first = tokens[index]
        var parts = InterfaceNameParts(first.text)
        var consumed = 1
        var numberColumn = first.column + first.text.prefix(while: { !$0.isNumber }).count

        if parts.number.isEmpty {
            // "fa 0/1": the number is the next word.
            guard index + 1 < tokens.count else {
                return typeIsPlausible(parts.type) ? .incomplete : .invalid(column: first.column + typePrefixLength(parts.type))
            }
            let next = tokens[index + 1]
            guard typeIsPlausible(parts.type) else {
                return .invalid(column: first.column + typePrefixLength(parts.type))
            }
            guard let digit = next.text.first, digit.isNumber else { return .invalid(column: next.column) }
            parts = InterfaceNameParts(first.text + next.text)
            consumed = 2
            numberColumn = next.column
        }

        switch InterfaceResolver.lookup(parts.normalized, in: ports) {
        case .found(let port):
            return .matched(.interfaces(selection(for: port)), consumed: consumed)
        case .ambiguous:
            return .invalid(column: first.column)
        case .unknownNumber(let offset):
            return .invalid(column: numberColumn + offset)
        case .unknownType:
            if let virtual = virtualInterface(parts) {
                return .matched(.interfaces(virtual), consumed: consumed)
            }
            if IOSEngine.virtualTypes.contains(where: { !parts.type.isEmpty && $0.name.hasPrefix(parts.type) }) {
                return .invalid(column: numberColumn)
            }
            return .invalid(column: first.column + typePrefixLength(parts.type))
        }
    }

    func matchInterfaceRange(_ input: ParseInput, _ index: Int) -> CustomMatch {
        let tokens = input.tokens
        let raw = input.rest(from: index)
        let base = tokens[index].column
        let ports = access.interfaces
        var ids: [UUID] = []
        var labels: [String] = []
        var offset = 0

        let segments = raw.split(separator: ",", omittingEmptySubsequences: false)
        for (position, segment) in segments.enumerated() {
            let column = base + offset + segment.prefix(while: { $0.isWhitespace }).count
            offset += segment.count + 1
            let text = segment.trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty else {
                return position == segments.count - 1 ? .incomplete : .invalid(column: column)
            }

            var startSpec = text
            var endText: String?
            if let dash = text.lastIndex(of: "-") {
                let left = text[..<dash].trimmingCharacters(in: .whitespaces)
                let right = text[text.index(after: dash)...].trimmingCharacters(in: .whitespaces)
                if left.contains(where: { $0.isNumber }) {
                    if right.isEmpty { return .incomplete }
                    if right.allSatisfy({ ($0.isASCII && $0.isNumber) || $0 == "/" }) {
                        startSpec = left
                        endText = right
                    }
                }
            }

            let startParts = InterfaceNameParts(startSpec)
            if startParts.number.isEmpty {
                // Only a type so far ("interface range fa").
                let plausible = typeIsPlausible(startParts.type) && !ports.contains {
                    InterfaceNameParts($0.name).normalized == startParts.normalized
                }
                if plausible { return position == segments.count - 1 ? .incomplete : .invalid(column: column) }
            }
            guard case .found(let startPort) = InterfaceResolver.lookup(startSpec, in: ports) else {
                return .invalid(column: column)
            }
            let actual = InterfaceNameParts(startPort.name)
            let tag = namer.promptTag(of: startPort.name)

            guard let endText else {
                ids.append(startPort.id)
                labels.append("\(tag)-\(actual.number)")
                continue
            }

            // "fa0/1 - 4" repeats the leading numbers of the start; "1/1 - 1/4" spells them out.
            let startComponents = actual.components
            let endComponents = endText.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            guard let startLast = startComponents.last.flatMap({ Int($0) }),
                  let endLast = endComponents.last.flatMap({ $0.count <= 6 ? Int($0) : nil }),
                  endComponents.count == 1 || endComponents.dropLast().elementsEqual(startComponents.dropLast()),
                  startLast <= endLast, endLast - startLast < 1024
            else { return .invalid(column: column) }

            let leading = startComponents.dropLast()
            let siblings = ports.filter { InterfaceNameParts($0.name).type == actual.type }
            for number in startLast...endLast {
                let wanted = (leading + [String(number)]).joined(separator: "/")
                guard let port = siblings.first(where: { InterfaceNameParts($0.name).number == wanted }) else {
                    return .invalid(column: column)
                }
                ids.append(port.id)
            }
            labels.append("\(tag)-\(actual.number)-\(endText)")
        }

        var seen = Set<UUID>()
        let unique = ids.filter { seen.insert($0).inserted }
        let selection = InterfaceSelection(
            target: .ports(unique),
            isRange: true,
            promptLabel: "range-" + labels.joined(separator: ",")
        )
        return .matched(.interfaces(selection), consumed: tokens.count - index)
    }
}
