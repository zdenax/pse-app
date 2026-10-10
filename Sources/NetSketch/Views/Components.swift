import SwiftUI
import NetSketchCore
import NetSketchCanvas

/// A text field that edits a local draft and reports the value once, when editing ends
/// (Return, focus loss, or the field going away). One edit is therefore one undo step in the
/// store, and values changed elsewhere (CLI, undo) show up immediately.
struct CommitTextField: View {
    let placeholder: String
    let value: String
    var axis: Axis = .horizontal
    /// Returns false when the value was refused; the field then falls back to `value`.
    let onCommit: (String) -> Bool

    @State private var draft: String
    @FocusState private var isFocused: Bool

    init(_ placeholder: String, value: String, axis: Axis = .horizontal, onCommit: @escaping (String) -> Bool) {
        self.placeholder = placeholder
        self.value = value
        self.axis = axis
        self.onCommit = onCommit
        _draft = State(initialValue: value)
    }

    var body: some View {
        TextField(placeholder, text: $draft, axis: axis)
            .focused($isFocused)
            .onSubmit { commit() }
            .onChange(of: isFocused) { _, focused in
                if !focused { commit() }
            }
            .onChange(of: value) { _, newValue in
                draft = newValue
            }
            .onDisappear { commit() }
    }

    private func commit() {
        guard draft != value else { return }
        if !onCommit(draft) { draft = value }
    }
}

/// The "check against the hardware" marker for unverified catalog data.
struct VerifyBadge: View {
    var help: String = CzechText.verifyHint

    var body: some View {
        Image(systemName: "exclamationmark.triangle")
            .foregroundStyle(Theme.warning)
            .help(help)
            .accessibilityLabel(help)
    }
}

/// A titled block of the inspector.
struct InspectorSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A caption on the left, a value on the right.
struct InspectorRow<Content: View>: View {
    let label: String
    @ViewBuilder var content: Content

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .foregroundStyle(.secondary)
                .frame(width: 74, alignment: .leading)
            content
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.callout)
    }
}

extension LinkStatus {
    /// Dot color matching the canvas; nil for "no status".
    var dotColor: Color? {
        switch self {
        case .none: return nil
        case .green: return Theme.statusGreen
        case .orange: return Theme.statusOrange
        case .red: return Theme.statusRed
        }
    }
}

/// Four dots to pick the status of one cable end.
struct StatusPicker: View {
    let status: LinkStatus
    let onChange: (LinkStatus) -> Void

    var body: some View {
        HStack(spacing: 6) {
            ForEach(LinkStatus.allCases, id: \.self) { option in
                Button {
                    onChange(option)
                } label: {
                    dot(for: option)
                }
                .buttonStyle(.plain)
                .help(option.czechName)
                .accessibilityLabel("Stav: " + option.czechName)
                .accessibilityAddTraits(option == status ? .isSelected : [])
            }
        }
    }

    private func dot(for option: LinkStatus) -> some View {
        ZStack {
            if let color = option.dotColor {
                Circle().fill(color)
            } else {
                Circle().strokeBorder(Color.secondary, style: StrokeStyle(lineWidth: 1.2, dash: [2.5, 2]))
            }
        }
        .frame(width: 13, height: 13)
        .padding(3)
        .overlay {
            Circle().strokeBorder(option == status ? Theme.selection : Color.clear, lineWidth: 2)
        }
        .contentShape(Circle())
    }
}

/// Small colored tag, e.g. "vlastní" or "shutdown".
struct Chip: View {
    let text: String
    var color: Color = Theme.slate

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .foregroundStyle(color)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(color.opacity(0.14), in: Capsule())
    }
}
