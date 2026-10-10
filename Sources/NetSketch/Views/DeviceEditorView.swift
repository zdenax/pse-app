import SwiftUI
import NetSketchCore
import NetSketchCanvas

/// Editable form of one `PortGroup`.
struct PortGroupDraft: Identifiable, Equatable {
    enum Mode: String, CaseIterable, Identifiable {
        /// prefix + number for a range of numbers.
        case range
        /// explicitly listed names.
        case names
        /// an empty module bay carried over from a built-in template.
        case placeholder

        var id: String { rawValue }
    }

    let id = UUID()
    var mode: Mode = .range
    var prefix = "Gi0/"
    var from = 1
    var to = 8
    var namesText = ""
    var speed = "1G"
    var connector: ConnectorType = .rj45
    // Carried over untouched from an existing group; the editor has no controls for them.
    var step = 1
    var suffix = ""
    var label: String?

    init() {}

    init(_ group: PortGroup) {
        if group.isPlaceholder {
            mode = .placeholder
        } else if let names = group.names {
            mode = .names
            namesText = names.joined(separator: ", ")
        } else {
            mode = .range
        }
        prefix = group.prefix
        from = group.rangeStart
        to = group.rangeEnd
        speed = group.speed
        connector = group.connector
        step = max(1, group.step)
        suffix = group.suffix
        label = group.label
    }

    /// Names typed in the "names" mode, trimmed, empty entries dropped.
    var explicitNames: [String] {
        namesText
            .split(whereSeparator: { $0 == "," || $0 == ";" || $0.isNewline })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    func portGroup(verified: Bool) -> PortGroup {
        switch mode {
        case .placeholder:
            return .placeholder(label: label ?? "", connector: connector, verified: verified)
        case .names:
            return PortGroup(names: explicitNames, speed: speed, connector: connector, verified: verified, label: label)
        case .range:
            return PortGroup(prefix: prefix, range: min(from, to)...max(from, to), step: step, suffix: suffix,
                             speed: speed, connector: connector, verified: verified, label: label)
        }
    }

    /// Generated port names; empty when the range is invalid.
    var portNames: [String] {
        switch mode {
        case .placeholder:
            return []
        case .names:
            return explicitNames
        case .range:
            guard from <= to, to - from < DeviceEditorModel.maxPorts * max(1, step) else { return [] }
            return portGroup(verified: false).portNames
        }
    }

    /// "Fa0/1 … Fa0/24, 24 portů"
    var preview: String {
        if mode == .placeholder { return "Prázdná pozice pro modul, bez portů" }
        let names = portNames
        guard let first = names.first, let last = names.last else { return "žádné porty" }
        let list: String
        switch names.count {
        case 1: list = first
        case 2: list = first + ", " + last
        default: list = first + " … " + last
        }
        return list + ", " + CzechText.ports(names.count)
    }

    /// What is wrong with this row alone; nil when it is fine.
    var problem: String? {
        switch mode {
        case .placeholder:
            return nil
        case .names:
            return explicitNames.isEmpty ? "Zadejte alespoň jeden název portu." : nil
        case .range:
            if from < 0 || to < 0 { return "Čísla portů nesmí být záporná." }
            if from > to { return "Rozsah „od“ musí být menší nebo roven „do“." }
            if to - from >= DeviceEditorModel.maxPorts * max(1, step) {
                return "Rozsah je příliš velký (nejvýše \(DeviceEditorModel.maxPorts) portů)."
            }
            return nil
        }
    }
}

/// State and validation of the custom-device sheet.
struct DeviceEditorModel {
    /// Upper bound for the number of ports of one device; anything above is almost certainly a typo.
    static let maxPorts = 256

    static let speedPresets = ["", "10M", "100M", "1G", "2.5G", "5G", "10G", "25G", "40G", "100G"]

    var model = ""
    var vendor = ""
    var category: DeviceCategory = .switch
    var note = ""
    var verified = false
    var groups: [PortGroupDraft] = []

    /// The template being changed in place; nil when a new one is created.
    private(set) var original: DeviceTemplate?

    init(request: DeviceEditorRequest) {
        switch request {
        case .new:
            var ports = PortGroupDraft()
            ports.prefix = "Gi0/"
            ports.from = 1
            ports.to = 24
            var console = PortGroupDraft()
            console.mode = .names
            console.namesText = "Console"
            console.speed = ""
            console.connector = .console
            groups = [ports, console]
        case .edit(let template):
            load(template)
            original = template
        case .duplicate(let template):
            load(template)
            model = template.model + (template.isCustom ? " (kopie)" : " (vlastní)")
            verified = false
        }
    }

    private mutating func load(_ template: DeviceTemplate) {
        model = template.model
        vendor = template.vendor
        category = template.category
        note = template.note ?? ""
        verified = !template.needsVerification
        groups = template.portGroups.map(PortGroupDraft.init)
    }

    var isEditingExisting: Bool { original != nil }

    var totalPorts: Int { groups.reduce(0) { $0 + $1.portNames.count } }

    /// Port names that occur more than once across all groups.
    var duplicateNames: [String] {
        var seen = Set<String>()
        var duplicates: [String] = []
        for name in groups.flatMap(\.portNames) {
            if !seen.insert(name).inserted, !duplicates.contains(name) { duplicates.append(name) }
        }
        return duplicates
    }

    /// Everything that blocks saving, in the order the user should fix it.
    var problems: [String] {
        var result: [String] = []
        if model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            result.append("Vyplňte název modelu.")
        }
        for (index, group) in groups.enumerated() {
            if let problem = group.problem { result.append("Skupina \(index + 1): " + problem) }
        }
        if result.isEmpty {
            if totalPorts == 0 {
                result.append("Zařízení musí mít alespoň jeden port.")
            } else if totalPorts > Self.maxPorts {
                result.append("Zařízení má \(totalPorts) portů, nejvýše je povoleno \(Self.maxPorts).")
            }
        }
        let duplicates = duplicateNames
        if !duplicates.isEmpty {
            let shown = duplicates.prefix(4).joined(separator: ", ")
            result.append("Názvy portů se opakují: \(shown)\(duplicates.count > 4 ? " …" : "").")
        }
        return result
    }

    /// The template to store. `newID` is used when a new entry is created.
    func template(newID: String) -> DeviceTemplate {
        let portGroups = groups.map { $0.portGroup(verified: verified) }
        // Keep a hand-tuned panel layout only while the ports themselves are unchanged.
        let keepLayout = original.map { $0.portGroups.map(\.portNames) == portGroups.map(\.portNames) } ?? false
        let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        return DeviceTemplate(
            id: original?.id ?? newID,
            vendor: vendor.trimmingCharacters(in: .whitespacesAndNewlines),
            model: model.trimmingCharacters(in: .whitespacesAndNewlines),
            category: category,
            portGroups: portGroups,
            layout: keepLayout ? original?.layout : nil,
            verified: verified,
            note: trimmedNote.isEmpty ? nil : trimmedNote,
            isCustom: true
        )
    }
}

/// Sheet for creating or editing a user-defined device.
struct DeviceEditorView: View {
    let catalog: DeviceCatalog
    let request: DeviceEditorRequest

    @Environment(\.dismiss) private var dismiss
    @State private var draft: DeviceEditorModel
    @State private var saveError: String?

    init(catalog: DeviceCatalog, request: DeviceEditorRequest) {
        self.catalog = catalog
        self.request = request
        _draft = State(initialValue: DeviceEditorModel(request: request))
    }

    var body: some View {
        let problems = draft.problems
        VStack(alignment: .leading, spacing: 0) {
            Text(draft.isEditingExisting ? "Upravit vlastní zařízení" : "Nové zařízení")
                .font(.title2.weight(.semibold))
                .padding(.horizontal, 20)
                .padding(.top, 18)
                .padding(.bottom, 12)

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    identityForm
                    groupsEditor
                    panelPreview
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 16)
            }

            Divider()
            footer(problems: problems)
        }
        .frame(minWidth: 780, idealWidth: 820, minHeight: 560, idealHeight: 640)
    }

    // MARK: Identity

    private var identityForm: some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 10) {
            GridRow {
                Text("Model").gridColumnAlignment(.trailing)
                TextField("např. Lab Switch 24", text: $draft.model)
                    .textFieldStyle(.roundedBorder)
            }
            GridRow {
                Text("Výrobce")
                TextField("nepovinné, jen jako text", text: $draft.vendor)
                    .textFieldStyle(.roundedBorder)
            }
            GridRow {
                Text("Kategorie")
                Picker("Kategorie", selection: $draft.category) {
                    ForEach(DeviceCategory.allCases, id: \.self) { category in
                        Text(category.czechName).tag(category)
                    }
                }
                .labelsHidden()
                .fixedSize()
            }
            GridRow {
                Text("Poznámka")
                TextField("nepovinné", text: $draft.note)
                    .textFieldStyle(.roundedBorder)
            }
            GridRow {
                Text("")
                Toggle("Porty jsem ověřil(a) podle skutečného hardwaru", isOn: $draft.verified)
                    .help("Bez zaškrtnutí se u zařízení a jeho portů zobrazuje upozornění „\(CzechText.verifyHint)“.")
            }
        }
    }

    // MARK: Port groups

    private var groupsEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Skupiny portů").font(.headline)
                Spacer()
                Text("Celkem " + CzechText.ports(draft.totalPorts))
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            if draft.groups.isEmpty {
                Text("Zatím žádná skupina. Přidejte alespoň jednu.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 6)
            }

            ForEach($draft.groups) { $group in
                PortGroupRow(group: $group) {
                    draft.groups.removeAll { $0.id == group.id }
                }
            }

            HStack {
                Button {
                    draft.groups.append(nextRangeGroup())
                } label: {
                    Label("Přidat rozsah portů", systemImage: "plus")
                }
                Button {
                    var group = PortGroupDraft()
                    group.mode = .names
                    group.namesText = ""
                    group.speed = ""
                    group.connector = .console
                    draft.groups.append(group)
                } label: {
                    Label("Přidat vyjmenované porty", systemImage: "plus")
                }
            }
            .controlSize(.small)
        }
    }

    /// A new range that continues after the last numbered group, so it does not collide with it.
    private func nextRangeGroup() -> PortGroupDraft {
        var group = PortGroupDraft()
        if let last = draft.groups.last(where: { $0.mode == .range }) {
            group.prefix = last.prefix
            group.from = last.to + 1
            group.to = last.to + 4
            group.speed = last.speed
            group.connector = last.connector
        }
        return group
    }

    // MARK: Preview

    @ViewBuilder
    private var panelPreview: some View {
        if draft.problems.isEmpty, draft.totalPorts > 0 {
            VStack(alignment: .leading, spacing: 8) {
                Text("Náhled čelního panelu").font(.headline)
                ScrollView(.horizontal) {
                    FrontPanelView(template: draft.template(newID: "preview"), portSize: 14)
                        .padding(8)
                }
                .background(Theme.canvasBackground, in: RoundedRectangle(cornerRadius: 8))
                Text("Rozložení portů na panelu se odvodí automaticky ze skupin.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Footer

    private func footer(problems: [String]) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                if let saveError {
                    Label(saveError, systemImage: "exclamationmark.circle.fill")
                        .foregroundStyle(Theme.statusRed)
                } else if let first = problems.first {
                    Label(first, systemImage: "exclamationmark.circle")
                        .foregroundStyle(Theme.statusRed)
                    if problems.count > 1 {
                        Text("a další: \(problems.count - 1)")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Label("Zařízení se uloží do vlastního katalogu.", systemImage: "checkmark.circle")
                        .foregroundStyle(.secondary)
                }
            }
            .font(.callout)
            .lineLimit(2)
            .help(problems.joined(separator: "\n"))

            Spacer()

            Button("Zrušit", role: .cancel) { dismiss() }
                .keyboardShortcut(.cancelAction)
            Button(draft.isEditingExisting ? "Uložit" : "Přidat do katalogu") { save() }
                .keyboardShortcut(.defaultAction)
                .disabled(!problems.isEmpty)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    private func save() {
        guard draft.problems.isEmpty else { return }
        let template = draft.template(newID: catalog.uniqueID(vendor: draft.vendor, model: draft.model))
        do {
            if draft.isEditingExisting {
                try catalog.updateCustom(template)
            } else {
                try catalog.addCustom(template)
            }
            dismiss()
        } catch {
            saveError = CzechText.message(for: error)
        }
    }
}

/// One editable row of the port-group list, with a live preview of the generated names.
private struct PortGroupRow: View {
    @Binding var group: PortGroupDraft
    let onRemove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                switch group.mode {
                case .range:
                    labeled("Prefix") {
                        TextField("Gi0/", text: $group.prefix)
                            .frame(width: 150)
                    }
                    labeled("Od") {
                        TextField("1", value: $group.from, format: .number.grouping(.never))
                            .frame(width: 54)
                            .multilineTextAlignment(.trailing)
                    }
                    labeled("Do") {
                        TextField("24", value: $group.to, format: .number.grouping(.never))
                            .frame(width: 54)
                            .multilineTextAlignment(.trailing)
                    }
                case .names:
                    labeled("Názvy portů oddělené čárkou") {
                        TextField("Console, Mgmt", text: $group.namesText)
                            .frame(minWidth: 280)
                    }
                case .placeholder:
                    labeled("Prázdná pozice") {
                        Text(group.label ?? "modul")
                            .frame(minWidth: 280, alignment: .leading)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer(minLength: 4)

                if group.mode != .placeholder {
                    labeled("Rychlost") {
                        Picker("Rychlost", selection: $group.speed) {
                            ForEach(speedOptions, id: \.self) { speed in
                                Text(speed.isEmpty ? "neuvedena" : speed).tag(speed)
                            }
                        }
                        .labelsHidden()
                        .frame(width: 112)
                    }
                    labeled("Konektor") {
                        Picker("Konektor", selection: $group.connector) {
                            ForEach(ConnectorType.allCases, id: \.self) { connector in
                                Text(connector.czechName).tag(connector)
                            }
                        }
                        .labelsHidden()
                        .frame(width: 124)
                    }
                }

                Button(role: .destructive, action: onRemove) {
                    Image(systemName: "minus.circle")
                }
                .buttonStyle(.borderless)
                .help("Odebrat skupinu")
                .padding(.top, 14)
            }
            .textFieldStyle(.roundedBorder)

            if let problem = group.problem {
                Label(problem, systemImage: "exclamationmark.circle")
                    .font(.caption)
                    .foregroundStyle(Theme.statusRed)
            } else {
                Text(group.preview)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
    }

    private var speedOptions: [String] {
        let presets = DeviceEditorModel.speedPresets
        return presets.contains(group.speed) ? presets : presets + [group.speed]
    }

    private func labeled<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            content()
        }
    }
}
