import Foundation
import CoreGraphics
import Testing
@testable import NetSketchCore

@Suite struct CablingTests {
    /// SW1 and SW2 (2960-24) plus DELL1 (S3048-ON), nothing connected.
    func makeLab() throws -> ProjectStore {
        let store = makeStore()
        try store.addDevice(templateID: TemplateID.c2960_24, at: CGPoint(x: 100, y: 100))
        try store.addDevice(templateID: TemplateID.c2960_24, at: CGPoint(x: 500, y: 100))
        try store.addDevice(templateID: TemplateID.dellS3048, at: CGPoint(x: 300, y: 400), hostname: "DELL1")
        return store
    }

    @Test func automaticHostnames() throws {
        let store = makeStore()
        let names = try [
            TemplateID.c2960_24, TemplateID.c2960_48, TemplateID.c3650, TemplateID.isr4321,
            TemplateID.pc, TemplateID.pc, TemplateID.server, TemplateID.accessPoint, TemplateID.hapLite,
        ].map { try store.addDevice(templateID: $0, at: .zero).hostname }
        #expect(names == ["SW1", "SW2", "SW3", "R1", "PC1", "PC2", "SRV1", "AP1", "R2"])

        // The lowest free number is reused; an explicit hostname wins.
        try store.removeDevice(id: try #require(store.project.device(hostname: "SW2")).id)
        #expect(store.nextHostname(for: .switch) == "SW2")
        #expect(try store.addDevice(templateID: TemplateID.pc, at: .zero, hostname: " Kiosk ").hostname == "Kiosk")
        #expect(throws: EditError.unknownTemplate("nope")) { try store.addDevice(templateID: "nope", at: .zero) }
    }

    @Test func newDeviceCarriesTemplateSnapshot() throws {
        let store = makeStore(snap: true)
        let device = try store.addDevice(templateID: TemplateID.dellS3048, at: CGPoint(x: 107, y: 93))
        let template = try #require(store.catalog.template(id: TemplateID.dellS3048))
        #expect(device.position == CGPoint(x: 100, y: 100))
        #expect(device.templateID == template.id)
        #expect(device.vendor == "Dell EMC" && device.model == "S3048-ON")
        #expect(device.category == template.category)
        #expect(device.layout == template.layout)
        #expect(device.ports.map(\.name) == template.makePorts().map(\.name))
        #expect(device.needsVerification)
        #expect(device.note.isEmpty && device.vlans.isEmpty)
        #expect(device.ports.allSatisfy { !$0.adminDown && $0.description.isEmpty && $0.vlan.isEmpty })
        #expect(store.project.device(id: device.id) == device)
    }

    @Test func connectAndRefuseDoubleUse() throws {
        let store = try makeLab()
        let sw1fa1 = try store.ref("SW1", "Fa0/1")
        let sw2fa1 = try store.ref("SW2", "Fa0/1")
        let sw2fa2 = try store.ref("SW2", "Fa0/2")
        let dell1 = try store.ref("DELL1", "GigabitEthernet 1/1")

        store.activeCableType = .fiber
        let link = try store.connect(sw1fa1, sw2fa1, cable: .crossover)
        #expect(link.cableType == .crossover)
        #expect(link.statusA == .none && link.statusB == .none)
        #expect(store.project.links == [link])
        #expect(store.isPortUsed(sw1fa1) && store.isPortUsed(sw2fa1))
        #expect(!store.isPortUsed(sw2fa2))
        #expect(store.link(at: sw2fa1) == link)
        #expect(store.link(at: sw2fa2) == nil)

        // A port takes one cable only, whichever end it would be.
        let before = store.project
        #expect(throws: EditError.portInUse(sw1fa1)) { try store.connect(sw1fa1, sw2fa2) }
        #expect(throws: EditError.portInUse(sw2fa1)) { try store.connect(dell1, sw2fa1) }
        #expect(throws: EditError.portInUse(sw1fa1)) { try store.connect(sw1fa1, sw2fa1) }
        #expect(store.project == before)

        // Without an explicit cable the active cable type is used.
        #expect(try store.connect(dell1, sw2fa2).cableType == .fiber)
        #expect(store.project.validate().isEmpty)
    }

    @Test func samePortSameDeviceAndUnknownPortAreRefused() throws {
        let store = try makeLab()
        let fa1 = try store.ref("SW1", "Fa0/1")
        let fa2 = try store.ref("SW1", "Fa0/2")
        let ghostPort = PortRef(deviceID: fa1.deviceID, portID: UUID())
        let ghostDevice = PortRef(deviceID: UUID(), portID: fa1.portID)
        let other = try store.ref("SW2", "Fa0/1")
        let before = store.project

        #expect(throws: EditError.samePort) { try store.connect(fa1, fa1) }
        #expect(throws: EditError.sameDevice) { try store.connect(fa1, fa2) }
        #expect(throws: EditError.unknownPort(ghostPort)) { try store.connect(ghostPort, other) }
        #expect(throws: EditError.unknownPort(ghostDevice)) { try store.connect(other, ghostDevice) }

        #expect(store.project == before)
        #expect(store.project.links.isEmpty)
        // Refused operations leave no undo step behind: three undos remove the three devices.
        #expect(store.undo() && store.undo() && store.undo())
        #expect(!store.canUndo)
    }

    @Test func twoClickFlow() throws {
        let store = try makeLab()
        let a = try store.ref("SW1", "Fa0/1")
        let sameDevice = try store.ref("SW1", "Fa0/2")
        let b = try store.ref("SW2", "Fa0/1")
        let c = try store.ref("DELL1", "GigabitEthernet 1/1")
        store.activeCableType = .crossover

        #expect(try store.clickPort(a) == .pending(a))
        #expect(store.pendingPort == a)
        #expect(try store.clickPort(a) == .cancelled)
        #expect(store.pendingPort == nil)

        #expect(try store.clickPort(a) == .pending(a))
        // An invalid second click throws and keeps the first port armed.
        #expect(throws: EditError.sameDevice) { try store.clickPort(sameDevice) }
        #expect(store.pendingPort == a)
        guard case .connected(let link) = try store.clickPort(b) else {
            Issue.record("expected a connection")
            return
        }
        #expect(link.a == a && link.b == b && link.cableType == .crossover)
        #expect(store.pendingPort == nil)
        #expect(store.project.links == [link])

        // An occupied port cannot start a cable, nor end one.
        #expect(throws: EditError.portInUse(a)) { try store.clickPort(a) }
        #expect(store.pendingPort == nil)
        #expect(try store.clickPort(c) == .pending(c))
        #expect(throws: EditError.portInUse(b)) { try store.clickPort(b) }
        #expect(store.pendingPort == c)
        store.cancelPendingPort()
        #expect(store.pendingPort == nil)
        let ghost = PortRef(deviceID: UUID(), portID: UUID())
        #expect(throws: EditError.unknownPort(ghost)) { try store.clickPort(ghost) }

        // A pending port disappears together with its device.
        #expect(try store.clickPort(c) == .pending(c))
        try store.removeDevice(id: c.deviceID)
        #expect(store.pendingPort == nil)
    }

    @Test func peersAndConnections() throws {
        let store = try makeLab()
        let a = try store.ref("SW1", "Gi0/1")
        let b = try store.ref("DELL1", "GigabitEthernet 1/1")
        let link = try store.connect(a, b, cable: .straight)

        let peer = try #require(store.peer(of: a))
        #expect(peer.device.hostname == "DELL1")
        #expect(peer.port.name == "GigabitEthernet 1/1")
        #expect(peer.port.shortName == "Gi1/1")
        #expect(peer.ref == b && peer.end == .b && peer.link == link)
        let back = try #require(store.peer(of: b))
        #expect(back.device.hostname == "SW1" && back.port.name == "Gi0/1" && back.end == .a)
        #expect(store.peer(of: try store.ref("SW1", "Gi0/2")) == nil)

        let rows = store.connections(ofDevice: a.deviceID)
        #expect(rows.count == 27)
        #expect(rows.filter { $0.link != nil }.map(\.port.name) == ["Gi0/1"])
        #expect(rows.first { $0.port.name == "Gi0/1" }?.peer == peer)
        #expect(store.connections(ofDevice: UUID()).isEmpty)

        #expect(link.end(at: a) == .a && link.end(onDevice: b.deviceID) == .b)
        #expect(link.otherEnd(from: a) == b)
        #expect(store.project.links(ofDevice: a.deviceID) == [link])
        #expect(store.project.links(between: b.deviceID, and: a.deviceID) == [link])
        #expect(DevicePair(a.deviceID, b.deviceID) == DevicePair(b.deviceID, a.deviceID))
    }

    @Test func linkAttributes() throws {
        let store = try makeLab()
        let link = try store.connect(store.ref("SW1", "Fa0/1"), store.ref("SW2", "Fa0/1"))
        try store.setCableType(linkID: link.id, .console)
        try store.setLinkNote(linkID: link.id, "patch 12")
        try store.setStatus(linkID: link.id, end: .b, status: .red)
        #expect(try store.cycleStatus(linkID: link.id, end: .a) == .green)
        #expect(try store.cycleStatus(linkID: link.id, end: .a) == .orange)
        #expect(try store.cycleStatus(linkID: link.id, end: .b) == .none)

        let stored = try #require(store.project.link(id: link.id))
        #expect(stored.cableType == .console && stored.note == "patch 12")
        #expect(stored.statusA == .orange && stored.statusB == .none)
        #expect(LinkStatus.red.next == .none && LinkStatus.orange.next == .red)

        let ghost = UUID()
        #expect(throws: EditError.unknownLink(ghost)) { try store.setCableType(linkID: ghost, .fiber) }
        #expect(throws: EditError.unknownLink(ghost)) { try store.cycleStatus(linkID: ghost, end: .a) }
        #expect(throws: EditError.unknownLink(ghost)) { try store.removeLink(id: ghost) }

        try store.removeLink(id: link.id)
        #expect(store.project.links.isEmpty)
        #expect(!store.isPortUsed(link.a))
    }

    @Test func removingADeviceRemovesItsLinksAndCleansBundles() throws {
        let store = try makeLab()
        let trunk = try store.connect(store.ref("SW1", "Fa0/1"), store.ref("SW2", "Fa0/1"))
        let lag1 = try store.connect(store.ref("SW1", "Gi0/1"), store.ref("DELL1", "GigabitEthernet 1/1"))
        let lag2 = try store.connect(store.ref("SW1", "Gi0/2"), store.ref("DELL1", "GigabitEthernet 1/2"))
        let bundle = try store.createBundle(linkIDs: [lag1.id, lag2.id])
        let dell = try #require(store.project.device(hostname: "DELL1"))
        store.selection = [.device(dell.id), .link(lag1.id), .link(trunk.id)]

        try store.removeDevice(id: dell.id)

        #expect(store.project.devices.map(\.hostname) == ["SW1", "SW2"])
        #expect(store.project.links == [trunk])
        #expect(store.project.bundles.isEmpty)
        #expect(store.project.bundle(id: bundle.id) == nil)
        #expect(!store.isPortUsed(lag1.a) && !store.isPortUsed(lag2.a))
        #expect(store.project.validate().isEmpty)
        // Selection no longer mentions anything that is gone.
        #expect(store.selection == [.link(trunk.id)])

        // One undo brings back the device, both cables and the bundle.
        store.undo()
        #expect(store.project.devices.count == 3 && store.project.links.count == 3)
        #expect(store.project.bundle(id: bundle.id)?.linkIDs == [lag1.id, lag2.id])
        #expect(store.project.link(id: lag1.id)?.bundleID == bundle.id)
        #expect(store.project.validate().isEmpty)

        let ghost = UUID()
        #expect(throws: EditError.unknownDevice(ghost)) { try store.removeDevices(ids: [dell.id, ghost]) }
        #expect(store.project.devices.count == 3)
    }

    @Test func shrinkingABundleBelowTwoLinksDissolvesIt() throws {
        let store = try makeLab()
        let links = try (1...3).map {
            try store.connect(store.ref("SW1", "Fa0/\($0)"), store.ref("SW2", "Fa0/\($0)"))
        }
        let bundle = try store.createBundle(linkIDs: links.map(\.id))

        try store.removeLink(id: links[0].id)
        #expect(store.project.bundle(id: bundle.id)?.linkIDs == [links[1].id, links[2].id])
        #expect(store.project.validate().isEmpty)

        store.selection = [.link(links[1].id)]
        store.removeSelection()
        #expect(store.project.bundles.isEmpty)
        #expect(store.project.links.map(\.id) == [links[2].id])
        #expect(store.project.links[0].bundleID == nil)
        #expect(store.project.validate().isEmpty)
        #expect(store.selection.isEmpty)
    }

    @Test func removeSelectionIsOneUndoStep() throws {
        let store = try makeLab()
        let link = try store.connect(store.ref("SW1", "Fa0/1"), store.ref("SW2", "Fa0/1"))
        let other = try store.connect(store.ref("SW2", "Fa0/2"), store.ref("DELL1", "GigabitEthernet 1/1"))
        let note = store.addAnnotation(text: "rack A", at: CGPoint(x: 10, y: 10))
        let sw1 = try #require(store.project.device(hostname: "SW1"))
        let before = store.project

        store.selection = [.device(sw1.id), .link(other.id), .annotation(note.id)]
        store.removeSelection()
        #expect(store.project.devices.map(\.hostname) == ["SW2", "DELL1"])
        #expect(store.project.links.isEmpty)
        #expect(store.project.link(id: link.id) == nil)
        #expect(store.project.annotations.isEmpty)
        #expect(store.selection.isEmpty)

        store.undo()
        #expect(store.project == before)
    }
}
