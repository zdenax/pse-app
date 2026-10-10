import SwiftUI
import AppKit

/// A plain sRGB color value that can be handed to SwiftUI, AppKit and CoreGraphics alike.
struct RGBA: Hashable {
    var r: CGFloat
    var g: CGFloat
    var b: CGFloat
    var a: CGFloat

    init(_ hex: UInt32, alpha: CGFloat = 1) {
        r = CGFloat((hex >> 16) & 0xFF) / 255
        g = CGFloat((hex >> 8) & 0xFF) / 255
        b = CGFloat(hex & 0xFF) / 255
        a = alpha
    }

    init(r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat = 1) {
        self.r = r
        self.g = g
        self.b = b
        self.a = a
    }

    func opacity(_ alpha: CGFloat) -> RGBA {
        RGBA(r: r, g: g, b: b, a: a * alpha)
    }

    /// Linear blend towards `other` (0 = self, 1 = other). Alpha is blended as well.
    func mixed(with other: RGBA, _ t: CGFloat) -> RGBA {
        RGBA(r: r + (other.r - r) * t,
             g: g + (other.g - g) * t,
             b: b + (other.b - b) * t,
             a: a + (other.a - a) * t)
    }

    var cgColor: CGColor { CGColor(srgbRed: r, green: g, blue: b, alpha: a) }
    var nsColor: NSColor { NSColor(srgbRed: r, green: g, blue: b, alpha: a) }
    var color: Color { Color(.sRGB, red: Double(r), green: Double(g), blue: Double(b), opacity: Double(a)) }
}

/// Fully resolved colors for one appearance. The renderer only ever talks to a `Palette`,
/// so the same drawing code serves the light canvas, the dark canvas and the (always light) export.
struct Palette {
    var isDark: Bool

    var canvas: RGBA
    var gridDot: RGBA
    var ink: RGBA
    var secondaryInk: RGBA

    var panelFill: RGBA
    var panelStroke: RGBA
    var panelShadow: RGBA
    var portLabel: RGBA

    var portRJ45: RGBA
    var portOptic: RGBA
    var portConsole: RGBA
    var portMgmt: RGBA
    var portWireless: RGBA

    var cableCopper: RGBA
    var cableConsole: RGBA
    var cableFiber: RGBA
    var labelPlate: RGBA
    var bundlePlate: RGBA
    var bundleInk: RGBA

    var selection: RGBA
    var pending: RGBA
    var hover: RGBA
    var reject: RGBA
    var warning: RGBA

    var statusGreen: RGBA
    var statusOrange: RGBA
    var statusRed: RGBA
    var statusNone: RGBA

    var annotationFill: RGBA
    var annotationStroke: RGBA

    var tooltipFill: RGBA
    var tooltipInk: RGBA

    var iconGlyph: RGBA
    var tileSwitch: RGBA
    var tileL3Switch: RGBA
    var tileRouter: RGBA
    var tileAccessPoint: RGBA
    var tilePC: RGBA
    var tileServer: RGBA
    var tileStroke: RGBA

    static let navyHex: UInt32 = 0x0B2545
    static let tealHex: UInt32 = 0x13A89E
    static let sandHex: UInt32 = 0xF4F1EA
    static let slateHex: UInt32 = 0x5C6B7A
    static let accentHex: UInt32 = 0xEE6C4D

    static let light = Palette(
        isDark: false,
        canvas: RGBA(sandHex),
        gridDot: RGBA(slateHex, alpha: 0.30),
        ink: RGBA(navyHex),
        secondaryInk: RGBA(slateHex),
        panelFill: RGBA(0xFFFFFF),
        panelStroke: RGBA(0xB9B2A3),
        panelShadow: RGBA(navyHex, alpha: 0.10),
        portLabel: RGBA(0x4A5866),
        portRJ45: RGBA(navyHex),
        portOptic: RGBA(0x0E8F86),
        portConsole: RGBA(0x2F8FC9),
        portMgmt: RGBA(0x8A6FB8),
        portWireless: RGBA(accentHex),
        cableCopper: RGBA(navyHex),
        cableConsole: RGBA(0x4FA8D8),
        cableFiber: RGBA(accentHex),
        labelPlate: RGBA(sandHex, alpha: 0.92),
        bundlePlate: RGBA(navyHex),
        bundleInk: RGBA(0xFFFFFF),
        selection: RGBA(accentHex),
        pending: RGBA(accentHex),
        hover: RGBA(tealHex),
        reject: RGBA(0xD64545),
        warning: RGBA(0xC98A00),
        statusGreen: RGBA(0x2EAD5B),
        statusOrange: RGBA(0xF29D38),
        statusRed: RGBA(0xD64545),
        statusNone: RGBA(slateHex, alpha: 0.55),
        annotationFill: RGBA(0xFFF6D6),
        annotationStroke: RGBA(0xD9C98F),
        tooltipFill: RGBA(navyHex, alpha: 0.95),
        tooltipInk: RGBA(0xFFFFFF),
        iconGlyph: RGBA(0xFFFFFF),
        tileSwitch: RGBA(tealHex),
        tileL3Switch: RGBA(0x0E7C8C),
        tileRouter: RGBA(navyHex),
        tileAccessPoint: RGBA(accentHex),
        tilePC: RGBA(slateHex),
        tileServer: RGBA(0x3D4C5C),
        tileStroke: RGBA(navyHex, alpha: 0.18)
    )

    static let dark = Palette(
        isDark: true,
        canvas: RGBA(0x081B33),
        gridDot: RGBA(0xFFFFFF, alpha: 0.13),
        ink: RGBA(sandHex),
        secondaryInk: RGBA(0x9FB0C3),
        panelFill: RGBA(0x122C4F),
        panelStroke: RGBA(0x355680),
        panelShadow: RGBA(0x000000, alpha: 0.30),
        portLabel: RGBA(0xB4C2D2),
        portRJ45: RGBA(0xE8E3D8),
        portOptic: RGBA(0x2FD0C4),
        portConsole: RGBA(0x6BC1F0),
        portMgmt: RGBA(0xB59CE0),
        portWireless: RGBA(0xF58A6E),
        cableCopper: RGBA(0xE8E3D8),
        cableConsole: RGBA(0x6BC1F0),
        cableFiber: RGBA(0xF58A6E),
        labelPlate: RGBA(0x081B33, alpha: 0.90),
        bundlePlate: RGBA(sandHex),
        bundleInk: RGBA(navyHex),
        selection: RGBA(0xF58A6E),
        pending: RGBA(0xF58A6E),
        hover: RGBA(0x2FD0C4),
        reject: RGBA(0xEF6B6B),
        warning: RGBA(0xF2B33D),
        statusGreen: RGBA(0x3DCB73),
        statusOrange: RGBA(0xF6AE4A),
        statusRed: RGBA(0xEF6B6B),
        statusNone: RGBA(0x9FB0C3, alpha: 0.55),
        annotationFill: RGBA(0x3A3520),
        annotationStroke: RGBA(0x6B6238),
        tooltipFill: RGBA(sandHex, alpha: 0.96),
        tooltipInk: RGBA(navyHex),
        iconGlyph: RGBA(0xFFFFFF),
        tileSwitch: RGBA(0x15A99F),
        tileL3Switch: RGBA(0x1489A0),
        tileRouter: RGBA(0x2A5C99),
        tileAccessPoint: RGBA(0xE8694A),
        tilePC: RGBA(0x6F8196),
        tileServer: RGBA(0x4F6379),
        tileStroke: RGBA(0xFFFFFF, alpha: 0.16)
    )

    static func resolve(dark: Bool) -> Palette { dark ? .dark : .light }
}

/// The NetSketch color palette. Brand colors are fixed, role colors adapt to light and dark mode.
public enum Theme {
    // MARK: Brand colors (fixed)

    /// Navy `#0B2545`.
    public static let navy = RGBA(Palette.navyHex).color
    /// Teal `#13A89E`.
    public static let teal = RGBA(Palette.tealHex).color
    /// Sand `#F4F1EA`.
    public static let sand = RGBA(Palette.sandHex).color
    /// Slate `#5C6B7A`.
    public static let slate = RGBA(Palette.slateHex).color
    /// Accent `#EE6C4D`.
    public static let accent = RGBA(Palette.accentHex).color

    // MARK: Adaptive role colors

    /// Canvas background: sand in light mode, deep navy in dark mode.
    public static let canvasBackground = adaptive(\.canvas)
    /// Primary text and line color on the canvas.
    public static let ink = adaptive(\.ink)
    /// Secondary text (device type, hints).
    public static let secondaryInk = adaptive(\.secondaryInk)
    /// Fill of device front panels and other raised surfaces.
    public static let panelFill = adaptive(\.panelFill)
    /// Outline of device front panels.
    public static let panelStroke = adaptive(\.panelStroke)
    /// Selection highlight.
    public static let selection = adaptive(\.selection)
    /// Hover highlight.
    public static let hover = adaptive(\.hover)
    /// Warning glyph tint ("verify against the hardware").
    public static let warning = adaptive(\.warning)
    /// Grid dots.
    public static let grid = adaptive(\.gridDot)

    /// Link status colors.
    public static let statusGreen = adaptive(\.statusGreen)
    public static let statusOrange = adaptive(\.statusOrange)
    public static let statusRed = adaptive(\.statusRed)

    /// Builds a color that follows the current appearance.
    public static func adaptive(light: Color, dark: Color) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.isDarkAppearance ? NSColor(dark) : NSColor(light)
        })
    }

    static func adaptive(_ keyPath: KeyPath<Palette, RGBA>) -> Color {
        let light = Palette.light[keyPath: keyPath].nsColor
        let dark = Palette.dark[keyPath: keyPath].nsColor
        return Color(nsColor: NSColor(name: nil) { appearance in
            appearance.isDarkAppearance ? dark : light
        })
    }
}

extension NSAppearance {
    var isDarkAppearance: Bool {
        bestMatch(from: [.darkAqua, .aqua, .vibrantDark, .vibrantLight,
                         .accessibilityHighContrastDarkAqua, .accessibilityHighContrastAqua,
                         .accessibilityHighContrastVibrantDark, .accessibilityHighContrastVibrantLight])
            .map { name in
                name == .darkAqua || name == .vibrantDark
                    || name == .accessibilityHighContrastDarkAqua
                    || name == .accessibilityHighContrastVibrantDark
            } ?? false
    }
}
