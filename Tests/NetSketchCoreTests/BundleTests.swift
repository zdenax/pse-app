import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import Testing
@testable import NetSketchCore

@Suite struct BundleTests {
    func makeLab() throws -> ProjectStore {
        let store = makeStore()
        for _ in 1...3 { try store.addDevice(templateID: TemplateID.c2960_24, at: .zero) }
        return store
    }

    @Test func needsTwoLinksBetweenTheSameDevicePair() throws {
        let store = try makeLab()
        let a1 = try store.connect(store.ref("SW1", "Fa0/1"), store.ref("SW2", "Fa0/1"))
        let a2 = try store.connect(store.ref("SW2", "Fa0/2"), store.ref("SW1", "Fa0/2"))  // reversed direction
        let other = try store.connect(store.ref("SW1", "Fa0/3"), store.ref("SW3", "Fa0/3"))
        let before = store.project

        #expect(throws: EditError.bundleNeedsTwoLinks) { try store.createBundle(linkIDs: [a1.id]) }
        #expect(throws: EditError.bundleNeedsTwoLinks) { try store.createBundle(linkIDs: [a1.id, a1.id]) }
        #expect(throws: EditError.bundleNeedsTwoLinks) { try store.createBundle(linkIDs: [UUID]()) }
        #expect(throws: EditError.bundleLinksNotParallel) { try store.createBundle(linkIDs: [a1.id, other.id]) }
        #expect(throws: EditError.bundleLinksNotParallel) { try store.createBundle(linkIDs: [a1.id, a2.id, other.id]) }
        let ghost = UUID()
        #expect(throws: EditError.unknownLink(ghost)) { try store.createBundle(linkIDs: [a1.id, ghost]) }
        #expect(store.project == before)
        #expect(store.project.bundles.isEmpty)

        // Direction of the individual cables does not matter.
        let bundle = try store.createBundle(linkIDs: Set([a2.id, a1.id]))
        #expect(bundle.label == "Po1 / bond1")
        #expect(bundle.linkIDs == [a1.id, a2.id])
        #expect(store.project.bundles == [bundle])
        #expect(store.project.link(id: a1.id)?.bundleID == bundle.id)
        #expect(store.project.link(id: a2.id)?.bundleID == bundle.id)
        #expect(store.project.link(id: other.id)?.bundleID == nil)
        #expect(store.bundle(ofLink: a1.id) == bundle)
        #expect(store.bundle(ofLink: other.id) == nil)
        #expect(store.project.validate().isEmpty)
    }

    @Test func labelsUnbundleAndRename() throws {
        let store = try makeLab()
        let first = try (1...2).map { try store.connect(store.ref("SW1", "Fa0/\($0)"), store.ref("SW2", "Fa0/\($0)")) }
        let second = try (3...4).map { try store.connect(store.ref("SW1", "Fa0/\($0)"), store.ref("SW3", "Fa0/\($0)")) }
        let third = try (5...6).map { try store.connect(store.ref("SW2", "Fa0/\($0)"), store.ref("SW3", "Fa0/\($0)")) }

        let po1 = try store.createBundle(linkIDs: first.map(\.id))
        let po2 = try store.createBundle(linkIDs: second.map(\.id))
        let named = try store.createBundle(linkIDs: third.map(\.id), label: "  MLAG peer  ")
        #expect([po1.label, po2.label, named.label] == ["Po1 / bond1", "Po2 / bond2", "MLAG peer"])

        #expect(throws: EditError.linkAlreadyBundled(first[0].id)) { try store.createBundle(linkIDs: first.map(\.id)) }

        try store.renameBundle(id: po2.id, to: "Po7 / bond7")
        #expect(store.project.bundle(id: po2.id)?.label == "Po7 / bond7")
        #expect(throws: EditError.emptyName) { try store.renameBundle(id: po2.id, to: "   ") }
        let ghost = UUID()
        #expect(throws: EditError.unknownBundle(ghost)) { try store.renameBundle(id: ghost, to: "x") }
        #expect(throws: EditError.unknownBundle(ghost)) { try store.unbundle(id: ghost) }

        try store.unbundle(id: po1.id)
        #expect(store.project.bundle(id: po1.id) == nil)
        #expect(store.project.links.count == 6)
        #expect(first.allSatisfy { store.project.link(id: $0.id)?.bundleID == nil })
        #expect(store.project.validate().isEmpty)

        // The freed label is reused.
        #expect(try store.createBundle(linkIDs: first.map(\.id)).label == "Po1 / bond1")

        store.undo()
        store.undo()
        #expect(store.project.bundle(id: po1.id) == po1)
        #expect(first.allSatisfy { store.project.link(id: $0.id)?.bundleID == po1.id })
    }
}
