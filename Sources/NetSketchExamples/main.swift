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
for exercise in Exercises.all {
    let store = ProjectStore(catalog: DeviceCatalog(supportDirectory: nil))
    do {
        try exercise.build(store)
        let problems = Exercises.failedPings(exercise, in: store)
        for problem in problems { print("ping FAILED \(problem)") }
        if !problems.isEmpty { failed = true }
        let url = directory.appendingPathComponent(exercise.fileName)
        try store.save(to: url)
        print("written \(url.path) (\(exercise.title))")
    } catch {
        print("error in \(exercise.fileName): \(error)")
        failed = true
    }
}
exit(failed ? 1 : 0)
