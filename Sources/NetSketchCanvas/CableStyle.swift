import CoreGraphics
import NetSketchCore

/// How a cable is stroked. THE one place that maps `CableType` to a look; the cable type is
/// purely visual and nothing else in the canvas interprets it.
///
/// | CableType  | Color                | Width | Pattern                 |
/// |------------|----------------------|-------|-------------------------|
/// | straight   | copper (ink)         | 2.0   | solid                   |
/// | crossover  | copper (ink)         | 2.0   | dashed 7-4              |
/// | console    | light blue           | 1.4   | solid, thin (rollover)  |
/// | fiber      | accent orange        | 2.4   | dash-dot 10-3-2-3       |
struct CableStyle {
    var color: RGBA
    var width: CGFloat
    /// Dash pattern in canvas points; empty = solid.
    var dash: [CGFloat]
    var cap: CGLineCap

    static func style(for type: CableType, palette: Palette) -> CableStyle {
        switch type {
        case .straight:
            return CableStyle(color: palette.cableCopper, width: 2.0, dash: [], cap: .round)
        case .crossover:
            return CableStyle(color: palette.cableCopper, width: 2.0, dash: [7, 4], cap: .butt)
        case .console:
            return CableStyle(color: palette.cableConsole, width: 1.4, dash: [], cap: .round)
        case .fiber:
            return CableStyle(color: palette.cableFiber, width: 2.4, dash: [10, 3, 2, 3], cap: .butt)
        @unknown default:
            return CableStyle(color: palette.cableCopper, width: 2.0, dash: [], cap: .round)
        }
    }

    /// Gap between the two rails of a bundled (LAG) cable, center to center.
    static let bundleRailSpacing: CGFloat = 4.0
    /// Width factor applied to each rail of a bundled cable.
    static let bundleRailWidthFactor: CGFloat = 0.72

    /// Applies color, width, dash and cap to a context.
    func apply(to ctx: CGContext, widthFactor: CGFloat = 1) {
        ctx.setStrokeColor(color.cgColor)
        ctx.setLineWidth(width * widthFactor)
        ctx.setLineCap(cap)
        ctx.setLineJoin(.round)
        ctx.setLineDash(phase: 0, lengths: dash)
    }
}

extension LinkStatus {
    /// Color of the status dot; `nil` for `.none`.
    func color(in palette: Palette) -> RGBA? {
        switch self {
        case .none: return nil
        case .green: return palette.statusGreen
        case .orange: return palette.statusOrange
        case .red: return palette.statusRed
        @unknown default: return nil
        }
    }
}
