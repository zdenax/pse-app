import AppKit
import SwiftUI
import NetSketchCanvas

/// Fonts and colors of the terminal. Everything is derived from the shared `Theme` brand colors.
enum ConsoleStyle {
    static let font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    static let emphasisFont = NSFont.monospacedSystemFont(ofSize: 13, weight: .semibold)
    static let hintFont = NSFont.systemFont(ofSize: 11)

    static let background = blend(NSColor(Theme.navy), .black, 0.32)
    static let footerBackground = blend(NSColor(Theme.navy), .black, 0.50)
    static let text = srgb(NSColor(Theme.sand))
    static let command = NSColor.white
    static let prompt = blend(NSColor(Theme.teal), .white, 0.18)
    static let error = blend(NSColor(Theme.accent), .white, 0.12)
    static let dim = blend(NSColor(Theme.slate), NSColor(Theme.sand), 0.50)
    static let selection = srgb(NSColor(Theme.teal)).withAlphaComponent(0.40)

    private static func srgb(_ color: NSColor) -> NSColor {
        color.usingColorSpace(.sRGB) ?? color
    }

    private static func blend(_ a: NSColor, _ b: NSColor, _ fraction: CGFloat) -> NSColor {
        srgb(a).blended(withFraction: fraction, of: srgb(b)) ?? a
    }
}

/// Keys the console input treats specially.
enum ConsoleKey {
    case enter, tab, historyUp, historyDown, help, interrupt, end, pageUp, pageDown

    init?(event: NSEvent) {
        let flags = event.modifierFlags.intersection([.command, .control, .option])
        switch event.keyCode {
        case 36, 76: self = .enter; return
        case 48 where flags.isEmpty: self = .tab; return
        case 126 where flags.isEmpty: self = .historyUp; return
        case 125 where flags.isEmpty: self = .historyDown; return
        case 116: self = .pageUp; return
        case 121: self = .pageDown; return
        default: break
        }
        if flags == [.control], let key = event.charactersIgnoringModifiers?.lowercased() {
            if key == "c" { self = .interrupt; return }
            if key == "z" { self = .end; return }
            if key == "p" { self = .historyUp; return }
            if key == "n" { self = .historyDown; return }
        }
        if !flags.contains(.command), !flags.contains(.control), event.characters == "?" {
            self = .help
            return
        }
        return nil
    }
}

protocol ConsoleKeyHandling: AnyObject {
    /// Returns true when the key was consumed.
    func handleConsoleKey(_ key: ConsoleKey) -> Bool
    /// Multi-line paste: every complete line is executed, the rest stays in the input.
    func handleConsolePaste(_ text: String)
}

/// The field editor of the console input line. All special keys are caught here, before the
/// text system sees them, so nothing depends on menu key equivalents or responder-chain fallbacks.
final class ConsoleFieldEditor: NSTextView {
    weak var keyHandler: ConsoleKeyHandling?

    override func keyDown(with event: NSEvent) {
        if !hasMarkedText(), let key = ConsoleKey(event: event), keyHandler?.handleConsoleKey(key) == true {
            return
        }
        super.keyDown(with: event)
    }

    override func paste(_ sender: Any?) {
        if let text = NSPasteboard.general.string(forType: .string),
           text.contains(where: \.isNewline), let keyHandler {
            keyHandler.handleConsolePaste(text)
            return
        }
        super.paste(sender)
    }

    override func becomeFirstResponder() -> Bool {
        let result = super.becomeFirstResponder()
        insertionPointColor = ConsoleStyle.text
        selectedTextAttributes = [.backgroundColor: ConsoleStyle.selection]
        return result
    }
}

/// The read-only scrollback. Typing while it has focus continues in the input line.
final class ScrollbackTextView: NSTextView {
    var redirectKeyDown: ((NSEvent) -> Void)?

    override func keyDown(with event: NSEvent) {
        // Scrolling keys stay here; everything else is meant for the command line.
        let scrollingKeys: Set<UInt16> = [115, 116, 119, 121]
        if scrollingKeys.contains(event.keyCode) || redirectKeyDown == nil {
            super.keyDown(with: event)
        } else {
            redirectKeyDown?(event)
        }
    }
}

/// One terminal: scrollback on top, a single input line prefixed by the live prompt, a hint footer.
final class ConsoleViewController: NSViewController, ConsoleKeyHandling {
    let model: ConsoleModel
    /// Called after a command closed the session (`exit` / `logout` at the top level).
    var onSessionClosed: (() -> Void)?

    let fieldEditor = ConsoleFieldEditor(frame: .zero)
    private let scrollView = NSScrollView()
    private let scrollback = ScrollbackTextView(frame: NSRect(x: 0, y: 0, width: 640, height: 320))
    private let promptLabel = NSTextField(labelWithString: "")
    private(set) var inputField = ConsoleInputField(frame: .zero)
    private let footerLabel = NSTextField(labelWithString: "")
    private var renderedChunkCount = 0
    private var renderedGeneration = -1

    init(model: ConsoleModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    // MARK: View setup

    override func loadView() {
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 760, height: 460))
        root.wantsLayer = true
        root.layer?.backgroundColor = ConsoleStyle.background.cgColor

        configureScrollback()
        configureInput()

        let footer = NSView()
        footer.wantsLayer = true
        footer.layer?.backgroundColor = ConsoleStyle.footerBackground.cgColor
        footerLabel.font = ConsoleStyle.hintFont
        footerLabel.textColor = ConsoleStyle.dim
        footerLabel.lineBreakMode = .byTruncatingTail
        footerLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        footer.addSubview(footerLabel)

        for view in [scrollView, promptLabel, inputField, footer, footerLabel] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
        }
        root.addSubview(scrollView)
        root.addSubview(promptLabel)
        root.addSubview(inputField)
        root.addSubview(footer)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: root.topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: inputField.topAnchor, constant: -2),

            promptLabel.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 11),
            promptLabel.firstBaselineAnchor.constraint(equalTo: inputField.firstBaselineAnchor),

            inputField.leadingAnchor.constraint(equalTo: promptLabel.trailingAnchor, constant: 0),
            inputField.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -11),
            inputField.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -8),

            footer.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            footer.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            footer.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            footer.heightAnchor.constraint(equalToConstant: 24),

            footerLabel.leadingAnchor.constraint(equalTo: footer.leadingAnchor, constant: 12),
            footerLabel.trailingAnchor.constraint(lessThanOrEqualTo: footer.trailingAnchor, constant: -12),
            footerLabel.centerYAnchor.constraint(equalTo: footer.centerYAnchor),
        ])

        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        refresh()
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        focusInput()
        scrollToEnd()
    }

    private func configureScrollback() {
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false
        scrollView.scrollerKnobStyle = .light

        scrollback.minSize = NSSize(width: 0, height: 0)
        scrollback.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        scrollback.isVerticallyResizable = true
        scrollback.isHorizontallyResizable = false
        scrollback.autoresizingMask = [.width]
        scrollback.textContainer?.widthTracksTextView = true
        scrollback.textContainer?.containerSize = NSSize(width: 640, height: CGFloat.greatestFiniteMagnitude)
        scrollback.textContainerInset = NSSize(width: 6, height: 8)
        scrollback.isEditable = false
        scrollback.isSelectable = true
        scrollback.isRichText = true
        scrollback.drawsBackground = false
        scrollback.font = ConsoleStyle.font
        scrollback.textColor = ConsoleStyle.text
        scrollback.selectedTextAttributes = [.backgroundColor: ConsoleStyle.selection]
        scrollback.isAutomaticLinkDetectionEnabled = false
        scrollback.isAutomaticQuoteSubstitutionEnabled = false
        scrollback.isAutomaticDashSubstitutionEnabled = false
        scrollback.redirectKeyDown = { [weak self] event in
            guard let self else { return }
            self.focusInput()
            self.fieldEditor.keyDown(with: event)
        }
        scrollView.documentView = scrollback
    }

    private func configureInput() {
        promptLabel.font = ConsoleStyle.emphasisFont
        promptLabel.textColor = ConsoleStyle.prompt
        promptLabel.lineBreakMode = .byClipping
        promptLabel.setContentHuggingPriority(.required, for: .horizontal)
        promptLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        inputField.font = ConsoleStyle.font
        inputField.textColor = ConsoleStyle.command
        inputField.isBordered = false
        inputField.isBezeled = false
        inputField.drawsBackground = false
        inputField.focusRingType = .none
        inputField.isEditable = true
        inputField.isSelectable = true
        inputField.usesSingleLineMode = true
        inputField.lineBreakMode = .byClipping
        inputField.cell?.isScrollable = true
        inputField.cell?.wraps = false
        inputField.setContentHuggingPriority(.defaultLow, for: .horizontal)
        inputField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        inputField.setAccessibilityLabel("Příkazový řádek")

        fieldEditor.isFieldEditor = true
        fieldEditor.isRichText = false
        fieldEditor.allowsUndo = true
        fieldEditor.drawsBackground = false
        fieldEditor.isAutomaticQuoteSubstitutionEnabled = false
        fieldEditor.isAutomaticDashSubstitutionEnabled = false
        fieldEditor.isAutomaticTextReplacementEnabled = false
        fieldEditor.isAutomaticSpellingCorrectionEnabled = false
        fieldEditor.isAutomaticTextCompletionEnabled = false
        fieldEditor.isContinuousSpellCheckingEnabled = false
        fieldEditor.isGrammarCheckingEnabled = false
        fieldEditor.keyHandler = self
    }

    // MARK: Input line

    /// The text currently typed on the command line.
    var inputText: String {
        get { inputField.currentEditor()?.string ?? inputField.stringValue }
        set {
            inputField.stringValue = newValue
            if let editor = inputField.currentEditor() {
                editor.string = newValue
                editor.selectedRange = NSRange(location: (newValue as NSString).length, length: 0)
            }
        }
    }

    /// Puts the caret at the end of the command line.
    func focusInput() {
        guard let window = view.window else { return }
        if inputField.currentEditor() == nil {
            window.makeFirstResponder(inputField)
        }
        if let editor = inputField.currentEditor() {
            editor.selectedRange = NSRange(location: (editor.string as NSString).length, length: 0)
        }
    }

    /// True when the given field editor request comes from this console's input line.
    func ownsFieldEditorClient(_ client: Any?) -> Bool {
        (client as AnyObject?) === inputField
    }

    // MARK: ConsoleKeyHandling

    func handleConsoleKey(_ key: ConsoleKey) -> Bool {
        switch key {
        case .enter:
            let line = inputText
            inputText = ""
            model.submit(line)
            afterCommand()
        case .tab:
            inputText = model.complete(inputText)
            refresh()
        case .help:
            model.showHelp(for: inputText)
            refresh()
        case .historyUp:
            if let line = model.historyPrevious(current: inputText) { inputText = line }
        case .historyDown:
            if let line = model.historyNext() { inputText = line }
        case .interrupt:
            model.interrupt(inputText)
            inputText = ""
            refresh()
        case .end:
            inputText = ""
            model.end()
            afterCommand()
        case .pageUp:
            scrollback.pageUp(nil)
        case .pageDown:
            scrollback.pageDown(nil)
        }
        return true
    }

    func handleConsolePaste(_ text: String) {
        var lines = text.components(separatedBy: .newlines)
        let remainder = lines.popLast() ?? ""
        var pending = inputText
        for line in lines {
            guard !model.isClosed else { break }
            model.submit(pending + line)
            pending = ""
        }
        inputText = pending + remainder
        afterCommand()
    }

    private func afterCommand() {
        refresh()
        if model.isClosed { onSessionClosed?() }
    }

    // MARK: Rendering

    /// Brings the scrollback, the prompt and the footer in line with the model.
    func refresh() {
        guard isViewLoaded else { return }
        renderScrollback()
        let prompt = model.prompt
        if promptLabel.stringValue != prompt { promptLabel.stringValue = prompt }
        let hint = model.footerText
        if footerLabel.stringValue != hint { footerLabel.stringValue = hint }
    }

    private func renderScrollback() {
        guard let storage = scrollback.textStorage else { return }
        if renderedGeneration != model.generation {
            storage.setAttributedString(NSAttributedString())
            renderedChunkCount = 0
            renderedGeneration = model.generation
        }
        let chunks = model.chunks
        guard renderedChunkCount < chunks.count else { return }
        let addition = NSMutableAttributedString()
        for chunk in chunks[renderedChunkCount...] {
            addition.append(Self.attributedText(for: chunk))
        }
        renderedChunkCount = chunks.count
        storage.append(addition)
        scrollToEnd()
    }

    private func scrollToEnd() {
        let length = scrollback.textStorage?.length ?? 0
        scrollback.scrollRangeToVisible(NSRange(location: length, length: 0))
    }

    /// The scrollback as plain text (used by the self-test).
    var scrollbackText: String { scrollback.string }

    private static func attributedText(for chunk: ConsoleChunk) -> NSAttributedString {
        func run(_ text: String, _ color: NSColor, _ font: NSFont = ConsoleStyle.font) -> NSAttributedString {
            NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color])
        }
        let result = NSMutableAttributedString()
        switch chunk.kind {
        case .banner:
            result.append(run(chunk.text + "\n", ConsoleStyle.dim))
        case .echo(let prompt):
            result.append(run(prompt, ConsoleStyle.prompt, ConsoleStyle.emphasisFont))
            result.append(run(chunk.text + "\n", ConsoleStyle.command))
        case .output:
            // IOS-style diagnostics start with "%"; tint them so they stand out.
            for line in chunk.text.components(separatedBy: "\n") {
                let isDiagnostic = line.drop(while: { $0 == " " }).hasPrefix("%")
                result.append(run(line + "\n", isDiagnostic ? ConsoleStyle.error : ConsoleStyle.text))
            }
        case .notice:
            result.append(run(chunk.text + "\n", ConsoleStyle.dim))
        }
        return result
    }
}

/// The single-line command field. It exists as a type so the window can hand it the console field editor.
final class ConsoleInputField: NSTextField {
    override var acceptsFirstResponder: Bool { true }
}
