import CoreGraphics
import Foundation
import NetSketchCore

/// A text plate that sits on a cable (port name at a cable end).
struct LinkEndLabel {
    let text: String
    let center: CGPoint
    /// Size of the plate (text plus padding).
    let size: CGSize

    var rect: CGRect { CGRect(center: center, size: size) }
}

/// One drawn cable. In the physical view this is exactly one `Link` between two port centers;
/// in the logical view a whole bundle collapses into one strand between two device icons.
struct LinkGeometry {
    /// Identity of the strand (the id of its first member link).
    let id: UUID
    /// Links represented by this strand.
    let memberIDs: [UUID]
    let cableType: CableType
    /// End `a`.
    let start: CGPoint
    /// End `b`.
    let end: CGPoint
    /// Drawn as a double line (member of a LAG).
    let isBundled: Bool
    let statusA: LinkStatus
    let statusB: LinkStatus
    /// Status dot centers; nil in the logical view.
    let dotA: CGPoint?
    let dotB: CGPoint?
    /// Port names at the ends; nil in the logical view.
    let labelA: LinkEndLabel?
    let labelB: LinkEndLabel?

    var midpoint: CGPoint { CGPoint(x: (start.x + end.x) / 2, y: (start.y + end.y) / 2) }
    var length: CGFloat { hypot(end.x - start.x, end.y - start.y) }

    func dot(_ end: LinkEnd) -> CGPoint? { end == .a ? dotA : dotB }
    func status(_ end: LinkEnd) -> LinkStatus { end == .a ? statusA : statusB }

    /// Distance from `point` to the cable.
    func distance(to point: CGPoint) -> CGFloat {
        Geometry.distance(from: point, toSegment: start, end)
    }
}

/// Caption of a LAG and the tie that visually groups its member cables.
struct BundleGeometry {
    let id: UUID
    let label: String
    let labelCenter: CGPoint
    /// Size of the caption plate.
    let labelSize: CGSize
    /// Midpoints of the member cables (physical view); the tie line runs through them.
    let tie: [CGPoint]
    let linkIDs: [UUID]

    var labelRect: CGRect { CGRect(center: labelCenter, size: labelSize) }
}

struct AnnotationGeometry {
    let id: UUID
    let text: String
    /// Top-left corner of the text (`Annotation.position`).
    let textOrigin: CGPoint
    /// The note plate around the text.
    let frame: CGRect

    static let paddingX: CGFloat = 7
    static let paddingY: CGFloat = 4

    init(annotation: Annotation) {
        id = annotation.id
        text = annotation.text
        textOrigin = annotation.position
        let size = TextRenderer.shared.blockSize(annotation.text.isEmpty ? " " : annotation.text, style: .annotation)
        frame = CGRect(x: annotation.position.x - AnnotationGeometry.paddingX,
                       y: annotation.position.y - AnnotationGeometry.paddingY,
                       width: max(size.width, 12) + 2 * AnnotationGeometry.paddingX,
                       height: size.height + 2 * AnnotationGeometry.paddingY)
    }
}

enum Geometry {
    static func distance(from p: CGPoint, toSegment a: CGPoint, _ b: CGPoint) -> CGFloat {
        let dx = b.x - a.x
        let dy = b.y - a.y
        let lengthSquared = dx * dx + dy * dy
        guard lengthSquared > 0.0001 else { return hypot(p.x - a.x, p.y - a.y) }
        let t = min(max(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared, 0), 1)
        return hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
    }

    /// For a segment that starts inside `rect`, the parameter (0...1) at which it leaves the rect.
    /// Returns 0 when the start is outside and 1 when the whole segment stays inside.
    static func exitParameter(from start: CGPoint, to end: CGPoint, leaving rect: CGRect) -> CGFloat {
        guard rect.contains(start) else { return 0 }
        let dx = end.x - start.x
        let dy = end.y - start.y
        var t: CGFloat = 1
        if dx > 0 { t = min(t, (rect.maxX - start.x) / dx) }
        if dx < 0 { t = min(t, (rect.minX - start.x) / dx) }
        if dy > 0 { t = min(t, (rect.maxY - start.y) / dy) }
        if dy < 0 { t = min(t, (rect.minY - start.y) / dy) }
        return min(max(t, 0), 1)
    }

    /// Parameter range (within 0...1) in which the segment runs inside `rect`; nil when it misses it.
    static func clipInterval(from start: CGPoint, to end: CGPoint, in rect: CGRect) -> (CGFloat, CGFloat)? {
        var t0: CGFloat = 0
        var t1: CGFloat = 1
        let dx = end.x - start.x
        let dy = end.y - start.y
        // Liang-Barsky: one (p, q) pair per rect edge.
        let edges: [(CGFloat, CGFloat)] = [
            (-dx, start.x - rect.minX), (dx, rect.maxX - start.x),
            (-dy, start.y - rect.minY), (dy, rect.maxY - start.y),
        ]
        for (p, q) in edges {
            if abs(p) < 1e-9 {
                if q < 0 { return nil }
            } else {
                let r = q / p
                if p < 0 {
                    if r > t1 { return nil }
                    t0 = max(t0, r)
                } else {
                    if r < t0 { return nil }
                    t1 = min(t1, r)
                }
            }
        }
        return t0 <= t1 ? (t0, t1) : nil
    }

    static func point(from a: CGPoint, to b: CGPoint, at t: CGFloat) -> CGPoint {
        CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
    }
}

/// Everything the canvas shows, laid out in canvas coordinates. Built from the project in one
/// pass and shared by drawing, hit testing and export.
struct DiagramScene {
    let mode: ViewMode
    /// Device nodes in project order (later = on top).
    let nodes: [NodeGeometry]
    let links: [LinkGeometry]
    let bundles: [BundleGeometry]
    let annotations: [AnnotationGeometry]
    /// Ports that have a cable plugged in.
    let usedPorts: Set<PortRef>
    /// Bounding box of all content; nil for an empty project.
    let contentBounds: CGRect?

    private let nodeIndex: [UUID: Int]

    static let endLabelPadding = CGSize(width: 4, height: 1.5)
    static let dotRadius: CGFloat = 4
    static let bundleLabelPadding = CGSize(width: 7, height: 2.5)

    func node(for deviceID: UUID) -> NodeGeometry? {
        nodeIndex[deviceID].map { nodes[$0] }
    }

    /// Center of a port in the physical view.
    func portCenter(_ ref: PortRef) -> CGPoint? {
        node(for: ref.deviceID)?.panel?.port(id: ref.portID)?.center
    }

    func portGeometry(_ ref: PortRef) -> PortGeometry? {
        node(for: ref.deviceID)?.panel?.port(id: ref.portID)
    }

    init(project: Project, mode: ViewMode, metrics: PanelMetrics = .standard) {
        self.mode = mode
        let nodes = project.devices.map { NodeGeometry(device: $0, mode: mode, metrics: metrics) }
        var nodeIndex: [UUID: Int] = [:]
        for (index, node) in nodes.enumerated() where nodeIndex[node.deviceID] == nil {
            nodeIndex[node.deviceID] = index
        }
        self.nodes = nodes
        self.nodeIndex = nodeIndex

        var used = Set<PortRef>()
        for link in project.links {
            used.insert(link.a)
            used.insert(link.b)
        }
        usedPorts = used
        annotations = project.annotations.map(AnnotationGeometry.init(annotation:))

        func node(_ id: UUID) -> NodeGeometry? { nodeIndex[id].map { nodes[$0] } }
        let bundleByID = Dictionary(project.bundles.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        func isBundled(_ link: Link) -> Bool {
            guard let bundleID = link.bundleID else { return false }
            return bundleByID[bundleID] != nil
        }

        var links: [LinkGeometry] = []
        var bundles: [BundleGeometry] = []
        let text = TextRenderer.shared

        switch mode {
        case .physical:
            // Device names and panels are obstacles for cable-end labels.
            var occupied: [CGRect] = nodes.map { $0.headerRect.insetBy(dx: -2, dy: -2) }
            let panels = nodes.map { $0.bodyRect }

            for link in project.links {
                guard let nodeA = node(link.a.deviceID), let nodeB = node(link.b.deviceID),
                      let portA = nodeA.panel?.port(id: link.a.portID),
                      let portB = nodeB.panel?.port(id: link.b.portID),
                      let deviceA = project.device(id: link.a.deviceID),
                      let deviceB = project.device(id: link.b.deviceID)
                else { continue }
                let start = portA.center
                let end = portB.center
                let length = hypot(end.x - start.x, end.y - start.y)
                let nameA = deviceA.ports.indices.contains(portA.index) ? deviceA.ports[portA.index].shortName : ""
                let nameB = deviceB.ports.indices.contains(portB.index) ? deviceB.ports[portB.index].shortName : ""

                var dotA: CGPoint?
                var dotB: CGPoint?
                var labelA: LinkEndLabel?
                var labelB: LinkEndLabel?
                if length > 1 {
                    let ux = (end.x - start.x) / length
                    let uy = (end.y - start.y) / length
                    // Distances along the cable (from end a) at which it leaves the two panels.
                    var exitA = Geometry.exitParameter(from: start, to: end, leaving: nodeA.bodyRect) * length
                    var exitB = length - Geometry.exitParameter(from: end, to: start, leaving: nodeB.bodyRect) * length
                    if exitB - exitA < 4 {
                        // Overlapping panels: fall back to thirds of the whole cable.
                        exitA = length * 0.12
                        exitB = length * 0.88
                    }
                    let middle = (exitA + exitB) / 2
                    let dotOffset = min(DiagramScene.dotRadius + 4, max((exitB - exitA) * 0.2, 0))
                    dotA = CGPoint(x: start.x + ux * (exitA + dotOffset), y: start.y + uy * (exitA + dotOffset))
                    dotB = CGPoint(x: start.x + ux * (exitB - dotOffset), y: start.y + uy * (exitB - dotOffset))

                    func place(_ name: String, from exit: CGFloat, direction: CGFloat) -> LinkEndLabel? {
                        guard !name.isEmpty else { return nil }
                        let textSize = text.size(name, style: .cableEnd)
                        let size = CGSize(width: ceil(textSize.width) + 2 * DiagramScene.endLabelPadding.width,
                                          height: ceil(textSize.height) + 2 * DiagramScene.endLabelPadding.height)
                        let halfExtent = (abs(ux) * size.width + abs(uy) * size.height) / 2
                        let base = dotOffset + DiagramScene.dotRadius + 3 + halfExtent
                        // Stay on the own half of the cable so the two end labels never swap sides.
                        let limit = max(abs(middle - exit) - halfExtent - 1, min(base, abs(middle - exit)))
                        func center(_ distance: CGFloat) -> CGPoint {
                            let s = exit + direction * distance
                            return CGPoint(x: (start.x + ux * s).rounded(), y: (start.y + uy * s).rounded())
                        }
                        let step = size.height + 2
                        var chosen = center(min(base, limit))
                        for attempt in 0..<7 {
                            let distance = base + CGFloat(attempt) * step
                            if distance > limit { break }
                            let candidate = center(distance)
                            let rect = CGRect(center: candidate, size: size).insetBy(dx: -1, dy: -1)
                            let blocked = occupied.contains { $0.intersects(rect) } || panels.contains { $0.intersects(rect) }
                            if !blocked {
                                chosen = candidate
                                break
                            }
                        }
                        let label = LinkEndLabel(text: name, center: chosen, size: size)
                        occupied.append(label.rect)
                        return label
                    }
                    labelA = place(nameA, from: exitA, direction: 1)
                    labelB = place(nameB, from: exitB, direction: -1)
                }

                links.append(LinkGeometry(
                    id: link.id, memberIDs: [link.id], cableType: link.cableType,
                    start: start, end: end, isBundled: isBundled(link),
                    statusA: link.statusA, statusB: link.statusB,
                    dotA: dotA, dotB: dotB, labelA: labelA, labelB: labelB
                ))
            }

            let linkByID = Dictionary(links.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            for bundle in project.bundles {
                let members = bundle.linkIDs.compactMap { linkByID[$0] }
                guard !members.isEmpty else { continue }
                let midpoints = members.map(\.midpoint).sorted { ($0.x, $0.y) < ($1.x, $1.y) }
                let centroid = CGPoint(x: midpoints.map(\.x).reduce(0, +) / CGFloat(midpoints.count),
                                       y: midpoints.map(\.y).reduce(0, +) / CGFloat(midpoints.count))
                bundles.append(BundleGeometry(
                    id: bundle.id, label: bundle.label,
                    labelCenter: CGPoint(x: centroid.x.rounded(), y: centroid.y.rounded()),
                    labelSize: DiagramScene.bundleLabelSize(bundle.label),
                    tie: midpoints, linkIDs: members.map(\.id)
                ))
            }

        case .logical:
            // Group parallel cables per device pair; a bundle is one strand, every other cable its own.
            struct Strand {
                var members: [Link]
                var bundle: LinkBundle?
            }
            var pairOrder: [DevicePair] = []
            var strandsByPair: [DevicePair: [Strand]] = [:]
            var strandOfBundle: [UUID: (pair: DevicePair, index: Int)] = [:]
            for link in project.links {
                guard link.a.deviceID != link.b.deviceID,
                      node(link.a.deviceID) != nil, node(link.b.deviceID) != nil else { continue }
                let pair = link.devicePair
                if strandsByPair[pair] == nil {
                    strandsByPair[pair] = []
                    pairOrder.append(pair)
                }
                if let bundleID = link.bundleID, let bundle = bundleByID[bundleID] {
                    if let existing = strandOfBundle[bundleID], existing.pair == pair {
                        strandsByPair[pair]?[existing.index].members.append(link)
                    } else {
                        strandOfBundle[bundleID] = (pair, strandsByPair[pair]?.count ?? 0)
                        strandsByPair[pair]?.append(Strand(members: [link], bundle: bundle))
                    }
                } else {
                    strandsByPair[pair]?.append(Strand(members: [link], bundle: nil))
                }
            }

            let spacing: CGFloat = 9
            for pair in pairOrder {
                guard let strands = strandsByPair[pair],
                      let first = node(pair.first), let second = node(pair.second) else { continue }
                let from = first.iconRect.center
                let to = second.iconRect.center
                let length = hypot(to.x - from.x, to.y - from.y)
                guard length > 1 else { continue }
                // Normal of the canonical direction, so parallel strands fan out consistently.
                let nx = -(to.y - from.y) / length
                let ny = (to.x - from.x) / length
                for (index, strand) in strands.enumerated() {
                    guard let lead = strand.members.first else { continue }
                    let offset = (CGFloat(index) - CGFloat(strands.count - 1) / 2) * spacing
                    let p1 = CGPoint(x: from.x + nx * offset, y: from.y + ny * offset)
                    let p2 = CGPoint(x: to.x + nx * offset, y: to.y + ny * offset)
                    // A strand becomes visible where it has left the icon AND the name plate of its device.
                    func hidden(from a: CGPoint, to b: CGPoint, behind node: NodeGeometry) -> CGFloat {
                        var t = Geometry.exitParameter(from: a, to: b, leaving: node.iconRect.insetBy(dx: -3, dy: -3))
                        if let (_, leave) = Geometry.clipInterval(from: a, to: b, in: node.labelPlateRect), leave > t {
                            t = leave
                        }
                        return t
                    }
                    let t1 = hidden(from: p1, to: p2, behind: first)
                    let t2 = hidden(from: p2, to: p1, behind: second)
                    guard t1 + t2 < 1 else { continue }
                    let visibleFirst = Geometry.point(from: p1, to: p2, at: t1)
                    let visibleSecond = Geometry.point(from: p2, to: p1, at: t2)
                    // Keep the a -> b orientation of the lead link.
                    let leadStartsAtFirst = lead.a.deviceID == pair.first
                    let geometry = LinkGeometry(
                        id: lead.id, memberIDs: strand.members.map(\.id), cableType: lead.cableType,
                        start: leadStartsAtFirst ? visibleFirst : visibleSecond,
                        end: leadStartsAtFirst ? visibleSecond : visibleFirst,
                        isBundled: strand.bundle != nil,
                        statusA: lead.statusA, statusB: lead.statusB,
                        dotA: nil, dotB: nil, labelA: nil, labelB: nil
                    )
                    links.append(geometry)
                    if let bundle = strand.bundle {
                        let mid = geometry.midpoint
                        bundles.append(BundleGeometry(
                            id: bundle.id, label: bundle.label,
                            labelCenter: CGPoint(x: mid.x.rounded(), y: mid.y.rounded()),
                            labelSize: DiagramScene.bundleLabelSize(bundle.label),
                            tie: [], linkIDs: strand.members.map(\.id)
                        ))
                    }
                }
            }
        }

        self.links = links
        self.bundles = bundles

        var bounds: CGRect?
        func include(_ rect: CGRect) {
            guard !rect.isNull, !rect.isInfinite else { return }
            bounds = bounds.map { $0.union(rect) } ?? rect
        }
        nodes.forEach { include($0.bounds) }
        annotations.forEach { include($0.frame) }
        for link in links {
            if let label = link.labelA { include(label.rect) }
            if let label = link.labelB { include(label.rect) }
            include(CGRect(x: min(link.start.x, link.end.x), y: min(link.start.y, link.end.y),
                           width: abs(link.end.x - link.start.x), height: abs(link.end.y - link.start.y)))
        }
        bundles.forEach { include($0.labelRect) }
        contentBounds = bounds
    }

    static func bundleLabelSize(_ label: String) -> CGSize {
        let size = TextRenderer.shared.size(label.isEmpty ? " " : label, style: .bundle)
        return CGSize(width: ceil(size.width) + 2 * bundleLabelPadding.width,
                      height: ceil(size.height) + 2 * bundleLabelPadding.height)
    }
}

// MARK: - Hit testing

/// What lies under a canvas point.
enum CanvasHit: Equatable {
    case port(PortRef)
    case statusDot(linkID: UUID, end: LinkEnd)
    case warning(deviceID: UUID)
    /// The icon / name part of a device.
    case deviceHeader(UUID)
    /// The panel plate of a device (between ports).
    case devicePanel(UUID)
    case annotation(UUID)
    /// A cable; carries every link of the strand (a whole bundle in the logical view).
    case link([UUID])
    case bundleLabel(bundleID: UUID, linkIDs: [UUID])
    case empty

    var deviceID: UUID? {
        switch self {
        case .port(let ref): return ref.deviceID
        case .warning(let id), .deviceHeader(let id), .devicePanel(let id): return id
        default: return nil
        }
    }
}

extension DiagramScene {
    /// Topmost element at `point` (canvas coordinates). `tolerance` is the pick slop in canvas points.
    func hitTest(_ point: CGPoint, tolerance: CGFloat) -> CanvasHit {
        // Drawing order is panels < cables < icons and names < cable decorations < bundles < annotations,
        // so test in reverse - except that ports win over the cable ends that sit on them, otherwise
        // a plugged port could not be clicked.
        for annotation in annotations.reversed() where annotation.frame.contains(point) {
            return .annotation(annotation.id)
        }
        for link in links.reversed() {
            for end in LinkEnd.allCases {
                if let dot = link.dot(end), hypot(point.x - dot.x, point.y - dot.y) <= DiagramScene.dotRadius + max(tolerance * 0.6, 2) {
                    return .statusDot(linkID: link.id, end: end)
                }
            }
        }
        for bundle in bundles.reversed() where bundle.labelRect.contains(point) {
            return .bundleLabel(bundleID: bundle.id, linkIDs: bundle.linkIDs)
        }
        // Icons and name plates hide the cables running behind them (in both views).
        for node in nodes.reversed() {
            if let warning = node.warningRect, warning.insetBy(dx: -3, dy: -3).contains(point) {
                return .warning(deviceID: node.deviceID)
            }
            if node.iconRect.contains(point) || node.labelPlateRect.contains(point) {
                return .deviceHeader(node.deviceID)
            }
        }
        // Only the topmost panel under the point counts: it hides the ports of the panels below it.
        if let node = nodes.last(where: { $0.bodyRect.contains(point) }), let panel = node.panel,
           let port = panel.port(at: point) {
            return .port(PortRef(deviceID: node.deviceID, portID: port.portID))
        }
        // Cables are thin: prefer them over the plates they cross, but only close to the line.
        var best: (distance: CGFloat, link: LinkGeometry)?
        for link in links {
            let distance = link.distance(to: point)
            if distance <= tolerance, distance < (best?.distance ?? .greatestFiniteMagnitude) {
                best = (distance, link)
            }
        }
        if let best {
            return .link(best.link.memberIDs)
        }
        for node in nodes.reversed() {
            if node.headerRect.insetBy(dx: -3, dy: -3).contains(point) {
                return .deviceHeader(node.deviceID)
            }
            if node.bodyRect.contains(point) {
                return node.panel != nil ? .devicePanel(node.deviceID) : .deviceHeader(node.deviceID)
            }
        }
        return .empty
    }

    /// Ids of everything whose frame intersects `rect` (rubber-band selection).
    func elements(in rect: CGRect) -> (devices: [UUID], links: [UUID], annotations: [UUID]) {
        let devices = nodes.filter { $0.bodyRect.intersects(rect) || $0.headerRect.intersects(rect) }.map(\.deviceID)
        let notes = annotations.filter { $0.frame.intersects(rect) }.map(\.id)
        // A cable is caught when both of its ends are inside the rubber band.
        let cables = links.filter { rect.contains($0.start) && rect.contains($0.end) }.flatMap(\.memberIDs)
        return (devices, cables, notes)
    }
}
