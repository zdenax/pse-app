import SwiftUI
import NetSketchCore

/// Hand-drawn device glyphs. Every icon is a colored tile with a white line glyph, described once
/// as paths in a unit square (origin top-left, y down) and rendered both by SwiftUI (`DeviceIconView`,
/// used in the palette) and by the CoreGraphics canvas renderer and exporter.
enum DeviceIconArt {
    /// One drawing step of a glyph.
    struct Layer {
        enum Paint {
            case fill
            /// Line width relative to the icon size.
            case stroke(CGFloat)
        }

        var path: Path
        var paint: Paint
        var opacity: CGFloat = 1
    }

    /// Default line width of glyph strokes, relative to the icon size.
    static let strokeWidth: CGFloat = 0.068

    /// Routers get a round tile (the classic "puck"), everything else a rounded square.
    static func tilePath(for category: DeviceCategory, in rect: CGRect) -> Path {
        switch category {
        case .router:
            return Path(ellipseIn: rect)
        default:
            let radius = min(rect.width, rect.height) * 0.24
            return Path(roundedRect: rect, cornerRadius: radius, style: .continuous)
        }
    }

    static func tileColor(for category: DeviceCategory, palette: Palette) -> RGBA {
        switch category {
        case .switch: return palette.tileSwitch
        case .l3switch: return palette.tileL3Switch
        case .router: return palette.tileRouter
        case .accessPoint: return palette.tileAccessPoint
        case .pc: return palette.tilePC
        case .server: return palette.tileServer
        @unknown default: return palette.tilePC
        }
    }

    /// Glyph layers in unit coordinates.
    static func glyph(for category: DeviceCategory) -> [Layer] {
        switch category {
        case .switch: return switchGlyph
        case .l3switch: return l3SwitchGlyph
        case .router: return routerGlyph
        case .accessPoint: return accessPointGlyph
        case .pc: return pcGlyph
        case .server: return serverGlyph
        @unknown default: return pcGlyph
        }
    }

    // MARK: Glyphs

    /// An arrow from `start` to `end` with an open head at `end`.
    private static func arrow(from start: CGPoint, to end: CGPoint, head: CGFloat = 0.11) -> Path {
        var path = Path()
        path.move(to: start)
        path.addLine(to: end)
        let dx = end.x - start.x
        let dy = end.y - start.y
        let length = max((dx * dx + dy * dy).squareRoot(), 0.0001)
        let ux = dx / length
        let uy = dy / length
        // Two wings at +-40 degrees from the reversed direction.
        let angle: CGFloat = 0.70
        for sign in [CGFloat(1), CGFloat(-1)] {
            let cosA = cos(angle * sign)
            let sinA = sin(angle * sign)
            let wx = -(ux * cosA - uy * sinA)
            let wy = -(ux * sinA + uy * cosA)
            path.move(to: end)
            path.addLine(to: CGPoint(x: end.x + wx * head, y: end.y + wy * head))
        }
        return path
    }

    /// L2 switch: two opposing horizontal arrows.
    private static let switchGlyph: [Layer] = {
        var path = Path()
        path.addPath(arrow(from: CGPoint(x: 0.24, y: 0.38), to: CGPoint(x: 0.76, y: 0.38)))
        path.addPath(arrow(from: CGPoint(x: 0.76, y: 0.62), to: CGPoint(x: 0.24, y: 0.62)))
        return [Layer(path: path, paint: .stroke(strokeWidth))]
    }()

    /// L3 switch: a routing ring with four arrows bursting out diagonally.
    private static let l3SwitchGlyph: [Layer] = {
        var arrows = Path()
        let inner: CGFloat = 0.13
        let outer: CGFloat = 0.29
        for (sx, sy) in [(1.0, -1.0), (1.0, 1.0), (-1.0, 1.0), (-1.0, -1.0)] {
            let start = CGPoint(x: 0.5 + CGFloat(sx) * inner, y: 0.5 + CGFloat(sy) * inner)
            let end = CGPoint(x: 0.5 + CGFloat(sx) * outer, y: 0.5 + CGFloat(sy) * outer)
            arrows.addPath(arrow(from: start, to: end, head: 0.12))
        }
        let ring = Path(ellipseIn: CGRect(x: 0.5 - 0.10, y: 0.5 - 0.10, width: 0.20, height: 0.20))
        return [
            Layer(path: arrows, paint: .stroke(strokeWidth)),
            Layer(path: ring, paint: .stroke(strokeWidth)),
        ]
    }()

    /// Router: two arrows in, two arrows out.
    private static let routerGlyph: [Layer] = {
        var path = Path()
        path.addPath(arrow(from: CGPoint(x: 0.17, y: 0.5), to: CGPoint(x: 0.41, y: 0.5)))
        path.addPath(arrow(from: CGPoint(x: 0.83, y: 0.5), to: CGPoint(x: 0.59, y: 0.5)))
        path.addPath(arrow(from: CGPoint(x: 0.5, y: 0.42), to: CGPoint(x: 0.5, y: 0.18)))
        path.addPath(arrow(from: CGPoint(x: 0.5, y: 0.58), to: CGPoint(x: 0.5, y: 0.82)))
        return [Layer(path: path, paint: .stroke(strokeWidth))]
    }()

    /// Access point: a radiating dot.
    private static let accessPointGlyph: [Layer] = {
        let center = CGPoint(x: 0.5, y: 0.73)
        var arcs = Path()
        for radius in [CGFloat(0.17), CGFloat(0.30), CGFloat(0.43)] {
            arcs.move(to: CGPoint(x: center.x + radius * cos(-.pi * 0.75), y: center.y + radius * sin(-.pi * 0.75)))
            arcs.addArc(center: center, radius: radius,
                        startAngle: .radians(-.pi * 0.75), endAngle: .radians(-.pi * 0.25), clockwise: false)
        }
        let dot = Path(ellipseIn: CGRect(x: center.x - 0.055, y: center.y - 0.055, width: 0.11, height: 0.11))
        return [
            Layer(path: arcs, paint: .stroke(strokeWidth)),
            Layer(path: dot, paint: .fill),
        ]
    }()

    /// PC: a monitor on a stand.
    private static let pcGlyph: [Layer] = {
        let screen = Path(roundedRect: CGRect(x: 0.20, y: 0.23, width: 0.60, height: 0.40), cornerRadius: 0.05)
        var stand = Path()
        stand.move(to: CGPoint(x: 0.5, y: 0.63))
        stand.addLine(to: CGPoint(x: 0.5, y: 0.77))
        stand.move(to: CGPoint(x: 0.34, y: 0.78))
        stand.addLine(to: CGPoint(x: 0.66, y: 0.78))
        return [
            Layer(path: screen, paint: .stroke(strokeWidth)),
            Layer(path: stand, paint: .stroke(strokeWidth)),
        ]
    }()

    /// Server: three stacked units with status lights.
    private static let serverGlyph: [Layer] = {
        var units = Path()
        var lights = Path()
        for index in 0..<3 {
            let y = 0.20 + CGFloat(index) * 0.215
            units.addPath(Path(roundedRect: CGRect(x: 0.24, y: y, width: 0.52, height: 0.17), cornerRadius: 0.04))
            lights.addPath(Path(ellipseIn: CGRect(x: 0.315, y: y + 0.085 - 0.032, width: 0.064, height: 0.064)))
        }
        return [
            Layer(path: units, paint: .stroke(strokeWidth * 0.9)),
            Layer(path: lights, paint: .fill),
        ]
    }()

    // MARK: CoreGraphics rendering

    /// Draws the complete icon (tile and glyph) into `rect` of a y-down context.
    static func draw(_ category: DeviceCategory, in rect: CGRect, palette: Palette, context ctx: CGContext) {
        ctx.saveGState()
        let tile = tilePath(for: category, in: rect).cgPath
        ctx.addPath(tile)
        ctx.setFillColor(tileColor(for: category, palette: palette).cgColor)
        ctx.fillPath()
        ctx.addPath(tile)
        ctx.setStrokeColor(palette.tileStroke.cgColor)
        ctx.setLineWidth(max(rect.width * 0.02, 0.5))
        ctx.strokePath()

        var transform = CGAffineTransform(translationX: rect.minX, y: rect.minY).scaledBy(x: rect.width, y: rect.height)
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
        for layer in glyph(for: category) {
            guard let path = layer.path.cgPath.copy(using: &transform) else { continue }
            let color = palette.iconGlyph.opacity(layer.opacity).cgColor
            ctx.addPath(path)
            switch layer.paint {
            case .fill:
                ctx.setFillColor(color)
                ctx.fillPath()
            case .stroke(let width):
                ctx.setStrokeColor(color)
                ctx.setLineWidth(width * rect.width)
                ctx.strokePath()
            }
        }
        ctx.restoreGState()
    }
}

/// The NetSketch icon of a device category: a colored tile with a white glyph.
/// Drawn entirely with vector shapes, so it stays sharp at any size.
public struct DeviceIconView: View {
    private let category: DeviceCategory
    private let size: CGFloat
    @Environment(\.colorScheme) private var colorScheme

    public init(category: DeviceCategory, size: CGFloat) {
        self.category = category
        self.size = size
    }

    public var body: some View {
        let palette = Palette.resolve(dark: colorScheme == .dark)
        Canvas { context, canvasSize in
            let side = min(canvasSize.width, canvasSize.height)
            let rect = CGRect(x: (canvasSize.width - side) / 2, y: (canvasSize.height - side) / 2,
                              width: side, height: side).insetBy(dx: 0.5, dy: 0.5)
            let tile = DeviceIconArt.tilePath(for: category, in: rect)
            context.fill(tile, with: .color(DeviceIconArt.tileColor(for: category, palette: palette).color))
            context.stroke(tile, with: .color(palette.tileStroke.color), lineWidth: max(side * 0.02, 0.5))

            let transform = CGAffineTransform(translationX: rect.minX, y: rect.minY)
                .scaledBy(x: rect.width, y: rect.height)
            for layer in DeviceIconArt.glyph(for: category) {
                let path = layer.path.applying(transform)
                let shading = GraphicsContext.Shading.color(palette.iconGlyph.opacity(layer.opacity).color)
                switch layer.paint {
                case .fill:
                    context.fill(path, with: shading)
                case .stroke(let width):
                    context.stroke(path, with: shading,
                                   style: StrokeStyle(lineWidth: width * rect.width, lineCap: .round, lineJoin: .round))
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
