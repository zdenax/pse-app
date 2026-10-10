import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import Observation

/// Something that can be selected on the canvas.
public enum SelectionItem: Hashable, Codable, Sendable {
    case device(UUID)
    case link(UUID)
    case annotation(UUID)

    /// The id of the selected object.
    public var id: UUID {
        switch self {
        case .device(let id), .link(let id), .annotation(let id): return id
        }
    }
}

/// Outcome of one click on a port in the two-click cabling flow.
public enum PortClickResult: Equatable, Sendable {
    /// First click: the port is remembered in `pendingPort`.
    case pending(PortRef)
    /// The pending port was clicked again: cabling was cancelled.
    case cancelled
    /// Second click: the cable was created.
    case connected(Link)
}

/// The editing engine: owns the project, the editor state the UI binds to, and the undo history.
///
/// Every mutating operation is one undo step (or part of one, inside `beginUndoGroup()` /
/// `endUndoGroup()`), marks the project dirty, and leaves the project untouched when it throws.
/// Operations that change nothing record no undo step. The class is not thread-safe; use it
/// from the main thread. It performs no protocol simulation of any kind.
@Observable
public final class ProjectStore {

    // MARK: State

    /// The document. Read-only for the UI; change it through the operations below.
    public private(set) var project: Project
    public let catalog: DeviceCatalog
    /// Selected devices, links and annotations. Freely writable; stale ids are pruned
    /// automatically whenever the project changes.
    public var selection: Set<SelectionItem> = []
    /// When true, new and moved devices and annotations land on the grid.
    public var snapToGrid: Bool = true
    /// Grid pitch in canvas points.
    public var gridSize: CGFloat = 20
    /// The first port clicked while cabling, see `clickPort(_:)`.
    public private(set) var pendingPort: PortRef?
    /// Cable type used by `clickPort(_:)` and by `connect` when none is given.
    public var activeCableType: CableType = .straight
    /// File the project was opened from or last saved to.
    public private(set) var fileURL: URL?
    /// True when the project differs from the last saved (or freshly created/opened) state.
    public private(set) var isDirty: Bool = false
    /// Inconsistencies found (and repaired) by the last `open(_:)`; empty for a healthy file.
    public private(set) var openIssues: [ProjectIssue] = []
    /// Hook registry for the CLI / future simulation. The store itself never calls it.
    public var behaviors = DeviceBehaviorRegistry()
    /// Maximum number of undo steps kept.
    public var undoLimit: Int = 200

    private var undoStack: [Project] = []
    private var redoStack: [Project] = []
    @ObservationIgnored private var cleanState: Project
    @ObservationIgnored private var groupDepth = 0
    @ObservationIgnored private var groupBase: Project?
    @ObservationIgnored private var rawPositions: [SelectionItem: CGPoint] = [:]

    /// - Parameters:
    ///   - catalog: defaults to the standard catalog (bundle + Application Support files).
    ///   - project: the initial document; an empty project by default.
    public init(catalog: DeviceCatalog = DeviceCatalog(), project: Project = Project()) {
        self.catalog = catalog
        self.project = project
        self.cleanState = ProjectStore.withoutViewState(project)
    }

    /// Current view mode. Stored in the project file; changing it is neither undoable nor dirtying.
    public var viewMode: ViewMode {
        get { project.viewMode ?? .physical }
        set {
            guard project.viewMode != newValue else { return }
            project.viewMode = newValue
            groupBase?.viewMode = newValue
        }
    }

    // MARK: Undo / redo

    public var canUndo: Bool { !undoStack.isEmpty || (groupDepth > 0 && groupBase != project) }
    public var canRedo: Bool { !redoStack.isEmpty }

    /// Reverts the last undo step. An open undo group is closed first. Returns false when there is nothing to undo.
    @discardableResult
    public func undo() -> Bool {
        closeAllGroups()
        guard let previous = undoStack.popLast() else { return false }
        redoStack.append(project)
        restore(previous)
        return true
    }

    /// Re-applies the last undone step. Returns false when there is nothing to redo.
    @discardableResult
    public func redo() -> Bool {
        closeAllGroups()
        guard let next = redoStack.popLast() else { return false }
        undoStack.append(project)
        restore(next)
        return true
    }

    /// Starts coalescing: every operation until the matching `endUndoGroup()` becomes ONE undo step.
    /// Groups nest. Use it for drags and for text fields that write on every keystroke.
    public func beginUndoGroup() {
        if groupDepth == 0 {
            groupBase = project
            rawPositions.removeAll()
        }
        groupDepth += 1
    }

    /// Ends the group started by `beginUndoGroup()`; records one undo step if anything changed.
    public func endUndoGroup() {
        guard groupDepth > 0 else { return }
        groupDepth -= 1
        guard groupDepth == 0 else { return }
        if let base = groupBase, base != project {
            pushUndo(base)
        }
        groupBase = nil
        rawPositions.removeAll()
    }

    /// Abandons the open group (all nesting levels) and restores the project as it was when it began.
    public func cancelUndoGroup() {
        guard groupDepth > 0 else { return }
        groupDepth = 0
        let base = groupBase
        groupBase = nil
        rawPositions.removeAll()
        if let base { restore(base) }
    }

    /// True between `beginUndoGroup()` / `beginDrag()` and the matching end.
    public var isGrouping: Bool { groupDepth > 0 }

    // MARK: Grid

    /// The nearest grid point when `snapToGrid` is on; `point` unchanged otherwise.
    public func snap(_ point: CGPoint) -> CGPoint {
        guard snapToGrid, gridSize > 0 else { return point }
        return CGPoint(
            x: (point.x / gridSize).rounded() * gridSize,
            y: (point.y / gridSize).rounded() * gridSize
        )
    }

    // MARK: Selection

    public var selectedDeviceIDs: Set<UUID> {
        Set(selection.compactMap { if case .device(let id) = $0 { return id } else { return nil } })
    }

    public var selectedLinkIDs: Set<UUID> {
        Set(selection.compactMap { if case .link(let id) = $0 { return id } else { return nil } })
    }

    public var selectedAnnotationIDs: Set<UUID> {
        Set(selection.compactMap { if case .annotation(let id) = $0 { return id } else { return nil } })
    }

    public func isSelected(_ item: SelectionItem) -> Bool { selection.contains(item) }

    /// Selects `item`. With `extending` the item is toggled in the existing selection (shift-click).
    public func select(_ item: SelectionItem, extending: Bool = false) {
        if extending {
            if selection.contains(item) { selection.remove(item) } else { selection.insert(item) }
        } else {
            selection = [item]
        }
    }

    public func clearSelection() { selection.removeAll() }

    /// Selects every device, link and annotation.
    public func selectAll() {
        var all = Set<SelectionItem>()
        project.devices.forEach { all.insert(.device($0.id)) }
        project.links.forEach { all.insert(.link($0.id)) }
        project.annotations.forEach { all.insert(.annotation($0.id)) }
        selection = all
    }

    /// Deletes everything selected (devices with their cables, links, annotations) as one undo step.
    public func removeSelection() {
        let devices = selectedDeviceIDs
        let links = selectedLinkIDs
        let annotations = selectedAnnotationIDs
        mutate { ProjectStore.remove(devices: devices, links: links, annotations: annotations, from: &$0) }
    }

    // MARK: Devices

    /// The next free automatic hostname for a category: "SW1", "SW2", "R1", "AP1", "PC1", "SRV1".
    public func nextHostname(for category: DeviceCategory) -> String {
        let used = Set(project.devices.map { $0.hostname.lowercased() })
        let prefix = category.hostnamePrefix
        var number = 1
        while used.contains("\(prefix)\(number)".lowercased()) { number += 1 }
        return "\(prefix)\(number)"
    }

    /// Places a new device created from a catalog template. `point` is the device centre and is
    /// snapped when `snapToGrid` is on. The hostname is generated unless one is given.
    @discardableResult
    public func addDevice(templateID: String, at point: CGPoint, hostname: String? = nil) throws -> Device {
        guard let template = catalog.template(id: templateID) else {
            throw EditError.unknownTemplate(templateID)
        }
        return addDevice(from: template, at: point, hostname: hostname)
    }

    /// Places a new device created from any template (it does not have to be in the catalog).
    @discardableResult
    public func addDevice(from template: DeviceTemplate, at point: CGPoint, hostname: String? = nil) -> Device {
        let given = hostname?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let device = template.makeDevice(
            hostname: given.isEmpty ? nextHostname(for: template.category) : given,
            at: snap(point)
        )
        mutate { $0.devices.append(device) }
        return device
    }

    /// Removes the devices together with every cable plugged into them; bundles left with
    /// fewer than two links are dissolved. Throws `.unknownDevice` (and changes nothing) for an unknown id.
    public func removeDevices(ids: Set<UUID>) throws {
        try mutate { project in
            for id in ids where project.device(id: id) == nil { throw EditError.unknownDevice(id) }
            ProjectStore.remove(devices: ids, links: [], annotations: [], from: &project)
        }
    }

    public func removeDevice(id: UUID) throws {
        try removeDevices(ids: [id])
    }

    /// Sets the hostname (trimmed). Throws `.emptyName` for an empty one. Duplicates are allowed.
    public func renameDevice(id: UUID, to hostname: String) throws {
        let trimmed = hostname.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw EditError.emptyName }
        try updateDevice(id) { $0.hostname = trimmed }
    }

    public func setDeviceNote(id: UUID, _ note: String) throws {
        try updateDevice(id) { $0.note = note }
    }

    /// Replaces the device's VLAN table. Entries are stored sorted by VLAN number; when a
    /// number occurs more than once the first entry wins. No logic is attached.
    public func setVLANs(deviceID: UUID, _ vlans: [VLANEntry]) throws {
        var seen = Set<Int>()
        let table = vlans.filter { seen.insert($0.id).inserted }.sorted { $0.id < $1.id }
        try updateDevice(deviceID) { $0.vlans = table }
    }

    // MARK: IP configuration (set from the consoles; used by the network simulation of the CLI)

    /// Sets or, with `nil`, removes the address of one layer-3 interface of the device.
    public func setAddress(deviceID: UUID, interface: L3InterfaceID, _ address: String?) throws {
        try updateDevice(deviceID) { device in
            let index = device.addresses.firstIndex { $0.interface == interface }
            switch (index, address) {
            case (let index?, let address?): device.addresses[index].address = address
            case (let index?, nil): device.addresses.remove(at: index)
            case (nil, let address?): device.addresses.append(InterfaceAddress(interface: interface, address: address))
            case (nil, nil): break
            }
        }
    }

    public func setDefaultGateway(deviceID: UUID, _ gateway: String) throws {
        try updateDevice(deviceID) { $0.defaultGateway = gateway }
    }

    /// Replaces the static routes; a route that occurs more than once is kept once.
    public func setStaticRoutes(deviceID: UUID, _ routes: [StaticRoute]) throws {
        var seen = Set<StaticRoute>()
        let unique = routes.filter { seen.insert($0).inserted }
        try updateDevice(deviceID) { $0.staticRoutes = unique }
    }

    /// Moves the device centre to `point` (snapped when `snapToGrid` is on).
    public func setPosition(deviceID: UUID, to point: CGPoint) throws {
        let target = snap(point)
        try updateDevice(deviceID) { $0.position = target }
    }

    // MARK: Ports

    public func setPortDescription(_ ref: PortRef, _ description: String) throws {
        try updatePort(ref) { $0.description = description }
    }

    /// Sets the free-text VLAN field of a port.
    public func setPortVLAN(_ ref: PortRef, _ vlan: String) throws {
        try updatePort(ref) { $0.vlan = vlan }
    }

    /// Marks the port administratively down (IOS `shutdown`) or up again. Stored only.
    public func setPortAdminDown(_ ref: PortRef, _ down: Bool) throws {
        try updatePort(ref) { $0.adminDown = down }
    }

    // MARK: Moving

    /// Moves devices and annotations by `delta` (links in the set are ignored, unknown ids skipped).
    ///
    /// The results are snapped when `snapToGrid` is on. Outside an undo group each call is one
    /// undo step. Inside a group (a drag) the unsnapped positions are accumulated, so many
    /// small deltas add up correctly even with snapping.
    public func move(_ items: Set<SelectionItem>, by delta: CGSize) {
        guard delta != .zero else { return }
        mutate { project in
            for item in items {
                guard let current = ProjectStore.position(of: item, in: project) else { continue }
                let raw = (groupDepth > 0 ? rawPositions[item] : nil) ?? current
                let moved = CGPoint(x: raw.x + delta.width, y: raw.y + delta.height)
                if groupDepth > 0 { rawPositions[item] = moved }
                ProjectStore.setPosition(of: item, to: snap(moved), in: &project)
            }
        }
    }

    /// Moves devices by `delta`, see `move(_:by:)`.
    public func moveDevices(ids: Set<UUID>, by delta: CGSize) {
        move(Set(ids.map(SelectionItem.device)), by: delta)
    }

    /// Moves the selected devices and annotations by `delta`, see `move(_:by:)`.
    public func moveSelection(by delta: CGSize) {
        move(selection, by: delta)
    }

    /// Starts a drag: everything until `endDrag()` is one undo step. Same as `beginUndoGroup()`.
    public func beginDrag() { beginUndoGroup() }

    /// Positions `items` at "where they were when the drag began" + `translation` (snapped when
    /// `snapToGrid` is on). `translation` is the TOTAL offset since `beginDrag()`, i.e. exactly
    /// SwiftUI's `DragGesture.Value.translation`. Outside a drag it behaves like `move(_:by:)`.
    public func drag(_ items: Set<SelectionItem>, translation: CGSize) {
        guard groupDepth > 0, let base = groupBase else {
            move(items, by: translation)
            return
        }
        mutate { project in
            for item in items {
                guard let origin = ProjectStore.position(of: item, in: base) else { continue }
                let moved = CGPoint(x: origin.x + translation.width, y: origin.y + translation.height)
                rawPositions[item] = moved
                ProjectStore.setPosition(of: item, to: snap(moved), in: &project)
            }
        }
    }

    /// Drags the selected devices and annotations, see `drag(_:translation:)`.
    public func dragSelection(translation: CGSize) {
        drag(selection, translation: translation)
    }

    /// Ends the drag and records one undo step if anything moved. Same as `endUndoGroup()`.
    public func endDrag() { endUndoGroup() }

    /// Aborts the drag and puts everything back. Same as `cancelUndoGroup()`.
    public func cancelDrag() { cancelUndoGroup() }

    // MARK: Cabling

    public func isPortUsed(_ ref: PortRef) -> Bool { project.isPortUsed(ref) }

    /// The cable plugged into the port, if any.
    public func link(at ref: PortRef) -> Link? { project.link(at: ref) }

    /// The device and port at the other end of the cable plugged into `ref`.
    public func peer(of ref: PortRef) -> PortPeer? { project.peer(of: ref) }

    /// Every port of the device with what is plugged into it ("what is plugged where").
    public func connections(ofDevice deviceID: UUID) -> [PortConnection] {
        project.connections(ofDevice: deviceID)
    }

    /// Plugs a cable between two ports. `cable` defaults to `activeCableType`.
    ///
    /// Refuses with `.unknownPort`, `.samePort`, `.sameDevice` (both ends on one device)
    /// or `.portInUse` (a port takes one cable only). Connector and cable type are not checked.
    @discardableResult
    public func connect(_ a: PortRef, _ b: PortRef, cable: CableType? = nil) throws -> Link {
        let cableType = cable ?? activeCableType
        return try mutate { project in
            guard project.port(a) != nil else { throw EditError.unknownPort(a) }
            guard project.port(b) != nil else { throw EditError.unknownPort(b) }
            guard a != b else { throw EditError.samePort }
            guard a.deviceID != b.deviceID else { throw EditError.sameDevice }
            guard !project.isPortUsed(a) else { throw EditError.portInUse(a) }
            guard !project.isPortUsed(b) else { throw EditError.portInUse(b) }
            let link = Link(a: a, b: b, cableType: cableType)
            project.links.append(link)
            return link
        }
    }

    /// The two-click cabling flow.
    ///
    /// - No pending port: the port becomes `pendingPort` (`.pending`); throws `.portInUse` or
    ///   `.unknownPort` and stays idle when the port cannot start a cable.
    /// - Clicking the pending port again cancels (`.cancelled`).
    /// - Any other port: `connect(pendingPort, ref, cable: activeCableType)`. On success the
    ///   pending port is cleared (`.connected`); on failure the error is thrown and the pending
    ///   port is KEPT so the user can pick another target (call `cancelPendingPort()` on Esc).
    @discardableResult
    public func clickPort(_ ref: PortRef) throws -> PortClickResult {
        guard project.port(ref) != nil else { throw EditError.unknownPort(ref) }
        guard let first = pendingPort else {
            guard !project.isPortUsed(ref) else { throw EditError.portInUse(ref) }
            pendingPort = ref
            return .pending(ref)
        }
        if first == ref {
            pendingPort = nil
            return .cancelled
        }
        let link = try connect(first, ref, cable: activeCableType)
        pendingPort = nil
        return .connected(link)
    }

    /// Forgets the first clicked port.
    public func cancelPendingPort() { pendingPort = nil }

    /// Unplugs a cable. A bundle left with fewer than two links is dissolved.
    public func removeLink(id: UUID) throws {
        try mutate { project in
            guard project.link(id: id) != nil else { throw EditError.unknownLink(id) }
            ProjectStore.remove(devices: [], links: [id], annotations: [], from: &project)
        }
    }

    public func setCableType(linkID: UUID, _ cableType: CableType) throws {
        try updateLink(linkID) { $0.cableType = cableType }
    }

    /// Sets the status dot at one end of a link.
    public func setStatus(linkID: UUID, end: LinkEnd, status: LinkStatus) throws {
        try updateLink(linkID) { link in
            if end == .a { link.statusA = status } else { link.statusB = status }
        }
    }

    /// Advances the status dot at one end: none -> green -> orange -> red -> none. Returns the new status.
    @discardableResult
    public func cycleStatus(linkID: UUID, end: LinkEnd) throws -> LinkStatus {
        guard let link = project.link(id: linkID) else { throw EditError.unknownLink(linkID) }
        let next = link.status(end).next
        try setStatus(linkID: linkID, end: end, status: next)
        return next
    }

    public func setLinkNote(linkID: UUID, _ note: String) throws {
        try updateLink(linkID) { $0.note = note }
    }

    // MARK: Bundles

    /// The bundle the link belongs to, if any.
    public func bundle(ofLink linkID: UUID) -> LinkBundle? { project.bundle(ofLink: linkID) }

    /// Groups links into a visual bundle (LAG).
    ///
    /// Needs two or more distinct links (`.bundleNeedsTwoLinks`) that all connect the same pair
    /// of devices (`.bundleLinksNotParallel`) and are not bundled yet (`.linkAlreadyBundled`).
    /// Without a label the next free "Po1 / bond1", "Po2 / bond2", ... is used.
    @discardableResult
    public func createBundle<S: Sequence>(linkIDs: S, label: String? = nil) throws -> LinkBundle where S.Element == UUID {
        let requested = Set(linkIDs)
        let given = label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return try mutate { project in
            for id in requested where project.link(id: id) == nil { throw EditError.unknownLink(id) }
            guard requested.count >= 2 else { throw EditError.bundleNeedsTwoLinks }
            let members = project.links.filter { requested.contains($0.id) }
            if let bundled = members.first(where: { $0.bundleID != nil }) {
                throw EditError.linkAlreadyBundled(bundled.id)
            }
            guard Set(members.map(\.devicePair)).count == 1 else { throw EditError.bundleLinksNotParallel }

            let bundle = LinkBundle(
                label: given.isEmpty ? ProjectStore.nextBundleLabel(in: project) : given,
                linkIDs: members.map(\.id)
            )
            project.bundles.append(bundle)
            for index in project.links.indices where requested.contains(project.links[index].id) {
                project.links[index].bundleID = bundle.id
            }
            return bundle
        }
    }

    /// Dissolves a bundle; its links stay.
    public func unbundle(id: UUID) throws {
        try mutate { project in
            guard project.bundle(id: id) != nil else { throw EditError.unknownBundle(id) }
            project.bundles.removeAll { $0.id == id }
            for index in project.links.indices where project.links[index].bundleID == id {
                project.links[index].bundleID = nil
            }
        }
    }

    /// Sets the bundle caption (trimmed). Throws `.emptyName` for an empty one.
    public func renameBundle(id: UUID, to label: String) throws {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw EditError.emptyName }
        try mutate { project in
            guard let index = project.bundles.firstIndex(where: { $0.id == id }) else {
                throw EditError.unknownBundle(id)
            }
            project.bundles[index].label = trimmed
        }
    }

    // MARK: Annotations

    /// Adds a text label; `point` is its top-leading corner (snapped when `snapToGrid` is on).
    @discardableResult
    public func addAnnotation(text: String, at point: CGPoint) -> Annotation {
        let annotation = Annotation(text: text, position: snap(point))
        mutate { $0.annotations.append(annotation) }
        return annotation
    }

    public func moveAnnotation(id: UUID, to point: CGPoint) throws {
        let target = snap(point)
        try updateAnnotation(id) { $0.position = target }
    }

    public func setAnnotationText(id: UUID, _ text: String) throws {
        try updateAnnotation(id) { $0.text = text }
    }

    public func removeAnnotation(id: UUID) throws {
        try mutate { project in
            guard project.annotation(id: id) != nil else { throw EditError.unknownAnnotation(id) }
            project.annotations.removeAll { $0.id == id }
        }
    }

    // MARK: Project and files

    /// Sets the project name (undoable).
    public func renameProject(to name: String) {
        mutate { $0.name = name }
    }

    /// Replaces the document with a new empty project and clears history, selection and file URL.
    public func new(name: String = "") {
        reset(to: Project(name: name, viewMode: project.viewMode), url: nil, clean: nil)
        openIssues = []
    }

    /// Opens a ".netsketch" file. Throws when the file cannot be read or decoded (the current
    /// project is then kept). An inconsistent file is repaired on the way in: the problems are
    /// listed in `openIssues` and the project starts out dirty.
    public func open(_ url: URL) throws {
        let loaded = try Project.load(from: url)
        let issues = loaded.validate()
        reset(to: issues.isEmpty ? loaded : loaded.repaired(), url: url, clean: loaded)
        openIssues = issues
    }

    /// Saves to `fileURL`. Throws `.noFileURL` when the project has never been saved.
    public func save() throws {
        guard let url = fileURL else { throw EditError.noFileURL }
        try save(to: url)
    }

    /// Saves to `url`, which becomes the project's `fileURL`. History is kept.
    public func save(to url: URL) throws {
        closeAllGroups()
        try project.save(to: url)
        fileURL = url
        cleanState = ProjectStore.withoutViewState(project)
        isDirty = false
    }

    // MARK: Internals

    /// Runs `body` on a copy of the project and commits the copy only when `body` returns.
    @discardableResult
    private func mutate<T>(_ body: (inout Project) throws -> T) rethrows -> T {
        var draft = project
        let result = try body(&draft)
        commit(draft)
        return result
    }

    private func commit(_ draft: Project) {
        guard draft != project else { return }
        if groupDepth == 0 { pushUndo(project) }
        if !redoStack.isEmpty { redoStack.removeAll() }
        project = draft
        projectDidChange()
    }

    private func pushUndo(_ snapshot: Project) {
        undoStack.append(snapshot)
        let limit = max(1, undoLimit)
        if undoStack.count > limit { undoStack.removeFirst(undoStack.count - limit) }
        if !redoStack.isEmpty { redoStack.removeAll() }
    }

    /// Swaps in a snapshot while keeping the current view mode (view state is not undoable).
    private func restore(_ snapshot: Project) {
        var restored = snapshot
        restored.viewMode = project.viewMode
        project = restored
        projectDidChange()
    }

    private func closeAllGroups() {
        guard groupDepth > 0 else { return }
        groupDepth = 1
        endUndoGroup()
    }

    private func projectDidChange() {
        let live = selection.filter { item in
            switch item {
            case .device(let id): return project.device(id: id) != nil
            case .link(let id): return project.link(id: id) != nil
            case .annotation(let id): return project.annotation(id: id) != nil
            }
        }
        if live.count != selection.count { selection = live }
        if let pending = pendingPort, project.port(pending) == nil || project.isPortUsed(pending) {
            pendingPort = nil
        }
        let dirty = ProjectStore.withoutViewState(project) != cleanState
        if dirty != isDirty { isDirty = dirty }
    }

    private func reset(to newProject: Project, url: URL?, clean: Project?) {
        groupDepth = 0
        groupBase = nil
        rawPositions.removeAll()
        undoStack.removeAll()
        redoStack.removeAll()
        selection.removeAll()
        pendingPort = nil
        fileURL = url
        project = newProject
        cleanState = ProjectStore.withoutViewState(clean ?? newProject)
        isDirty = ProjectStore.withoutViewState(newProject) != cleanState
    }

    private static func withoutViewState(_ project: Project) -> Project {
        var copy = project
        copy.viewMode = nil
        return copy
    }

    private func updateDevice(_ id: UUID, _ change: (inout Device) -> Void) throws {
        try mutate { project in
            guard let index = project.devices.firstIndex(where: { $0.id == id }) else {
                throw EditError.unknownDevice(id)
            }
            change(&project.devices[index])
        }
    }

    private func updatePort(_ ref: PortRef, _ change: (inout Port) -> Void) throws {
        try mutate { project in
            guard let deviceIndex = project.devices.firstIndex(where: { $0.id == ref.deviceID }),
                  let portIndex = project.devices[deviceIndex].ports.firstIndex(where: { $0.id == ref.portID })
            else { throw EditError.unknownPort(ref) }
            change(&project.devices[deviceIndex].ports[portIndex])
        }
    }

    private func updateLink(_ id: UUID, _ change: (inout Link) -> Void) throws {
        try mutate { project in
            guard let index = project.links.firstIndex(where: { $0.id == id }) else {
                throw EditError.unknownLink(id)
            }
            change(&project.links[index])
        }
    }

    private func updateAnnotation(_ id: UUID, _ change: (inout Annotation) -> Void) throws {
        try mutate { project in
            guard let index = project.annotations.firstIndex(where: { $0.id == id }) else {
                throw EditError.unknownAnnotation(id)
            }
            change(&project.annotations[index])
        }
    }

    private static func position(of item: SelectionItem, in project: Project) -> CGPoint? {
        switch item {
        case .device(let id): return project.device(id: id)?.position
        case .annotation(let id): return project.annotation(id: id)?.position
        case .link: return nil
        }
    }

    private static func setPosition(of item: SelectionItem, to point: CGPoint, in project: inout Project) {
        switch item {
        case .device(let id):
            if let index = project.devices.firstIndex(where: { $0.id == id }) {
                project.devices[index].position = point
            }
        case .annotation(let id):
            if let index = project.annotations.firstIndex(where: { $0.id == id }) {
                project.annotations[index].position = point
            }
        case .link:
            break
        }
    }

    /// Removes objects and everything that depends on them: cables of removed devices, and
    /// bundles that would be left with fewer than two links.
    private static func remove(
        devices: Set<UUID>,
        links: Set<UUID>,
        annotations: Set<UUID>,
        from project: inout Project
    ) {
        var doomedLinks = links
        if !devices.isEmpty {
            for link in project.links where devices.contains(link.a.deviceID) || devices.contains(link.b.deviceID) {
                doomedLinks.insert(link.id)
            }
            project.devices.removeAll { devices.contains($0.id) }
        }
        if !doomedLinks.isEmpty {
            project.links.removeAll { doomedLinks.contains($0.id) }
            var dissolved = Set<UUID>()
            project.bundles = project.bundles.compactMap { bundle in
                var bundle = bundle
                bundle.linkIDs.removeAll { doomedLinks.contains($0) }
                guard bundle.linkIDs.count >= 2 else {
                    dissolved.insert(bundle.id)
                    return nil
                }
                return bundle
            }
            for index in project.links.indices {
                if let bundleID = project.links[index].bundleID, dissolved.contains(bundleID) {
                    project.links[index].bundleID = nil
                }
            }
        }
        if !annotations.isEmpty {
            project.annotations.removeAll { annotations.contains($0.id) }
        }
    }

    private static func nextBundleLabel(in project: Project) -> String {
        let used = Set(project.bundles.map(\.label))
        var number = 1
        while used.contains("Po\(number) / bond\(number)") { number += 1 }
        return "Po\(number) / bond\(number)"
    }
}
