import AppKit
import Observation
import NetSketchCore

/// The AppKit view behind `CanvasView`: draws the diagram with CoreGraphics and handles all
/// pointer, keyboard, scroll and drop input. SwiftUI only wraps it and overlays banners.
final class CanvasNSView: NSView, NSTextFieldDelegate {

    // MARK: Collaborators

    private(set) var store: ProjectStore
    private(set) var viewport: CanvasViewport
    let feedback: CanvasFeedback

    // MARK: Interaction state (shared with the input extension)

    /// What the primary mouse button is currently doing.
    enum Interaction {
        case idle
        /// Button is down, the pointer has not moved far enough to be a drag yet.
        case pressed(hit: CanvasHit, startView: CGPoint, startCanvas: CGPoint,
                     extending: Bool, collapseTo: SelectionItem?)
        /// Moving the selection; `store.beginDrag()` is open.
        case draggingItems(startCanvas: CGPoint)
        case rubberBand(startCanvas: CGPoint, currentCanvas: CGPoint, base: Set<SelectionItem>)
        case panning(lastView: CGPoint)
    }

    /// What the inline text field edits.
    enum EditTarget: Equatable {
        case hostname(UUID)
        case annotation(UUID)
        case newAnnotation(CGPoint)
        case bundleLabel(UUID)
    }

    var interaction: Interaction = .idle
    var hover: CanvasHit = .empty
    var hoverSince: TimeInterval = 0
    /// Last known pointer position in view coordinates; nil while the pointer is outside.
    var pointerView: CGPoint?
    var isSpaceDown = false
    var rejectedPort: PortRef?
    var rejectedGeneration = 0
    /// Outline of the device that a palette drag would drop.
    var dropGhost: NodeGeometry?
    var dropTemplateID: String?

    var editor: NSTextField?
    var editTarget: EditTarget?
    var isFinishingEdit = false

    private var cachedScene: DiagramScene?
    private var trackingArea: NSTrackingArea?
    private var didInitialLayout = false

    static let dragThreshold: CGFloat = 3
    static let tooltipDelay: TimeInterval = 0.55

    // MARK: Lifecycle

    init(store: ProjectStore, viewport: CanvasViewport, feedback: CanvasFeedback) {
        self.store = store
        self.viewport = viewport
        self.feedback = feedback
        super.init(frame: .zero)
        // Since macOS 14 views no longer clip by default; the canvas must not paint over its neighbors.
        clipsToBounds = true
        registerForDraggedTypes(CanvasNSView.dropTypes)
        attachViewport()
        setAccessibilityLabel("Plátno topologie")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Called by the SwiftUI wrapper when its inputs change.
    func update(store: ProjectStore, viewport: CanvasViewport) {
        if store !== self.store {
            finishEditing(commit: false)
            self.store = store
            interaction = .idle
            hover = .empty
            invalidateScene()
        }
        if viewport !== self.viewport {
            self.viewport.contentBoundsProvider = nil
            self.viewport = viewport
            attachViewport()
            needsDisplay = true
        }
    }

    private func attachViewport() {
        viewport.viewSize = bounds.size
        viewport.contentBoundsProvider = { [weak self] in
            self?.currentScene().contentBounds
        }
    }

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let window else { return }
        window.acceptsMouseMovedEvents = true
        // Take keyboard focus if nothing else has it, so Delete / Esc work right away.
        DispatchQueue.main.async { [weak self] in
            guard let self, let window = self.window else { return }
            if window.firstResponder == nil || window.firstResponder === window {
                window.makeFirstResponder(self)
            }
        }
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        viewport.viewSize = newSize
        if !didInitialLayout, newSize.width > 1, newSize.height > 1 {
            didInitialLayout = true
            bringContentIntoViewIfNeeded()
        }
        needsDisplay = true
    }

    /// A freshly opened project whose content lies outside the untouched viewport is brought into view once.
    private func bringContentIntoViewIfNeeded() {
        guard viewport.zoom == 1, viewport.offset == .zero,
              let content = currentScene().contentBounds else { return }
        let visible = CGRect(origin: .zero, size: bounds.size)
        if !visible.contains(content) { viewport.reset() }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: .zero,
                                  options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    // MARK: Scene

    /// The laid out diagram; rebuilt lazily whenever the project or the view mode changes.
    func currentScene() -> DiagramScene {
        if let cachedScene { return cachedScene }
        let store = self.store
        let scene = withObservationTracking {
            DiagramScene(project: store.project, mode: store.viewMode)
        } onChange: { [weak self] in
            CanvasNSView.onMain { self?.invalidateScene() }
        }
        cachedScene = scene
        return scene
    }

    func invalidateScene() {
        cachedScene = nil
        needsDisplay = true
    }

    /// Runs `work` on the main actor: synchronously when already there (so caches are dropped
    /// before the caller continues), otherwise on the next main-queue turn.
    nonisolated static func onMain(_ work: @escaping @MainActor () -> Void) {
        if Thread.isMainThread {
            MainActor.assumeIsolated { work() }
        } else {
            DispatchQueue.main.async { work() }
        }
    }

    // MARK: Coordinates

    func canvasPoint(_ viewPoint: CGPoint) -> CGPoint { viewport.canvasPoint(fromView: viewPoint) }

    /// Pick slop in canvas points (constant on screen).
    var hitTolerance: CGFloat { 5 / viewport.clampedZoom }

    func hit(atView point: CGPoint) -> CanvasHit {
        currentScene().hitTest(canvasPoint(point), tolerance: hitTolerance)
    }

    // MARK: Drawing

    /// Editor state the drawing depends on, read inside observation tracking so any change repaints.
    private struct LiveState {
        var zoom: CGFloat
        var offset: CGSize
        var selection: Set<SelectionItem>
        var pendingPort: PortRef?
        var gridSize: CGFloat
        var activeCable: CableType
    }

    private func observeLiveState() -> LiveState {
        let store = self.store
        let viewport = self.viewport
        return withObservationTracking {
            LiveState(zoom: viewport.clampedZoom, offset: viewport.offset, selection: store.selection,
                      pendingPort: store.pendingPort, gridSize: store.gridSize, activeCable: store.activeCableType)
        } onChange: { [weak self] in
            CanvasNSView.onMain { self?.needsDisplay = true }
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        render(in: ctx, size: bounds.size, dark: effectiveAppearance.isDarkAppearance)
    }

    /// Paints the whole canvas into a y-down context of `size` points.
    func render(in ctx: CGContext, size: CGSize, dark: Bool) {
        let palette = Palette.resolve(dark: dark)
        let live = observeLiveState()
        let scene = currentScene()
        let project = store.project

        ctx.saveGState()
        ctx.setFillColor(palette.canvas.cgColor)
        ctx.fill(CGRect(origin: .zero, size: size))
        drawGrid(in: ctx, size: size, palette: palette, live: live)

        // Diagram, in canvas coordinates.
        ctx.saveGState()
        ctx.translateBy(x: live.offset.width, y: live.offset.height)
        ctx.scaleBy(x: live.zoom, y: live.zoom)

        var options = RenderOptions(palette: palette)
        options.zoom = live.zoom
        for item in live.selection {
            switch item {
            case .device(let id): options.selectedDevices.insert(id)
            case .link(let id): options.selectedLinks.insert(id)
            case .annotation(let id): options.selectedAnnotations.insert(id)
            }
        }
        options.pendingPort = live.pendingPort
        options.rejectedPort = rejectedPort
        switch hover {
        case .port(let ref):
            options.hoverPort = ref
            options.hoverPortRejected = scene.usedPorts.contains(ref)
                || (live.pendingPort.map { $0.deviceID == ref.deviceID && $0 != ref } ?? false)
        case .link(let ids):
            options.hoverLinks = Set(ids)
        case .bundleLabel(_, let ids):
            options.hoverLinks = Set(ids)
        default:
            break
        }
        switch editTarget {
        case .hostname(let id): options.editingDevice = id
        case .annotation(let id): options.editingAnnotation = id
        default: break
        }
        options.visibleRect = CGRect(x: -live.offset.width / live.zoom, y: -live.offset.height / live.zoom,
                                     width: size.width / live.zoom, height: size.height / live.zoom)
        DiagramRenderer.draw(scene, options: options, in: ctx)
        drawDropGhost(in: ctx, palette: palette)
        drawPendingCable(in: ctx, scene: scene, palette: palette, live: live)
        ctx.restoreGState()

        // Overlays, in view coordinates.
        drawRubberBand(in: ctx, palette: palette, live: live)
        if project.devices.isEmpty, project.annotations.isEmpty, dropGhost == nil, editTarget == nil {
            TextRenderer.shared.draw(CanvasStrings.emptyCanvasHint, style: .placeholder,
                                     color: palette.secondaryInk.opacity(0.85).cgColor,
                                     at: CGPoint(x: size.width / 2, y: size.height / 2),
                                     h: .center, v: .center, in: ctx)
        }
        drawTooltip(in: ctx, size: size, scene: scene, project: project, palette: palette, live: live)
        ctx.restoreGState()
    }

    private func drawGrid(in ctx: CGContext, size: CGSize, palette: Palette, live: LiveState) {
        guard live.gridSize > 0.5, size.width > 0, size.height > 0 else { return }
        var step = live.gridSize * live.zoom
        // Thin the grid out when zoomed far out; doubling keeps every drawn dot a snap point.
        while step < 13 { step *= 2 }
        func first(_ offset: CGFloat) -> CGFloat {
            let remainder = offset.truncatingRemainder(dividingBy: step)
            return remainder < 0 ? remainder + step : remainder
        }
        let dot: CGFloat = live.zoom >= 1.6 ? 2 : 1.5
        var rects: [CGRect] = []
        rects.reserveCapacity(Int((size.width / step + 2) * (size.height / step + 2)))
        var x = first(live.offset.width)
        while x < size.width {
            var y = first(live.offset.height)
            let px = (x * 2).rounded() / 2 - dot / 2
            while y < size.height {
                rects.append(CGRect(x: px, y: (y * 2).rounded() / 2 - dot / 2, width: dot, height: dot))
                y += step
            }
            x += step
        }
        ctx.setFillColor(palette.gridDot.cgColor)
        ctx.fill(rects)
    }

    /// The cable being pulled from the first clicked port to the pointer.
    private func drawPendingCable(in ctx: CGContext, scene: DiagramScene, palette: Palette, live: LiveState) {
        guard let pending = live.pendingPort, let start = scene.portCenter(pending), let pointerView else { return }
        var end = canvasPoint(pointerView)
        if case .port(let ref) = hover, ref != pending, let center = scene.portCenter(ref) {
            end = center
        }
        let style = CableStyle.style(for: live.activeCable, palette: palette)
        ctx.saveGState()
        ctx.setAlpha(0.85)
        style.apply(to: ctx)
        ctx.move(to: start)
        ctx.addLine(to: end)
        ctx.strokePath()
        ctx.setLineDash(phase: 0, lengths: [])
        ctx.setFillColor(style.color.cgColor)
        ctx.fillEllipse(in: CGRect(center: end, size: CGSize(width: 6, height: 6)))
        ctx.restoreGState()
    }

    private func drawDropGhost(in ctx: CGContext, palette: Palette) {
        guard let ghost = dropGhost else { return }
        ctx.saveGState()
        let outline = DiagramRenderer.roundedPath(ghost.bodyRect, radius: 6)
        ctx.addPath(outline)
        ctx.setFillColor(palette.hover.opacity(0.10).cgColor)
        ctx.fillPath()
        ctx.addPath(outline)
        ctx.setStrokeColor(palette.hover.cgColor)
        ctx.setLineWidth(1.5)
        ctx.setLineDash(phase: 0, lengths: [5, 4])
        ctx.strokePath()
        ctx.setAlpha(0.6)
        if ghost.panel != nil {
            DeviceIconArt.draw(ghost.category, in: ghost.iconRect, palette: palette, context: ctx)
        }
        ctx.restoreGState()
    }

    private func drawRubberBand(in ctx: CGContext, palette: Palette, live: LiveState) {
        guard case .rubberBand(let start, let current, _) = interaction else { return }
        let a = viewport.viewPoint(fromCanvas: start)
        let b = viewport.viewPoint(fromCanvas: current)
        let rect = CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
        ctx.saveGState()
        ctx.setFillColor(palette.selection.opacity(0.10).cgColor)
        ctx.fill(rect)
        ctx.setStrokeColor(palette.selection.cgColor)
        ctx.setLineWidth(1)
        ctx.stroke(rect.insetBy(dx: 0.5, dy: 0.5))
        ctx.restoreGState()
    }

    // MARK: Tooltip

    /// Lines of the hover tag for an element; the first line is the title.
    func tooltipLines(for hit: CanvasHit, project: Project) -> [String] {
        switch hit {
        case .port(let ref):
            guard let (_, port) = project.resolve(ref) else { return [] }
            var lines = [port.shortName == port.name ? port.name : "\(port.name) (\(port.shortName))"]
            var facts = [CanvasStrings.connectorName(port.connector)]
            if !port.speed.isEmpty { facts.append(port.speed) }
            if let peer = project.peer(of: ref) {
                facts.append("zapojeno do \(peer.device.hostname) \(peer.port.shortName)")
            } else {
                facts.append("volný")
            }
            lines.append(facts.joined(separator: " \u{00B7} "))
            var extra: [String] = []
            if !port.vlan.isEmpty { extra.append("VLAN \(port.vlan)") }
            if !port.description.isEmpty { extra.append(port.description) }
            if port.adminDown { extra.append("vypnutý (shutdown)") }
            if !extra.isEmpty { lines.append(extra.joined(separator: " \u{00B7} ")) }
            if !port.verified { lines.append(CanvasStrings.verifyAgainstHardware) }
            return lines
        case .warning:
            return [CanvasStrings.verifyAgainstHardware]
        case .statusDot(let linkID, let end):
            guard let link = project.link(id: linkID) else { return [] }
            return ["Stav konce \(CanvasStrings.portTitle(link.ref(end), in: project)): \(CanvasStrings.statusName(link.status(end)))",
                    "Kliknutím přepnete."]
        case .link(let ids):
            guard let first = ids.first, let link = project.link(id: first) else { return [] }
            if ids.count > 1 {
                let label = project.bundle(ofLink: first)?.label ?? ""
                return ["Svazek \(label)", "\(ids.count) kabely"]
            }
            var lines = ["\(CanvasStrings.portTitle(link.a, in: project)) \u{2013} \(CanvasStrings.portTitle(link.b, in: project))"]
            var facts = ["\(CanvasStrings.cableName(link.cableType)) kabel"]
            if let bundle = project.bundle(ofLink: first) { facts.append("svazek \(bundle.label)") }
            lines.append(facts.joined(separator: " \u{00B7} "))
            if !link.note.isEmpty { lines.append(link.note) }
            return lines
        case .bundleLabel(let bundleID, let ids):
            let label = project.bundle(id: bundleID)?.label ?? ""
            return ["Svazek \(label)", "\(ids.count) kabely \u{00B7} dvojklikem přejmenujete"]
        case .deviceHeader, .devicePanel, .annotation, .empty:
            return []
        }
    }

    private func tooltipIsDue(for hit: CanvasHit) -> Bool {
        switch hit {
        case .port, .warning:
            return true
        case .statusDot, .link, .bundleLabel:
            return ProcessInfo.processInfo.systemUptime - hoverSince >= CanvasNSView.tooltipDelay
        default:
            return false
        }
    }

    private func drawTooltip(in ctx: CGContext, size: CGSize, scene: DiagramScene, project: Project,
                             palette: Palette, live: LiveState) {
        guard case .idle = interaction, editTarget == nil, let pointerView, tooltipIsDue(for: hover) else { return }
        let lines = tooltipLines(for: hover, project: project)
        guard !lines.isEmpty else { return }

        let text = TextRenderer.shared
        let titleStyle = TextStyle(size: 11.5, weight: .semibold)
        let bodyStyle = TextStyle(size: 11, weight: .regular)
        let lineHeight: CGFloat = 15
        let padding = CGSize(width: 9, height: 6)
        let width = lines.enumerated().map { text.metrics($1, style: $0 == 0 ? titleStyle : bodyStyle).width }.max() ?? 0
        let plateSize = CGSize(width: ceil(width) + 2 * padding.width,
                               height: CGFloat(lines.count) * lineHeight + 2 * padding.height)

        // Ports get the tag right above the jack; everything else next to the pointer.
        var origin: CGPoint
        if case .port(let ref) = hover, let port = scene.portGeometry(ref) {
            let cell = viewport.viewRect(fromCanvas: port.cell)
            origin = CGPoint(x: cell.midX - plateSize.width / 2, y: cell.minY - plateSize.height - 8)
            if origin.y < 4 { origin.y = cell.maxY + 8 }
        } else {
            origin = CGPoint(x: pointerView.x + 14, y: pointerView.y + 18)
            if origin.y + plateSize.height > size.height - 4 { origin.y = pointerView.y - plateSize.height - 10 }
        }
        origin.x = min(max(origin.x, 4), max(size.width - plateSize.width - 4, 4))
        origin.y = min(max(origin.y, 4), max(size.height - plateSize.height - 4, 4))
        let plate = CGRect(origin: CGPoint(x: origin.x.rounded(), y: origin.y.rounded()), size: plateSize)

        ctx.saveGState()
        ctx.addPath(DiagramRenderer.roundedPath(plate.offsetBy(dx: 0, dy: 1.5), radius: 7))
        ctx.setFillColor(RGBA(0x000000, alpha: 0.18).cgColor)
        ctx.fillPath()
        ctx.addPath(DiagramRenderer.roundedPath(plate, radius: 7))
        ctx.setFillColor(palette.tooltipFill.cgColor)
        ctx.fillPath()
        for (index, line) in lines.enumerated() {
            let isWarning = line == CanvasStrings.verifyAgainstHardware && lines.count > 1
            let color = index == 0 ? palette.tooltipInk : palette.tooltipInk.opacity(isWarning ? 1 : 0.82)
            text.draw(line, style: index == 0 ? titleStyle : bodyStyle, color: color.cgColor,
                      at: CGPoint(x: plate.minX + padding.width,
                                  y: plate.minY + padding.height + (CGFloat(index) + 0.5) * lineHeight),
                      h: .leading, v: .center, in: ctx)
        }
        ctx.restoreGState()
    }
}
