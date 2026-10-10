import AppKit
import CoreText

/// Font description used by the canvas renderer. Kept tiny and hashable so that laid out
/// lines can be cached.
struct TextStyle: Hashable {
    enum Weight: Hashable {
        case regular, medium, semibold, bold

        var nsWeight: NSFont.Weight {
            switch self {
            case .regular: return .regular
            case .medium: return .medium
            case .semibold: return .semibold
            case .bold: return .bold
            }
        }
    }

    var size: CGFloat
    var weight: Weight = .regular
    /// Tabular digits keep port numbers aligned and evenly sized.
    var monospacedDigits = false

    static let hostname = TextStyle(size: 13, weight: .semibold)
    static let deviceType = TextStyle(size: 10.5, weight: .regular)
    static let portLabel = TextStyle(size: 8, weight: .medium, monospacedDigits: true)
    static let cableEnd = TextStyle(size: 9, weight: .medium, monospacedDigits: true)
    static let bundle = TextStyle(size: 10, weight: .semibold)
    static let annotation = TextStyle(size: 12.5, weight: .regular)
    static let tooltip = TextStyle(size: 11, weight: .medium)
    static let placeholder = TextStyle(size: 13, weight: .medium)

    var font: NSFont {
        if monospacedDigits {
            return NSFont.monospacedDigitSystemFont(ofSize: size, weight: weight.nsWeight)
        }
        return NSFont.systemFont(ofSize: size, weight: weight.nsWeight)
    }
}

enum HAlign { case leading, center, trailing }
enum VAlign { case top, center, bottom, baseline }

/// CoreText based text measuring and drawing for y-down ("flipped") CoreGraphics contexts.
/// Works identically on screen, in bitmap contexts and in PDF contexts (where text stays vector).
final class TextRenderer {
    static let shared = TextRenderer()

    private struct Key: Hashable {
        var text: String
        var style: TextStyle
    }

    struct Metrics {
        var width: CGFloat
        var ascent: CGFloat
        var descent: CGFloat
        var height: CGFloat { ascent + descent }
        var size: CGSize { CGSize(width: width, height: height) }
    }

    private struct Entry {
        var line: CTLine
        var metrics: Metrics
    }

    private var cache: [Key: Entry] = [:]
    private var fonts: [TextStyle: NSFont] = [:]
    private let cacheLimit = 6000

    private func font(for style: TextStyle) -> NSFont {
        if let cached = fonts[style] { return cached }
        let font = style.font
        fonts[style] = font
        return font
    }

    private func entry(_ text: String, _ style: TextStyle) -> Entry {
        let key = Key(text: text, style: style)
        if let cached = cache[key] { return cached }
        if cache.count >= cacheLimit { cache.removeAll(keepingCapacity: true) }
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font(for: style),
            // Take the fill color from the context so the cached line is color independent.
            NSAttributedString.Key(kCTForegroundColorFromContextAttributeName as String): true,
        ]
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
        var ascent: CGFloat = 0
        var descent: CGFloat = 0
        var leading: CGFloat = 0
        let width = CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, &leading))
        let entry = Entry(line: line, metrics: Metrics(width: width, ascent: ascent, descent: descent))
        cache[key] = entry
        return entry
    }

    func metrics(_ text: String, style: TextStyle) -> Metrics {
        entry(text, style).metrics
    }

    func size(_ text: String, style: TextStyle) -> CGSize {
        entry(text, style).metrics.size
    }

    /// Line height used for multi-line blocks.
    func lineHeight(style: TextStyle) -> CGFloat {
        let font = font(for: style)
        return ceil(font.ascender - font.descender + font.leading) + 1
    }

    /// Draws a single line. `point` is interpreted according to the alignments
    /// (e.g. `.center`/`.center` puts the middle of the text box on the point).
    func draw(_ text: String, style: TextStyle, color: CGColor, at point: CGPoint,
              h: HAlign = .leading, v: VAlign = .top, in ctx: CGContext) {
        guard !text.isEmpty else { return }
        let entry = entry(text, style)
        let m = entry.metrics
        var x = point.x
        switch h {
        case .leading: break
        case .center: x -= m.width / 2
        case .trailing: x -= m.width
        }
        let baseline: CGFloat
        switch v {
        case .top: baseline = point.y + m.ascent
        case .center: baseline = point.y + (m.ascent - m.descent) / 2
        case .bottom: baseline = point.y - m.descent
        case .baseline: baseline = point.y
        }
        ctx.saveGState()
        ctx.setFillColor(color)
        // The context is y-down, CoreText draws y-up: flip glyphs locally.
        ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
        ctx.textPosition = CGPoint(x: x, y: baseline)
        CTLineDraw(entry.line, ctx)
        ctx.restoreGState()
    }

    /// Splits text into display lines (hard line breaks only).
    func lines(of text: String) -> [String] {
        text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }

    /// Size of a multi-line block.
    func blockSize(_ text: String, style: TextStyle) -> CGSize {
        let parts = lines(of: text)
        let width = parts.map { metrics($0, style: style).width }.max() ?? 0
        return CGSize(width: ceil(width), height: lineHeight(style: style) * CGFloat(max(parts.count, 1)))
    }

    /// Draws a multi-line block with its top-left corner at `origin`.
    func drawBlock(_ text: String, style: TextStyle, color: CGColor, origin: CGPoint, in ctx: CGContext) {
        let lineHeight = lineHeight(style: style)
        for (index, part) in lines(of: text).enumerated() {
            let top = origin.y + CGFloat(index) * lineHeight
            draw(part, style: style, color: color, at: CGPoint(x: origin.x, y: top + lineHeight / 2),
                 h: .leading, v: .center, in: ctx)
        }
    }

    /// Shortens `text` with an ellipsis so that it fits `maxWidth`.
    func truncated(_ text: String, style: TextStyle, maxWidth: CGFloat) -> String {
        if metrics(text, style: style).width <= maxWidth { return text }
        var characters = Array(text)
        while characters.count > 1 {
            characters.removeLast()
            let candidate = String(characters) + "\u{2026}"
            if metrics(candidate, style: style).width <= maxWidth { return candidate }
        }
        return "\u{2026}"
    }
}
