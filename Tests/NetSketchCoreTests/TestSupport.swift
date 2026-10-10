import Foundation
import CoreGraphics
@testable import NetSketchCore

/// A store on the bundled catalog only; never touches Application Support.
func makeStore(snap: Bool = false) -> ProjectStore {
    let store = ProjectStore(catalog: DeviceCatalog(supportDirectory: nil))
    store.snapToGrid = snap
    return store
}

/// A fresh, empty temporary directory.
func makeTempDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("NetSketchTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// Repository root, derived from this source file's location.
let packageRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()

let exampleURL = packageRoot.appendingPathComponent("examples/trojuhelnik.netsketch")

enum TemplateID {
    static let c2960_24 = "cisco-catalyst-2960-24"
    static let c2960_48 = "cisco-catalyst-2960-48"
    static let c3650 = "cisco-catalyst-3650-24ps"
    static let isr4321 = "cisco-isr-4321"
    static let dellS3048 = "dell-s3048-on"
    static let hapLite = "mikrotik-hap-lite"
    static let crs = "mikrotik-crs-generic"
    static let udmPro = "ubiquiti-udm-pro"
    static let unifi24 = "ubiquiti-unifi-switch-24"
    static let pc = "generic-pc"
    static let server = "generic-server"
    static let accessPoint = "generic-ap"

    static let all = [
        c2960_24, c2960_48, c3650, isr4321, dellS3048, hapLite, crs, udmPro, unifi24, pc, server, accessPoint,
    ]
}

struct MissingPort: Error { let hostname: String; let port: String }

extension ProjectStore {
    /// Reference to a port by hostname and port name; throws when either is missing.
    func ref(_ hostname: String, _ portName: String) throws -> PortRef {
        guard let ref = project.device(hostname: hostname)?.ref(portNamed: portName) else {
            throw MissingPort(hostname: hostname, port: portName)
        }
        return ref
    }
}

/// Builds the example project "trojuhelnik" purely through `ProjectStore` operations.
enum ExampleBuilder {
    static func buildTriangle() throws -> ProjectStore {
        let store = ProjectStore(catalog: DeviceCatalog(supportDirectory: nil))
        store.snapToGrid = true
        store.gridSize = 20
        store.renameProject(to: "Trojúhelník")

        // Triangle of switches, Dell to the lower left of SW1.
        try store.addDevice(templateID: TemplateID.c2960_24, at: CGPoint(x: 460, y: 160))   // SW1
        try store.addDevice(templateID: TemplateID.c2960_24, at: CGPoint(x: 1040, y: 160))  // SW2
        let hap = try store.addDevice(templateID: TemplateID.hapLite, at: CGPoint(x: 800, y: 520))
        try store.renameDevice(id: hap.id, to: "SW3")
        let dell = try store.addDevice(templateID: TemplateID.dellS3048, at: CGPoint(x: 340, y: 520))
        try store.renameDevice(id: dell.id, to: "DELL1")

        // The triangle: crossover between switches.
        try store.connect(store.ref("SW1", "Fa0/1"), store.ref("SW2", "Fa0/1"), cable: .crossover)
        try store.connect(store.ref("SW1", "Fa0/2"), store.ref("SW3", "ether1"), cable: .crossover)
        let redundant = try store.connect(store.ref("SW2", "Fa0/2"), store.ref("SW3", "ether2"), cable: .crossover)

        // Double link SW1 - DELL1, drawn as one bundle.
        let lag1 = try store.connect(
            store.ref("SW1", "Gi0/1"), store.ref("DELL1", "GigabitEthernet 1/1"), cable: .crossover)
        let lag2 = try store.connect(
            store.ref("SW1", "Gi0/2"), store.ref("DELL1", "GigabitEthernet 1/2"), cable: .crossover)
        try store.createBundle(linkIDs: [lag1.id, lag2.id])

        // Manual status dots: everything up, the redundant triangle side held back at SW3.
        for link in store.project.links {
            try store.setStatus(linkID: link.id, end: .a, status: .green)
            try store.setStatus(linkID: link.id, end: .b, status: .green)
        }
        try store.setStatus(linkID: redundant.id, end: .b, status: .orange)
        try store.setLinkNote(linkID: redundant.id, "Záložní strana trojúhelníku")

        try store.setDeviceNote(id: dell.id, "Dell OS9. Port-channel 1 směrem na SW1 (Gi0/1 + Gi0/2).")
        try store.setPortDescription(store.ref("SW1", "Gi0/1"), "LAG na DELL1")
        try store.setPortDescription(store.ref("SW1", "Gi0/2"), "LAG na DELL1")
        store.addAnnotation(
            text: "Trojúhelník SW1-SW2-SW3 a dvojitý svazek SW1-DELL1 (Po1 / bond1)",
            at: CGPoint(x: 300, y: 40)
        )
        store.viewMode = .physical
        return store
    }
}
