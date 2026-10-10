// swift-tools-version: 6.0
import PackageDescription
import Foundation

// Swift Testing without Xcode (Command Line Tools only)
// ------------------------------------------------------
// SwiftPM does not add the CLT location of Testing.framework on its own. Run the tests with:
//
//   swift test -Xswiftc -F -Xswiftc /Library/Developer/CommandLineTools/Library/Developer/Frameworks
//
// What is needed, and where it lives:
//   1. A framework search path so that `import Testing` compiles and the auto-linked Testing
//      frameworks link. This MUST be given on the command line (above): the test runner module
//      that SwiftPM synthesizes for the test product takes no settings from this manifest, and
//      without the flag it compiles to an empty runner, i.e. `swift test` builds, runs zero
//      tests and exits 0. That is why the flag is deliberately NOT repeated per target here:
//      a plain `swift test` then fails loudly with "no such module 'Testing'".
//   2. Two runtime search paths, one for Testing.framework and one for lib_TestingInterop.dylib
//      (Testing.framework loads it via @rpath from Library/Developer/usr/lib). These are in
//      `testingLinkerSettings` below; one test target carrying them is enough, because all
//      test targets are linked into a single test bundle.
// `testingLinkerSettings` is empty when Xcode is the active developer directory.
let cltDeveloper = "/Library/Developer/CommandLineTools/Library/Developer"
let cltFrameworks = cltDeveloper + "/Frameworks"
let cltLibraries = cltDeveloper + "/usr/lib"

let usesCommandLineTools: Bool = {
    guard FileManager.default.fileExists(atPath: cltFrameworks + "/Testing.framework") else { return false }
    if let developerDir = ProcessInfo.processInfo.environment["DEVELOPER_DIR"], !developerDir.isEmpty {
        return developerDir.contains("CommandLineTools")
    }
    if let selected = try? FileManager.default.destinationOfSymbolicLink(atPath: "/var/db/xcode_select_link") {
        return selected.contains("CommandLineTools")
    }
    return !FileManager.default.fileExists(atPath: "/Applications/Xcode.app")
}()

let testingLinkerSettings: [LinkerSetting] = usesCommandLineTools
    ? [.unsafeFlags([
        "-Xlinker", "-rpath", "-Xlinker", cltFrameworks,
        "-Xlinker", "-rpath", "-Xlinker", cltLibraries,
    ])]
    : []

// SwiftUI/AppKit exist only on macOS. Elsewhere (e.g. a Linux CI job) the package consists of
// the portable targets only, so `swift build` and `swift test` check the core and the CLI.
#if os(macOS)
let appProducts: [Product] = [
    .library(name: "NetSketchCanvas", targets: ["NetSketchCanvas"]),
    .executable(name: "NetSketch", targets: ["NetSketch"]),
]
let appTargets: [Target] = [
    .target(
        name: "NetSketchCanvas",
        dependencies: ["NetSketchCore"]
    ),
    .executableTarget(
        name: "NetSketch",
        dependencies: ["NetSketchCore", "NetSketchCanvas", "NetSketchCLI"]
    ),
]
#else
let appProducts: [Product] = []
let appTargets: [Target] = []
#endif

let package = Package(
    name: "NetSketch",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "NetSketchCore", targets: ["NetSketchCore"]),
        .library(name: "NetSketchCLI", targets: ["NetSketchCLI"]),
    ] + appProducts,
    targets: [
        .target(
            name: "NetSketchCore",
            resources: [.process("Resources")]
        ),
        .target(
            name: "NetSketchCLI",
            dependencies: ["NetSketchCore"]
        ),
        .executableTarget(
            name: "NetSketchExamples",
            dependencies: ["NetSketchCore", "NetSketchCLI"]
        ),
        .testTarget(
            name: "NetSketchCoreTests",
            dependencies: ["NetSketchCore"],
            linkerSettings: testingLinkerSettings
        ),
        .testTarget(
            name: "NetSketchCLITests",
            dependencies: ["NetSketchCLI", "NetSketchCore"]
        ),
    ] + appTargets,
    swiftLanguageModes: [.v5]
)
