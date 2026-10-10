import CoreGraphics
import Foundation
import NetSketchCore

extension CGRect {
    var center: CGPoint { CGPoint(x: midX, y: midY) }

    init(center: CGPoint, size: CGSize) {
        self.init(x: center.x - size.width / 2, y: center.y - size.height / 2, width: size.width, height: size.height)
    }
}

/// Sizes of the front-panel drawing. Everything derives from `cell`, the width of one RJ45
/// column and the height of one port row, so a panel can be drawn at any size.
struct PanelMetrics: Equatable {
    /// Width of an RJ45 column = height of a port row, in canvas points.
    var cell: CGFloat

    static let standardCell: CGFloat = 17
    static let standard = PanelMetrics(cell: standardCell)

    var scale: CGFloat { cell / PanelMetrics.standardCell }
    var paddingX: CGFloat { 8 * scale }
    var paddingY: CGFloat { 5 * scale }
    /// Height of the strip that carries the printed port labels above / below the rows.
    var labelStrip: CGFloat { 10 * scale }
    /// Height of the strip with section captions ("PoE+", "Uplink").
    var captionStrip: CGFloat { 10 * scale }
    var cornerRadius: CGFloat { 6 * scale }
    var minWidth: CGFloat { 84 * scale }
    /// Panels with at most this many ports get wide cells that fit the whole short port name.
    var roomyPortLimit: Int { 10 }
    /// Sections with at most this many columns always get wide cells (uplinks, console, mgmt).
    var roomySectionColumns: Int { 2 }
    var maxRoomyPitch: CGFloat { 3.2 * cell }

    var labelStyle: TextStyle { TextStyle(size: 8 * scale, weight: .medium, monospacedDigits: true) }
    var captionStyle: TextStyle { TextStyle(size: 7.5 * scale, weight: .semibold) }

    /// Column width needed by a connector, relative to `cell`.
    func pitchFactor(for connector: ConnectorType) -> CGFloat {
        switch connector {
        case .sfp, .sfpPlus: return 1.35
        case .qsfpPlus: return 1.7
        default: return 1.0
        }
    }

    /// Size of the drawn jack / cage of a connector inside a column of width `pitch`.
    func jackSize(for connector: ConnectorType, pitch: CGFloat) -> CGSize {
        let gap = 3 * scale
        switch connector {
        case .sfp, .sfpPlus:
            return CGSize(width: min(1.18 * cell, pitch - gap), height: 0.62 * cell)
        case .qsfpPlus:
            return CGSize(width: min(1.53 * cell, pitch - gap), height: 0.74 * cell)
        default:
            let side = 0.76 * cell
            return CGSize(width: side, height: side)
        }
    }
}

/// Where the printed label of a port goes.
enum PortLabelPlacement {
    case above, below, hidden
}

/// One port on a drawn front panel.
struct PortGeometry {
    /// Index into `Device.ports`.
    let index: Int
    let portID: UUID
    let connector: ConnectorType
    /// Administratively shut down; drawn struck through. Stored only, nothing is simulated.
    let adminDown: Bool
    /// The whole grid cell; used for hit testing so ports are easy to click.
    let cell: CGRect
    /// The drawn jack / cage.
    let rect: CGRect
    let row: Int
    /// Text printed next to the port; empty when nothing readable fits.
    let label: String
    let labelPlacement: PortLabelPlacement
    /// Center of the printed label.
    let labelCenter: CGPoint

    /// Where cables attach.
    var center: CGPoint { rect.center }
}

/// THE geometry of a front panel: template/layout + device position -> port rectangles in canvas
/// coordinates. The node renderer, the link layer, hit testing and the exporter all go through this
/// type, so cables always land exactly on the drawn ports.
struct PanelGeometry {
    struct Caption {
        let text: String
        /// Leading edge, vertical center.
        let anchor: CGPoint
    }

    struct Bay {
        let rect: CGRect
        let label: String
    }

    let metrics: PanelMetrics
    /// The panel plate.
    let frame: CGRect
    /// One entry per device port, ordered like `Device.ports`.
    let ports: [PortGeometry]
    let captions: [Caption]
    /// Empty module bays.
    let bays: [Bay]
    /// True when the cells were widened to fit full short port names.
    let isRoomy: Bool

    private let indexByID: [UUID: Int]

    /// Panel centered on `device.position`.
    init(device: Device, metrics: PanelMetrics = .standard) {
        self.init(device: device, placement: .center(device.position), metrics: metrics)
    }

    /// Panel with its top-left corner at `origin` (used by previews).
    init(device: Device, origin: CGPoint, metrics: PanelMetrics = .standard) {
        self.init(device: device, placement: .origin(origin), metrics: metrics)
    }

    private enum Placement {
        case center(CGPoint)
        case origin(CGPoint)
    }

    private init(device: Device, placement: Placement, metrics m: PanelMetrics) {
        let text = TextRenderer.shared
        let grid = device.panelGrid
        let ports = device.ports
        let cell = m.cell
        let roomy = !ports.isEmpty && ports.count <= m.roomyPortLimit
        let shortNames = ports.map { $0.shortName }

        // Slots per section.
        var slotsBySection: [Int: [PanelGrid.Slot]] = [:]
        for slot in grid.slots where ports.indices.contains(slot.portIndex) {
            slotsBySection[slot.section, default: []].append(slot)
        }

        // Horizontal extent of every section. A section is as wide as its widest connector
        // needs (cages are wider than RJ45 jacks); sparse panels get roomy cells for full names.
        struct SectionBox {
            var x: CGFloat = 0
            var width: CGFloat = 0
            var pitch: CGFloat = 0
        }
        var boxes = [SectionBox](repeating: SectionBox(), count: grid.sections.count)
        var cursor: CGFloat = 0
        var lastGap: CGFloat = 0
        for (index, section) in grid.sections.enumerated() {
            var box = SectionBox()
            box.x = cursor
            let slots = slotsBySection[index] ?? []
            if section.isPlaceholder || slots.isEmpty {
                box.pitch = cell
                box.width = max(section.width, 1) * cell
            } else {
                var pitch = slots.map { m.pitchFactor(for: ports[$0.portIndex].connector) }.max().map { $0 * cell } ?? cell
                let columnCount = (slots.map(\.column).max() ?? 0) + 1
                // Sparse panels, and small sections of dense ones (uplinks, console, management),
                // have room for the whole short name under each port.
                if roomy || columnCount <= m.roomySectionColumns {
                    let widest = slots.map { text.metrics(shortNames[$0.portIndex], style: m.labelStyle).width }.max() ?? 0
                    pitch = min(max(pitch, ceil(widest + 7 * m.scale)), max(m.maxRoomyPitch, pitch))
                }
                let columns = CGFloat(columnCount)
                // Whatever the core grid added on top of the plain columns are block gaps.
                let extraGaps = max(section.width - columns, 0) * cell
                box.pitch = pitch
                box.width = columns * pitch + extraGaps
            }
            boxes[index] = box
            let nextGap: CGFloat
            if index + 1 < grid.sections.count {
                nextGap = max(grid.sections[index + 1].x - (section.x + section.width), 0) * cell
            } else {
                nextGap = 0
            }
            lastGap = nextGap
            cursor += box.width + nextGap
        }
        let contentWidth = max(cursor - lastGap, 0)

        // Vertical structure: [captions] [labels of the top row] rows [labels of the bottom row].
        let rows = max(grid.rows, 1)
        let hasCaptions = grid.sections.contains { !$0.isPlaceholder && !($0.label ?? "").isEmpty }
        let hasTopLabels = rows > 1
        let rowsTopInset = m.paddingY + (hasCaptions ? m.captionStrip : 0) + (hasTopLabels ? m.labelStrip : 0)
        let rowsHeight = CGFloat(rows) * cell
        let height = rowsTopInset + rowsHeight + m.labelStrip + m.paddingY
        let width = max(contentWidth + 2 * m.paddingX, m.minWidth)

        let origin: CGPoint
        switch placement {
        case .center(let center):
            origin = CGPoint(x: (center.x - width / 2).rounded(), y: (center.y - height / 2).rounded())
        case .origin(let point):
            origin = point
        }
        let frame = CGRect(x: origin.x, y: origin.y, width: width, height: height)
        let contentLeft = frame.minX + (width - contentWidth) / 2
        let rowsTop = frame.minY + rowsTopInset

        // Ports.
        var portGeometry: [PortGeometry?] = Array(repeating: nil, count: ports.count)
        for slot in grid.slots where ports.indices.contains(slot.portIndex) && grid.sections.indices.contains(slot.section) {
            let section = grid.sections[slot.section]
            let box = boxes[slot.section]
            let port = ports[slot.portIndex]
            let extra = max(slot.x - section.x - CGFloat(slot.column), 0) * cell
            let x = contentLeft + box.x + CGFloat(slot.column) * box.pitch + extra
            let y = rowsTop + CGFloat(slot.row) * cell
            let cellRect = CGRect(x: x, y: y, width: box.pitch, height: cell)
            let jack = CGRect(center: cellRect.center, size: m.jackSize(for: port.connector, pitch: box.pitch))

            let placement: PortLabelPlacement
            let labelY: CGFloat
            if rows > 1 && slot.row == 0 {
                placement = .above
                labelY = rowsTop - m.labelStrip / 2
            } else if slot.row == rows - 1 {
                placement = .below
                labelY = rowsTop + rowsHeight + m.labelStrip / 2
            } else {
                placement = .hidden
                labelY = cellRect.midY
            }
            let label = placement == .hidden
                ? ""
                : PanelGeometry.printedLabel(shortName: shortNames[slot.portIndex],
                                             maxWidth: box.pitch - 1.5 * m.scale, style: m.labelStyle)
            portGeometry[slot.portIndex] = PortGeometry(
                index: slot.portIndex, portID: port.id, connector: port.connector,
                adminDown: port.adminDown, cell: cellRect, rect: jack, row: slot.row,
                label: label, labelPlacement: label.isEmpty ? .hidden : placement,
                labelCenter: CGPoint(x: cellRect.midX, y: labelY)
            )
        }
        let resolved = portGeometry.compactMap { $0 }

        // Captions and empty bays.
        var captions: [Caption] = []
        var bays: [Bay] = []
        for (index, section) in grid.sections.enumerated() {
            let box = boxes[index]
            let label = (section.label ?? "").trimmingCharacters(in: .whitespaces)
            if section.isPlaceholder || (slotsBySection[index] ?? []).isEmpty {
                let rect = CGRect(x: contentLeft + box.x, y: rowsTop + 1.5 * m.scale,
                                  width: box.width, height: rowsHeight - 3 * m.scale)
                bays.append(Bay(rect: rect, label: text.truncated(label, style: m.captionStyle, maxWidth: box.width - 4 * m.scale)))
            } else if hasCaptions, !label.isEmpty {
                // Allow the caption to spill into the gap towards the next section, but not beyond.
                let available = box.width + (index + 1 < grid.sections.count ? 0.3 * cell : 0)
                let fitted = text.truncated(label, style: m.captionStyle, maxWidth: available)
                if fitted.count >= min(label.count, 3) {
                    captions.append(Caption(text: fitted,
                                            anchor: CGPoint(x: contentLeft + box.x + 1 * m.scale,
                                                            y: frame.minY + m.paddingY + m.captionStrip / 2)))
                }
            }
        }

        self.metrics = m
        self.frame = frame
        self.ports = resolved
        self.captions = captions
        self.bays = bays
        self.isRoomy = roomy
        var lookup: [UUID: Int] = [:]
        for (offset, port) in resolved.enumerated() { lookup[port.portID] = offset }
        self.indexByID = lookup
    }

    func port(id: UUID) -> PortGeometry? {
        indexByID[id].map { ports[$0] }
    }

    /// The port whose cell contains `point`.
    func port(at point: CGPoint) -> PortGeometry? {
        guard frame.contains(point) else { return nil }
        return ports.first { $0.cell.contains(point) }
    }

    /// The readable subset of a port name that fits `maxWidth`:
    /// the whole short name if possible, else its trailing number, else a short abbreviation.
    static func printedLabel(shortName: String, maxWidth: CGFloat, style: TextStyle) -> String {
        let text = TextRenderer.shared
        func fits(_ candidate: String) -> Bool {
            !candidate.isEmpty && text.metrics(candidate, style: style).width <= maxWidth
        }
        if fits(shortName) { return shortName }

        // Trailing number: "Gi1/0/24" -> "24", "ether5" -> "5".
        var digits = ""
        for character in shortName.reversed() {
            if character.isNumber { digits.insert(character, at: digits.startIndex) } else { break }
        }
        if fits(digits) { return digits }
        if !digits.isEmpty {
            // Even the number does not fit (very long numbers): give up rather than print noise.
            return ""
        }

        // Named ports: "Console" -> "Con", "Management" -> "Man".
        let firstWord = shortName.split(whereSeparator: { $0 == " " || $0 == "-" || $0 == "/" }).first.map(String.init) ?? shortName
        if fits(firstWord) { return firstWord }
        for length in [4, 3, 2] where firstWord.count > length {
            let candidate = String(firstWord.prefix(length))
            if fits(candidate) { return candidate }
        }
        return ""
    }
}

/// Complete geometry of one device node (icon, texts, warning glyph and - in the physical view - the panel).
struct NodeGeometry {
    let deviceID: UUID
    let category: DeviceCategory
    let mode: ViewMode
    /// `Device.position`: center of the panel (physical) or of the icon (logical).
    let anchor: CGPoint
    let iconRect: CGRect
    let hostname: String
    let hostnameRect: CGRect
    let typeText: String
    let typeRect: CGRect
    /// Frame of the "verify against hardware" glyph; nil when the device is verified.
    let warningRect: CGRect?
    let panel: PanelGeometry?
    /// Icon and texts: the drag handle and rename target.
    let headerRect: CGRect
    /// The solid body links attach to: the panel (physical) or the icon (logical).
    let bodyRect: CGRect
    /// Everything that belongs to the node.
    let bounds: CGRect
    /// True when texts are centered under the icon (logical view).
    let centeredLabels: Bool

    static let physicalIconSize: CGFloat = 30
    static let logicalIconSize: CGFloat = 46
    static let warningSize: CGFloat = 13

    init(device: Device, mode: ViewMode, metrics: PanelMetrics = .standard) {
        let text = TextRenderer.shared
        let hostnameSize = text.size(device.hostname.isEmpty ? " " : device.hostname, style: .hostname)
        let typeText = device.displayModel
        let typeSize = text.size(typeText.isEmpty ? " " : typeText, style: .deviceType)
        let needsWarning = device.needsVerification
        let warning = NodeGeometry.warningSize

        deviceID = device.id
        category = device.category
        self.mode = mode
        anchor = device.position
        hostname = device.hostname
        self.typeText = typeText

        switch mode {
        case .physical:
            let panel = PanelGeometry(device: device, metrics: metrics)
            let icon = NodeGeometry.physicalIconSize
            let iconRect = CGRect(x: panel.frame.minX, y: panel.frame.minY - 7 - icon, width: icon, height: icon)
            let textX = iconRect.maxX + 8
            let hostnameRect = CGRect(x: textX, y: iconRect.minY - 1,
                                      width: ceil(hostnameSize.width), height: ceil(hostnameSize.height))
            let typeRect = CGRect(x: textX, y: hostnameRect.maxY,
                                  width: ceil(typeSize.width), height: ceil(typeSize.height))
            let warningRect = needsWarning
                ? CGRect(x: hostnameRect.maxX + 6, y: hostnameRect.midY - warning / 2, width: warning, height: warning)
                : nil
            var header = iconRect.union(hostnameRect).union(typeRect)
            if let warningRect { header = header.union(warningRect) }

            self.iconRect = iconRect
            self.hostnameRect = hostnameRect
            self.typeRect = typeRect
            self.warningRect = warningRect
            self.panel = panel
            headerRect = header
            bodyRect = panel.frame
            bounds = header.union(panel.frame)
            centeredLabels = false

        case .logical:
            let icon = NodeGeometry.logicalIconSize
            let iconRect = CGRect(center: CGPoint(x: device.position.x.rounded(), y: device.position.y.rounded()),
                                  size: CGSize(width: icon, height: icon))
            let hostnameRect = CGRect(x: iconRect.midX - ceil(hostnameSize.width) / 2, y: iconRect.maxY + 5,
                                      width: ceil(hostnameSize.width), height: ceil(hostnameSize.height))
            let typeRect = CGRect(x: iconRect.midX - ceil(typeSize.width) / 2, y: hostnameRect.maxY,
                                  width: ceil(typeSize.width), height: ceil(typeSize.height))
            let warningRect = needsWarning
                ? CGRect(x: hostnameRect.maxX + 5, y: hostnameRect.midY - warning / 2, width: warning, height: warning)
                : nil
            var header = iconRect.union(hostnameRect).union(typeRect)
            if let warningRect { header = header.union(warningRect) }

            self.iconRect = iconRect
            self.hostnameRect = hostnameRect
            self.typeRect = typeRect
            self.warningRect = warningRect
            panel = nil
            headerRect = header
            bodyRect = iconRect
            bounds = header
            centeredLabels = true
        }
    }

    /// The plate behind hostname, type and warning glyph.
    var labelPlateRect: CGRect {
        var plate = hostnameRect.union(typeRect)
        if let warningRect { plate = plate.union(warningRect) }
        return plate.insetBy(dx: -4, dy: -1)
    }

    /// Rect offered to the inline hostname editor (roomier than the text itself).
    var hostnameEditRect: CGRect {
        let minWidth: CGFloat = 120
        let width = max(hostnameRect.width + 24, minWidth)
        if centeredLabels {
            return CGRect(x: hostnameRect.midX - width / 2, y: hostnameRect.minY - 3, width: width, height: hostnameRect.height + 6)
        }
        return CGRect(x: hostnameRect.minX - 4, y: hostnameRect.minY - 3, width: width, height: hostnameRect.height + 6)
    }
}
