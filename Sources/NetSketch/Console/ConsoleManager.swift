import AppKit
import Observation
import NetSketchCore
import NetSketchCLI

/// One piece of the scrollback.
struct ConsoleChunk {
    enum Kind: Equatable {
        /// Greeting printed when the session starts.
        case banner
        /// A command line as it was entered; `prompt` is the prompt it was typed at.
        case echo(prompt: String)
        /// What the device answered.
        case output
        /// A line added by the terminal itself.
        case notice
    }

    var kind: Kind
    var text: String
}

/// Everything about one device console that outlives its window: the CLI session (and with
/// it the mode the user left it in), the scrollback and the command history.
@MainActor
final class ConsoleModel {
    static let maxChunks = 3000
    static let maxHistory = 300

    let deviceID: UUID
    private let session: CLISession
    private(set) var chunks: [ConsoleChunk] = []
    /// Bumped when old scrollback is dropped, so the view re-renders from scratch.
    private(set) var generation = 0

    private var history: [String] = []
    /// Index into `history` while browsing with the arrow keys; nil while typing a new line.
    private var historyCursor: Int?
    private var stashedLine = ""

    init(store: ProjectStore, deviceID: UUID) {
        self.deviceID = deviceID
        session = CLISession(store: store, deviceID: deviceID)
        let banner = session.banner.trimmingCharacters(in: .newlines)
        if !banner.isEmpty { append(.banner, banner) }
    }

    var prompt: String { session.prompt }
    var isClosed: Bool { session.isClosed }

    var dialectName: String {
        switch session.dialect {
        case .ios: return "Cisco IOS"
        case .dellOS9: return "Dell OS9"
        case .routerOS: return "MikroTik RouterOS"
        case .generic: return "obecný"
        case .host: return "příkazový řádek"
        }
    }

    var footerText: String {
        "Dialekt: \(dialectName)   ·   Tab doplní   ·   ? nápověda   ·   ↑↓ historie   ·   Ctrl-C zruší řádek   ·   Ctrl-Z end   ·   ping a traceroute podle diagramu"
    }

    // MARK: Commands

    /// Executes one line and records the prompt, the command and the answer.
    func submit(_ line: String) {
        append(.echo(prompt: session.prompt), line)
        remember(line)
        appendOutput(session.execute(line))
    }

    /// IOS-style "?": prints the help for what has been typed, the line itself stays as it is.
    func showHelp(for line: String) {
        append(.echo(prompt: session.prompt), line + "?")
        appendOutput(session.help(line))
    }

    /// Tab completion. Returns the new content of the input line.
    func complete(_ line: String) -> String {
        let candidates = session.complete(line)
        guard !candidates.isEmpty else { return line }
        if candidates.count == 1 {
            // "address=" waits for its value right after the "=".
            let separator = candidates[0].hasSuffix("=") ? "" : " "
            return Self.applying(completion: candidates[0], to: line) + separator
        }
        // Several candidates: list them like IOS does and keep the line.
        append(.echo(prompt: session.prompt), line)
        appendOutput(candidates.joined(separator: "  "))
        return line
    }

    /// Replaces the word being typed with `completion`. A completion that already repeats
    /// the whole line is taken as it is.
    static func applying(completion: String, to line: String) -> String {
        if !line.isEmpty, completion.lowercased().hasPrefix(line.lowercased()) { return completion }
        guard let lastSpace = line.lastIndex(where: { $0 == " " }) else { return completion }
        return String(line[...lastSpace]) + completion
    }

    /// Ctrl-C: the typed line is abandoned.
    func interrupt(_ line: String) {
        append(.echo(prompt: session.prompt), line + "^C")
        historyCursor = nil
        stashedLine = ""
    }

    /// Ctrl-Z: same as typing `end`.
    func end() {
        append(.echo(prompt: session.prompt), "^Z")
        appendOutput(session.execute("end"))
        historyCursor = nil
    }

    // MARK: History

    /// The previous command (arrow up); nil when there is none.
    func historyPrevious(current: String) -> String? {
        guard !history.isEmpty else { return nil }
        if let cursor = historyCursor {
            guard cursor > 0 else { return nil }
            historyCursor = cursor - 1
            return history[cursor - 1]
        }
        stashedLine = current
        historyCursor = history.count - 1
        return history[history.count - 1]
    }

    /// The next command (arrow down); past the newest one the line being typed comes back.
    func historyNext() -> String? {
        guard let cursor = historyCursor else { return nil }
        if cursor + 1 < history.count {
            historyCursor = cursor + 1
            return history[cursor + 1]
        }
        historyCursor = nil
        return stashedLine
    }

    private func remember(_ line: String) {
        historyCursor = nil
        stashedLine = ""
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, history.last != trimmed else { return }
        history.append(trimmed)
        if history.count > Self.maxHistory { history.removeFirst(history.count - Self.maxHistory) }
    }

    // MARK: Scrollback

    private func appendOutput(_ text: String) {
        var output = text
        while output.hasSuffix("\n") { output.removeLast() }
        guard !output.isEmpty else { return }
        append(.output, output)
    }

    private func append(_ kind: ConsoleChunk.Kind, _ text: String) {
        chunks.append(ConsoleChunk(kind: kind, text: text))
        if chunks.count > Self.maxChunks {
            chunks.removeFirst(chunks.count - Self.maxChunks * 3 / 4)
            generation += 1
        }
    }
}

/// A console window: plain AppKit, so key handling and focus do not depend on SwiftUI scenes.
@MainActor
final class ConsoleWindowController: NSObject, NSWindowDelegate {
    let window: NSWindow
    let terminal: ConsoleViewController
    var onClose: (() -> Void)?

    private static var cascadePoint = NSPoint.zero

    init(model: ConsoleModel, title: String) {
        terminal = ConsoleViewController(model: model)
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 780, height: 480),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        super.init()
        window.isReleasedWhenClosed = false
        window.contentViewController = terminal
        window.setContentSize(NSSize(width: 780, height: 480))
        window.contentMinSize = NSSize(width: 480, height: 260)
        window.title = title
        window.tabbingMode = .disallowed
        window.isRestorable = false
        // The terminal is dark in both appearances; keep the title bar in line with it.
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = ConsoleStyle.background
        window.delegate = self
        if Self.cascadePoint == .zero {
            window.center()
            Self.cascadePoint = NSPoint(x: window.frame.minX, y: window.frame.maxY)
        }
        Self.cascadePoint = window.cascadeTopLeft(from: Self.cascadePoint)
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        terminal.focusInput()
    }

    func close() {
        window.close()
    }

    func setTitle(_ title: String) {
        if window.title != title { window.title = title }
    }

    // MARK: NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        onClose?()
    }

    func windowWillReturnFieldEditor(_ sender: NSWindow, to client: Any?) -> Any? {
        terminal.ownsFieldEditorClient(client) ? terminal.fieldEditor : nil
    }

    func windowDidBecomeKey(_ notification: Notification) {
        if window.firstResponder === window { terminal.focusInput() }
    }
}

/// Owns the console sessions and windows of all devices.
///
/// A session lives as long as its device (closing the window keeps the CLI mode and the
/// scrollback). When a device disappears - deleted, undone, another project opened - its
/// window is closed and its session dropped. Titles and prompts follow renames.
@MainActor
final class ConsoleManager {
    private let store: ProjectStore
    private var models: [UUID: ConsoleModel] = [:]
    private var windows: [UUID: ConsoleWindowController] = [:]

    init(store: ProjectStore) {
        self.store = store
        observeProject()
    }

    func supportsConsole(_ device: Device) -> Bool {
        CLI.supportsConsole(device)
    }

    /// Opens the console of a device, or brings its window to the front.
    func open(deviceID: UUID) {
        guard let device = store.project.device(id: deviceID), supportsConsole(device) else { return }
        if let existing = windows[deviceID] {
            existing.show()
            return
        }
        let model = models[deviceID] ?? ConsoleModel(store: store, deviceID: deviceID)
        models[deviceID] = model
        let controller = ConsoleWindowController(model: model, title: Self.title(for: device))
        controller.onClose = { [weak self] in
            self?.windows[deviceID] = nil
        }
        controller.terminal.onSessionClosed = { [weak self] in
            self?.sessionEnded(deviceID)
        }
        windows[deviceID] = controller
        controller.show()
    }

    /// The window of a device's console, if it is open.
    func controller(for deviceID: UUID) -> ConsoleWindowController? {
        windows[deviceID]
    }

    var openConsoleCount: Int { windows.count }
    var sessionCount: Int { models.count }

    static func title(for device: Device) -> String {
        "Konzole — \(device.hostname)"
    }

    /// `exit` at the top level: the window goes away and the next open starts a fresh session.
    private func sessionEnded(_ deviceID: UUID) {
        models[deviceID] = nil
        guard let controller = windows[deviceID] else { return }
        // Not from inside the key event that is still being handled by this very window.
        DispatchQueue.main.async { controller.close() }
    }

    // MARK: Following the project

    private func observeProject() {
        withObservationTracking {
            _ = store.project
        } onChange: { [weak self] in
            // onChange fires before the new value is in place; look at it on the next turn.
            DispatchQueue.main.async {
                guard let self else { return }
                self.projectDidChange()
                self.observeProject()
            }
        }
    }

    private func projectDidChange() {
        guard !models.isEmpty || !windows.isEmpty else { return }
        var devices: [UUID: Device] = [:]
        for device in store.project.devices { devices[device.id] = device }

        for (id, controller) in windows {
            if let device = devices[id] {
                controller.setTitle(Self.title(for: device))
                controller.terminal.refresh()
            } else {
                controller.close()
            }
        }
        for id in Array(models.keys) where devices[id] == nil {
            models[id] = nil
        }
    }
}
