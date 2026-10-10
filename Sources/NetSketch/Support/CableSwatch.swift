import AppKit
import SwiftUI
import NetSketchCore
import NetSketchCanvas

/// Small line samples for the cable-type picker.
///
/// They are images (not SwiftUI shapes) because menu items can only show images. The image
/// draws itself on demand, so it follows the light/dark appearance of wherever it is shown.
enum CableSwatch {
    static let size = NSSize(width: 30, height: 12)

    static func image(for type: CableType) -> NSImage {
        let image = NSImage(size: size, flipped: false) { rect in
            let look = CableLook(type)
            let path = NSBezierPath()
            path.move(to: NSPoint(x: rect.minX + 2, y: rect.midY))
            path.line(to: NSPoint(x: rect.maxX - 2, y: rect.midY))
            path.lineWidth = look.width
            path.lineCapStyle = look.dash.isEmpty ? .round : .butt
            if !look.dash.isEmpty {
                path.setLineDash(look.dash, count: look.dash.count, phase: 0)
            }
            look.color.setStroke()
            path.stroke()
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = type.czechDescription
        return image
    }
}

/// Color, width and dash of a cable type in the toolbar sample.
///
/// This mirrors the canvas' own mapping (`CableStyle` in NetSketchCanvas, which is internal to
/// that module): straight = solid ink, crossover = dashed ink, console = thin light blue,
/// fiber = accent dash-dot. Keep the two in step when the canvas mapping changes.
private struct CableLook {
    var color: NSColor
    var width: CGFloat
    var dash: [CGFloat]

    init(_ type: CableType) {
        switch type {
        case .straight:
            color = NSColor(Theme.ink)
            width = 2.0
            dash = []
        case .crossover:
            color = NSColor(Theme.ink)
            width = 2.0
            dash = [5, 3]
        case .console:
            color = NSColor(name: nil) { appearance in
                let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                return isDark
                    ? NSColor(srgbRed: 0x6B / 255, green: 0xC1 / 255, blue: 0xF0 / 255, alpha: 1)
                    : NSColor(srgbRed: 0x4F / 255, green: 0xA8 / 255, blue: 0xD8 / 255, alpha: 1)
            }
            width = 1.4
            dash = []
        case .fiber:
            color = NSColor(Theme.accent)
            width = 2.4
            dash = [7, 2.5, 2, 2.5]
        }
    }
}
