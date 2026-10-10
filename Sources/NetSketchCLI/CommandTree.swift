import Foundation

// A small table-driven command parser in the style of the Cisco IOS parser.
//
// Every command of the IOS-like dialects is declared exactly once as a path in a tree of
// `CommandNode`s. Execution, abbreviation matching, the three classic error messages,
// context help ("?") and Tab completion are all derived from that single definition.

/// One whitespace-separated word of a command line together with its position.
struct CLIToken: Equatable {
    let text: String
    /// Zero-based character offset in the echoed command line (prompt excluded).
    let column: Int

    var lower: String { text.lowercased() }
}

/// A tokenized command line. Keeps the raw text so free-text arguments keep their spacing.
struct ParseInput {
    let source: String
    /// Column of the first character of `source` in the echoed line (non-zero for `do ...`).
    let baseColumn: Int
    let tokens: [CLIToken]

    init(_ source: String, baseColumn: Int = 0) {
        self.source = source
        self.baseColumn = baseColumn
        self.tokens = ParseInput.tokenize(source, baseColumn: baseColumn)
    }

    static func tokenize(_ line: String, baseColumn: Int) -> [CLIToken] {
        var tokens: [CLIToken] = []
        var current = ""
        var start = baseColumn
        var column = baseColumn
        for character in line {
            if character.isWhitespace {
                if !current.isEmpty {
                    tokens.append(CLIToken(text: current, column: start))
                    current = ""
                }
            } else {
                if current.isEmpty { start = column }
                current.append(character)
            }
            column += 1
        }
        if !current.isEmpty { tokens.append(CLIToken(text: current, column: start)) }
        return tokens
    }

    /// Raw text from the token at `index` to the end of the line, without trailing whitespace.
    func rest(from index: Int) -> String {
        guard index < tokens.count else { return "" }
        let offset = max(0, tokens[index].column - baseColumn)
        return String(source.dropFirst(offset)).trimmingTrailingWhitespace()
    }

    /// True when the line ends with whitespace (or is empty): the next word has not been started.
    var endsWithSeparator: Bool {
        guard let last = source.last else { return true }
        return last.isWhitespace
    }

    /// Column just behind the last character of the line.
    var endColumn: Int { baseColumn + source.count }
}

extension String {
    func trimmingTrailingWhitespace() -> String {
        var view = self[...]
        while let last = view.last, last.isWhitespace { view = view.dropLast() }
        return String(view)
    }

    /// Pads with spaces on the right up to `width` characters (never truncates).
    func padded(_ width: Int) -> String {
        count >= width ? self : self + String(repeating: " ", count: width - count)
    }

    /// Pads with spaces on the left up to `width` characters (never truncates).
    func leftPadded(_ width: Int) -> String {
        count >= width ? self : String(repeating: " ", count: width - count) + self
    }

    /// Truncates to `width` characters and pads to exactly `width`.
    func column(_ width: Int) -> String {
        String(prefix(width)).padded(width)
    }
}

/// A parsed argument value.
enum ArgValue {
    case int(Int)
    case text(String)
    case intList([Int])
    case interfaces(InterfaceSelection)
}

/// Result of a custom (multi-token, device-aware) argument matcher.
enum CustomMatch {
    case matched(ArgValue, consumed: Int)
    /// The tokens are not this kind of argument at all; other alternatives may still match.
    case noMatch
    /// The tokens start like this argument but are wrong at `column`.
    case invalid(column: Int)
    /// The tokens ended in the middle of the argument (e.g. an interface type without a number).
    case incomplete
}

/// A device-aware argument that may span several tokens (interface names, interface ranges).
struct CustomArgument {
    let name: String
    let match: (_ engine: IOSEngine, _ input: ParseInput, _ index: Int) -> CustomMatch
    /// Help entries shown where the argument may start.
    let helpEntries: (_ engine: IOSEngine) -> [HelpEntry]
    /// Help shown when the tokens typed so far left the argument incomplete.
    let continuationHelp: (_ engine: IOSEngine, _ pending: [CLIToken]) -> [HelpEntry]
    /// Words offered for Tab completion of the first token of the argument.
    let completions: (_ engine: IOSEngine) -> [String]
}

struct HelpEntry: Equatable {
    let name: String
    let text: String
}

/// The values collected while a command line was matched against the tree.
struct ParsedCommand {
    var values: [String: ArgValue] = [:]
    /// Canonical spelling of every matched keyword, in order.
    var keywords: [String] = []

    func int(_ name: String) -> Int? {
        if case .int(let value)? = values[name] { return value }
        return nil
    }

    func text(_ name: String) -> String? {
        if case .text(let value)? = values[name] { return value }
        return nil
    }

    func intList(_ name: String) -> [Int]? {
        if case .intList(let value)? = values[name] { return value }
        return nil
    }

    func interfaces(_ name: String) -> InterfaceSelection? {
        if case .interfaces(let value)? = values[name] { return value }
        return nil
    }

    func has(_ keyword: String) -> Bool { keywords.contains(keyword) }
}

typealias CommandHandler = (_ engine: IOSEngine, _ command: ParsedCommand) -> String

/// One element of a command: a keyword or an argument, with its help text, the elements that
/// may follow, and (when the command may end here) the handler to run.
final class CommandNode {
    enum Kind {
        /// The root of a mode's command tree; never matched itself.
        case root
        /// A literal keyword. Any unambiguous prefix matches, case-insensitively.
        case keyword(String)
        /// An integer in a range, shown in help as `<low-high>`.
        case number(name: String, range: ClosedRange<Int>)
        /// A single free word, shown in help as `WORD`.
        case word(name: String, placeholder: String)
        /// The rest of the line, shown in help as `LINE`.
        case line(name: String, placeholder: String)
        /// A list of VLAN ids such as `10,20,30-40`.
        case vlanList(name: String)
        /// A device-aware argument that may span several tokens.
        case custom(CustomArgument)
    }

    let kind: Kind
    let help: String
    private(set) var children: [CommandNode]
    let handler: CommandHandler?
    /// Hidden nodes still parse but are not listed in help or completion.
    let hidden: Bool

    init(kind: Kind, help: String, children: [CommandNode] = [], hidden: Bool = false, handler: CommandHandler? = nil) {
        self.kind = kind
        self.help = help
        self.children = children
        self.hidden = hidden
        self.handler = handler
    }

    var keyword: String? {
        if case .keyword(let word) = kind { return word }
        return nil
    }

    func adding(_ nodes: [CommandNode]) -> CommandNode {
        children.append(contentsOf: nodes)
        return self
    }
}

// MARK: - Tree construction helpers

func root(_ children: [CommandNode]) -> CommandNode {
    CommandNode(kind: .root, help: "", children: children)
}

func kw(_ name: String, _ help: String, _ children: [CommandNode] = [], hidden: Bool = false,
        run: CommandHandler? = nil) -> CommandNode {
    CommandNode(kind: .keyword(name), help: help, children: children, hidden: hidden, handler: run)
}

func num(_ name: String, _ range: ClosedRange<Int>, _ help: String, _ children: [CommandNode] = [],
         run: CommandHandler? = nil) -> CommandNode {
    CommandNode(kind: .number(name: name, range: range), help: help, children: children, handler: run)
}

func word(_ name: String, _ help: String, placeholder: String = "WORD", _ children: [CommandNode] = [],
          run: CommandHandler? = nil) -> CommandNode {
    CommandNode(kind: .word(name: name, placeholder: placeholder), help: help, children: children, handler: run)
}

func line(_ name: String, _ help: String, placeholder: String = "LINE", run: CommandHandler?) -> CommandNode {
    CommandNode(kind: .line(name: name, placeholder: placeholder), help: help, handler: run)
}

func vlanList(_ name: String, _ help: String, _ children: [CommandNode] = [],
              run: CommandHandler? = nil) -> CommandNode {
    CommandNode(kind: .vlanList(name: name), help: help, children: children, handler: run)
}

func custom(_ argument: CustomArgument, _ help: String = "", _ children: [CommandNode] = [],
            run: CommandHandler? = nil) -> CommandNode {
    CommandNode(kind: .custom(argument), help: help, children: children, handler: run)
}

// MARK: - Matching

enum ParseResult {
    /// A complete command: run `node.handler`.
    case run(CommandNode, ParsedCommand)
    /// The line is a valid beginning but stops too early.
    case incomplete
    /// A keyword prefix matches more than one keyword.
    case ambiguous
    /// Nothing matches at `column`.
    case invalid(column: Int)
}

/// Outcome of matching a single token position against the children of a node.
private enum StepResult {
    case next(CommandNode, consumed: Int, value: (String, ArgValue)?)
    case ambiguous
    case invalid(column: Int)
    case incomplete
}

enum VLANListParser {
    /// Parses "10", "10,20", "10-12,20" into a sorted list of unique ids within 1...4094.
    static func parse(_ text: String) -> [Int]? {
        guard !text.isEmpty, text.count <= 400 else { return nil }
        var result = Set<Int>()
        for part in text.split(separator: ",", omittingEmptySubsequences: false) {
            let bounds = part.split(separator: "-", omittingEmptySubsequences: false)
            switch bounds.count {
            case 1:
                guard let value = vlanID(bounds[0]) else { return nil }
                result.insert(value)
            case 2:
                guard let low = vlanID(bounds[0]), let high = vlanID(bounds[1]), low <= high else { return nil }
                for value in low...high { result.insert(value) }
            default:
                return nil
            }
        }
        return result.isEmpty ? nil : result.sorted()
    }

    private static func vlanID(_ text: Substring) -> Int? {
        guard !text.isEmpty, text.count <= 4, text.allSatisfy({ $0.isASCII && $0.isNumber }),
              let value = Int(text), (1...4094).contains(value) else { return nil }
        return value
    }

    /// Formats a set of ids as a compact range list: [1,2,3,10] -> "1-3,10".
    static func format(_ ids: [Int]) -> String {
        let sorted = Array(Set(ids)).sorted()
        var parts: [String] = []
        var index = 0
        while index < sorted.count {
            var end = index
            while end + 1 < sorted.count, sorted[end + 1] == sorted[end] + 1 { end += 1 }
            parts.append(end == index ? "\(sorted[index])" : "\(sorted[index])-\(sorted[end])")
            index = end + 1
        }
        return parts.joined(separator: ",")
    }
}

struct CommandParser {
    let engine: IOSEngine

    /// Matches a whole line against `tree`.
    func parse(_ input: ParseInput, tree: CommandNode) -> ParseResult {
        var node = tree
        var index = 0
        var command = ParsedCommand()
        while index < input.tokens.count {
            switch step(node, input, index) {
            case .next(let child, let consumed, let value):
                if let keyword = child.keyword { command.keywords.append(keyword) }
                if let (name, argument) = value { command.values[name] = argument }
                node = child
                index += max(1, consumed)
            case .ambiguous:
                return .ambiguous
            case .invalid(let column):
                return .invalid(column: column)
            case .incomplete:
                return .incomplete
            }
        }
        if case .root = node.kind { return .incomplete }
        return node.handler == nil ? .incomplete : .run(node, command)
    }

    private func step(_ node: CommandNode, _ input: ParseInput, _ index: Int) -> StepResult {
        let token = input.tokens[index]
        let lower = token.lower

        // Keywords first: an exact match wins, otherwise a unique prefix.
        var prefixMatches: [CommandNode] = []
        for child in node.children {
            guard let keyword = child.keyword?.lowercased() else { continue }
            if keyword == lower { return .next(child, consumed: 1, value: nil) }
            if keyword.hasPrefix(lower) { prefixMatches.append(child) }
        }
        if prefixMatches.count == 1 { return .next(prefixMatches[0], consumed: 1, value: nil) }
        if prefixMatches.count > 1 { return .ambiguous }

        // Arguments, in declaration order.
        var invalidColumn: Int?
        for child in node.children {
            switch child.kind {
            case .root, .keyword:
                continue
            case .number(let name, let range):
                guard token.text.count <= 12, token.text.allSatisfy({ $0.isASCII && $0.isNumber }),
                      let value = Int(token.text) else { continue }
                if range.contains(value) { return .next(child, consumed: 1, value: (name, .int(value))) }
                invalidColumn = invalidColumn ?? token.column
            case .vlanList(let name):
                if let list = VLANListParser.parse(token.text) {
                    return .next(child, consumed: 1, value: (name, .intList(list)))
                }
                if let first = token.text.first, first.isNumber { invalidColumn = invalidColumn ?? token.column }
            case .word(let name, _):
                return .next(child, consumed: 1, value: (name, .text(token.text)))
            case .line(let name, _):
                return .next(child, consumed: input.tokens.count - index, value: (name, .text(input.rest(from: index))))
            case .custom(let argument):
                switch argument.match(engine, input, index) {
                case .matched(let value, let consumed):
                    return .next(child, consumed: consumed, value: (argument.name, value))
                case .noMatch:
                    continue
                case .invalid(let column):
                    invalidColumn = invalidColumn ?? column
                case .incomplete:
                    return .incomplete
                }
            }
        }
        if let invalidColumn { return .invalid(column: invalidColumn) }
        return .invalid(column: token.column + longestKeywordPrefix(of: lower, in: node))
    }

    /// Number of leading characters of `text` that still match some keyword of `node`.
    /// Real IOS puts the caret under the first character that cannot be part of any keyword.
    private func longestKeywordPrefix(of text: String, in node: CommandNode) -> Int {
        var best = 0
        for child in node.children {
            guard let keyword = child.keyword?.lowercased() else { continue }
            var length = 0
            for (a, b) in zip(text, keyword) {
                if a != b { break }
                length += 1
            }
            best = max(best, length)
        }
        return min(best, max(0, text.count - 1))
    }

    // MARK: Help and completion

    /// Where a partial line stands in the tree.
    enum Position {
        /// All complete words matched; `node` is where the next word would attach.
        case at(CommandNode)
        /// The words so far ended inside a multi-token argument.
        case insideArgument(CustomArgument, pending: [CLIToken])
        case ambiguous
        case invalid
    }

    /// Walks `tokens` (all of them complete words) and reports the position reached.
    func position(after tokens: [CLIToken], input: ParseInput, tree: CommandNode) -> Position {
        var node = tree
        var index = 0
        while index < tokens.count {
            switch step(node, input, index) {
            case .next(let child, let consumed, _):
                node = child
                index += max(1, consumed)
            case .ambiguous:
                return .ambiguous
            case .invalid:
                return .invalid
            case .incomplete:
                for child in node.children {
                    if case .custom(let argument) = child.kind {
                        return .insideArgument(argument, pending: Array(tokens[index...]))
                    }
                }
                return .invalid
            }
        }
        return .at(node)
    }

    /// The entries listed by "?" where the next word of `node` may start.
    func helpEntries(for node: CommandNode) -> [HelpEntry] {
        var arguments: [HelpEntry] = []
        var keywords: [HelpEntry] = []
        // Inside free text the only thing that can follow is more text (or Enter).
        if case .line(_, let placeholder) = node.kind {
            arguments.append(HelpEntry(name: placeholder, text: node.help))
        }
        for child in node.children where !child.hidden {
            switch child.kind {
            case .root:
                continue
            case .keyword(let name):
                keywords.append(HelpEntry(name: name, text: child.help))
            case .number(_, let range):
                arguments.append(HelpEntry(name: "<\(range.lowerBound)-\(range.upperBound)>", text: child.help))
            case .word(_, let placeholder), .line(_, let placeholder):
                arguments.append(HelpEntry(name: placeholder, text: child.help))
            case .vlanList:
                arguments.append(HelpEntry(name: "WORD", text: child.help))
            case .custom(let argument):
                keywords.append(contentsOf: argument.helpEntries(engine))
            }
        }
        keywords.sort { $0.name.lowercased() < $1.name.lowercased() }
        var entries = arguments + keywords
        if node.handler != nil { entries.append(HelpEntry(name: "<cr>", text: "")) }
        return entries
    }

    /// Keywords (canonical spelling) that may start the next word of `node`.
    func completionWords(for node: CommandNode) -> [String] {
        var words: [String] = []
        for child in node.children where !child.hidden {
            switch child.kind {
            case .keyword(let name): words.append(name)
            case .custom(let argument): words.append(contentsOf: argument.completions(engine))
            default: continue
            }
        }
        return words
    }
}

enum HelpFormatter {
    /// IOS layout: two spaces, the keyword padded to the longest one, two spaces, the description.
    static func table(_ entries: [HelpEntry]) -> String {
        let width = entries.map(\.name.count).max() ?? 0
        return entries.map { entry in
            entry.text.isEmpty ? "  \(entry.name)" : "  \(entry.name.padded(width))  \(entry.text)"
        }.joined(separator: "\n")
    }

    /// IOS layout of a prefix listing ("sh?"): just the words, separated by two spaces.
    static func words(_ words: [String]) -> String {
        words.joined(separator: "  ")
    }
}
