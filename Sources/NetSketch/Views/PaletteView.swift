import SwiftUI
import NetSketchCore
import NetSketchCanvas

/// The left-hand column: the device catalog grouped by category, with search.
/// Rows are dragged onto the canvas; a double click adds the device at a default spot.
struct PaletteView: View {
    @Bindable var model: AppModel

    @State private var searchText = ""
    @State private var collapsed: Set<DeviceCategory> = []
    @State private var pendingDeletion: DeviceTemplate?

    private var catalog: DeviceCatalog { model.store.catalog }

    var body: some View {
        let groups = filteredGroups
        VStack(spacing: 0) {
            searchField
                .padding(.horizontal, 10)
                .padding(.top, 8)
                .padding(.bottom, 6)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if groups.isEmpty {
                        emptyState
                    }
                    ForEach(groups) { group in
                        sectionHeader(group)
                        if !collapsed.contains(group.category) || isSearching {
                            ForEach(group.templates) { template in
                                PaletteRow(template: template)
                                    .draggable(templateDragPrefix + template.id) {
                                        dragPreview(template)
                                    }
                                    .onTapGesture(count: 2) {
                                        model.addDevice(templateID: template.id)
                                    }
                                    .contextMenu { contextMenu(for: template) }
                            }
                        }
                    }
                }
                .padding(.horizontal, 6)
                .padding(.bottom, 8)
            }

            Divider()
            Button {
                model.deviceEditor = .new
            } label: {
                Label("Nové zařízení…", systemImage: "plus")
                    .frame(maxWidth: .infinity)
            }
            .controlSize(.large)
            .padding(10)
            .help("Přidat do katalogu vlastní zařízení s vlastními porty")
        }
        .confirmationDialog(
            "Smazat vlastní zařízení „\(pendingDeletion?.displayName ?? "")“?",
            isPresented: Binding(get: { pendingDeletion != nil }, set: { if !$0 { pendingDeletion = nil } }),
            presenting: pendingDeletion
        ) { template in
            Button("Smazat z katalogu", role: .destructive) {
                model.perform("Zařízení nelze smazat") { try catalog.removeCustom(id: template.id) }
            }
            Button("Zrušit", role: .cancel) {}
        } message: { _ in
            Text("Zařízení už umístěná na plátně zůstanou beze změny.")
        }
    }

    // MARK: Search

    private var isSearching: Bool {
        !searchText.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private var filteredGroups: [TemplateGroup] {
        let query = searchText.trimmingCharacters(in: .whitespaces)
        let groups = catalog.templatesByCategory
        guard !query.isEmpty else { return groups }
        return groups.compactMap { group in
            let categoryMatches = group.category.czechPlural.localizedStandardContains(query)
                || group.category.czechName.localizedStandardContains(query)
            let members = categoryMatches ? group.templates : group.templates.filter { template in
                template.model.localizedStandardContains(query)
                    || template.vendor.localizedStandardContains(query)
                    || template.id.localizedStandardContains(query)
            }
            return members.isEmpty ? nil : TemplateGroup(category: group.category, templates: members)
        }
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("Hledat zařízení", text: $searchText)
                .textFieldStyle(.plain)
            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Zrušit hledání")
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 7))
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: catalog.templates.isEmpty ? "tray" : "magnifyingglass")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text(catalog.templates.isEmpty ? "Katalog je prázdný" : "Nic nenalezeno")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 30)
    }

    // MARK: Rows

    private func sectionHeader(_ group: TemplateGroup) -> some View {
        let isCollapsed = collapsed.contains(group.category) && !isSearching
        return Button {
            if collapsed.contains(group.category) {
                collapsed.remove(group.category)
            } else {
                collapsed.insert(group.category)
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.bold))
                    .rotationEffect(.degrees(isCollapsed ? 0 : 90))
                Text(group.category.czechPlural.uppercased())
                    .font(.caption.weight(.semibold))
                Text(String(group.templates.count))
                    .font(.caption)
                Spacer()
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.top, 10)
            .padding(.bottom, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isSearching)
    }

    private func dragPreview(_ template: DeviceTemplate) -> some View {
        HStack(spacing: 8) {
            DeviceIconView(category: template.category, size: 28)
            Text(template.model).font(.callout.weight(.medium))
        }
        .padding(8)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder
    private func contextMenu(for template: DeviceTemplate) -> some View {
        Button("Přidat na plátno") {
            model.addDevice(templateID: template.id)
        }
        Divider()
        if template.isCustom {
            Button("Upravit…") {
                model.deviceEditor = .edit(template)
            }
            Button("Duplikovat…") {
                model.deviceEditor = .duplicate(template)
            }
            Divider()
            Button("Smazat z katalogu…", role: .destructive) {
                pendingDeletion = template
            }
        } else {
            Button("Duplikovat jako vlastní…") {
                model.deviceEditor = .duplicate(template)
            }
        }
    }
}

/// One catalog entry: icon, model, vendor as plain text, port summary, "verify" marker.
struct PaletteRow: View {
    let template: DeviceTemplate

    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 10) {
            DeviceIconView(category: template.category, size: 32)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 5) {
                    Text(template.model)
                        .font(.callout.weight(.medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if template.isCustom {
                        Chip(text: "vlastní", color: Theme.teal)
                    }
                }
                Text(template.vendor.isEmpty ? "výrobce neuveden" : template.vendor)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(CzechText.portSummary(of: template))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 2)
            if template.needsVerification {
                VerifyBadge()
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isHovered ? Color.primary.opacity(0.08) : Color.clear, in: RoundedRectangle(cornerRadius: 7))
        .contentShape(RoundedRectangle(cornerRadius: 7))
        .onHover { isHovered = $0 }
        .help(tooltip)
        .accessibilityElement(children: .combine)
    }

    private var tooltip: String {
        var lines = [template.displayName, CzechText.ports(template.portCount) + ": " + CzechText.portSummary(of: template)]
        if let note = template.note, !note.isEmpty { lines.append(note) }
        if template.needsVerification { lines.append(CzechText.verifyHint + ".") }
        lines.append("Přetáhněte na plátno nebo dvakrát klikněte.")
        return lines.joined(separator: "\n")
    }
}
