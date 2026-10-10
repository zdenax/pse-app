import Foundation
import CoreGraphics
import Testing
@testable import NetSketchCore

@Suite struct ExampleProjectTests {
    /// Writes examples/trojuhelnik.netsketch. Run on demand:
    /// `NETSKETCH_WRITE_EXAMPLE=1 swift test --filter writeExampleFile`
    @Test(.enabled(if: ProcessInfo.processInfo.environment["NETSKETCH_WRITE_EXAMPLE"] == "1"))
    func writeExampleFile() throws {
        let store = try ExampleBuilder.buildTriangle()
        #expect(store.project.validate().isEmpty)
        try FileManager.default.createDirectory(
            at: exampleURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try store.save(to: exampleURL)
    }

    @Test func builderProducesTheExpectedTopology() throws {
        try Self.checkTopology(try ExampleBuilder.buildTriangle().project)
    }

    @Test func committedExampleDecodesAndIsConsistent() throws {
        let project = try Project.load(from: exampleURL)
        try Self.checkTopology(project)

        // The file is exactly what this build would write for that project.
        #expect(try project.encoded() == Data(contentsOf: exampleURL))

        // It opens cleanly in a store and can be edited.
        let store = makeStore()
        try store.open(exampleURL)
        #expect(store.openIssues.isEmpty && !store.isDirty)
        #expect(throws: EditError.portInUse(try store.ref("SW1", "Fa0/1"))) {
            try store.connect(store.ref("SW1", "Fa0/1"), store.ref("DELL1", "GigabitEthernet 1/3"))
        }
        try store.connect(store.ref("SW2", "Gi0/1"), store.ref("DELL1", "GigabitEthernet 1/3"))
        #expect(store.project.validate().isEmpty && store.isDirty)
    }

    static func checkTopology(_ project: Project) throws {
        #expect(project.formatVersion == 1)
        #expect(project.validate().isEmpty)
        #expect(project.devices.map(\.hostname).sorted() == ["DELL1", "SW1", "SW2", "SW3"])

        // Every port reference resolves and no port carries two cables (checked independently of validate()).
        var used = Set<PortRef>()
        for link in project.links {
            for ref in [link.a, link.b] {
                let resolved = project.resolve(ref)
                #expect(resolved != nil, "dangling reference in link \(link.id)")
                #expect(used.insert(ref).inserted, "port used twice: \(resolved?.port.name ?? "?")")
            }
            #expect(link.a.deviceID != link.b.deviceID)
        }
        #expect(Set(project.devices.map(\.id)).count == project.devices.count)

        let sw1 = try #require(project.device(hostname: "SW1"))
        let sw2 = try #require(project.device(hostname: "SW2"))
        let sw3 = try #require(project.device(hostname: "SW3"))
        let dell = try #require(project.device(hostname: "DELL1"))
        #expect(sw1.templateID == "cisco-catalyst-2960-24" && sw2.templateID == "cisco-catalyst-2960-24")
        #expect(sw3.templateID == "mikrotik-hap-lite")
        #expect(dell.templateID == "dell-s3048-on")
        #expect(sw1.ports.count == 27 && sw3.ports.count == 5 && dell.ports.count == 56)
        #expect(project.devices.allSatisfy { $0.needsVerification })

        // The cabling, written as "host:port <-> host:port".
        func describe(_ ref: PortRef) -> String {
            guard let resolved = project.resolve(ref) else { return "?" }
            return "\(resolved.device.hostname):\(resolved.port.name)"
        }
        let cabling = Set(project.links.map { "\(describe($0.a)) <-> \(describe($0.b))" })
        #expect(cabling == [
            "SW1:Fa0/1 <-> SW2:Fa0/1",
            "SW1:Fa0/2 <-> SW3:ether1",
            "SW2:Fa0/2 <-> SW3:ether2",
            "SW1:Gi0/1 <-> DELL1:GigabitEthernet 1/1",
            "SW1:Gi0/2 <-> DELL1:GigabitEthernet 1/2",
        ])
        #expect(project.links.count == 5)
        #expect(project.links.allSatisfy { $0.cableType == .crossover })

        // The double link to the Dell is one bundle.
        #expect(project.bundles.count == 1)
        let bundle = try #require(project.bundles.first)
        #expect(bundle.label == "Po1 / bond1")
        #expect(bundle.linkIDs.count == 2)
        let members = project.links.filter { $0.bundleID == bundle.id }
        #expect(members.map(\.id) == bundle.linkIDs)
        #expect(members.allSatisfy { $0.devicePair == DevicePair(sw1.id, dell.id) })
        #expect(project.links.filter { $0.bundleID == nil }.count == 3)

        // Peers as the inspector would list them.
        let uplink = try #require(dell.ref(portNamed: "GigabitEthernet 1/2"))
        #expect(project.peer(of: uplink)?.device.hostname == "SW1")
        #expect(project.peer(of: uplink)?.port.name == "Gi0/2")
        #expect(project.connections(ofDevice: sw1.id).filter { $0.peer != nil }.count == 4)

        // Layout: laid out on the grid, nothing stacked; one annotation, one device note.
        #expect(Set(project.devices.map { "\($0.position.x)/\($0.position.y)" }).count == 4)
        #expect(project.devices.allSatisfy {
            $0.position.x.truncatingRemainder(dividingBy: 20) == 0 && $0.position.y.truncatingRemainder(dividingBy: 20) == 0
        })
        #expect(project.annotations.count == 1)
        #expect(project.annotations.first?.text.isEmpty == false)
        #expect(!dell.note.isEmpty)
    }
}
