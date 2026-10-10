import AppKit
import NetSketchCore
import NetSketchCanvas
import NetSketchCLI

/// `--selftest`: a smoke test of the assembled app.
///
/// It drives the real window, canvas, sheets and console windows through the main workflows
/// without any user input, prints one line per check to standard output and quits with exit
/// code 0 when everything passed, 1 otherwise:
///
///     swift run NetSketch --selftest
///
/// It never asks anything (unsaved changes are discarded), writes files only into a fresh
/// temporary directory and only reads the device catalog (no custom devices are stored).
@MainActor
enum SelfTest {
    static let argument = "--selftest"

    /// Called by the app delegate once launching has finished.
    static func runIfRequested(arguments: [String] = CommandLine.arguments) {
        guard arguments.contains(argument) else { return }
        Task { @MainActor in
            let runner = SelfTestRunner(model: AppModel.shared)
            let passed = await runner.run()
            exit(passed ? 0 : 1)
        }
    }
}

@MainActor
private final class SelfTestRunner {
    private let model: AppModel
    private var store: ProjectStore { model.store }
    private var passed = 0
    private var failed = 0

    init(model: AppModel) {
        self.model = model
    }

    /// Runs every check; true when all of them passed.
    func run() async -> Bool {
        report("NetSketch self-test")
        model.discardChoiceOverride = { .discard }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NetSketch-selftest-" + UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        checkHelpers()
        await waitForMainWindow()
        await checkWorkflows(directory: directory)

        model.newDocument()
        report(failed == 0
               ? "all \(passed) checks passed"
               : "\(failed) of \(passed + failed) checks FAILED")
        return failed == 0
    }

    // MARK: Reporting

    private func check(_ name: String, _ condition: () throws -> Bool) {
        let ok: Bool
        var detail = ""
        do {
            ok = try condition()
        } catch {
            ok = false
            detail = " (" + CzechText.message(for: error, in: store.project) + ")"
        }
        if ok { passed += 1 } else { failed += 1 }
        report((ok ? "ok    " : "FAIL  ") + name + detail)
    }

    private func report(_ line: String) {
        FileHandle.standardOutput.write(Data(("selftest: " + line + "\n").utf8))
    }

    /// Lets the run loop deliver what the app does asynchronously (observation, closing windows, sheets).
    private func settle(_ seconds: Double = 0.25) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    // MARK: Pure helpers

    private func checkHelpers() {
        check("project file named on the command line") {
            let url = AppModel.startupFileURL(arguments: ["NetSketch", "--selftest", "-AppleLanguages", "(cs)", "/tmp/a.netsketch"])
            return url?.path == "/tmp/a.netsketch"
                && AppModel.startupFileURL(arguments: ["NetSketch", "--selftest"]) == nil
        }
        check("file name extensions") {
            FilePanels.withExtension("Cvičení 3.1", "netsketch") == "Cvičení 3.1.netsketch"
                && FilePanels.withExtension("lab.NETSKETCH", "netsketch") == "lab.NETSKETCH"
        }
        check("Czech plurals") {
            CzechText.ports(1) == "1 port" && CzechText.ports(3) == "3 porty" && CzechText.ports(24) == "24 portů"
        }
        check("Tab completion replaces the word being typed") {
            ConsoleModel.applying(completion: "configure", to: "conf") == "configure"
                && ConsoleModel.applying(completion: "running-config", to: "show run") == "show running-config"
        }
        check("custom-device form validates its input") {
            var draft = DeviceEditorModel(request: .new)
            let refusedEmpty = !draft.problems.isEmpty
            draft.model = "Self-test Switch"
            return refusedEmpty && draft.problems.isEmpty && draft.template(newID: "selftest").portCount == 25
        }
    }

    // MARK: The app

    private func waitForMainWindow() async {
        for _ in 0..<50 where model.mainWindow == nil {
            await settle(0.1)
        }
        check("main window is open") { model.mainWindow?.isVisible == true }
        // A launch alert (e.g. catalog problems) would sit on the window as a sheet.
        model.alert = nil
        await settle()
    }

    private func checkWorkflows(directory: URL) async {
        model.newDocument()
        check("new project is empty and clean") {
            store.project.devices.isEmpty && !store.isDirty && store.fileURL == nil
        }

        let templates = store.catalog.templates
        check("device catalog is loaded") { !templates.isEmpty }
        guard let networkTemplate = Self.consoleTemplate(in: templates),
              let endTemplate = templates.first(where: { !CLI.supportsConsole(Self.sample($0)) }) else {
            check("catalog has an IOS-style switch or router and an end device") { false }
            return
        }

        // Palette: a double click adds the device at a free spot and selects it.
        model.addDevice(templateID: networkTemplate.id)
        let addedNetwork = model.singleSelectedDevice
        model.addDevice(templateID: endTemplate.id)
        let addedEnd = model.singleSelectedDevice
        guard let network = addedNetwork, let end = addedEnd, network.id != end.id else {
            check("devices from the palette are added and selected") { false }
            return
        }
        check("devices from the palette are added, selected and placed apart") {
            store.project.devices.count == 2 && store.isDirty && network.position != end.position
        }
        check("console is offered only for network devices") {
            model.consoleUnavailableReason(for: network) == nil && model.consoleUnavailableReason(for: end) != nil
        }
        check("cable between the devices; undo and redo") {
            guard let a = Self.freePorts(of: network.id, in: store).first,
                  let b = Self.freePorts(of: end.id, in: store).first else { return false }
            try store.connect(a, b)
            let connected = store.project.links.count == 1
            model.undo()
            let undone = store.project.links.isEmpty
            model.redo()
            return connected && undone && store.project.links.count == 1
        }

        await checkConsole(deviceID: network.id)
        await checkCanvasKeys(deviceID: end.id)

        check("two parallel cables form a bundle (LAG) and dissolve again") {
            model.addDevice(templateID: networkTemplate.id)
            guard let second = model.singleSelectedDevice else { return false }
            let left = Self.freePorts(of: network.id, in: store)
            let right = Self.freePorts(of: second.id, in: store)
            guard left.count >= 2, right.count >= 2 else { return false }
            let first = try store.connect(left[0], right[0])
            let other = try store.connect(left[1], right[1])
            store.selection = [.link(first.id), .link(other.id)]
            guard model.canBundleSelection, model.bundleSelectedLinks() else { return false }
            let bundled = store.project.bundles.count == 1 && model.selectionHasBundle
            model.unbundleSelectedLinks()
            return bundled && store.project.bundles.isEmpty
        }

        model.addAnnotation()
        check("note is added and selected") {
            store.project.annotations.count == 1 && store.selectedAnnotationIDs.count == 1
        }
        check("logical and physical view") {
            store.viewMode = .logical
            let logical = store.viewMode == .logical
            store.viewMode = .physical
            return logical && store.viewMode == .physical
        }
        check("zoom in and back to 100 %") {
            model.viewport.zoomIn()
            let zoomed = model.viewport.zoomPercent > 100
            model.viewport.reset()
            return zoomed && model.viewport.zoomPercent == 100
        }
        check("PNG export") {
            guard let data = CanvasExporter.pngData(store: store, scale: 2) else { return false }
            return data.starts(with: [0x89, 0x50, 0x4E, 0x47])
        }
        check("PDF export") {
            guard let data = CanvasExporter.pdfData(store: store) else { return false }
            return data.starts(with: Array("%PDF".utf8))
        }

        model.alert = nil
        model.deviceEditor = .duplicate(networkTemplate)
        await settle(0.8)
        check("custom-device sheet opens") { model.mainWindow?.attachedSheet != nil }
        model.deviceEditor = nil
        await settle(0.8)
        check("custom-device sheet closes") { model.mainWindow?.attachedSheet == nil }

        checkFiles(directory: directory)
    }

    private func checkConsole(deviceID: UUID) async {
        let consoles = model.consoles
        store.selection = [.device(deviceID)]
        model.openConsoleForSelection()
        await settle()
        guard let console = consoles.controller(for: deviceID) else {
            check("console window opens for the selected device") { false }
            return
        }
        check("console window opens for the selected device") {
            console.window.isVisible && consoles.openConsoleCount == 1 && consoles.sessionCount == 1
        }
        let terminal = console.terminal
        let originalName = store.project.device(id: deviceID)?.hostname ?? ""

        enter("enable", in: terminal)
        terminal.inputText = "conf"
        _ = terminal.handleConsoleKey(.tab)
        check("Tab completes a command") { terminal.inputText.hasPrefix("configure") }

        enter("configure terminal", in: terminal)
        enter("hostname SELFTEST", in: terminal)
        check("hostname typed in the console renames the device") {
            store.project.device(id: deviceID)?.hostname == "SELFTEST" && terminal.model.prompt.hasPrefix("SELFTEST")
        }
        check("scrollback shows the commands") { terminal.scrollbackText.contains("hostname SELFTEST") }

        let lengthBeforeHelp = terminal.scrollbackText.count
        terminal.inputText = ""
        _ = terminal.handleConsoleKey(.help)
        check("? lists the commands of the mode") { terminal.scrollbackText.count > lengthBeforeHelp }

        terminal.inputText = "no such"
        _ = terminal.handleConsoleKey(.interrupt)
        check("Ctrl-C abandons the line") {
            terminal.inputText.isEmpty && terminal.scrollbackText.contains("no such^C")
        }

        _ = terminal.handleConsoleKey(.historyUp)
        let recalled = terminal.inputText
        _ = terminal.handleConsoleKey(.historyDown)
        check("arrow keys browse the history") { recalled == "hostname SELFTEST" && terminal.inputText.isEmpty }

        _ = terminal.handleConsoleKey(.end)
        check("Ctrl-Z leaves the configuration mode") { !terminal.model.prompt.contains("(config") }

        await settle()
        check("console title follows the hostname") {
            guard let device = store.project.device(id: deviceID) else { return false }
            return console.window.title == ConsoleManager.title(for: device)
        }
        check("undo reverts a console command, redo applies it again") {
            model.undo()
            let reverted = store.project.device(id: deviceID)?.hostname == originalName
            model.redo()
            return reverted && store.project.device(id: deviceID)?.hostname == "SELFTEST"
        }

        for _ in 0..<5 where !terminal.model.isClosed {
            enter("exit", in: terminal)
        }
        await settle()
        check("exit closes the console window and ends the session") {
            terminal.model.isClosed && consoles.openConsoleCount == 0 && consoles.sessionCount == 0
        }

        model.openConsole(deviceID: deviceID)
        await settle()
        check("console reopens with a fresh session") {
            consoles.openConsoleCount == 1 && consoles.controller(for: deviceID)?.terminal.model.isClosed == false
        }
        store.selection = [.device(deviceID)]
        model.deleteSelection()
        await settle()
        check("deleting the device closes its console") {
            store.project.device(id: deviceID) == nil && consoles.openConsoleCount == 0 && consoles.sessionCount == 0
        }
        model.undo()
        check("undo brings the device back with its cable") {
            store.project.device(id: deviceID) != nil && store.project.links.count == 1
        }
    }

    /// Delete and Cmd+A reach the canvas selection through `AppModel.intercept(_:)`.
    private func checkCanvasKeys(deviceID: UUID) async {
        guard let window = model.mainWindow else { return }
        window.makeKeyAndOrderFront(nil)
        await settle()
        window.makeFirstResponder(nil)
        store.selection = [.device(deviceID)]
        let delete = NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber, context: nil, characters: "\u{7F}", charactersIgnoringModifiers: "\u{7F}",
            isARepeat: false, keyCode: 51
        )
        check("Delete key deletes the canvas selection") {
            guard let delete else { return false }
            return model.intercept(delete) == nil && store.project.device(id: deviceID) == nil
        }
        model.undo()

        let selectAll = NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber, context: nil, characters: "a", charactersIgnoringModifiers: "a",
            isARepeat: false, keyCode: 0
        )
        check("Cmd+A selects everything on the canvas") {
            guard let selectAll else { return false }
            let project = store.project
            return model.intercept(selectAll) == nil
                && store.selection.count == project.devices.count + project.links.count + project.annotations.count
        }
    }

    private func checkFiles(directory: URL) {
        let url = directory.appendingPathComponent("selftest.netsketch")
        check("save writes the project file") {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try store.save(to: url)
            return !store.isDirty && store.fileURL == url && FileManager.default.fileExists(atPath: url.path)
        }
        check("window title names the file") { model.windowTitle == "selftest.netsketch" }

        let saved = store.project
        model.newDocument()
        check("new project replaces the saved one") { store.project.devices.isEmpty && store.fileURL == nil }
        model.open(url: url)
        check("open restores the saved project") {
            store.project == saved && store.fileURL == url && !store.isDirty && store.openIssues.isEmpty
        }
        check("unsaved changes are not thrown away without asking") {
            store.renameProject(to: "Self-test")
            model.discardChoiceOverride = { .cancel }
            let kept = !model.confirmDiscardingChanges()
            model.discardChoiceOverride = { .discard }
            return store.isDirty && kept && model.confirmDiscardingChanges()
        }
    }

    // MARK: Helpers

    /// Types a line into the console and presses Return.
    private func enter(_ line: String, in terminal: ConsoleViewController) {
        terminal.inputText = line
        _ = terminal.handleConsoleKey(.enter)
    }

    /// A throwaway device of a template, for asking the CLI about it.
    private static func sample(_ template: DeviceTemplate) -> Device {
        template.makeDevice(hostname: "SELFTEST", at: .zero)
    }

    /// A Cisco (IOS) device with a console or, failing that, one with the generic IOS-style console.
    private static func consoleTemplate(in templates: [DeviceTemplate]) -> DeviceTemplate? {
        for dialect in [CLIDialect.ios, .generic] {
            let match = templates.first { template in
                let device = sample(template)
                return CLI.supportsConsole(device) && CLI.dialect(of: device) == dialect
            }
            if let match { return match }
        }
        return nil
    }

    /// The ports of a device without a cable (console ports left out), as references.
    private static func freePorts(of deviceID: UUID, in store: ProjectStore) -> [PortRef] {
        guard let device = store.project.device(id: deviceID) else { return [] }
        return device.ports
            .filter { $0.connector != .console && !store.isPortUsed(device.ref($0)) }
            .map { device.ref($0) }
    }
}
