import AppKit
import NetSketchCore
import NetSketchCanvas

// Renders project files to PNG with the canvas renderer (macOS only):
//
//     swift run NetSketchRender <output directory> <file.netsketch>...
//
// Every file gives <name>-fyzicky.png (physical view) and <name>-logicky.png (logical view).

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count >= 2 else {
    print("usage: NetSketchRender <output directory> <file.netsketch>...")
    exit(2)
}
let output = URL(fileURLWithPath: arguments[0], isDirectory: true)
var failed = false

MainActor.assumeIsolated {
    do {
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    } catch {
        print("error: cannot create \(output.path): \(error)")
        failed = true
        return
    }
    for path in arguments.dropFirst() {
        let input = URL(fileURLWithPath: path)
        let name = input.deletingPathExtension().lastPathComponent
        let store = ProjectStore(catalog: DeviceCatalog(supportDirectory: nil))
        do {
            try store.open(input)
        } catch {
            print("error: cannot open \(path): \(error)")
            failed = true
            continue
        }
        for (mode, suffix) in [(ViewMode.physical, "fyzicky"), (ViewMode.logical, "logicky")] {
            store.viewMode = mode
            let url = output.appendingPathComponent("\(name)-\(suffix).png")
            guard let data = CanvasExporter.pngData(store: store, scale: 1.5) else {
                print("error: rendering \(name) (\(suffix)) failed")
                failed = true
                continue
            }
            do {
                try data.write(to: url, options: .atomic)
                print("written \(url.path)")
            } catch {
                print("error: cannot write \(url.path): \(error)")
                failed = true
            }
        }
    }
}
exit(failed ? 1 : 0)
