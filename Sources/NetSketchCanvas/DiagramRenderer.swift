import AppKit
import CoreGraphics
import NetSketchCore

/// Everything that varies between "live canvas", "dark canvas" and "export" for one drawing pass.
struct RenderOptions {
    var palette: Palette
    /// Current zoom; only used to skip details that would be illegible anyway.
    var zoom: CGFloat = 1
    /// Export: no selection, no hover, no interactive affordances.
    var isExport = false

    var selectedDevices: Set<UUID> = []
    var selectedLinks: Set<UUID> = []
    var selectedAnnotations: Set<UUID> = []

    /// First clicked port of the cabling flow.
    var pendingPort: PortRef?
    var hoverPort: PortRef?
    /// The hovered port cannot take a cable (already used).
    var hoverPortRejected = false
    /// Port that just refused a click.
    var rejectedPort: PortRef?
    var hoverLinks: Set<UUID> = []

    /// Device whose hostname is being edited inline (the text is hidden under the editor).
    var editingDevice: UUID?
    var editingAnnotation: UUID?

    /// Visible part of the canvas, for culling; nil draws everything.
    var visibleRect: CGRect?

    init(palette: Palette) {
        self.palette = palette
    }

    func isVisible(_ rect: CGRect) -> Bool {
        guard let visibleRect else { return true }
        return visibleRect.intersects(rect.insetBy(dx: -16, dy: -16))
    }

    var showsPortLabels: Bool { isExport || zoom >= 0.5 }
    var showsCableLabels: Bool { isExport || zoom >= 0.4 }
}

/// CoreGraphics drawing of a `DiagramScene` into a y-down context whose user space is the canvas
/// coordinate system. The live canvas view and the PNG / PDF exporter share this code, so what is
/// exported is exactly what is on screen (minus selection and hover).
enum DiagramRenderer {

    static func draw(_ scene: DiagramScene, options o: RenderOptions, in ctx: CGContext) {
        ctx.saveGState()
        let visibleNodes = scene.nodes.filter { o.isVisible($0.bounds) }
        switch scene.mode {
        case .physical:
            // Panels at the bottom, cables plugged into them, then names, then everything that labels cables.
            for node in visibleNodes { drawNodeBody(node, scene: scene, options: o, in: ctx) }
            drawCables(scene, options: o, in: ctx)
            for node in visibleNodes { drawNodeHeader(node, options: o, in: ctx) }
            drawCableDecorations(scene, options: o, in: ctx)
            drawBundles(scene, options: o, in: ctx)
        case .logical:
            drawCables(scene, options: o, in: ctx)
            for node in visibleNodes {
                drawNodeBody(node, scene: scene, options: o, in: ctx)
                drawNodeHeader(node, options: o, in: ctx)
            }
            drawBundles(scene, options: o, in: ctx)
        }
        for annotation in scene.annotations where o.isVisible(annotation.frame) {
            drawAnnotation(annotation, options: o, in: ctx)
        }
        ctx.restoreGState()
    }

    // MARK: Paths

    static func roundedPath(_ rect: CGRect, radius: CGFloat) -> CGPath {
        let r = max(min(radius, rect.width / 2, rect.height / 2), 0)
        guard rect.width > 0, rect.height > 0 else { return CGPath(rect: rect, transform: nil) }
        return CGPath(roundedRect: rect, cornerWidth: r, cornerHeight: r, transform: nil)
    }

    // MARK: Device node

    /// Selection outline and, in the physical view, the front panel.
    static func drawNodeBody(_ node: NodeGeometry, scene: DiagramScene, options o: RenderOptions, in ctx: CGContext) {
        let p = o.palette
        if !o.isExport, o.selectedDevices.contains(node.deviceID) {
            let outline = roundedPath(node.bounds.insetBy(dx: -7, dy: -7), radius: 10)
            ctx.addPath(outline)
            ctx.setFillColor(p.selection.opacity(0.09).cgColor)
            ctx.fillPath()
            ctx.addPath(outline)
            ctx.setStrokeColor(p.selection.cgColor)
            ctx.setLineWidth(1.8)
            ctx.setLineDash(phase: 0, lengths: [])
            ctx.strokePath()
        }
        if let panel = node.panel {
            drawPanel(panel, deviceID: node.deviceID, usedPorts: scene.usedPorts, options: o, in: ctx)
        }
    }

    /// Icon, hostname, device type and the "verify" marker. Drawn above the cables on a plate,
    /// so a cable passing behind a name never strikes it through.
    static func drawNodeHeader(_ node: NodeGeometry, options o: RenderOptions, in ctx: CGContext) {
        let p = o.palette
        ctx.addPath(roundedPath(node.labelPlateRect, radius: 4))
        ctx.setFillColor(p.labelPlate.cgColor)
        ctx.fillPath()

        DeviceIconArt.draw(node.category, in: node.iconRect, palette: p, context: ctx)

        let text = TextRenderer.shared
        if o.editingDevice != node.deviceID {
            text.draw(node.hostname, style: .hostname, color: p.ink.cgColor,
                      at: node.hostnameRect.origin, h: .leading, v: .top, in: ctx)
        }
        text.draw(node.typeText, style: .deviceType, color: p.secondaryInk.cgColor,
                  at: node.typeRect.origin, h: .leading, v: .top, in: ctx)

        if let warning = node.warningRect, o.editingDevice != node.deviceID {
            // The SF Symbol rasterizes in PDF contexts; exports get the equivalent vector drawing.
            if o.isExport {
                SymbolRenderer.drawVectorWarning(in: warning, color: p.warning, context: ctx)
            } else {
                SymbolRenderer.drawWarning(in: warning, color: p.warning, context: ctx)
            }
        }
    }

    // MARK: Front panel

    /// Accumulates the jack outlines of one color so a panel needs only a handful of draw calls.
    private struct PortBatch {
        let hollowFill = CGMutablePath()
        let stroke = CGMutablePath()
        let fill = CGMutablePath()
        let detail = CGMutablePath()
    }

    private enum PortTint: Int, CaseIterable {
        case copper, optic, console, mgmt, wireless

        init(_ connector: ConnectorType) {
            switch connector {
            case .rj45: self = .copper
            case .sfp, .sfpPlus, .qsfpPlus: self = .optic
            case .console: self = .console
            case .mgmt: self = .mgmt
            case .wireless: self = .wireless
            @unknown default: self = .copper
            }
        }

        func color(_ p: Palette) -> RGBA {
            switch self {
            case .copper: return p.portRJ45
            case .optic: return p.portOptic
            case .console: return p.portConsole
            case .mgmt: return p.portMgmt
            case .wireless: return p.portWireless
            }
        }
    }

    static func portColor(_ connector: ConnectorType, palette: Palette) -> RGBA {
        PortTint(connector).color(palette)
    }

    static func drawPanel(_ panel: PanelGeometry, deviceID: UUID, usedPorts: Set<PortRef>,
                          options o: RenderOptions, in ctx: CGContext) {
        let p = o.palette
        let m = panel.metrics
        let s = m.scale
        let text = TextRenderer.shared

        ctx.saveGState()
        ctx.setLineDash(phase: 0, lengths: [])

        // Plate with a flat drop shadow (no blur: stays crisp and vector in PDF).
        ctx.addPath(roundedPath(panel.frame.offsetBy(dx: 0, dy: 2 * s), radius: m.cornerRadius))
        ctx.setFillColor(p.panelShadow.cgColor)
        ctx.fillPath()
        let plate = roundedPath(panel.frame, radius: m.cornerRadius)
        ctx.addPath(plate)
        ctx.setFillColor(p.panelFill.cgColor)
        ctx.fillPath()
        ctx.addPath(plate)
        ctx.setStrokeColor(p.panelStroke.cgColor)
        ctx.setLineWidth(1)
        ctx.strokePath()

        // Empty module bays.
        for bay in panel.bays {
            ctx.addPath(roundedPath(bay.rect, radius: 3 * s))
            ctx.setStrokeColor(p.panelStroke.cgColor)
            ctx.setLineWidth(0.9 * s)
            ctx.setLineDash(phase: 0, lengths: [3 * s, 2.5 * s])
            ctx.strokePath()
            ctx.setLineDash(phase: 0, lengths: [])
            if o.showsPortLabels, !bay.label.isEmpty {
                text.draw(bay.label, style: m.captionStyle, color: p.secondaryInk.cgColor,
                          at: bay.rect.center, h: .center, v: .center, in: ctx)
            }
        }

        // Ports, batched per tint.
        var batches: [PortBatch] = PortTint.allCases.map { _ in PortBatch() }
        let cutFill = CGMutablePath()
        let cutStroke = CGMutablePath()

        for port in panel.ports {
            let used = usedPorts.contains(PortRef(deviceID: deviceID, portID: port.portID))
            let batch = batches[PortTint(port.connector).rawValue]
            let rect = port.rect
            switch port.connector {
            case .rj45, .console, .mgmt:
                let jack = roundedPath(rect, radius: 1.8 * s)
                // Latch notch: up on the top row, down otherwise - like a real switch.
                let tabWidth = rect.width * 0.38
                let tabHeight = rect.height * 0.22
                let tabY = port.labelPlacement == .above ? rect.minY + 1.2 * s : rect.maxY - 1.2 * s - tabHeight
                let tab = CGRect(x: rect.midX - tabWidth / 2, y: tabY, width: tabWidth, height: tabHeight)
                if used {
                    batch.fill.addPath(jack)
                    cutFill.addRect(tab)
                } else {
                    batch.hollowFill.addPath(jack)
                    batch.stroke.addPath(jack)
                    batch.detail.addRect(tab)
                }
            case .sfp, .sfpPlus, .qsfpPlus:
                let cage = roundedPath(rect, radius: rect.height * 0.32)
                if used {
                    batch.fill.addPath(cage)
                } else {
                    batch.hollowFill.addPath(cage)
                    batch.stroke.addPath(cage)
                }
                if port.connector == .qsfpPlus {
                    // QSFP+ cages carry a center divider to tell them from SFP cages.
                    let target = used ? cutStroke : batch.stroke
                    target.move(to: CGPoint(x: rect.midX, y: rect.minY + 2.2 * s))
                    target.addLine(to: CGPoint(x: rect.midX, y: rect.maxY - 2.2 * s))
                }
            case .wireless:
                // Antenna mark: a dot with two arcs.
                let base = CGPoint(x: rect.midX, y: rect.maxY - rect.height * 0.22)
                let dot = CGRect(center: base, size: CGSize(width: rect.width * 0.2, height: rect.width * 0.2))
                let arcs = used ? cutStroke : batch.stroke
                for radius in [rect.width * 0.28, rect.width * 0.5] {
                    arcs.move(to: CGPoint(x: base.x + radius * cos(-.pi * 0.78), y: base.y + radius * sin(-.pi * 0.78)))
                    arcs.addArc(center: base, radius: radius, startAngle: -.pi * 0.78, endAngle: -.pi * 0.22, clockwise: false)
                }
                if used {
                    batch.fill.addPath(roundedPath(rect.insetBy(dx: -1 * s, dy: -1 * s), radius: 3 * s))
                    cutFill.addEllipse(in: dot)
                } else {
                    batch.fill.addEllipse(in: dot)
                }
            @unknown default:
                batch.stroke.addPath(roundedPath(rect, radius: 1.8 * s))
            }
        }

        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
        for tint in PortTint.allCases {
            let batch = batches[tint.rawValue]
            let color = tint.color(p)
            if !batch.hollowFill.isEmpty {
                ctx.addPath(batch.hollowFill)
                ctx.setFillColor(color.opacity(0.07).cgColor)
                ctx.fillPath()
            }
            if !batch.detail.isEmpty {
                ctx.addPath(batch.detail)
                ctx.setFillColor(color.opacity(0.45).cgColor)
                ctx.fillPath()
            }
            if !batch.stroke.isEmpty {
                ctx.addPath(batch.stroke)
                ctx.setStrokeColor(color.opacity(0.9).cgColor)
                ctx.setLineWidth(1.1 * s)
                ctx.strokePath()
            }
            if !batch.fill.isEmpty {
                ctx.addPath(batch.fill)
                ctx.setFillColor(color.cgColor)
                ctx.fillPath()
            }
        }
        if !cutFill.isEmpty {
            ctx.addPath(cutFill)
            ctx.setFillColor(p.panelFill.cgColor)
            ctx.fillPath()
        }
        if !cutStroke.isEmpty {
            ctx.addPath(cutStroke)
            ctx.setStrokeColor(p.panelFill.cgColor)
            ctx.setLineWidth(1.1 * s)
            ctx.strokePath()
        }
        batches.removeAll()

        // Per-port states.
        for port in panel.ports {
            let ref = PortRef(deviceID: deviceID, portID: port.portID)
            if port.adminDown {
                ctx.move(to: CGPoint(x: port.rect.minX + 1 * s, y: port.rect.maxY - 1 * s))
                ctx.addLine(to: CGPoint(x: port.rect.maxX - 1 * s, y: port.rect.minY + 1 * s))
                ctx.setStrokeColor(p.reject.cgColor)
                ctx.setLineWidth(1.4 * s)
                ctx.strokePath()
            }
            guard !o.isExport else { continue }
            if o.pendingPort == ref {
                ctx.addPath(roundedPath(port.rect, radius: 2 * s))
                ctx.setFillColor(p.pending.cgColor)
                ctx.fillPath()
                ctx.addPath(roundedPath(port.rect.insetBy(dx: -3 * s, dy: -3 * s), radius: 4 * s))
                ctx.setStrokeColor(p.pending.cgColor)
                ctx.setLineWidth(1.6 * s)
                ctx.strokePath()
            } else if o.rejectedPort == ref {
                ctx.addPath(roundedPath(port.rect.insetBy(dx: -3 * s, dy: -3 * s), radius: 4 * s))
                ctx.setFillColor(p.reject.opacity(0.28).cgColor)
                ctx.fillPath()
                ctx.addPath(roundedPath(port.rect.insetBy(dx: -3 * s, dy: -3 * s), radius: 4 * s))
                ctx.setStrokeColor(p.reject.cgColor)
                ctx.setLineWidth(1.8 * s)
                ctx.strokePath()
            } else if o.hoverPort == ref {
                let color = o.hoverPortRejected ? p.reject : p.hover
                ctx.addPath(roundedPath(port.rect.insetBy(dx: -2.5 * s, dy: -2.5 * s), radius: 3.5 * s))
                ctx.setStrokeColor(color.cgColor)
                ctx.setLineWidth(1.5 * s)
                ctx.strokePath()
            }
        }

        // Printed labels and section captions.
        if o.showsPortLabels {
            let labelColor = p.portLabel.cgColor
            for port in panel.ports where port.labelPlacement != .hidden {
                text.draw(port.label, style: m.labelStyle, color: labelColor,
                          at: port.labelCenter, h: .center, v: .center, in: ctx)
            }
            for caption in panel.captions {
                text.draw(caption.text, style: m.captionStyle, color: p.secondaryInk.cgColor,
                          at: caption.anchor, h: .leading, v: .center, in: ctx)
            }
        }
        ctx.restoreGState()
    }

    // MARK: Cables

    /// Cable strokes and the plugs at their ends.
    static func drawCables(_ scene: DiagramScene, options o: RenderOptions, in ctx: CGContext) {
        let p = o.palette
        let physical = scene.mode == .physical

        for link in scene.links {
            let box = CGRect(x: min(link.start.x, link.end.x), y: min(link.start.y, link.end.y),
                             width: abs(link.end.x - link.start.x), height: abs(link.end.y - link.start.y))
            guard o.isVisible(box) else { continue }
            let style = CableStyle.style(for: link.cableType, palette: p)
            let selected = !o.isExport && link.memberIDs.contains { o.selectedLinks.contains($0) }
            let hovered = !o.isExport && link.memberIDs.contains { o.hoverLinks.contains($0) }

            ctx.saveGState()
            if selected || hovered {
                let extra: CGFloat = link.isBundled ? CableStyle.bundleRailSpacing : 0
                ctx.move(to: link.start)
                ctx.addLine(to: link.end)
                ctx.setLineCap(.round)
                ctx.setLineDash(phase: 0, lengths: [])
                ctx.setStrokeColor((selected ? p.selection.opacity(0.38) : p.hover.opacity(0.30)).cgColor)
                ctx.setLineWidth(style.width + extra + (selected ? 7 : 5))
                ctx.strokePath()
            }

            let length = link.length
            if link.isBundled, length > 0.5 {
                // LAG member: two parallel rails.
                let nx = -(link.end.y - link.start.y) / length * CableStyle.bundleRailSpacing / 2
                let ny = (link.end.x - link.start.x) / length * CableStyle.bundleRailSpacing / 2
                style.apply(to: ctx, widthFactor: CableStyle.bundleRailWidthFactor)
                for sign in [CGFloat(1), CGFloat(-1)] {
                    ctx.move(to: CGPoint(x: link.start.x + nx * sign, y: link.start.y + ny * sign))
                    ctx.addLine(to: CGPoint(x: link.end.x + nx * sign, y: link.end.y + ny * sign))
                }
                ctx.strokePath()
            } else {
                style.apply(to: ctx)
                ctx.move(to: link.start)
                ctx.addLine(to: link.end)
                ctx.strokePath()
            }
            ctx.setLineDash(phase: 0, lengths: [])

            if physical {
                // Plugs sitting in the ports.
                ctx.setFillColor(style.color.cgColor)
                for point in [link.start, link.end] {
                    ctx.fillEllipse(in: CGRect(center: point, size: CGSize(width: 5.2, height: 5.2)))
                }
            }
            ctx.restoreGState()
        }
    }

    /// Status dots and port names at the cable ends (physical view only); they go on top of all cables.
    static func drawCableDecorations(_ scene: DiagramScene, options o: RenderOptions, in ctx: CGContext) {
        guard scene.mode == .physical else { return }
        let p = o.palette
        let text = TextRenderer.shared
        for link in scene.links {
            for end in LinkEnd.allCases {
                guard let dot = link.dot(end) else { continue }
                let radius = DiagramScene.dotRadius
                let rect = CGRect(center: dot, size: CGSize(width: radius * 2, height: radius * 2))
                guard o.isVisible(rect) else { continue }
                if let color = link.status(end).color(in: p) {
                    ctx.setFillColor(p.canvas.cgColor)
                    ctx.fillEllipse(in: rect.insetBy(dx: -1.3, dy: -1.3))
                    ctx.setFillColor(color.cgColor)
                    ctx.fillEllipse(in: rect)
                } else if !o.isExport {
                    // No status yet: a faint ring shows where to click to set one.
                    let ring = rect.insetBy(dx: 0.9, dy: 0.9)
                    ctx.setFillColor(p.canvas.cgColor)
                    ctx.fillEllipse(in: ring)
                    ctx.setStrokeColor(p.statusNone.cgColor)
                    ctx.setLineWidth(1)
                    ctx.strokeEllipse(in: ring)
                }
            }
        }

        guard o.showsCableLabels else { return }
        for link in scene.links {
            let style = CableStyle.style(for: link.cableType, palette: p)
            for label in [link.labelA, link.labelB].compactMap({ $0 }) where o.isVisible(label.rect) {
                let plate = roundedPath(label.rect, radius: 3.5)
                ctx.addPath(plate)
                ctx.setFillColor(p.labelPlate.cgColor)
                ctx.fillPath()
                ctx.addPath(plate)
                ctx.setStrokeColor(style.color.opacity(0.55).cgColor)
                ctx.setLineWidth(0.75)
                ctx.strokePath()
                text.draw(label.text, style: .cableEnd, color: p.ink.cgColor,
                          at: label.center, h: .center, v: .center, in: ctx)
            }
        }
    }

    // MARK: Bundles

    static func drawBundles(_ scene: DiagramScene, options o: RenderOptions, in ctx: CGContext) {
        let p = o.palette
        let text = TextRenderer.shared
        for bundle in scene.bundles {
            ctx.saveGState()
            if bundle.tie.count > 1 {
                // Tie the member cables together at their midpoints.
                ctx.move(to: bundle.tie[0])
                for point in bundle.tie.dropFirst() { ctx.addLine(to: point) }
                ctx.setStrokeColor(p.bundlePlate.cgColor)
                ctx.setLineWidth(1.3)
                ctx.setLineCap(.round)
                ctx.setLineDash(phase: 0, lengths: [])
                ctx.strokePath()
            }
            ctx.setFillColor(p.bundlePlate.cgColor)
            for point in bundle.tie {
                ctx.fillEllipse(in: CGRect(center: point, size: CGSize(width: 6.4, height: 6.4)))
            }
            let rect = bundle.labelRect
            if o.isVisible(rect) {
                let selected = !o.isExport && bundle.linkIDs.contains { o.selectedLinks.contains($0) }
                if selected {
                    ctx.addPath(roundedPath(rect.insetBy(dx: -2.5, dy: -2.5), radius: rect.height / 2 + 2.5))
                    ctx.setFillColor(p.selection.opacity(0.45).cgColor)
                    ctx.fillPath()
                }
                ctx.addPath(roundedPath(rect, radius: rect.height / 2))
                ctx.setFillColor(p.bundlePlate.cgColor)
                ctx.fillPath()
                text.draw(bundle.label, style: .bundle, color: p.bundleInk.cgColor,
                          at: rect.center, h: .center, v: .center, in: ctx)
            }
            ctx.restoreGState()
        }
    }

    // MARK: Annotations

    static func drawAnnotation(_ annotation: AnnotationGeometry, options o: RenderOptions, in ctx: CGContext) {
        let p = o.palette
        ctx.saveGState()
        ctx.setLineDash(phase: 0, lengths: [])
        if !o.isExport, o.selectedAnnotations.contains(annotation.id) {
            ctx.addPath(roundedPath(annotation.frame.insetBy(dx: -3, dy: -3), radius: 8))
            ctx.setStrokeColor(p.selection.cgColor)
            ctx.setLineWidth(1.8)
            ctx.strokePath()
        }
        let plate = roundedPath(annotation.frame, radius: 5)
        ctx.addPath(plate)
        ctx.setFillColor(p.annotationFill.cgColor)
        ctx.fillPath()
        ctx.addPath(plate)
        ctx.setStrokeColor(p.annotationStroke.cgColor)
        ctx.setLineWidth(0.8)
        ctx.strokePath()
        if o.editingAnnotation != annotation.id {
            TextRenderer.shared.drawBlock(annotation.text, style: .annotation, color: p.ink.cgColor,
                                          origin: annotation.textOrigin, in: ctx)
        }
        ctx.restoreGState()
    }
}

/// Draws the SF Symbol used for the "verify against the hardware" marker into a CoreGraphics context.
enum SymbolRenderer {
    static let warningSymbolName = "exclamationmark.triangle"

    private static var cache: [RGBA: NSImage] = [:]

    private static func warningImage(color: RGBA) -> NSImage? {
        if let cached = cache[color] { return cached }
        guard let base = NSImage(systemSymbolName: warningSymbolName, accessibilityDescription: nil) else { return nil }
        let configuration = NSImage.SymbolConfiguration(pointSize: 24, weight: .semibold)
            .applying(NSImage.SymbolConfiguration(paletteColors: [color.nsColor]))
        guard let image = base.withSymbolConfiguration(configuration) else { return nil }
        cache[color] = image
        return image
    }

    static func drawWarning(in rect: CGRect, color: RGBA, context ctx: CGContext) {
        if let image = warningImage(color: color), image.size.width > 0, image.size.height > 0 {
            let scale = min(rect.width / image.size.width, rect.height / image.size.height)
            let target = CGRect(center: rect.center,
                                size: CGSize(width: image.size.width * scale, height: image.size.height * scale))
            let previous = NSGraphicsContext.current
            NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
            image.draw(in: target, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            NSGraphicsContext.current = previous
            return
        }
        drawVectorWarning(in: rect, color: color, context: ctx)
    }

    /// Vector twin of the symbol: a rounded triangle with an exclamation mark. Used for exports
    /// (keeps the PDF free of bitmaps) and if the symbol is unavailable.
    static func drawVectorWarning(in rect: CGRect, color: RGBA, context ctx: CGContext) {
        ctx.saveGState()
        let box = rect.insetBy(dx: rect.width * 0.04, dy: rect.height * 0.09)
        let top = CGPoint(x: box.midX, y: box.minY)
        let right = CGPoint(x: box.maxX, y: box.maxY)
        let left = CGPoint(x: box.minX, y: box.maxY)
        let radius = box.width * 0.13
        let path = CGMutablePath()
        path.move(to: CGPoint(x: (top.x + left.x) / 2, y: (top.y + left.y) / 2))
        path.addArc(tangent1End: top, tangent2End: right, radius: radius)
        path.addArc(tangent1End: right, tangent2End: left, radius: radius)
        path.addArc(tangent1End: left, tangent2End: top, radius: radius)
        path.closeSubpath()
        ctx.addPath(path)
        ctx.setStrokeColor(color.cgColor)
        ctx.setLineWidth(max(rect.width * 0.095, 0.8))
        ctx.setLineJoin(.round)
        ctx.setLineDash(phase: 0, lengths: [])
        ctx.strokePath()
        ctx.setLineCap(.round)
        ctx.move(to: CGPoint(x: box.midX, y: box.minY + box.height * 0.36))
        ctx.addLine(to: CGPoint(x: box.midX, y: box.minY + box.height * 0.60))
        ctx.strokePath()
        ctx.setFillColor(color.cgColor)
        let dot = max(rect.width * 0.12, 1)
        ctx.fillEllipse(in: CGRect(center: CGPoint(x: box.midX, y: box.minY + box.height * 0.79),
                                   size: CGSize(width: dot, height: dot)))
        ctx.restoreGState()
    }
}
