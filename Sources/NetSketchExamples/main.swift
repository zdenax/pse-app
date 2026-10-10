import Foundation
import NetSketchCore
import NetSketchCLI

// Builds the lab exercises (NetSketchCLI.Exercises) through the device consoles, checks
// their pings and saves them as project files.
//
//     swift run NetSketchExamples [directory]      (default: examples)

let directory = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "examples", isDirectory: true)
var failed = false
do {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
} catch {
    print("error: cannot create \(directory.path): \(error)")
    exit(1)
}
var transcript = """
# Ukázka cvičení

Výstupy konzolí z hotových cvičení, tak jak je vypíše NetSketch (generuje `swift run NetSketchExamples`).
Obrázky diagramů vyrenderuje `NetSketchRender` na macOS.

"""
for exercise in Exercises.all {
    let store = ProjectStore(catalog: DeviceCatalog(supportDirectory: nil))
    do {
        try exercise.build(store)
        let problems = Exercises.failedPings(exercise, in: store)
        for problem in problems { print("ping FAILED \(problem)") }
        if !problems.isEmpty { failed = true }
        let url = directory.appendingPathComponent(exercise.fileName)
        // Saved before the demo runs: the demo only reads, but the file must be the exercise as built.
        try Exercises.fileData(of: store).write(to: url, options: .atomic)
        print("written \(url.path) (\(exercise.title))")
        transcript += "\n" + Exercises.demoTranscript(exercise, in: store)
    } catch {
        print("error in \(exercise.fileName): \(error)")
        failed = true
    }
}
do {
    let url = directory.appendingPathComponent("UKAZKA.md")
    try Data(transcript.utf8).write(to: url, options: .atomic)
    print("written \(url.path)")
} catch {
    print("error: cannot write the demo transcript: \(error)")
    failed = true
}
exit(failed ? 1 : 0)
