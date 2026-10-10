import SwiftUI
import AppKit
import NetSketchCore

/// The topology canvas: devices with their front panels, cables, bundles and notes.
///
/// Gestures: click selects (Shift / Cmd toggles), dragging an object moves the selection, dragging on
/// empty canvas rubber-band selects, scrolling pans, Cmd-scroll or pinch zooms, Space-drag (or
/// Option-drag on empty canvas, or the middle button) pans. Clicking a free port starts a cable,
/// clicking a second port finishes it, Esc cancels. Double-click renames a device or edits a note.
///
/// The canvas accepts a dropped `String` of the form `"netsketch-template:<templateID>"`
/// (see `templateDragPrefix`) and places that device at the drop location.
public struct CanvasView: View {
    private let store: ProjectStore
    private let externalViewport: CanvasViewport?
    @State private var ownViewport = CanvasViewport()
    @State private var feedback = CanvasFeedback()
    @State private var bridge = CanvasBridge()

    /// A canvas that manages its own zoom and pan.
    public init(store: ProjectStore) {
        self.store = store
        self.externalViewport = nil
    }

    /// A canvas whose zoom and pan are driven (and observable) from outside, e.g. by toolbar buttons.
    public init(store: ProjectStore, viewport: CanvasViewport) {
        self.store = store
        self.externalViewport = viewport
    }

    public var body: some View {
        let viewport = externalViewport ?? ownViewport
        CanvasRepresentable(store: store, viewport: viewport, feedback: feedback, bridge: bridge)
            // Fallback for drags AppKit does not hand to the canvas view directly.
            .dropDestination(for: String.self) { items, location in
                guard let payload = items.first(where: { $0.hasPrefix(templateDragPrefix) }) else { return false }
                return bridge.view?.handleDrop(payload: payload, atView: location) ?? false
            }
            .overlay(alignment: .top) {
                CanvasBanners(store: store, feedback: feedback)
            }
            .background(Theme.canvasBackground)
            .clipped()
    }
}

/// Lets SwiftUI-side handlers reach the AppKit view.
final class CanvasBridge {
    weak var view: CanvasNSView?
}

private struct CanvasRepresentable: NSViewRepresentable {
    let store: ProjectStore
    let viewport: CanvasViewport
    let feedback: CanvasFeedback
    let bridge: CanvasBridge

    func makeNSView(context: Context) -> CanvasNSView {
        let view = CanvasNSView(store: store, viewport: viewport, feedback: feedback)
        bridge.view = view
        return view
    }

    func updateNSView(_ nsView: CanvasNSView, context: Context) {
        nsView.update(store: store, viewport: viewport)
        bridge.view = nsView
    }
}

/// Transient notices at the top of the canvas: the last refused action and the cabling hint.
private struct CanvasBanners: View {
    let store: ProjectStore
    let feedback: CanvasFeedback
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = Palette.resolve(dark: colorScheme == .dark)
        VStack(spacing: 6) {
            if let message = feedback.message {
                banner(message, symbol: "exclamationmark.circle.fill", tint: palette.reject.color, palette: palette)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            if store.pendingPort != nil {
                banner(CanvasStrings.pendingHint, symbol: "cable.connector", tint: palette.hover.color, palette: palette)
                    .transition(.opacity)
            }
        }
        .padding(.top, 10)
        .animation(.easeOut(duration: 0.18), value: feedback.message)
        .animation(.easeOut(duration: 0.18), value: store.pendingPort)
        .allowsHitTesting(false)
    }

    private func banner(_ text: String, symbol: String, tint: Color, palette: Palette) -> some View {
        HStack(spacing: 7) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
            Text(text)
                .foregroundStyle(palette.ink.color)
                .lineLimit(2)
        }
        .font(.system(size: 12, weight: .medium))
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(
            Capsule(style: .continuous)
                .fill(palette.panelFill.color)
                .shadow(color: .black.opacity(palette.isDark ? 0.45 : 0.14), radius: 6, y: 2)
        )
        .overlay(
            Capsule(style: .continuous)
                .strokeBorder(palette.panelStroke.color.opacity(0.8), lineWidth: 0.8)
        )
        .padding(.horizontal, 16)
    }
}
