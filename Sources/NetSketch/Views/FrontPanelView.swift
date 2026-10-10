import SwiftUI
import NetSketchCore
import NetSketchCanvas

/// Drawing of a template's front panel for the custom-device sheet: the plate, every port at
/// its place in `DeviceTemplate.panelGrid`, empty module bays, section captions and the printed
/// port names. `portSize` is the side of one port cell (one RJ45 column, one port row) in points.
///
/// The canvas draws panels with its own renderer, which NetSketchCanvas keeps internal. This
/// is a SwiftUI rendition of the same rules (cell metrics, wider columns for cages, labels above
/// the top row and below the bottom row, colors per connector), so the preview matches what
/// the device will look like on the canvas.
struct FrontPanelView: View {
    let template: DeviceTemplate
    let portSize: CGFloat

    init(template: DeviceTemplate, portSize: CGFloat = 17) {
        self.template = template
        self.portSize = portSize
    }

    var body: some View {
        let layout = PanelPreviewLayout(template: template, cell: max(portSize, 6))
        Canvas { context, _ in
            layout.draw(in: &context)
        }
        .frame(width: layout.size.width, height: layout.size.height)
        .accessibilityElement()
        .accessibilityLabel("Náhled čelního panelu, " + CzechText.ports(template.portCount))
    }
}

/// Port colors of the canvas palette (light / dark), per connector.
private enum PanelPreviewColors {
    static let shadow = Theme.adaptive(light: Theme.navy.opacity(0.10), dark: Color.black.opacity(0.30))
    static let label = Theme.adaptive(light: rgb(0x4A5866), dark: rgb(0xB4C2D2))
    static let copper = Theme.adaptive(light: rgb(0x0B2545), dark: rgb(0xE8E3D8))
    static let optic = Theme.adaptive(light: rgb(0x0E8F86), dark: rgb(0x2FD0C4))
    static let console = Theme.adaptive(light: rgb(0x2F8FC9), dark: rgb(0x6BC1F0))
    static let mgmt = Theme.adaptive(light: rgb(0x8A6FB8), dark: rgb(0xB59CE0))
    static let wireless = Theme.adaptive(light: rgb(0xEE6C4D), dark: rgb(0xF58A6E))

    static func tint(for connector: ConnectorType) -> Color {
        switch connector {
        case .rj45: return copper
        case .sfp, .sfpPlus, .qsfpPlus: return optic
        case .console: return console
        case .mgmt: return mgmt
        case .wireless: return wireless
        }
    }

    private static func rgb(_ hex: UInt32) -> Color {
        Color(.sRGB,
              red: Double((hex >> 16) & 0xFF) / 255,
              green: Double((hex >> 8) & 0xFF) / 255,
              blue: Double(hex & 0xFF) / 255,
              opacity: 1)
    }
}

/// Geometry of the preview in view points, origin at the top-left corner of the plate.
private struct PanelPreviewLayout {
    struct PortMark {
        /// The drawn jack / cage.
        let rect: CGRect
        /// Width of the port's column; the printed name must fit into it.
        let pitch: CGFloat
        let connector: ConnectorType
        let shortName: String
        /// Center of the printed name; nil in a middle row, which has no room for names.
        let labelCenter: CGPoint?
        let isTopRow: Bool
    }

    struct Bay {
        let rect: CGRect
        let label: String
    }

    struct Caption {
        let text: String
        /// Leading edge, vertical center.
        let anchor: CGPoint
        let maxWidth: CGFloat
    }

    /// Cell size relative to the canvas' standard cell of 17 points.
    let scale: CGFloat
    let plate: CGRect
    let ports: [PortMark]
    let bays: [Bay]
    let captions: [Caption]

    /// The plate plus room for its drop shadow.
    var size: CGSize { CGSize(width: ceil(plate.width), height: ceil(plate.maxY + 2 * scale)) }

    private var labelFont: Font { .system(size: 8 * scale, weight: .medium).monospacedDigit() }
    private var captionFont: Font { .system(size: 7.5 * scale, weight: .semibold) }

    init(template: DeviceTemplate, cell: CGFloat) {
        let grid = template.panelGrid
        let devicePorts = template.makePorts()
        let s = cell / 17
        let paddingX = 8 * s
        let paddingY = 5 * s
        let strip = 10 * s
        let rows = max(grid.rows, 1)
        let shortNames = devicePorts.map(\.shortName)
        // Sparse panels get cells wide enough for the whole short name, like on the canvas.
        let roomy = !devicePorts.isEmpty && devicePorts.count <= 10

        var slotsBySection: [Int: [PanelGrid.Slot]] = [:]
        for slot in grid.slots where devicePorts.indices.contains(slot.portIndex) {
            slotsBySection[slot.section, default: []].append(slot)
        }

        // Horizontal extent of every section. Cages need wider columns than RJ45 jacks.
        var boxX: [CGFloat] = []
        var boxWidth: [CGFloat] = []
        var boxPitch: [CGFloat] = []
        var cursor: CGFloat = 0
        for (index, section) in grid.sections.enumerated() {
            let slots = slotsBySection[index] ?? []
            var pitch = cell
            var width = max(section.width, 1) * cell
            if !section.isPlaceholder, !slots.isEmpty {
                pitch = (slots.map { Self.pitchFactor(devicePorts[$0.portIndex].connector) }.max() ?? 1) * cell
                let columnCount = (slots.map(\.column).max() ?? 0) + 1
                if roomy || columnCount <= 2 {
                    let widest = slots.map { Self.estimatedWidth(shortNames[$0.portIndex], scale: s) }.max() ?? 0
                    pitch = min(max(pitch, ceil(widest + 7 * s)), max(3.2 * cell, pitch))
                }
                let columns = CGFloat(columnCount)
                // Whatever the core grid added on top of the plain columns are block gaps.
                width = columns * pitch + max(section.width - columns, 0) * cell
            }
            boxX.append(cursor)
            boxWidth.append(width)
            boxPitch.append(pitch)
            let gap = index + 1 < grid.sections.count
                ? max(grid.sections[index + 1].x - (section.x + section.width), 0) * cell
                : 0
            cursor += width + gap
        }
        let contentWidth = cursor

        // Vertical structure: [captions] [names of the top row] rows [names of the bottom row].
        let hasCaptions = grid.sections.contains { !$0.isPlaceholder && !($0.label ?? "").isEmpty }
        let rowsTop = paddingY + (hasCaptions ? strip : 0) + (rows > 1 ? strip : 0)
        let rowsHeight = CGFloat(rows) * cell
        let plateWidth = max(contentWidth + 2 * paddingX, 84 * s)
        let plateHeight = rowsTop + rowsHeight + strip + paddingY
        let left = (plateWidth - contentWidth) / 2

        var marks: [PortMark] = []
        for slot in grid.slots where devicePorts.indices.contains(slot.portIndex) && grid.sections.indices.contains(slot.section) {
            let section = grid.sections[slot.section]
            let pitch = boxPitch[slot.section]
            let port = devicePorts[slot.portIndex]
            let extra = max(slot.x - section.x - CGFloat(slot.column), 0) * cell
            let cellRect = CGRect(x: left + boxX[slot.section] + CGFloat(slot.column) * pitch + extra,
                                  y: rowsTop + CGFloat(slot.row) * cell,
                                  width: pitch, height: cell)
            let jack = Self.jackSize(port.connector, cell: cell, pitch: pitch, scale: s)
            let rect = CGRect(x: cellRect.midX - jack.width / 2, y: cellRect.midY - jack.height / 2,
                              width: jack.width, height: jack.height)
            let isTopRow = rows > 1 && slot.row == 0
            let labelY: CGFloat?
            if isTopRow {
                labelY = rowsTop - strip / 2
            } else if slot.row == rows - 1 {
                labelY = rowsTop + rowsHeight + strip / 2
            } else {
                labelY = nil
            }
            marks.append(PortMark(rect: rect, pitch: pitch, connector: port.connector, shortName: port.shortName,
                                  labelCenter: labelY.map { CGPoint(x: cellRect.midX, y: $0) }, isTopRow: isTopRow))
        }

        var bays: [Bay] = []
        var captions: [Caption] = []
        for (index, section) in grid.sections.enumerated() {
            let label = (section.label ?? "").trimmingCharacters(in: .whitespaces)
            if section.isPlaceholder || (slotsBySection[index] ?? []).isEmpty {
                bays.append(Bay(rect: CGRect(x: left + boxX[index], y: rowsTop + 1.5 * s,
                                             width: boxWidth[index], height: rowsHeight - 3 * s),
                                label: label))
            } else if hasCaptions, !label.isEmpty {
                // The caption may spill a little into the gap towards the next section.
                let available = boxWidth[index] + (index + 1 < grid.sections.count ? 0.3 * cell : 0)
                captions.append(Caption(text: label,
                                        anchor: CGPoint(x: left + boxX[index] + s, y: paddingY + strip / 2),
                                        maxWidth: available))
            }
        }

        scale = s
        plate = CGRect(x: 0, y: 0, width: plateWidth, height: plateHeight)
        ports = marks
        self.bays = bays
        self.captions = captions
    }

    // MARK: Metrics (same factors as the canvas)

    /// Column width needed by a connector, relative to the cell.
    private static func pitchFactor(_ connector: ConnectorType) -> CGFloat {
        switch connector {
        case .sfp, .sfpPlus: return 1.35
        case .qsfpPlus: return 1.7
        default: return 1.0
        }
    }

    /// Size of the drawn jack or cage inside a column of width `pitch`.
    private static func jackSize(_ connector: ConnectorType, cell: CGFloat, pitch: CGFloat, scale: CGFloat) -> CGSize {
        let gap = 3 * scale
        switch connector {
        case .sfp, .sfpPlus:
            return CGSize(width: min(1.18 * cell, pitch - gap), height: 0.62 * cell)
        case .qsfpPlus:
            return CGSize(width: min(1.53 * cell, pitch - gap), height: 0.74 * cell)
        default:
            return CGSize(width: 0.76 * cell, height: 0.76 * cell)
        }
    }

    /// Rough width of a printed port name; only used to decide how wide roomy columns get.
    /// The name itself is measured exactly when it is drawn.
    private static func estimatedWidth(_ text: String, scale: CGFloat) -> CGFloat {
        CGFloat(text.count) * 8 * scale * 0.58
    }

    /// What may be printed next to a port, best first: the short name, its trailing number,
    /// or (for named ports) the first word and shorter abbreviations of it.
    static func labelCandidates(_ shortName: String) -> [String] {
        var result = [shortName]
        let digits = String(shortName.reversed().prefix(while: \.isNumber).reversed())
        if !digits.isEmpty {
            result.append(digits)
            return result
        }
        let firstWord = shortName.split(whereSeparator: { $0 == " " || $0 == "-" || $0 == "/" })
            .first.map(String.init) ?? shortName
        result.append(firstWord)
        for length in [4, 3, 2] where firstWord.count > length {
            result.append(String(firstWord.prefix(length)))
        }
        return result
    }

    // MARK: Drawing

    func draw(in context: inout GraphicsContext) {
        let s = scale

        // Plate with a flat drop shadow.
        context.fill(Self.rounded(plate.offsetBy(dx: 0, dy: 2 * s), 6 * s), with: .color(PanelPreviewColors.shadow))
        let platePath = Self.rounded(plate, 6 * s)
        context.fill(platePath, with: .color(Theme.panelFill))
        context.stroke(platePath, with: .color(Theme.panelStroke), lineWidth: 1)

        // Empty module bays.
        for bay in bays {
            context.stroke(Self.rounded(bay.rect, 3 * s), with: .color(Theme.panelStroke),
                           style: StrokeStyle(lineWidth: 0.9 * s, dash: [3 * s, 2.5 * s]))
            if !bay.label.isEmpty,
               let text = fitted([bay.label], font: captionFont, color: Theme.secondaryInk,
                                 maxWidth: bay.rect.width - 4 * s, in: context) {
                context.draw(text, at: CGPoint(x: bay.rect.midX, y: bay.rect.midY), anchor: .center)
            }
        }

        // Ports and their printed names.
        for port in ports {
            drawJack(port, in: &context)
            if let center = port.labelCenter,
               let text = fitted(Self.labelCandidates(port.shortName), font: labelFont, color: PanelPreviewColors.label,
                                 maxWidth: port.pitch - 1.5 * s, in: context) {
                context.draw(text, at: center, anchor: .center)
            }
        }

        // Section captions ("PoE+", "Uplink").
        for caption in captions {
            if let text = fitted([caption.text], font: captionFont, color: Theme.secondaryInk,
                                 maxWidth: caption.maxWidth, in: context) {
                context.draw(text, at: caption.anchor, anchor: .leading)
            }
        }
    }

    private func drawJack(_ port: PortMark, in context: inout GraphicsContext) {
        let s = scale
        let rect = port.rect
        let tint = PanelPreviewColors.tint(for: port.connector)
        switch port.connector {
        case .sfp, .sfpPlus, .qsfpPlus:
            let cage = Self.rounded(rect, rect.height * 0.32)
            context.fill(cage, with: .color(tint.opacity(0.07)))
            context.stroke(cage, with: .color(tint.opacity(0.9)), lineWidth: 1.1 * s)
            if port.connector == .qsfpPlus {
                // QSFP+ cages carry a center divider to tell them from SFP cages.
                var divider = Path()
                divider.move(to: CGPoint(x: rect.midX, y: rect.minY + 2.2 * s))
                divider.addLine(to: CGPoint(x: rect.midX, y: rect.maxY - 2.2 * s))
                context.stroke(divider, with: .color(tint.opacity(0.9)), lineWidth: 1.1 * s)
            }
        case .wireless:
            // Antenna mark: a dot with two arcs.
            let base = CGPoint(x: rect.midX, y: rect.maxY - rect.height * 0.22)
            var arcs = Path()
            for radius in [rect.width * 0.28, rect.width * 0.5] {
                arcs.move(to: CGPoint(x: base.x + radius * cos(-CGFloat.pi * 0.78),
                                      y: base.y + radius * sin(-CGFloat.pi * 0.78)))
                arcs.addArc(center: base, radius: radius,
                            startAngle: .radians(-Double.pi * 0.78), endAngle: .radians(-Double.pi * 0.22),
                            clockwise: false)
            }
            context.stroke(arcs, with: .color(tint.opacity(0.9)), style: StrokeStyle(lineWidth: 1.1 * s, lineCap: .round))
            let dot = rect.width * 0.2
            context.fill(Path(ellipseIn: CGRect(x: base.x - dot / 2, y: base.y - dot / 2, width: dot, height: dot)),
                         with: .color(tint))
        case .rj45, .console, .mgmt:
            let jack = Self.rounded(rect, 1.8 * s)
            context.fill(jack, with: .color(tint.opacity(0.07)))
            context.stroke(jack, with: .color(tint.opacity(0.9)), lineWidth: 1.1 * s)
            // Latch notch: up on the top row, down otherwise - like a real switch.
            let tabWidth = rect.width * 0.38
            let tabHeight = rect.height * 0.22
            let tabY = port.isTopRow ? rect.minY + 1.2 * s : rect.maxY - 1.2 * s - tabHeight
            context.fill(Path(CGRect(x: rect.midX - tabWidth / 2, y: tabY, width: tabWidth, height: tabHeight)),
                         with: .color(tint.opacity(0.45)))
        }
    }

    /// The first candidate that fits `maxWidth`, resolved for drawing; nil when none fits.
    private func fitted(_ candidates: [String], font: Font, color: Color, maxWidth: CGFloat,
                        in context: GraphicsContext) -> GraphicsContext.ResolvedText? {
        guard maxWidth > 0 else { return nil }
        let unlimited = CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        for candidate in candidates where !candidate.isEmpty {
            var text = context.resolve(Text(candidate).font(font))
            text.shading = .color(color)
            if text.measure(in: unlimited).width <= maxWidth { return text }
        }
        return nil
    }

    /// A rounded rectangle whose radius never exceeds half of the shorter side.
    private static func rounded(_ rect: CGRect, _ radius: CGFloat) -> Path {
        let r = max(min(radius, rect.width / 2, rect.height / 2), 0)
        return Path(roundedRect: rect, cornerRadius: r, style: .circular)
    }
}
