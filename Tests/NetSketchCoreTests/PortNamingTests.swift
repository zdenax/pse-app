import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import Testing
@testable import NetSketchCore

@Suite struct PortNamingTests {
    let catalog = DeviceCatalog(supportDirectory: nil)

    @Test func cisco2960PortNames() throws {
        let template = try #require(catalog.template(id: TemplateID.c2960_24))
        let names = template.makePorts().map(\.name)
        #expect(Array(names.prefix(24)) == (1...24).map { "Fa0/\($0)" })
        #expect(Array(names.dropFirst(24)) == ["Gi0/1", "Gi0/2", "Console"])
        #expect(template.portGroups[0].portNames.first == "Fa0/1")
        #expect(template.portGroups[0].portNames.last == "Fa0/24")
        #expect(template.portGroups[0].portCount == 24)

        let big = try #require(catalog.template(id: TemplateID.c2960_48))
        let bigNames = big.makePorts().map(\.name)
        #expect(Array(bigNames.prefix(48)) == (1...48).map { "Fa0/\($0)" })
        #expect(Array(bigNames.dropFirst(48)) == ["Gi0/1", "Gi0/2", "Console"])
    }

    @Test func dellS3048PortNames() throws {
        let template = try #require(catalog.template(id: TemplateID.dellS3048))
        #expect(template.portGroups.map(\.portCount) == [48, 4, 2, 1, 1])
        #expect(template.portGroups[0].portNames == (1...48).map { "GigabitEthernet 1/\($0)" })
        #expect(template.portGroups[1].portNames == (49...52).map { "TenGigabitEthernet 1/\($0)" })
        #expect(template.portGroups[2].portNames == ["fortyGigE 1/53", "fortyGigE 1/55"])
        #expect(template.portGroups.map(\.connector) == [.rj45, .sfpPlus, .qsfpPlus, .mgmt, .console])
        #expect(template.portGroups.prefix(3).map(\.speed) == ["1G", "10G", "40G"])

        let ports = template.makePorts()
        #expect(ports.count == 56)
        #expect(ports.filter { $0.connector == .rj45 }.count == 48)
        #expect(ports.filter { $0.connector == .sfpPlus }.count == 4)
        #expect(ports.filter { $0.connector == .qsfpPlus }.map(\.name) == ["fortyGigE 1/53", "fortyGigE 1/55"])
        #expect(ports.filter { $0.connector == .qsfpPlus }.map(\.shortName) == ["Fo1/53", "Fo1/55"])
        #expect(ports[0].shortName == "Gi1/1")
        #expect(ports[48].shortName == "Te1/49")
        #expect(ports[48].groupIndex == 1)
    }

    @Test func otherTemplates() throws {
        let hap = try #require(catalog.template(id: TemplateID.hapLite))
        let hapPorts = hap.makePorts()
        #expect(hapPorts.map(\.name) == ["ether1", "ether2", "ether3", "ether4", "wlan1"])
        #expect(hapPorts.prefix(4).allSatisfy { $0.speed == "100M" && $0.connector == .rj45 })
        #expect(hapPorts[4].connector == .wireless)
        #expect(hapPorts.map(\.shortName) == hapPorts.map(\.name))

        let c3650 = try #require(catalog.template(id: TemplateID.c3650)).makePorts()
        #expect(Array(c3650.prefix(24)).map(\.name) == (1...24).map { "Gi1/0/\($0)" })
        #expect(c3650.filter { $0.connector == .sfp }.map(\.name) == ["Gi1/1/1", "Gi1/1/2", "Gi1/1/3", "Gi1/1/4"])
        #expect(c3650.contains { $0.connector == .console })
        #expect(c3650.contains { $0.connector == .mgmt })

        let isr = try #require(catalog.template(id: TemplateID.isr4321))
        #expect(isr.makePorts().map(\.name) == ["Gi0/0/0", "Gi0/0/1", "Console"])
        #expect(isr.portGroups[1].isPlaceholder)
        #expect(isr.portGroups[1].portNames.isEmpty)
        let bay = try #require(isr.panelGrid.sections.first { $0.isPlaceholder })
        #expect(bay.label == "NIM")
        #expect(bay.width == 4)

        let crs = try #require(catalog.template(id: TemplateID.crs)).makePorts()
        #expect(crs.map(\.name) == (1...8).map { "ether\($0)" } + ["sfp1", "sfp2"])

        let udm = try #require(catalog.template(id: TemplateID.udmPro)).makePorts()
        #expect(udm.map(\.name) == (1...8).map { "LAN \($0)" } + ["WAN", "WAN SFP+", "LAN SFP+"])
        #expect(udm.suffix(2).allSatisfy { $0.connector == .sfpPlus })

        let unifi = try #require(catalog.template(id: TemplateID.unifi24)).makePorts()
        #expect(unifi.filter { $0.connector == .rj45 }.count == 24)
        #expect(unifi.filter { $0.connector == .sfp }.count == 2)

        #expect(try #require(catalog.template(id: TemplateID.pc)).makePorts().map(\.name) == ["eth0"])
        #expect(try #require(catalog.template(id: TemplateID.server)).makePorts().map(\.name) == ["eth0", "eth1", "mgmt0"])
        #expect(try #require(catalog.template(id: TemplateID.accessPoint)).makePorts().map(\.name) == ["eth0", "wlan0"])
    }

    @Test func portGroupGeneration() {
        let stepped = PortGroup(prefix: "fortyGigE 1/", range: 53...55, step: 2, speed: "40G", connector: .qsfpPlus)
        #expect(stepped.portNames == ["fortyGigE 1/53", "fortyGigE 1/55"])
        let suffixed = PortGroup(prefix: "swp", range: 1...2, suffix: "s0", speed: "10G", connector: .sfpPlus)
        #expect(suffixed.portNames == ["swp1s0", "swp2s0"])
        let named = PortGroup(names: ["WAN", "DMZ"], speed: "1G", connector: .rj45)
        #expect(named.portNames == ["WAN", "DMZ"])
        #expect(PortGroup.placeholder(label: "NIM").portCount == 0)
    }

    @Test func shortNames() {
        let cases: [(String, String)] = [
            ("GigabitEthernet 1/1", "Gi1/1"),
            ("TenGigabitEthernet 1/49", "Te1/49"),
            ("fortyGigE 1/53", "Fo1/53"),
            ("FastEthernet0/1", "Fa0/1"),
            ("GigabitEthernet1/0/24", "Gi1/0/24"),
            ("ManagementEthernet 1/1", "Ma1/1"),
            ("HundredGigE 1/1/1", "Hu1/1/1"),
            ("Ethernet1/1", "Eth1/1"),
            ("Port-channel1", "Po1"),
            // Already short or not an interface type: unchanged.
            ("ether1", "ether1"),
            ("Fa0/1", "Fa0/1"),
            ("Gi1/0/1", "Gi1/0/1"),
            ("Te1/49", "Te1/49"),
            ("eth0", "eth0"),
            ("wlan1", "wlan1"),
            ("LAN 3", "LAN 3"),
            ("WAN SFP+", "WAN SFP+"),
            ("Console", "Console"),
            ("Ethernet", "Ethernet"),
        ]
        for (long, short) in cases {
            #expect(PortNaming.shortName(long) == short, "\(long)")
        }
    }

    @Test func panelGridOfA2960() throws {
        let template = try #require(catalog.template(id: TemplateID.c2960_24))
        let device = template.makeDevice(hostname: "SW1", at: .zero)
        let grid = device.panelGrid
        #expect(grid == template.panelGrid)
        #expect(grid.rows == 2)
        #expect(grid.sections.count == 3)

        // Odd ports on top, even ports below, column by column.
        let fa1 = try #require(grid.slot(forPortIndex: 0))
        let fa2 = try #require(grid.slot(forPortIndex: 1))
        let fa3 = try #require(grid.slot(forPortIndex: 2))
        #expect(fa1.row == 0 && fa1.x == 0)
        #expect(fa2.row == 1 && fa2.x == 0)
        #expect(fa3.row == 0 && fa3.x == 1)
        // A block gap after six columns (twelve ports).
        let fa13 = try #require(grid.slot(forPortIndex: 12))
        #expect(fa13.column == 6)
        #expect(fa13.x == 6 + PanelLayout.blockGap)

        // Uplinks: single row at the bottom, after a section gap. Console: top row.
        let gi1 = try #require(grid.slot(forPortIndex: 24))
        let gi2 = try #require(grid.slot(forPortIndex: 25))
        let console = try #require(grid.slot(forPortIndex: 26))
        #expect(gi1.row == 1 && gi2.row == 1)
        #expect(gi1.x == grid.sections[0].x + grid.sections[0].width + PanelLayout.sectionGap)
        #expect(gi2.x == gi1.x + 1)
        #expect(console.row == 0)
        #expect(grid.sections[1].label == "Uplink")
        #expect(grid.width == console.x + 1)
    }

    @Test func layoutNormalizationAndFallbacks() {
        let groups = [
            PortGroup(prefix: "p", range: 1...16, speed: "1G", connector: .rj45),
            PortGroup(prefix: "s", range: 1...2, speed: "10G", connector: .sfpPlus, label: "Uplink"),
            PortGroup.placeholder(label: "Bay"),
        ]
        let automatic = PanelLayout.automatic(for: groups)
        #expect(automatic.rows == 2)
        #expect(automatic.sections.map(\.arrangement) == [.oddTopEvenBottom, .singleRow, .singleRow])
        #expect(automatic.sections[2].placeholderWidth == PanelLayout.defaultPlaceholderWidth)

        // Bad indices are dropped, unmentioned groups appended, rows raised.
        let sloppy = PanelLayout(rows: 1, sections: [
            PanelSection(groups: [1, 7, 1], arrangement: .topRowThenBottomRow),
        ])
        let normalized = sloppy.normalized(for: groups)
        #expect(normalized.rows == 2)
        #expect(normalized.sections.map(\.groups) == [[1], [0], [2]])
        #expect(normalized.sections[0].label == "Uplink")
        #expect(normalized.normalized(for: groups) == normalized)

        // A layout that knows nothing still yields a slot for every port.
        let template = DeviceTemplate(vendor: "T", model: "M", category: .switch, portGroups: groups)
        let ports = template.makePorts()
        let bare = PanelLayout().grid(for: ports)
        #expect(bare.slots.count == ports.count)
        #expect(bare.rows == 1)

        // Row-major arrangement: first half on top.
        let rowMajor = PanelLayout(rows: 2, sections: [PanelSection(groups: [0], arrangement: .topRowThenBottomRow)])
            .grid(groupIndices: Array(repeating: 0, count: 6))
        #expect(rowMajor.slots.map(\.row) == [0, 0, 0, 1, 1, 1])
        #expect(rowMajor.slots.map(\.column) == [0, 1, 2, 0, 1, 2])
        let evenTop = PanelLayout(rows: 2, sections: [PanelSection(groups: [0], arrangement: .evenTopOddBottom)])
            .grid(groupIndices: [0, 0, 0, 0])
        #expect(evenTop.slots.map(\.row) == [1, 0, 1, 0])

        // A layout that was never normalized: the single-row section still lands on the bottom row.
        let raw = PanelLayout(rows: 1, sections: [
            PanelSection(groups: [1]),
            PanelSection(groups: [0], arrangement: .oddTopEvenBottom),
        ]).grid(groupIndices: [0, 0, 0, 0, 1])
        #expect(raw.rows == 2)
        #expect(raw.slot(forPortIndex: 4)?.row == 1 && raw.slot(forPortIndex: 4)?.x == 0)
        #expect(raw.slots.map(\.portIndex) == [0, 1, 2, 3, 4])
        #expect(raw.slot(forPortIndex: 0)?.x == 1 + PanelLayout.sectionGap)
    }

    @Test func slug() {
        #expect(DeviceTemplate.slug(vendor: "Dell EMC", model: "S3048-ON") == "dell-emc-s3048-on")
        #expect(DeviceTemplate.slug(vendor: "", model: "  Žluťoučký kůň!  ") == "zlutoucky-kun")
        #expect(DeviceTemplate.slug(vendor: "", model: "???") == "device")
    }
}
