import AppKit
import CoreGraphics
import NetSketchCore

/// Renders the WHOLE diagram (bounding box of all content plus a margin, not just the visible part
/// of the canvas) on a light background, without selection or hover decorations.
///
/// Both formats are produced by the same CoreGraphics renderer the live canvas uses; the PDF is
/// fully vector (shapes as paths, texts as text).
public enum CanvasExporter {
    /// Free space around the content, in points.
    public static let margin: CGFloat = 36
    /// Page used for a project without any content.
    static let emptyPageSize = CGSize(width: 480, height: 300)
    /// Upper bound for either side of an exported bitmap, in pixels.
    static let maxPixelSide: CGFloat = 16_000

    /// PNG of the whole diagram. `scale` is the number of pixels per canvas point (2 = "Retina").
    /// Returns nil only if the bitmap cannot be created.
    @MainActor
    public static func pngData(store: ProjectStore, scale: CGFloat) -> Data? {
        pngData(project: store.project, mode: store.viewMode, scale: scale)
    }

    /// Single-page vector PDF of the whole diagram; the page is exactly as large as the diagram.
    @MainActor
    public static func pdfData(store: ProjectStore) -> Data? {
        pdfData(project: store.project, mode: store.viewMode)
    }

    /// Size of the exported page in points (content plus margin).
    @MainActor
    public static func pageSize(store: ProjectStore) -> CGSize {
        ExportPage(project: store.project, mode: store.viewMode).bounds.size
    }

    // MARK: Implementation

    /// The laid out diagram and the canvas rectangle that ends up on the page.
    struct ExportPage {
        let scene: DiagramScene
        let bounds: CGRect
        let isEmpty: Bool

        init(project: Project, mode: ViewMode) {
            scene = DiagramScene(project: project, mode: mode)
            if let content = scene.contentBounds, content.width.isFinite, content.height.isFinite {
                bounds = content.insetBy(dx: -CanvasExporter.margin, dy: -CanvasExporter.margin).integral
                isEmpty = false
            } else {
                bounds = CGRect(origin: .zero, size: CanvasExporter.emptyPageSize)
                isEmpty = true
            }
        }

        /// Draws the page into a y-down context whose origin is the page's top-left corner.
        func draw(in ctx: CGContext, palette: Palette = .light) {
            ctx.saveGState()
            ctx.setFillColor(palette.canvas.cgColor)
            ctx.fill(CGRect(origin: .zero, size: bounds.size))
            if isEmpty {
                TextRenderer.shared.draw("Prázdný projekt", style: .placeholder, color: palette.secondaryInk.cgColor,
                                         at: CGPoint(x: bounds.width / 2, y: bounds.height / 2),
                                         h: .center, v: .center, in: ctx)
            } else {
                ctx.translateBy(x: -bounds.minX, y: -bounds.minY)
                var options = RenderOptions(palette: palette)
                options.isExport = true
                DiagramRenderer.draw(scene, options: options, in: ctx)
            }
            ctx.restoreGState()
        }
    }

    static func pngData(project: Project, mode: ViewMode, scale: CGFloat) -> Data? {
        let page = ExportPage(project: project, mode: mode)
        return pngData(size: page.bounds.size, scale: scale) { ctx in page.draw(in: ctx) }
    }

    /// Creates a bitmap of `size` points at `scale` and hands `draw` a y-down context in points.
    static func pngData(size: CGSize, scale requestedScale: CGFloat, draw: (CGContext) -> Void) -> Data? {
        guard size.width > 0, size.height > 0 else { return nil }
        var scale = requestedScale.isFinite ? min(max(requestedScale, 0.25), 8) : 1
        let longest = max(size.width, size.height)
        if longest * scale > maxPixelSide { scale = maxPixelSide / longest }
        let pixelWidth = max(Int((size.width * scale).rounded(.up)), 1)
        let pixelHeight = max(Int((size.height * scale).rounded(.up)), 1)
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil, width: pixelWidth, height: pixelHeight, bitsPerComponent: 8,
                                  bytesPerRow: 0, space: colorSpace,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        ctx.interpolationQuality = .high
        ctx.setShouldAntialias(true)
        ctx.setAllowsFontSmoothing(false)
        // Flip to y-down and work in points.
        ctx.translateBy(x: 0, y: CGFloat(pixelHeight))
        ctx.scaleBy(x: scale, y: -scale)
        draw(ctx)
        guard let image = ctx.makeImage() else { return nil }
        let representation = NSBitmapImageRep(cgImage: image)
        // Record the point size so viewers show the image at its natural size.
        representation.size = size
        return representation.representation(using: .png, properties: [:])
    }

    static func pdfData(project: Project, mode: ViewMode) -> Data? {
        let page = ExportPage(project: project, mode: mode)
        let data = NSMutableData()
        var mediaBox = CGRect(origin: .zero, size: page.bounds.size)
        var info: [CFString: Any] = [kCGPDFContextCreator: "NetSketch"]
        if !project.name.isEmpty { info[kCGPDFContextTitle] = project.name }
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
              let ctx = CGContext(consumer: consumer, mediaBox: &mediaBox, info as CFDictionary)
        else { return nil }
        ctx.beginPDFPage(nil)
        ctx.translateBy(x: 0, y: page.bounds.height)
        ctx.scaleBy(x: 1, y: -1)
        page.draw(in: ctx)
        ctx.endPDFPage()
        ctx.closePDF()
        return data as Data
    }
}
