import Foundation
import CoreGraphics
import Observation

/// Zoom and pan state of a canvas. Owned by the canvas itself, or supplied by the app shell
/// when it wants to drive zooming from toolbar buttons and menu commands.
///
/// Mapping: `viewPoint = canvasPoint * zoom + offset` (view space has its origin top-left, y down).
@Observable
public final class CanvasViewport {
    public static let minZoom: CGFloat = 0.2
    public static let maxZoom: CGFloat = 4.0

    /// Zoom factor, 1 = 100 %. Values outside `minZoom...maxZoom` are clamped when used.
    public var zoom: CGFloat = 1
    /// Translation of the canvas origin in view points.
    public var offset: CGSize = .zero

    /// Size of the attached canvas view; kept up to date by `CanvasView`.
    @ObservationIgnored public internal(set) var viewSize: CGSize = .zero
    /// Returns the bounding box of the current content (canvas coordinates); installed by `CanvasView`.
    @ObservationIgnored var contentBoundsProvider: (() -> CGRect?)?

    public init() {}

    /// Zoom clamped to the supported range.
    public var clampedZoom: CGFloat {
        let value = zoom.isFinite ? zoom : 1
        return min(max(value, Self.minZoom), Self.maxZoom)
    }

    /// Zoom as a whole percentage, handy for a toolbar label.
    public var zoomPercent: Int { Int((clampedZoom * 100).rounded()) }

    // MARK: Commands

    public func zoomIn() { zoom(by: 1.25) }

    public func zoomOut() { zoom(by: 1 / 1.25) }

    /// Back to 100 %. If the canvas knows its content, the content is brought back into view.
    public func reset() {
        zoom = 1
        guard viewSize.width > 0, viewSize.height > 0,
              let bounds = contentBoundsProvider?(), !bounds.isEmpty else {
            offset = .zero
            return
        }
        // Center content that fits; otherwise pin its top-left corner with a small margin.
        let margin: CGFloat = 32
        let x = bounds.width + 2 * margin <= viewSize.width
            ? (viewSize.width - bounds.width) / 2 - bounds.minX
            : margin - bounds.minX
        let y = bounds.height + 2 * margin <= viewSize.height
            ? (viewSize.height - bounds.height) / 2 - bounds.minY
            : margin - bounds.minY
        offset = CGSize(width: x.rounded(), height: y.rounded())
    }

    /// Scales and centers the view so that the whole diagram is visible.
    public func fit() {
        guard let bounds = contentBoundsProvider?() else {
            reset()
            return
        }
        fit(to: bounds)
    }

    /// Scales and centers the view so that `bounds` (canvas coordinates) is visible.
    public func fit(to bounds: CGRect, margin: CGFloat = 48) {
        guard viewSize.width > 0, viewSize.height > 0, bounds.width > 0, bounds.height > 0 else {
            zoom = 1
            offset = .zero
            return
        }
        let availableWidth = max(viewSize.width - 2 * margin, 40)
        let availableHeight = max(viewSize.height - 2 * margin, 40)
        let scale = min(availableWidth / bounds.width, availableHeight / bounds.height)
        // Never blow a tiny diagram up beyond 100 % when fitting.
        let newZoom = min(max(min(scale, 1.0), Self.minZoom), Self.maxZoom)
        zoom = newZoom
        offset = CGSize(
            width: ((viewSize.width - bounds.width * newZoom) / 2 - bounds.minX * newZoom).rounded(),
            height: ((viewSize.height - bounds.height * newZoom) / 2 - bounds.minY * newZoom).rounded()
        )
    }

    /// Multiplies the zoom by `factor`, keeping `anchor` (view coordinates) fixed on screen.
    /// Without an anchor the center of the view stays put.
    public func zoom(by factor: CGFloat, anchor: CGPoint? = nil) {
        setZoom(clampedZoom * factor, anchor: anchor)
    }

    /// Sets an absolute zoom, keeping `anchor` (view coordinates) fixed on screen.
    public func setZoom(_ newValue: CGFloat, anchor: CGPoint? = nil) {
        let old = clampedZoom
        let new = min(max(newValue.isFinite ? newValue : 1, Self.minZoom), Self.maxZoom)
        let pivot = anchor ?? CGPoint(x: viewSize.width / 2, y: viewSize.height / 2)
        // Keep the canvas point under the pivot where it is.
        let canvasX = (pivot.x - offset.width) / old
        let canvasY = (pivot.y - offset.height) / old
        zoom = new
        offset = CGSize(width: pivot.x - canvasX * new, height: pivot.y - canvasY * new)
    }

    /// Pans by a delta given in view points.
    public func pan(by delta: CGSize) {
        offset = CGSize(width: offset.width + delta.width, height: offset.height + delta.height)
    }

    // MARK: Coordinate conversion

    public func canvasPoint(fromView point: CGPoint) -> CGPoint {
        let z = clampedZoom
        return CGPoint(x: (point.x - offset.width) / z, y: (point.y - offset.height) / z)
    }

    public func viewPoint(fromCanvas point: CGPoint) -> CGPoint {
        let z = clampedZoom
        return CGPoint(x: point.x * z + offset.width, y: point.y * z + offset.height)
    }

    public func canvasRect(fromView rect: CGRect) -> CGRect {
        let z = clampedZoom
        return CGRect(x: (rect.minX - offset.width) / z, y: (rect.minY - offset.height) / z,
                      width: rect.width / z, height: rect.height / z)
    }

    public func viewRect(fromCanvas rect: CGRect) -> CGRect {
        let z = clampedZoom
        return CGRect(x: rect.minX * z + offset.width, y: rect.minY * z + offset.height,
                      width: rect.width * z, height: rect.height * z)
    }
}
