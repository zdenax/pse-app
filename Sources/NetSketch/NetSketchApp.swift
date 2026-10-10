import AppKit
import SwiftUI
import NetSketchCore
import NetSketchCanvas

/// Entry point. Two developer switches run without the GUI or drive it by themselves:
/// `--catalog-info` prints where the bundled catalog was found (used by scripts/make-app.sh)
/// and `--selftest` runs the built-in smoke test (see SelfTest.swift).
@main
enum NetSketchMain {
    @MainActor
    static func main() {
        if CommandLine.arguments.contains("--catalog-info") {
            printCatalogInfo()
        }
        NetSketchApp.main()
    }

    private static func printCatalogInfo() -> Never {
        let catalog = DeviceCatalog(supportDirectory: nil)
        print("devices.json: \(DeviceCatalog.bundledDevicesURL?.path ?? "NOT FOUND")")
        print("templates: \(catalog.builtIn.count)")
        for issue in catalog.loadIssues {
            print("issue: \(issue)")
        }
        exit(catalog.builtIn.isEmpty ? 1 : 0)
    }
}

struct NetSketchApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = AppModel.shared

    var body: some Scene {
        Window("NetSketch", id: "main") {
            ContentView(model: model)
        }
        .defaultSize(width: 1320, height: 840)
        .windowResizability(.contentMinSize)
        .windowToolbarStyle(.unified)
        .commands {
            AppCommands(model: model)
            SidebarCommands()
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        NSWindow.allowsAutomaticWindowTabbing = false
        // The project is a file; restoring stale windows on the next launch would only confuse.
        UserDefaults.standard.register(defaults: ["NSQuitAlwaysKeepsWindows": false])
        // A bare SwiftPM executable has no Info.plist, so it must ask to be a regular app
        // (Dock icon, menu bar, key window) itself.
        NSApp.setActivationPolicy(.regular)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.activate(ignoringOtherApps: true)
        AppModel.shared.applicationDidFinishLaunching()
        SelfTest.runIfRequested()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        AppModel.shared.mayTerminate() ? .terminateNow : .terminateCancel
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    /// Files opened from Finder (the packaged app registers the .netsketch type).
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first else { return }
        AppModel.shared.openExternally(url)
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        true
    }

    // Standard Edit menu actions that reach the app when no text view handles them.

    @objc func selectAll(_ sender: Any?) {
        AppModel.shared.selectAll()
    }

    @objc func delete(_ sender: Any?) {
        AppModel.shared.deleteSelection()
    }
}
