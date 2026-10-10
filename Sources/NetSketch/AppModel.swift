import AppKit
import SwiftUI
import UniformTypeIdentifiers
import NetSketchCore
import NetSketchCanvas

/// A message shown as an alert on the main window.
struct AppAlert: Identifiable {
    let id = UUID()
    var title: String
    var message: String
}

/// What the custom-device sheet is editing.
enum DeviceEditorRequest: Identifiable {
    /// A blank custom device.
    case new
    /// Change an existing custom device in place.
    case edit(DeviceTemplate)
    /// A new custom device pre-filled from another template (built-in or custom).
    case duplicate(DeviceTemplate)

    var id: String {
        switch self {
        case .new: return "new"
        case .edit(let template): return "edit:" + template.id
        case .duplicate(let template): return "duplicate:" + template.id
        }
    }
}

/// Answer to "the project has unsaved changes".
enum DiscardChoice {
    case save, discard, cancel
}

/// App-level state and commands shared by the window, the menus and the app delegate.
/// The document itself lives in `store`; this class only adds what the shell needs around it.
@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    let store: ProjectStore
    let viewport = CanvasViewport()
    @ObservationIgnored private(set) lazy var consoles = ConsoleManager(store: store)

    var isInspectorVisible = true
    var alert: AppAlert?
    var deviceEditor: DeviceEditorRequest?

    @ObservationIgnored private(set) weak var mainWindow: NSWindow?
    @ObservationIgnored private var closeGuard: WindowCloseGuard?
    @ObservationIgnored private var eventMonitor: Any?
    @ObservationIgnored private var closeObserver: NSObjectProtocol?
    /// Set once the user agreed to lose (or saved) the changes on the way out, so quitting asks only once.
    @ObservationIgnored var terminationConfirmed = false
    /// Replaces the "save changes?" dialog; used by the self-test only.
    @ObservationIgnored var discardChoiceOverride: (() -> DiscardChoice)?

    init(store: ProjectStore = ProjectStore()) {
        self.store = store
    }

    // MARK: Launch

    func applicationDidFinishLaunching() {
        installEventMonitor()
        _ = consoles
        reportCatalogIssues()
        if let url = Self.startupFileURL() {
            open(url: url)
        }
    }

    /// The first command-line argument that is not an option, taken as a project file path.
    static func startupFileURL(arguments: [String] = CommandLine.arguments) -> URL? {
        let args = Array(arguments.dropFirst())
        for (index, arg) in args.enumerated() {
            if arg.hasPrefix("-") { continue }
            // Skip the value of a Cocoa defaults option such as "-AppleLanguages (cs)".
            if index > 0, args[index - 1].hasPrefix("-"), !args[index - 1].hasPrefix("--") { continue }
            return URL(fileURLWithPath: (arg as NSString).expandingTildeInPath)
        }
        return nil
    }

    private func reportCatalogIssues() {
        let catalog = store.catalog
        if catalog.templates.isEmpty {
            alert = AppAlert(
                title: "Katalog zařízení je prázdný",
                message: "Soubor devices.json se nepodařilo najít nebo načíst. Vlastní zařízení lze přidat tlačítkem „Nové zařízení…“."
                    + (catalog.loadIssues.isEmpty ? "" : "\n\n" + catalog.loadIssues.joined(separator: "\n"))
            )
        } else if !catalog.loadIssues.isEmpty {
            alert = AppAlert(
                title: "Katalog zařízení se nenačetl celý",
                message: catalog.loadIssues.joined(separator: "\n")
            )
        }
    }

    // MARK: Errors

    func present(_ error: Error, title: String) {
        alert = AppAlert(title: title, message: CzechText.message(for: error, in: store.project))
    }

    /// Runs an editing operation and shows its error, if any. Returns true on success.
    @discardableResult
    func perform(_ title: String = "Akci nelze provést", _ body: () throws -> Void) -> Bool {
        do {
            try body()
            return true
        } catch {
            present(error, title: title)
            return false
        }
    }

    // MARK: Document

    /// File name without extension, the project name, or a placeholder.
    var documentName: String {
        if let url = store.fileURL { return url.deletingPathExtension().lastPathComponent }
        let name = store.project.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "Bez názvu" : name
    }

    var windowTitle: String {
        let name = store.fileURL?.lastPathComponent ?? documentName
        return store.isDirty ? name + " — upraveno" : name
    }

    func newDocument() {
        guard confirmDiscardingChanges() else { return }
        store.new()
        viewport.zoom = 1
        viewport.offset = .zero
    }

    func openDocument() {
        guard confirmDiscardingChanges() else { return }
        guard let url = FilePanels.chooseProjectToOpen() else { return }
        open(url: url)
    }

    /// Opens a file handed over by Finder while the app is running.
    func openExternally(_ url: URL) {
        // AppKit also reports a path given on the command line; that file is already open.
        if let current = store.fileURL, !store.isDirty,
           current.standardizedFileURL == url.standardizedFileURL { return }
        guard confirmDiscardingChanges() else { return }
        open(url: url)
    }

    /// Opens `url` without asking about unsaved changes.
    func open(url: URL) {
        do {
            try store.open(url)
        } catch {
            present(error, title: "Soubor „\(url.lastPathComponent)“ se nepodařilo otevřít")
            return
        }
        let issues = store.openIssues
        if !issues.isEmpty {
            var kinds: [String] = []
            for issue in issues {
                let text = CzechText.describe(issue)
                if !kinds.contains(text) { kinds.append(text) }
            }
            alert = AppAlert(
                title: "Soubor obsahoval nekonzistence",
                message: "Při otevření bylo opraveno \(issues.count) "
                    + CzechText.plural(issues.count, "nekonzistence", "nekonzistence", "nekonzistencí")
                    + " (" + kinds.joined(separator: ", ") + "). "
                    + "Chybné objekty byly vynechány; původní soubor se změní až po uložení."
            )
        }
        // The canvas learns its content after the next layout pass; fit the view then.
        DispatchQueue.main.async { [viewport] in viewport.fit() }
    }

    @discardableResult
    func save() -> Bool {
        guard store.fileURL != nil else { return saveAs() }
        return perform("Projekt se nepodařilo uložit") { try store.save() }
    }

    @discardableResult
    func saveAs() -> Bool {
        guard let url = FilePanels.chooseProjectDestination(
            suggestedName: documentName,
            directory: store.fileURL?.deletingLastPathComponent()
        ) else { return false }
        return perform("Projekt se nepodařilo uložit") { try store.save(to: url) }
    }

    /// Asks what to do with unsaved changes. Returns true when it is fine to throw the
    /// current project away (nothing to lose, saved, or the user chose not to save).
    func confirmDiscardingChanges() -> Bool {
        guard store.isDirty else { return true }
        let choice: DiscardChoice
        if let override = discardChoiceOverride {
            choice = override()
        } else {
            let dialog = NSAlert()
            dialog.alertStyle = .warning
            dialog.messageText = "Chcete uložit změny v projektu „\(documentName)“?"
            dialog.informativeText = "Pokud změny neuložíte, budou ztraceny."
            dialog.addButton(withTitle: "Uložit")
            dialog.addButton(withTitle: "Zrušit")
            dialog.addButton(withTitle: "Neukládat")
            switch dialog.runModal() {
            case .alertFirstButtonReturn: choice = .save
            case .alertThirdButtonReturn: choice = .discard
            default: choice = .cancel
            }
        }
        switch choice {
        case .save: return save()
        case .discard: return true
        case .cancel: return false
        }
    }

    // MARK: Export

    func exportPNG() {
        guard let data = CanvasExporter.pngData(store: store, scale: 2) else {
            alert = AppAlert(title: "Export do PNG se nezdařil", message: "Projekt je prázdný nebo se obrázek nepodařilo vykreslit.")
            return
        }
        write(data, as: .png, title: "Exportovat jako PNG")
    }

    func exportPDF() {
        guard let data = CanvasExporter.pdfData(store: store) else {
            alert = AppAlert(title: "Export do PDF se nezdařil", message: "Projekt je prázdný nebo se dokument nepodařilo vykreslit.")
            return
        }
        write(data, as: .pdf, title: "Exportovat jako PDF")
    }

    private func write(_ data: Data, as type: UTType, title: String) {
        guard let url = FilePanels.chooseExportDestination(suggestedName: documentName, type: type, title: title) else { return }
        perform("Export se nepodařilo uložit") { try data.write(to: url, options: .atomic) }
    }

    // MARK: Editing commands

    /// Cmd+Z outside of text fields: the store's own history.
    func undo() { store.undo() }

    func redo() { store.redo() }

    func deleteSelection() {
        guard !store.selection.isEmpty else { return }
        store.removeSelection()
    }

    func selectAll() { store.selectAll() }

    /// Adds a device from the catalog at a free spot near the middle of the visible canvas.
    func addDevice(templateID: String) {
        let point = freeSpot(near: visibleCenter)
        perform("Zařízení nelze přidat") {
            let device = try store.addDevice(templateID: templateID, at: point)
            store.selection = [.device(device.id)]
        }
    }

    /// Adds a text label near the middle of the visible canvas and selects it for editing.
    func addAnnotation() {
        let center = visibleCenter
        let point = freeSpot(near: CGPoint(x: center.x - 60, y: center.y - 120))
        let annotation = store.addAnnotation(text: "Poznámka", at: point)
        store.selection = [.annotation(annotation.id)]
        isInspectorVisible = true
    }

    /// Groups the selected links into a bundle (LAG). Returns true on success.
    @discardableResult
    func bundleSelectedLinks(label: String? = nil) -> Bool {
        let ids = store.selectedLinkIDs
        return perform("Kabely nelze seskupit") {
            try store.createBundle(linkIDs: ids, label: label)
        }
    }

    /// Dissolves every bundle that has a member among the selected links.
    func unbundleSelectedLinks() {
        let bundleIDs = Set(store.selectedLinkIDs.compactMap { store.bundle(ofLink: $0)?.id })
        guard !bundleIDs.isEmpty else { return }
        store.beginUndoGroup()
        defer { store.endUndoGroup() }
        for id in bundleIDs {
            guard perform("Svazek nelze zrušit", { try store.unbundle(id: id) }) else { return }
        }
    }

    var canBundleSelection: Bool { store.selectedLinkIDs.count >= 2 }

    var selectionHasBundle: Bool {
        store.selectedLinkIDs.contains { store.bundle(ofLink: $0) != nil }
    }

    /// The device when exactly one device (and nothing else) is selected.
    var singleSelectedDevice: Device? {
        guard store.selection.count == 1, case .device(let id)? = store.selection.first else { return nil }
        return store.project.device(id: id)
    }

    private var visibleCenter: CGPoint {
        let size = viewport.viewSize
        guard size.width > 0, size.height > 0 else { return CGPoint(x: 400, y: 300) }
        return viewport.canvasPoint(fromView: CGPoint(x: size.width / 2, y: size.height / 2))
    }

    /// Steps diagonally away from `point` until nothing sits (almost) exactly there.
    private func freeSpot(near point: CGPoint) -> CGPoint {
        var candidate = point
        for _ in 0..<40 {
            let occupied = store.project.devices.contains { isClose($0.position, candidate) }
                || store.project.annotations.contains { isClose($0.position, candidate) }
            if !occupied { break }
            candidate.x += 40
            candidate.y += 40
        }
        return candidate
    }

    private func isClose(_ a: CGPoint, _ b: CGPoint) -> Bool {
        abs(a.x - b.x) < 30 && abs(a.y - b.y) < 30
    }

    // MARK: Console

    /// Why the console of this device cannot be opened; nil when it can.
    func consoleUnavailableReason(for device: Device) -> String? {
        consoles.supportsConsole(device) ? nil : "Toto zařízení nemá konfigurační konzoli."
    }

    func openConsole(deviceID: UUID) {
        guard let device = store.project.device(id: deviceID) else { return }
        if let reason = consoleUnavailableReason(for: device) {
            alert = AppAlert(title: "Konzoli nelze otevřít", message: reason)
            return
        }
        consoles.open(deviceID: deviceID)
    }

    func openConsoleForSelection() {
        guard let device = singleSelectedDevice else { return }
        openConsole(deviceID: device.id)
    }

    // MARK: Main window

    /// Called by the window accessor whenever the root view (re)attaches or updates.
    func attachMainWindow(_ window: NSWindow) {
        if mainWindow !== window {
            mainWindow = window
            window.tabbingMode = .disallowed
            if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) }
            closeObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.willCloseNotification, object: window, queue: .main
            ) { _ in
                // The main window is the document; without it the app has nothing to show.
                DispatchQueue.main.async { NSApp.terminate(nil) }
            }
            DispatchQueue.main.async { [weak self, weak window] in
                guard let self, let window else { return }
                self.installCloseGuard(on: window)
            }
        }
        installCloseGuard(on: window)
        window.isDocumentEdited = store.isDirty
        window.representedURL = store.fileURL
    }

    /// Wraps whatever delegate SwiftUI installed so that closing asks about unsaved changes.
    private func installCloseGuard(on window: NSWindow) {
        guard !(window.delegate is WindowCloseGuard) else { return }
        let guardDelegate = WindowCloseGuard(original: window.delegate) { [weak self] in
            self?.mainWindowMayClose() ?? true
        }
        closeGuard = guardDelegate
        window.delegate = guardDelegate
    }

    private func mainWindowMayClose() -> Bool {
        if terminationConfirmed { return true }
        guard confirmDiscardingChanges() else { return false }
        terminationConfirmed = true
        return true
    }

    /// Used by the app delegate when quitting.
    func mayTerminate() -> Bool {
        if terminationConfirmed { return true }
        guard confirmDiscardingChanges() else { return false }
        terminationConfirmed = true
        return true
    }

    // MARK: Keys that must not collide with text editing

    private func installEventMonitor() {
        guard eventMonitor == nil else { return }
        eventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown]) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self else { return event }
                return self.intercept(event)
            }
        }
    }

    /// Plain-key shortcuts of the canvas (Delete, Cmd+A) and the split between text undo and
    /// project undo are decided here, by looking at what currently has keyboard focus.
    /// A menu key equivalent could not make that distinction reliably.
    func intercept(_ event: NSEvent) -> NSEvent? {
        guard let window = event.window else { return event }
        let responder = window.firstResponder
        let isEditingText = responder?.isTextInput ?? false

        if event.type == .leftMouseDown {
            // Clicking outside the text field being edited ends the edit (and commits it),
            // so a following Delete goes to the canvas selection and not into the field.
            if window === mainWindow, isEditingText, let editor = responder as? NSView {
                let location = editor.convert(event.locationInWindow, from: nil)
                if !editor.bounds.contains(location) { window.makeFirstResponder(nil) }
            }
            return event
        }

        let flags = event.modifierFlags.intersection([.command, .control, .option, .shift])

        if isEditingText {
            // Cmd+Z / Cmd+Shift+Z inside a text field undo typing, never a canvas operation.
            if event.charactersIgnoringModifiers?.lowercased() == "z",
               flags == [.command] || flags == [.command, .shift],
               let textView = responder as? NSTextView {
                if flags.contains(.shift) {
                    if textView.undoManager?.canRedo == true { textView.undoManager?.redo() }
                } else if textView.undoManager?.canUndo == true {
                    textView.undoManager?.undo()
                }
                return nil
            }
            return event
        }

        guard window === mainWindow, window.attachedSheet == nil else { return event }

        let isDeleteKey = event.keyCode == 51 || event.keyCode == 117
        if isDeleteKey, flags.subtracting(.shift).isEmpty {
            guard !store.selection.isEmpty else { return event }
            deleteSelection()
            return nil
        }
        if flags == [.command], event.charactersIgnoringModifiers?.lowercased() == "a" {
            selectAll()
            return nil
        }
        return event
    }
}
