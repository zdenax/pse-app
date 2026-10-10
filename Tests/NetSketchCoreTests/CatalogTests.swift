import Foundation
import Testing
@testable import NetSketchCore

@Suite struct CatalogTests {
    let catalog = DeviceCatalog(supportDirectory: nil)

    @Test func loadsFromBundle() {
        #expect(catalog.loadIssues.isEmpty)
        #expect(catalog.builtInSource == .bundle)
        #expect(catalog.custom.isEmpty)
        #expect(DeviceCatalog.bundledDevicesURL != nil)
        #expect(catalog.templates.count == TemplateID.all.count)
        for id in TemplateID.all {
            #expect(catalog.template(id: id) != nil, "missing template \(id)")
        }
        #expect(catalog.template(id: "does-not-exist") == nil)
    }

    @Test func everythingIsUnverified() {
        for template in catalog.templates {
            #expect(template.verified == false, "\(template.id) must be unverified")
            #expect(template.isCustom == false)
            #expect(template.needsVerification)
            #expect(!template.portGroups.isEmpty)
            for group in template.portGroups {
                #expect(group.verified == false, "\(template.id) / \(group.prefix) must be unverified")
            }
            #expect(template.makePorts().allSatisfy { !$0.verified })
        }
    }

    @Test func categoriesAndGrouping() {
        #expect(catalog.template(id: TemplateID.c3650)?.category == .l3switch)
        #expect(catalog.template(id: TemplateID.isr4321)?.category == .router)
        #expect(catalog.template(id: TemplateID.c2960_24)?.category == .switch)
        #expect(catalog.template(id: TemplateID.pc)?.category == .pc)
        #expect(catalog.template(id: TemplateID.server)?.category == .server)
        #expect(catalog.template(id: TemplateID.accessPoint)?.category == .accessPoint)

        let groups = catalog.templatesByCategory
        #expect(groups.map(\.category) == DeviceCategory.allCases)
        #expect(groups.reduce(0) { $0 + $1.templates.count } == catalog.templates.count)
        for group in groups {
            #expect(group.templates.allSatisfy { $0.category == group.category })
            #expect(group.templates == catalog.templates(in: group.category))
        }
    }

    @Test func portNamesAreUniqueAndEveryPortHasASlot() {
        for template in catalog.templates {
            let ports = template.makePorts()
            #expect(ports.count == template.portCount)
            #expect(Set(ports.map(\.name)).count == ports.count, "\(template.id) has duplicate port names")
            #expect(Set(ports.map(\.id)).count == ports.count)

            let grid = template.panelGrid
            #expect(grid.slots.count == ports.count, "\(template.id): one slot per port")
            #expect(grid.slots.map(\.portIndex) == Array(ports.indices))
            #expect(grid.rows == template.layout.rows)
            #expect(grid.width > 0)
            let cells = Set(grid.slots.map { "\($0.x)/\($0.row)" })
            #expect(cells.count == ports.count, "\(template.id): two ports share a cell")
            #expect(grid.slots.allSatisfy { $0.row >= 0 && $0.row < grid.rows && $0.x >= 0 && $0.x + 1 <= grid.width })
            // The layout stored in the catalog is already normalized.
            #expect(template.layout == template.layout.normalized(for: template.portGroups))
        }
    }

    @Test func decodesFromArbitraryData() throws {
        let wrapped = Data("""
        {"templates": [{"id": "x-1", "vendor": "X", "model": "One", "category": "switch",
          "portGroups": [{"prefix": "p", "rangeStart": 1, "rangeEnd": 3, "speed": "1G", "connector": "RJ45"}]}]}
        """.utf8)
        let fromWrapped = try DeviceCatalog.decodeTemplates(from: wrapped)
        #expect(fromWrapped.count == 1)
        #expect(fromWrapped[0].portGroups[0].portNames == ["p1", "p2", "p3"])
        #expect(fromWrapped[0].verified == false)
        #expect(fromWrapped[0].portGroups[0].verified == false)
        #expect(fromWrapped[0].layout.sections.count == 1)

        let bare = Data("""
        [{"vendor": "Acme Č", "model": "Švitch 8", "category": "L3 switch", "portGroups": []}]
        """.utf8)
        let fromBare = try DeviceCatalog.decodeTemplates(from: bare)
        #expect(fromBare[0].id == "acme-c-svitch-8")
        #expect(fromBare[0].category == .l3switch)

        let roundTrip = try DeviceCatalog.decodeTemplates(from: DeviceCatalog.encodeTemplates(catalog.templates))
        #expect(roundTrip == catalog.templates)

        let other = DeviceCatalog(builtIn: [], supportDirectory: nil)
        try other.loadBuiltIn(from: wrapped)
        #expect(other.templates.map(\.id) == ["x-1"])
        #expect(other.builtInSource == .provided)
        #expect(throws: (any Error).self) { try DeviceCatalog.decodeTemplates(from: Data("nonsense".utf8)) }
    }

    @Test func customTemplatesPersistInSupportDirectory() throws {
        let directory = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let first = DeviceCatalog(supportDirectory: directory)
        #expect(first.custom.isEmpty)
        #expect(first.loadIssues.isEmpty)

        let template = DeviceTemplate(
            id: first.uniqueID(vendor: "Acme", model: "Lab Switch 10"),
            vendor: "Acme",
            model: "Lab Switch 10",
            category: .switch,
            portGroups: [
                PortGroup(prefix: "ge-0/0/", range: 0...7, speed: "1G", connector: .rj45, verified: true),
                PortGroup(prefix: "xe-0/1/", range: 0...1, speed: "10G", connector: .sfpPlus),
                PortGroup(names: ["con0"], speed: "", connector: .console),
            ],
            verified: true,
            note: "vlastní šablona"
        )
        let added = try first.addCustom(template)
        #expect(added.id == "acme-lab-switch-10")
        #expect(added.isCustom)
        #expect(first.template(id: added.id) == added)
        #expect(FileManager.default.fileExists(atPath: directory.appendingPathComponent("custom-devices.json").path))
        #expect(throws: CatalogError.duplicateID(added.id)) { try first.addCustom(template) }

        // A second catalog on the same directory sees it.
        let second = DeviceCatalog(supportDirectory: directory)
        #expect(second.custom == [added])
        #expect(second.template(id: added.id)?.makePorts().map(\.name).prefix(2) == ["ge-0/0/0", "ge-0/0/1"])
        #expect(second.templates(in: .switch).last == added)
        #expect(second.uniqueID(vendor: "Acme", model: "Lab Switch 10") == "acme-lab-switch-10-2")

        var changed = added
        changed.model = "Lab Switch 10 rev B"
        try second.updateCustom(changed)
        #expect(DeviceCatalog(supportDirectory: directory).template(id: added.id)?.model == "Lab Switch 10 rev B")

        // Built-ins are protected; unknown ids are reported.
        let builtIn = try #require(second.template(id: TemplateID.pc))
        #expect(throws: CatalogError.notCustom(TemplateID.pc)) { try second.updateCustom(builtIn) }
        #expect(throws: CatalogError.notCustom(TemplateID.pc)) { try second.removeCustom(id: TemplateID.pc) }
        #expect(throws: CatalogError.duplicateID(TemplateID.pc)) { try second.addCustom(builtIn) }
        #expect(throws: CatalogError.unknownTemplate("nope")) { try second.removeCustom(id: "nope") }

        try second.removeCustom(id: added.id)
        #expect(DeviceCatalog(supportDirectory: directory).custom.isEmpty)
    }

    @Test func overrideFileReplacesBundledCatalog() throws {
        let directory = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let overrideURL = directory.appendingPathComponent("devices.json")

        let only = DeviceTemplate(vendor: "Only", model: "One", category: .pc, portGroups: [
            PortGroup(names: ["eth0"], speed: "1G", connector: .rj45),
        ])
        try DeviceCatalog.encodeTemplates([only]).write(to: overrideURL)
        let overridden = DeviceCatalog(supportDirectory: directory)
        #expect(overridden.builtIn.map(\.id) == ["only-one"])
        #expect(overridden.builtInSource == .overrideFile(overrideURL))
        #expect(overridden.loadIssues.isEmpty)

        // A broken override falls back to the bundle and reports the problem.
        try Data("{ not json".utf8).write(to: overrideURL)
        let fallback = DeviceCatalog(supportDirectory: directory)
        #expect(fallback.builtInSource == .bundle)
        #expect(fallback.builtIn.count == TemplateID.all.count)
        #expect(fallback.loadIssues.count == 1)
    }

    @Test func unreadableCustomFileIsKeptAsBackup() throws {
        let directory = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let customURL = directory.appendingPathComponent("custom-devices.json")
        try Data("broken".utf8).write(to: customURL)

        let catalog = DeviceCatalog(supportDirectory: directory)
        #expect(catalog.custom.isEmpty)
        #expect(catalog.loadIssues.count == 1)
        try catalog.addCustom(DeviceTemplate(vendor: "A", model: "B", category: .pc, portGroups: []))
        let backup = directory.appendingPathComponent("custom-devices.invalid.json")
        #expect(try String(contentsOf: backup, encoding: .utf8) == "broken")
        #expect(DeviceCatalog(supportDirectory: directory).custom.map(\.id) == ["a-b"])
    }
}
