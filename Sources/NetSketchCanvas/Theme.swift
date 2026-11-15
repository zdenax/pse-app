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
    var tilePatchPanel: RGBA
    var tileStroke: RGBA

    // Brand constants (`Theme.navy` etc. below): unchanged, still used across the native app's own
    // chrome (palette, inspector, console). The canvas/export palette below has its own dedicated
    // hex values, aligned with the "kabelážní plán" redesign (web/DESIGN.md), so the diagram and its
    // exports match the new look without re-skinning the rest of the native app.
    static let navyHex: UInt32 = 0x0B2545
    static let tealHex: UInt32 = 0x13A89E
    static let sandHex: UInt32 = 0xF4F1EA
    static let slateHex: UInt32 = 0x5C6B7A
    static let accentHex: UInt32 = 0xEE6C4D

    // Canvas-only palette: "kabelážní plán" neutrals and cable-blue, matching web/DESIGN.md.
    static let canvasInkHex: UInt32 = 0x15191E
    static let canvasMutedInkHex: UInt32 = 0x4F5964
    static let canvasNeutralHex: UInt32 = 0xF2F4F6
    static let cableBlueHex: UInt32 = 0x1F5CC8
    static let cableAccentHex: UInt32 = 0xC96A35
    static let destructiveHex: UInt32 = 0xB8312A
    static let graphiteHex: UInt32 = 0x1B1F24
    static let graphiteRaisedHex: UInt32 = 0x2A3038

    static let darkBackgroundHex: UInt32 = 0x121518
    static let darkForegroundHex: UInt32 = 0xE8EBEF
    static let darkMutedForegroundHex: UInt32 = 0xA7B0BA
    static let darkRackLineHex: UInt32 = 0x3A414A
    static let darkCableBlueHex: UInt32 = 0x7AA7FF
    static let darkDestructiveHex: UInt32 = 0xFF8A7F

    static let light = Palette(
        isDark: false,
        canvas: RGBA(canvasNeutralHex),
        gridDot: RGBA(canvasMutedInkHex, alpha: 0.30),
        ink: RGBA(canvasInkHex),
        secondaryInk: RGBA(canvasMutedInkHex),
        panelFill: RGBA(0xFFFFFF),
        panelStroke: RGBA(0xBCC4CD),
        panelShadow: RGBA(canvasInkHex, alpha: 0.10),
        portLabel: RGBA(canvasMutedInkHex),
        portRJ45: RGBA(cableBlueHex),
        portOptic: RGBA(0x0E8F86),
        portConsole: RGBA(0x2F8FC9),
        portMgmt: RGBA(0x8A6FB8),
        portWireless: RGBA(cableAccentHex),
        cableCopper: RGBA(cableBlueHex),
        cableConsole: RGBA(0x2F8FC9),
        cableFiber: RGBA(cableAccentHex),
        labelPlate: RGBA(canvasNeutralHex, alpha: 0.92),
        bundlePlate: RGBA(graphiteHex),
        bundleInk: RGBA(0xFFFFFF),
        selection: RGBA(cableAccentHex),
        pending: RGBA(cableAccentHex),
        hover: RGBA(tealHex),
        reject: RGBA(destructiveHex),
        warning: RGBA(0xC98A00),
        statusGreen: RGBA(0x2EAD5B),
        statusOrange: RGBA(0xF29D38),
        statusRed: RGBA(destructiveHex),
        statusNone: RGBA(canvasMutedInkHex, alpha: 0.55),
        annotationFill: RGBA(0xFFF6D6),
        annotationStroke: RGBA(0xD9C98F),
        tooltipFill: RGBA(canvasInkHex, alpha: 0.95),
        tooltipInk: RGBA(0xFFFFFF),
        iconGlyph: RGBA(0xFFFFFF),
        tileSwitch: RGBA(tealHex),
        tileL3Switch: RGBA(0x0E7C8C),
        tileRouter: RGBA(graphiteHex),
        tileAccessPoint: RGBA(cableAccentHex),
        tilePC: RGBA(canvasMutedInkHex),
        tileServer: RGBA(graphiteRaisedHex),
        tilePatchPanel: RGBA(0x6B705C),
        tileStroke: RGBA(canvasInkHex, alpha: 0.18)
    )

    static let dark = Palette(
        isDark: true,
        canvas: RGBA(darkBackgroundHex),
        gridDot: RGBA(0xFFFFFF, alpha: 0.13),
        ink: RGBA(darkForegroundHex),
        secondaryInk: RGBA(darkMutedForegroundHex),
        panelFill: RGBA(0x1C2025),
        panelStroke: RGBA(darkRackLineHex),
        panelShadow: RGBA(0x000000, alpha: 0.30),
        portLabel: RGBA(darkMutedForegroundHex),
        portRJ45: RGBA(darkCableBlueHex),
        portOptic: RGBA(0x2FD0C4),
        portConsole: RGBA(0x6BC1F0),
        portMgmt: RGBA(0xB59CE0),
        portWireless: RGBA(0xF58A6E),
        cableCopper: RGBA(darkCableBlueHex),
        cableConsole: RGBA(0x6BC1F0),
        cableFiber: RGBA(0xF58A6E),
        labelPlate: RGBA(darkBackgroundHex, alpha: 0.90),
        bundlePlate: RGBA(darkForegroundHex),
        bundleInk: RGBA(canvasInkHex),
        selection: RGBA(0xF58A6E),
        pending: RGBA(0xF58A6E),
        hover: RGBA(0x2FD0C4),
        reject: RGBA(darkDestructiveHex),
        warning: RGBA(0xF2B33D),
        statusGreen: RGBA(0x3DCB73),
        statusOrange: RGBA(0xF6AE4A),
        statusRed: RGBA(darkDestructiveHex),
        statusNone: RGBA(darkMutedForegroundHex, alpha: 0.55),
        annotationFill: RGBA(0x3A3520),
        annotationStroke: RGBA(0x6B6238),
        tooltipFill: RGBA(darkForegroundHex, alpha: 0.96),
        tooltipInk: RGBA(canvasInkHex),
        iconGlyph: RGBA(0xFFFFFF),
        tileSwitch: RGBA(0x15A99F),
        tileL3Switch: RGBA(0x1489A0),
        tileRouter: RGBA(0x2A5C99),
        tileAccessPoint: RGBA(0xE8694A),
        tilePC: RGBA(0x6F8196),
        tileServer: RGBA(0x4F6379),
        tilePatchPanel: RGBA(0x84896F),
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
