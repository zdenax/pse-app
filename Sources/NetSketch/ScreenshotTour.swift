import AppKit
import NetSketchCore
import NetSketchCanvas

/// `--screenshots=DIR`: opens the exercises from `examples/` in the real window, types a few
/// commands into device consoles and saves PNG pictures of the windows into DIR, then quits.
///
/// Used by CI (macOS) to keep the README pictures current:
///
///     swift run NetSketch --screenshots=docs/screenshots
///
/// It never asks anything (unsaved changes are discarded) and writes only into DIR.
@MainActor
enum ScreenshotTour {
    static let prefix = "--screenshots="

    /// Called by the app delegate once launching has finished.
    static func runIfRequested(arguments: [String] = CommandLine.arguments) {
        guard let argument = arguments.first(where: { $0.hasPrefix(prefix) }) else { return }
        let directory = URL(fileURLWithPath: String(argument.dropFirst(prefix.count)), isDirectory: true)
        Task { @MainActor in
            let runner = ScreenshotTourRunner(model: AppModel.shared, directory: directory)
            let succeeded = await runner.run()
            exit(succeeded ? 0 : 1)
        }
    }
}

@MainActor
private final class ScreenshotTourRunner {
    private let model: AppModel
    private let directory: URL
    private var failures = 0
    private var store: ProjectStore { model.store }

    init(model: AppModel, directory: URL) {
        self.model = model
        self.directory = directory
    }

    func run() async -> Bool {
        model.discardChoiceOverride = { .discard }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            report("cannot create \(directory.path): \(error)")
            return false
        }
        for _ in 0..<50 where model.mainWindow == nil {
            await settle(0.1)
        }
        guard let window = model.mainWindow else {
            report("the main window did not open")
            return false
        }
        model.alert = nil
        window.setContentSize(NSSize(width: 1500, height: 900))
        window.center()
        window.makeKeyAndOrderFront(nil)
        await settle(0.5)

        let examples = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
            .appendingPathComponent("examples", isDirectory: true)

        // Exercise 2: four routers, consoles of a PC, a Cisco and a MikroTik router.
        await show(examples.appendingPathComponent("cviceni-2-ctyri-routery.netsketch"))
        capture(window, "aplikace-cviceni-2")
        if let pc = store.project.device(hostname: "PC1") {
            store.selection = [.device(pc.id)]
            await settle(0.4)
            capture(window, "aplikace-inspector-pc1")
        }
        await console("PC1", ["ipconfig", "ping 192.168.4.10", "tracert 192.168.4.10"], picture: "konzole-pc1")
        await console("R1-CISCO", ["enable", "show ip route", "ping 192.168.4.10"], picture: "konzole-r1-cisco")
        await console("R2-MIKROTIK", ["/ip address print", "/ip route print", "/ping 192.168.4.10 count=3"],
                      picture: "konzole-r2-mikrotik")

        // Exercise 1: four switches, physical and logical view.
        await show(examples.appendingPathComponent("cviceni-1-multivendor-switche.netsketch"))
        capture(window, "aplikace-cviceni-1")
        store.viewMode = .logical
        await settle(0.3)
        model.viewport.fit()
        await settle(0.4)
        capture(window, "aplikace-cviceni-1-logicky")
        await console("SW2-DELL", ["enable", "show ip route", "ping 192.168.10.3"], picture: "konzole-sw2-dell")

        model.newDocument()
        report(failures == 0 ? "all pictures written" : "\(failures) pictures FAILED")
        return failures == 0
    }

    // MARK: Steps

    private func show(_ url: URL) async {
        model.open(url: url)
        await settle(0.6)
        store.selection = []
        model.viewport.fit()
        await settle(0.6)
    }

    /// Opens the device's console, types the lines and takes a picture of the console window.
    private func console(_ hostname: String, _ lines: [String], picture: String) async {
        guard let device = store.project.device(hostname: hostname) else {
            report("no device \(hostname)")
            failures += 1
            return
        }
        model.openConsole(deviceID: device.id)
        await settle(0.5)
        guard let controller = model.consoles.controller(for: device.id) else {
            report("the console of \(hostname) did not open")
            failures += 1
            return
        }
        controller.window.setContentSize(NSSize(width: 860, height: 600))
        for line in lines {
            controller.terminal.inputText = line
            _ = controller.terminal.handleConsoleKey(.enter)
        }
        await settle(0.6)
        capture(controller.window, picture)
        controller.close()
        await settle(0.3)
    }

    // MARK: Pictures

    /// Draws the window's frame view (title bar included) into a PNG.
    private func capture(_ window: NSWindow, _ name: String) {
        guard let view = window.contentView?.superview ?? window.contentView else {
            report("no view to capture for \(name)")
            failures += 1
            return
        }
        view.layoutSubtreeIfNeeded()
        view.displayIfNeeded()
        let bounds = view.bounds
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: bounds) else {
            report("no bitmap for \(name)")
            failures += 1
            return
        }
        view.cacheDisplay(in: bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            report("PNG encoding failed for \(name)")
            failures += 1
            return
        }
        let url = directory.appendingPathComponent(name + ".png")
        do {
            try data.write(to: url, options: .atomic)
            report("written \(url.path)")
        } catch {
            report("cannot write \(url.path): \(error)")
            failures += 1
        }
    }

    private func report(_ line: String) {
        FileHandle.standardOutput.write(Data(("screenshots: " + line + "\n").utf8))
    }

    /// Lets the run loop deliver what the app does asynchronously (observation, layout, windows).
    private func settle(_ seconds: Double) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }
}
