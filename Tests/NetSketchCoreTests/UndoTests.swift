import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import Testing
@testable import NetSketchCore

@Suite struct UndoTests {
    @Test func undoAndRedoRestoreState() throws {
        let store = makeStore()
        #expect(!store.canUndo && !store.canRedo && !store.isDirty)
        #expect(!store.undo() && !store.redo())
        let empty = store.project

        let sw1 = try store.addDevice(templateID: TemplateID.c2960_24, at: CGPoint(x: 100, y: 100))
        let afterFirst = store.project
        let sw2 = try store.addDevice(templateID: TemplateID.c2960_24, at: CGPoint(x: 400, y: 100))
        let afterSecond = store.project
        let link = try store.connect(store.ref("SW1", "Fa0/1"), store.ref("SW2", "Fa0/1"))
        let afterLink = store.project
        try store.renameDevice(id: sw1.id, to: "CORE")
        let afterRename = store.project
        #expect(store.canUndo && !store.canRedo && store.isDirty)

        #expect(store.undo())
        #expect(store.project == afterLink)
        #expect(store.project.device(id: sw1.id)?.hostname == "SW1")
        #expect(store.canRedo)
        #expect(store.undo())
        #expect(store.project == afterSecond)
        #expect(store.project.link(id: link.id) == nil)
        #expect(store.undo())
        #expect(store.project == afterFirst)
        #expect(store.project.device(id: sw2.id) == nil)
        #expect(store.undo())
        #expect(store.project == empty)
        #expect(!store.canUndo && !store.isDirty)
        #expect(!store.undo())

        #expect(store.redo() && store.redo() && store.redo() && store.redo())
        #expect(store.project == afterRename)
        #expect(!store.canRedo && !store.redo())

        // A new edit after an undo discards the redo branch.
        store.undo()
        #expect(store.canRedo)
        try store.setDeviceNote(id: sw1.id, "rack 3")
        #expect(!store.canRedo)
        #expect(store.project.device(id: sw1.id)?.hostname == "SW1")
    }

    @Test func noOpsAndFailuresRecordNoUndoStep() throws {
        let store = makeStore()
        let device = try store.addDevice(templateID: TemplateID.pc, at: .zero)
        try store.renameDevice(id: device.id, to: "PC1")        // unchanged
        try store.setDeviceNote(id: device.id, "")              // unchanged
        store.moveDevices(ids: [device.id], by: .zero)
        store.moveDevices(ids: [UUID()], by: CGSize(width: 5, height: 5))
        store.removeSelection()                                 // nothing selected
        #expect(throws: EditError.emptyName) { try store.renameDevice(id: device.id, to: "  ") }
        #expect(throws: EditError.unknownDevice(device.ports[0].id)) {
            try store.renameDevice(id: device.ports[0].id, to: "X")
        }
        #expect(store.undo())
        #expect(!store.canUndo)
        #expect(store.project.devices.isEmpty)
    }

    @Test func dragCoalescesIntoOneUndoStep() throws {
        let store = makeStore(snap: true)
        let device = try store.addDevice(templateID: TemplateID.c2960_24, at: CGPoint(x: 100, y: 100))
        let note = store.addAnnotation(text: "label", at: CGPoint(x: 200, y: 40))
        let start = store.project

        // Many small incremental moves, each far below half a grid cell.
        store.beginDrag()
        #expect(store.isGrouping)
        for _ in 0..<25 {
            store.moveDevices(ids: [device.id], by: CGSize(width: 3, height: 1))
        }
        #expect(store.canUndo)
        store.endDrag()
        #expect(!store.isGrouping)
        // 25 * (3, 1) = (75, 25) -> snapped to the 20 pt grid.
        #expect(store.project.device(id: device.id)?.position == CGPoint(x: 180, y: 120))

        #expect(store.undo())
        #expect(store.project == start)
        #expect(store.redo())
        #expect(store.project.device(id: device.id)?.position == CGPoint(x: 180, y: 120))
        store.undo()

        // Total-translation style (SwiftUI DragGesture.translation), mixed selection.
        store.selection = [.device(device.id), .annotation(note.id)]
        store.beginDrag()
        for step in 1...30 {
            store.dragSelection(translation: CGSize(width: Double(step) * 2, height: Double(step)))
        }
        store.endDrag()
        #expect(store.project.device(id: device.id)?.position == CGPoint(x: 160, y: 140))
        #expect(store.project.annotation(id: note.id)?.position == CGPoint(x: 260, y: 80))
        #expect(store.undo())
        #expect(store.project == start)

        // Exactly two steps remain: the annotation and the device.
        #expect(store.undo() && store.undo())
        #expect(!store.canUndo)
    }

    @Test func dragThatEndsWhereItStartedOrIsCancelledLeavesNoStep() throws {
        let store = makeStore()
        let device = try store.addDevice(templateID: TemplateID.pc, at: CGPoint(x: 50, y: 50))
        let start = store.project

        store.beginDrag()
        store.drag([.device(device.id)], translation: CGSize(width: 40, height: 0))
        store.drag([.device(device.id)], translation: .zero)
        store.endDrag()
        #expect(store.project == start)

        store.beginDrag()
        store.moveSelection(by: CGSize(width: 9, height: 9))           // empty selection: nothing
        store.move([.device(device.id)], by: CGSize(width: 33, height: 7))
        #expect(store.project.device(id: device.id)?.position == CGPoint(x: 83, y: 57))
        store.cancelDrag()
        #expect(store.project == start)
        #expect(!store.isGrouping)

        // Only the "add device" step exists.
        #expect(store.undo())
        #expect(!store.canUndo)
    }

    @Test func undoGroupCoalescesArbitraryEdits() throws {
        let store = makeStore()
        let device = try store.addDevice(templateID: TemplateID.pc, at: .zero)
        let before = store.project

        store.beginUndoGroup()
        for text in ["u", "up", "upl", "upli", "uplin", "uplink"] {
            try store.setPortDescription(device.ref(device.ports[0]), text)
        }
        store.beginUndoGroup()                 // nested
        try store.setDeviceNote(id: device.id, "typed")
        store.endUndoGroup()
        store.endUndoGroup()

        #expect(store.project.port(device.ref(device.ports[0]))?.description == "uplink")
        #expect(store.undo())
        #expect(store.project == before)

        // Undo while a group is still open closes the group first.
        store.beginUndoGroup()
        try store.setDeviceNote(id: device.id, "half typed")
        #expect(store.canUndo)
        #expect(store.undo())
        #expect(store.project == before)
        #expect(!store.isGrouping)
        #expect(store.redo())
        #expect(store.project.device(id: device.id)?.note == "half typed")
    }

    @Test func moveAndSetPosition() throws {
        let store = makeStore(snap: true)
        let device = try store.addDevice(templateID: TemplateID.pc, at: CGPoint(x: 100, y: 100))
        store.moveDevices(ids: [device.id], by: CGSize(width: 20, height: -40))
        #expect(store.project.device(id: device.id)?.position == CGPoint(x: 120, y: 60))
        try store.setPosition(deviceID: device.id, to: CGPoint(x: 333, y: 8))
        #expect(store.project.device(id: device.id)?.position == CGPoint(x: 340, y: 0))
        #expect(throws: EditError.unknownDevice(device.ports[0].id)) {
            try store.setPosition(deviceID: device.ports[0].id, to: .zero)
        }

        #expect(store.snap(CGPoint(x: 29, y: 31)) == CGPoint(x: 20, y: 40))
        store.gridSize = 50
        #expect(store.snap(CGPoint(x: 74, y: 76)) == CGPoint(x: 50, y: 100))
        store.snapToGrid = false
        #expect(store.snap(CGPoint(x: 74.5, y: 76.25)) == CGPoint(x: 74.5, y: 76.25))
        try store.setPosition(deviceID: device.id, to: CGPoint(x: 1.5, y: 2.5))
        #expect(store.project.device(id: device.id)?.position == CGPoint(x: 1.5, y: 2.5))

        // Each move outside a drag is its own step: add + move + setPosition + setPosition.
        #expect(store.undo() && store.undo() && store.undo() && store.undo())
        #expect(!store.canUndo)
    }

    @Test func undoStackIsCapped() throws {
        let store = makeStore()
        store.undoLimit = 5
        let device = try store.addDevice(templateID: TemplateID.pc, at: .zero)
        for index in 1...12 {
            try store.renameDevice(id: device.id, to: "PC-\(index)")
        }
        var undone = 0
        while store.undo() { undone += 1 }
        #expect(undone == 5)
        #expect(store.project.device(id: device.id)?.hostname == "PC-7")
        #expect(ProjectStore(catalog: store.catalog).undoLimit == 200)
    }

    @Test func deviceAndPortSettersAreUndoable() throws {
        let store = makeStore()
        let device = try store.addDevice(templateID: TemplateID.c2960_24, at: .zero)
        let port = try store.ref("SW1", "Fa0/5")
        let base = store.project

        try store.setPortDescription(port, "printer")
        try store.setPortVLAN(port, "trunk 10,20")
        try store.setPortAdminDown(port, true)
        try store.setVLANs(deviceID: device.id, [
            VLANEntry(id: 20, name: "servers"),
            VLANEntry(id: 10, name: "users"),
            VLANEntry(id: 20, name: "duplicate"),
        ])
        try store.setDeviceNote(id: device.id, "rack 1")

        let stored = try #require(store.project.port(port))
        #expect(stored.description == "printer" && stored.vlan == "trunk 10,20" && stored.adminDown)
        // Sorted by VLAN number, first entry of a duplicated number wins.
        #expect(store.project.device(id: device.id)?.vlans == [
            VLANEntry(id: 10, name: "users"), VLANEntry(id: 20, name: "servers"),
        ])
        #expect(store.project.device(id: device.id)?.note == "rack 1")

        // Five edits, five steps.
        store.undo()
        #expect(store.project.device(id: device.id)?.note == "")
        store.undo()
        #expect(store.project.device(id: device.id)?.vlans == [])
        store.undo()
        #expect(store.project.port(port)?.adminDown == false)
        store.undo()
        #expect(store.project.port(port)?.vlan == "")
        store.undo()
        #expect(store.project == base)
        for _ in 1...5 { store.redo() }
        #expect(store.project.port(port)?.adminDown == true)
        #expect(store.project.device(id: device.id)?.vlans.map(\.id) == [10, 20])

        let ghost = PortRef(deviceID: device.id, portID: UUID())
        #expect(throws: EditError.unknownPort(ghost)) { try store.setPortDescription(ghost, "x") }
        #expect(throws: EditError.unknownPort(ghost)) { try store.setPortVLAN(ghost, "x") }
        #expect(throws: EditError.unknownPort(ghost)) { try store.setPortAdminDown(ghost, true) }
        #expect(throws: EditError.unknownDevice(ghost.portID)) { try store.setVLANs(deviceID: ghost.portID, []) }
        #expect(throws: EditError.unknownDevice(ghost.portID)) { try store.setDeviceNote(id: ghost.portID, "x") }
    }

    @Test func annotations() throws {
        let store = makeStore(snap: true)
        let note = store.addAnnotation(text: "Rack A", at: CGPoint(x: 12, y: 47))
        #expect(note.position == CGPoint(x: 20, y: 40))
        try store.setAnnotationText(id: note.id, "Rack B")
        try store.moveAnnotation(id: note.id, to: CGPoint(x: 100, y: 100))
        #expect(store.project.annotations == [Annotation(id: note.id, text: "Rack B", position: CGPoint(x: 100, y: 100))])

        store.undo()
        #expect(store.project.annotation(id: note.id)?.position == CGPoint(x: 20, y: 40))
        store.undo()
        #expect(store.project.annotation(id: note.id)?.text == "Rack A")

        let ghost = UUID()
        #expect(throws: EditError.unknownAnnotation(ghost)) { try store.setAnnotationText(id: ghost, "x") }
        #expect(throws: EditError.unknownAnnotation(ghost)) { try store.moveAnnotation(id: ghost, to: .zero) }
        #expect(throws: EditError.unknownAnnotation(ghost)) { try store.removeAnnotation(id: ghost) }
        try store.removeAnnotation(id: note.id)
        #expect(store.project.annotations.isEmpty)
        store.undo()
        store.undo()
        #expect(store.project.annotations.isEmpty && !store.canUndo)
    }

    @Test func selectionHelpersAndViewMode() throws {
        let store = makeStore()
        let a = try store.addDevice(templateID: TemplateID.pc, at: .zero)
        let b = try store.addDevice(templateID: TemplateID.server, at: .zero)
        let link = try store.connect(store.ref("PC1", "eth0"), store.ref("SRV1", "eth0"))
        let note = store.addAnnotation(text: "n", at: .zero)

        store.select(.device(a.id))
        store.select(.link(link.id), extending: true)
        store.select(.annotation(note.id), extending: true)
        #expect(store.selectedDeviceIDs == [a.id])
        #expect(store.selectedLinkIDs == [link.id])
        #expect(store.selectedAnnotationIDs == [note.id])
        #expect(SelectionItem.link(link.id).id == link.id)
        store.select(.device(a.id), extending: true)
        #expect(!store.isSelected(.device(a.id)))
        store.select(.device(b.id))
        #expect(store.selection == [.device(b.id)])
        store.selectAll()
        #expect(store.selection.count == 4)

        // Undoing the creation of selected things drops them from the selection.
        store.undo()
        store.undo()
        #expect(store.selection == [.device(a.id), .device(b.id)])
        store.clearSelection()
        #expect(store.selection.isEmpty)

        // The view mode is view state: not undoable, not dirtying, never rolled back by undo.
        let steps = store.canUndo
        #expect(store.viewMode == .physical)
        store.viewMode = .logical
        #expect(store.viewMode == .logical && store.project.viewMode == .logical)
        #expect(store.canUndo == steps)
        store.undo()
        #expect(store.viewMode == .logical)
        store.redo()
        #expect(store.viewMode == .logical)
        store.new()
        #expect(store.viewMode == .logical && !store.isDirty)
        store.viewMode = .physical
        #expect(!store.isDirty && !store.canUndo)
    }

    @Test func behaviorHookDoesNothing() throws {
        let store = makeStore()
        let device = try store.addDevice(templateID: TemplateID.c2960_24, at: .zero)
        let before = store.project
        let behavior = store.behaviors.behavior(for: device)
        #expect(behavior is DefaultDeviceBehavior)
        #expect(behavior.handleCommand("show running-config", on: device, in: store) == nil)
        behavior.deviceDidAdd(device, in: store.project)
        #expect(store.project == before)

        struct Echo: DeviceBehavior {
            func handleCommand(_ command: String, on device: Device, in store: ProjectStore) -> String? {
                "\(device.hostname)# \(command)"
            }
        }
        store.behaviors.register(Echo(), forCategory: .switch)
        #expect(store.behaviors.behavior(for: device).handleCommand("x", on: device, in: store) == "SW1# x")
        store.behaviors.register(DefaultDeviceBehavior(), forTemplateID: device.templateID)
        #expect(store.behaviors.behavior(for: device) is DefaultDeviceBehavior)
        store.behaviors.unregister(templateID: device.templateID)
        store.behaviors.unregister(category: .switch)
        #expect(store.behaviors.behavior(for: device) is DefaultDeviceBehavior)
    }
}
