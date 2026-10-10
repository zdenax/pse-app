import Foundation
import CoreGraphics
import Testing
@testable import NetSketchCore

@Suite struct SerializationTests {
    /// The example topology with every optional field in use.
    func makeRichProject() throws -> Project {
        let store = try ExampleBuilder.buildTriangle()
        let sw1 = try #require(store.project.device(hostname: "SW1"))
        try store.setPortAdminDown(store.ref("SW1", "Fa0/24"), true)
        try store.setPortVLAN(store.ref("SW1", "Fa0/5"), "10")
        try store.setPortDescription(store.ref("SW1", "Fa0/5"), "tiskárna \"A/B\"")
        try store.setVLANs(deviceID: sw1.id, [VLANEntry(id: 10, name: "users"), VLANEntry(id: 99, name: "mgmt")])
        store.snapToGrid = false
        try store.setPosition(deviceID: sw1.id, to: CGPoint(x: 461.25, y: 159.5))
        store.viewMode = .logical
        return store.project
    }

    @Test func roundTrip() throws {
        let project = try makeRichProject()
        let data = try project.encoded()
        let decoded = try Project(data: data)
        #expect(decoded == project)
        #expect(decoded.validate().isEmpty)
        #expect(try decoded.encoded() == data)

        // The new CLI-related fields survive the trip.
        let sw1 = try #require(decoded.device(hostname: "SW1"))
        #expect(sw1.vlans == [VLANEntry(id: 10, name: "users"), VLANEntry(id: 99, name: "mgmt")])
        #expect(sw1.port(named: "Fa0/24")?.adminDown == true)
        #expect(sw1.port(named: "Fa0/23")?.adminDown == false)
        #expect(sw1.port(named: "Fa0/5")?.vlan == "10")
        #expect(sw1.port(named: "Fa0/5")?.description == "tiskárna \"A/B\"")
        #expect(sw1.position == CGPoint(x: 461.25, y: 159.5))
        #expect(decoded.viewMode == .logical)
        #expect(decoded.formatVersion == Project.currentFormatVersion)

        // Pretty-printed, keys sorted, slashes left alone.
        let text = try #require(String(data: data, encoding: .utf8))
        #expect(text.contains("\n  \"formatVersion\" : 1"))
        #expect(text.contains("\"Fa0/1\""))
        #expect(text.contains("\"adminDown\" : true"))
        let topLevelKeys = ["\"annotations\"", "\"bundles\"", "\"devices\"", "\"formatVersion\"", "\"links\"", "\"name\"", "\"viewMode\""]
        let positions = try topLevelKeys.map { key in
            try #require(text.range(of: "\n  \(key) :")).lowerBound
        }
        #expect(positions == positions.sorted())
    }

    @Test func emptyProjectRoundTrip() throws {
        let empty = Project(name: "nic")
        #expect(try Project(data: empty.encoded()) == empty)
        #expect(empty.validate().isEmpty)
        #expect(try Project(data: Data("{}".utf8)) == Project())
    }

    @Test func filesWithoutNewFieldsStillDecode() throws {
        // A file as an older build wrote it: no adminDown, no vlans (and other optional keys missing).
        let deviceA = UUID(), deviceB = UUID(), portA = UUID(), portB = UUID(), link = UUID()
        let legacy = """
        {
          "formatVersion": 1,
          "name": "legacy",
          "devices": [
            { "id": "\(deviceA)", "templateID": "generic-pc", "vendor": "Generic", "model": "PC", "category": "PC",
              "hostname": "PC1", "position": { "x": 40, "y": 60 },
              "ports": [ { "id": "\(portA)", "name": "eth0", "connector": "RJ45", "speed": "1G",
                           "verified": false, "description": "", "vlan": "", "groupIndex": 0 } ],
              "note": "", "verified": false,
              "layout": { "rows": 1, "sections": [ { "groups": [0], "arrangement": "singleRow" } ] } },
            { "id": "\(deviceB)", "category": "switch", "hostname": "SW1", "position": { "x": 300, "y": 60 },
              "ports": [ { "id": "\(portB)", "name": "FastEthernet0/1", "connector": "RJ45" } ] }
          ],
          "links": [
            { "id": "\(link)", "a": { "deviceID": "\(deviceA)", "portID": "\(portA)" },
              "b": { "deviceID": "\(deviceB)", "portID": "\(portB)" } }
          ]
        }
        """
        let project = try Project(data: Data(legacy.utf8))
        #expect(project.name == "legacy")
        #expect(project.devices.count == 2)
        #expect(project.devices.allSatisfy { $0.vlans.isEmpty })
        #expect(project.devices.flatMap(\.ports).allSatisfy { !$0.adminDown })
        #expect(project.validate().isEmpty)
        #expect(project.bundles.isEmpty && project.annotations.isEmpty && project.viewMode == nil)

        let sw1 = try #require(project.device(hostname: "SW1"))
        #expect(sw1.ports[0].shortName == "Fa0/1")
        #expect(sw1.ports[0].speed == "" && sw1.ports[0].vlan == "" && sw1.ports[0].groupIndex == 0)
        #expect(sw1.panelGrid.slots.count == 1)
        #expect(project.links[0].cableType == .straight && project.links[0].statusA == .none)
        #expect(project.peer(of: PortRef(deviceID: deviceA, portID: portA))?.device.hostname == "SW1")

        // Stripping the new keys from a current file gives the same project back.
        var current = try ExampleBuilder.buildTriangle().project
        current.viewMode = nil
        let object = try JSONSerialization.jsonObject(with: current.encoded())
        let stripped = try JSONSerialization.data(withJSONObject: Self.removing(["adminDown", "vlans"], from: object))
        let text = try #require(String(data: stripped, encoding: .utf8))
        #expect(!text.contains("adminDown") && !text.contains("vlans"))
        #expect(try Project(data: stripped) == current)

        // Re-encoding the legacy project writes the new keys with their defaults.
        let rewritten = try #require(String(data: project.encoded(), encoding: .utf8))
        #expect(rewritten.contains("\"adminDown\" : false") && rewritten.contains("\"vlans\""))
    }

    static func removing(_ keys: Set<String>, from value: Any) -> Any {
        if let dictionary = value as? [String: Any] {
            return dictionary.filter { !keys.contains($0.key) }.mapValues { removing(keys, from: $0) }
        }
        if let array = value as? [Any] {
            return array.map { removing(keys, from: $0) }
        }
        return value
    }

    @Test func newerFormatVersionIsRejected() {
        let future = Data("{\"formatVersion\": 99, \"name\": \"x\"}".utf8)
        #expect(throws: ProjectFileError.unsupportedFormatVersion(found: 99, supported: 1)) {
            try Project(data: future)
        }
        #expect(throws: (any Error).self) { try Project(data: Data("not json".utf8)) }
    }

    @Test func storeSaveAndOpen() throws {
        let directory = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("lab.\(Project.fileExtension)")

        let store = try ExampleBuilder.buildTriangle()
        #expect(store.isDirty && store.fileURL == nil)
        #expect(throws: EditError.noFileURL) { try store.save() }
        try store.save(to: url)
        #expect(!store.isDirty && store.fileURL == url && store.canUndo)
        #expect(try Project.load(from: url) == store.project)

        // Dirty tracking follows the saved state through edits, undo and save().
        let sw1 = try #require(store.project.device(hostname: "SW1"))
        try store.renameDevice(id: sw1.id, to: "CORE1")
        #expect(store.isDirty)
        store.undo()
        #expect(!store.isDirty)
        store.redo()
        try store.save()
        #expect(!store.isDirty)
        store.undo()
        #expect(store.isDirty)

        let reader = makeStore()
        try reader.addDevice(templateID: TemplateID.pc, at: .zero)
        reader.selection = [.device(reader.project.devices[0].id)]
        try reader.open(url)
        #expect(reader.project.device(hostname: "CORE1") != nil)
        #expect(reader.fileURL == url && !reader.isDirty && !reader.canUndo && !reader.canRedo)
        #expect(reader.selection.isEmpty && reader.openIssues.isEmpty)
        #expect(reader.viewMode == .physical)

        // A failed open keeps the current project.
        let kept = reader.project
        #expect(throws: (any Error).self) { try reader.open(directory.appendingPathComponent("missing.netsketch")) }
        #expect(reader.project == kept && reader.fileURL == url)

        reader.new(name: "prázdný")
        #expect(reader.project.devices.isEmpty && reader.project.name == "prázdný")
        #expect(reader.fileURL == nil && !reader.isDirty && !reader.canUndo)
    }

    @Test func inconsistentFileIsRepairedOnOpen() throws {
        let directory = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("broken.netsketch")

        var project = try ExampleBuilder.buildTriangle().project
        let sw1 = try #require(project.device(hostname: "SW1"))
        let sw2 = try #require(project.device(hostname: "SW2"))
        let bundle = try #require(project.bundles.first)
        // A dangling cable, a second cable in an occupied port, a cable inside one device,
        // and a bundle that lists a link which does not exist.
        let dangling = Link(a: try #require(sw1.ref(portNamed: "Fa0/10")), b: PortRef(deviceID: UUID(), portID: UUID()))
        let doubled = Link(a: try #require(sw1.ref(portNamed: "Fa0/1")), b: try #require(sw2.ref(portNamed: "Fa0/9")))
        let inside = Link(a: try #require(sw2.ref(portNamed: "Fa0/11")), b: try #require(sw2.ref(portNamed: "Fa0/12")))
        project.links += [dangling, doubled, inside]
        project.bundles[0].linkIDs.append(UUID())
        project.bundles.append(LinkBundle(label: "lonely", linkIDs: [project.links[0].id]))

        let issues = project.validate()
        #expect(issues.contains(.danglingPortRef(linkID: dangling.id, end: .b)))
        #expect(issues.contains(.portUsedTwice(doubled.a)))
        #expect(issues.contains(.linkWithinDevice(linkID: inside.id)))
        #expect(issues.contains { if case .bundleMissingLink(bundle.id, _) = $0 { return true } else { return false } })
        #expect(issues.contains { if case .bundleTooSmall = $0 { return true } else { return false } })

        try project.save(to: url)
        let store = makeStore()
        try store.open(url)
        #expect(store.openIssues == issues)
        #expect(store.project.validate().isEmpty)
        #expect(store.isDirty)
        #expect(store.project.links.count == 5)
        #expect(store.project.bundles.map(\.label) == ["Po1 / bond1"])
        #expect(store.project.bundles[0].linkIDs.count == 2)
        #expect(store.project.devices == project.devices)
    }
}
