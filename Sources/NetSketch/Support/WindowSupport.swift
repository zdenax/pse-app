import AppKit
import SwiftUI

/// Reports the `NSWindow` that hosts a SwiftUI view.
struct WindowAccessor: NSViewRepresentable {
    let onWindow: (NSWindow) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = TrackingView()
        view.onWindow = onWindow
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        guard let view = nsView as? TrackingView else { return }
        view.onWindow = onWindow
        if let window = view.window { onWindow(window) }
    }

    private final class TrackingView: NSView {
        var onWindow: ((NSWindow) -> Void)?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window { onWindow?(window) }
        }
    }
}

/// A window delegate that sits in front of the delegate SwiftUI installed and only adds a
/// "may this window close?" question. Everything else is forwarded untouched.
///
/// The `NSWindowDelegate` conformance lives in an extension on purpose: declared on the class
/// it would make the whole class main-actor isolated, and the `NSObject` overrides below
/// (which are nonisolated) could then not read `original`.
final class WindowCloseGuard: NSObject {
    private weak var original: NSWindowDelegate?
    private let mayClose: () -> Bool

    init(original: NSWindowDelegate?, mayClose: @escaping () -> Bool) {
        self.original = original
        self.mayClose = mayClose
    }

    override func responds(to aSelector: Selector!) -> Bool {
        if super.responds(to: aSelector) { return true }
        return original?.responds(to: aSelector) ?? false
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        if let original, original.responds(to: aSelector) { return original }
        return super.forwardingTarget(for: aSelector)
    }
}

extension WindowCloseGuard: NSWindowDelegate {
    @MainActor
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard mayClose() else { return false }
        return original?.windowShouldClose?(sender) ?? true
    }
}

extension NSResponder {
    /// True for the field editor of a text field and for any other text view, i.e. whenever
    /// plain keys such as Delete belong to text editing rather than to the canvas.
    var isTextInput: Bool { self is NSText }
}
