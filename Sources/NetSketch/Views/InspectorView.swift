import SwiftUI
import NetSketchCore
import NetSketchCanvas

/// The right-hand column. What it shows follows `store.selection`.
struct InspectorView: View {
    let model: AppModel

    private var store: ProjectStore { model.store }

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    @ViewBuilder
    private var content: some View {
        let selection = store.selection
        if selection.count == 1, let item = selection.first {
            switch item {
            case .device(let id):
                if let device = store.project.device(id: id) {
                    DeviceInspector(model: model, device: device).id(id)
                }
            case .link(let id):
                if let link = store.project.link(id: id) {
                    LinkInspector(model: model, link: link).id(id)
                }
            case .annotation(let id):
                if let annotation = store.project.annotation(id: id) {
                    AnnotationInspector(model: model, annotation: annotation).id(id)
                }
            }
        } else if selection.isEmpty {
            ProjectInspector(model: model)
        } else {
            MultiSelectionInspector(model: model)
        }
    }
}

// MARK: - Device

struct DeviceInspector: View {
    let model: AppModel
    let device: Device

    @State private var connectedOnly = false

    private var store: ProjectStore { model.store }

    var body: some View {
        let connections = store.connections(ofDevice: device.id)
        let connectedCount = connections.filter { $0.link != nil }.count
        let visible = connectedOnly ? connections.filter { $0.link != nil } : connections

        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16, pinnedViews: [.sectionHeaders]) {
                header
                identity
                consoleButton
                InspectorSection(title: "Poznámka") {
                    CommitTextField("Poznámka k zařízení", value: device.note, axis: .vertical) { text in
                        model.perform { try store.setDeviceNote(id: device.id, text) }
                    }
                    .lineLimit(2...8)
                    .textFieldStyle(.roundedBorder)
                }
                if !device.vlans.isEmpty { vlanTable }

                Section {
                    if visible.isEmpty {
                        Text(connectedOnly ? "Žádný port není zapojený." : "Zařízení nemá žádné porty.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 4)
                    }
                    VStack(spacing: 0) {
                        ForEach(visible) { connection in
                            PortRow(model: model, deviceID: device.id, connection: connection)
                            Divider()
                        }
                    }
                } header: {
                    portsHeader(total: connections.count, connected: connectedCount)
                }
            }
            .padding(14)
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            DeviceIconView(category: device.category, size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(device.hostname)
                    .font(.headline)
                    .lineLimit(1)
                Text(device.displayModel.isEmpty ? device.category.czechName : device.displayModel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }

    private var identity: some View {
        InspectorSection(title: "Zařízení") {
            InspectorRow(label: "Hostname") {
                CommitTextField("Hostname", value: device.hostname) { text in
                    model.perform("Zařízení nelze přejmenovat") { try store.renameDevice(id: device.id, to: text) }
                }
                .textFieldStyle(.roundedBorder)
            }
            InspectorRow(label: "Výrobce") {
                Text(device.vendor.isEmpty ? "neuveden" : device.vendor).textSelection(.enabled)
            }
            InspectorRow(label: "Model") {
                Text(device.model.isEmpty ? "neuveden" : device.model).textSelection(.enabled)
            }
            InspectorRow(label: "Kategorie") {
                Text(device.category.czechName)
            }
            if device.needsVerification {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    VerifyBadge()
                    Text("Počty a názvy portů nejsou ověřené. Zkontrolujte je podle skutečného hardwaru.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder
    private var consoleButton: some View {
        let reason = model.consoleUnavailableReason(for: device)
        Button {
            model.openConsole(deviceID: device.id)
        } label: {
            Label("Otevřít konzoli", systemImage: "terminal")
                .frame(maxWidth: .infinity)
        }
        .controlSize(.large)
        .disabled(reason != nil)
        .help(reason ?? "Otevře konfigurační konzoli zařízení (Cmd+T)")
    }

    private var vlanTable: some View {
        InspectorSection(title: "VLAN (z konzole)") {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(device.vlans) { vlan in
                    HStack(spacing: 8) {
                        Text(String(vlan.id))
                            .font(.system(.callout, design: .monospaced))
                            .frame(width: 44, alignment: .trailing)
                        Text(vlan.name.isEmpty ? "bez názvu" : vlan.name)
                            .font(.callout)
                            .foregroundStyle(vlan.name.isEmpty ? .secondary : .primary)
                            .lineLimit(1)
                    }
                }
            }
            Text("Tabulka se upravuje příkazy v konzoli. Je to jen zápis, VLAN se nesimulují.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func portsHeader(total: Int, connected: Int) -> some View {
        HStack(spacing: 8) {
            Text("PORTY")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text("zapojeno \(connected) z \(total)")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Toggle("Jen zapojené", isOn: $connectedOnly)
                .toggleStyle(.checkbox)
                .controlSize(.small)
        }
        .padding(.vertical, 6)
        .background(.background)
    }
}

/// One port: name, connector and speed, what is plugged in, description, VLAN text, shutdown flag.
struct PortRow: View {
    let model: AppModel
    let deviceID: UUID
    let connection: PortConnection

    private var store: ProjectStore { model.store }
    // Qualified: a bare `Port` is ambiguous with Foundation.Port (NSPort).
    private var port: NetSketchCore.Port { connection.port }
    private var ref: PortRef { PortRef(deviceID: deviceID, portID: connection.port.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(port.name)
                    .font(.system(.callout, design: .monospaced).weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(1)
                    .help(port.name)
                if !port.verified {
                    VerifyBadge().font(.caption)
                }
                Spacer(minLength: 4)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            HStack(spacing: 6) {
                peerLabel
                Spacer(minLength: 4)
                Toggle("shutdown", isOn: Binding(
                    get: { port.adminDown },
                    set: { down in model.perform { try store.setPortAdminDown(ref, down) } }
                ))
                .toggleStyle(.button)
                .controlSize(.mini)
                .tint(Theme.accent)
                .help(port.adminDown
                      ? "Port je administrativně vypnutý (shutdown). Kliknutím ho zapnete."
                      : "Označit port jako administrativně vypnutý (shutdown). Jen zápis, nic se nesimuluje.")
            }
            HStack(spacing: 6) {
                CommitTextField("Popis", value: port.description) { text in
                    model.perform { try store.setPortDescription(ref, text) }
                }
                CommitTextField("VLAN", value: port.vlan) { text in
                    model.perform { try store.setPortVLAN(ref, text) }
                }
                .frame(width: 86)
                .help("Volný text, např. „10“ nebo „trunk 10,20“. Bez logiky.")
            }
            .textFieldStyle(.roundedBorder)
            .controlSize(.small)
        }
        .padding(.vertical, 6)
    }

    private var detail: String {
        [port.connector.czechName, port.speed].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    @ViewBuilder
    private var peerLabel: some View {
        if let peer = connection.peer, let link = connection.link {
            Button {
                store.selection = [.link(link.id)]
            } label: {
                Text("→ \(peer.device.hostname) \(peer.port.shortName)")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Theme.teal)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .buttonStyle(.plain)
            .help("Zapojeno do \(peer.device.hostname), port \(peer.port.name). Kliknutím vyberete kabel.")
        } else if connection.link != nil {
            Text("zapojeno")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            Text("volný")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Link

struct LinkInspector: View {
    let model: AppModel
    // Qualified: a bare `Link` is ambiguous with SwiftUI.Link.
    let link: NetSketchCore.Link

    private var store: ProjectStore { model.store }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 10) {
                    Image(systemName: "cable.connector")
                        .font(.title2)
                        .foregroundStyle(Theme.teal)
                        .frame(width: 36, height: 36)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Kabel").font(.headline)
                        Text(link.cableType.czechDescription)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                InspectorSection(title: "Konce kabelu") {
                    endRow(.a)
                    endRow(.b)
                    Text("Stav je jen ruční značka u konce kabelu, nic se nepočítá.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                InspectorSection(title: "Typ kabelu") {
                    Picker("Typ kabelu", selection: Binding(
                        get: { link.cableType },
                        set: { type in model.perform { try store.setCableType(linkID: link.id, type) } }
                    )) {
                        ForEach(CableType.allCases, id: \.self) { type in
                            Text(type.czechDescription).tag(type)
                        }
                    }
                    .labelsHidden()
                }

                InspectorSection(title: "Poznámka") {
                    CommitTextField("Poznámka ke kabelu", value: link.note, axis: .vertical) { text in
                        model.perform { try store.setLinkNote(linkID: link.id, text) }
                    }
                    .lineLimit(2...8)
                    .textFieldStyle(.roundedBorder)
                }

                if let bundle = store.bundle(ofLink: link.id) {
                    BundleSection(model: model, bundle: bundle)
                } else {
                    InspectorSection(title: "Svazek (LAG)") {
                        Text("Kabel není ve svazku. Vyberte dva nebo více kabelů mezi stejnými zařízeními a seskupte je.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Button(role: .destructive) {
                    model.perform("Kabel nelze odpojit") { try store.removeLink(id: link.id) }
                } label: {
                    Label("Odpojit kabel", systemImage: "trash")
                }
            }
            .padding(14)
        }
    }

    @ViewBuilder
    private func endRow(_ end: LinkEnd) -> some View {
        let ref = link.ref(end)
        let resolved = store.project.resolve(ref)
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(end == .a ? "A" : "B")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 14)
                if let resolved {
                    Button {
                        store.selection = [.device(resolved.device.id)]
                    } label: {
                        Text(resolved.device.hostname)
                            .font(.callout.weight(.medium))
                            .lineLimit(1)
                    }
                    .buttonStyle(.plain)
                    .help("Vybrat zařízení \(resolved.device.hostname)")
                    Text(resolved.port.name)
                        .font(.system(.callout, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                } else {
                    Text("neznámý port").foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
            }
            HStack(spacing: 8) {
                Text("Stav")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 20)
                StatusPicker(status: link.status(end)) { status in
                    model.perform { try store.setStatus(linkID: link.id, end: end, status: status) }
                }
                Text(link.status(end).czechName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// Label and membership of a bundle (LAG). Shown for a member link or for the whole bundle selected.
struct BundleSection: View {
    let model: AppModel
    let bundle: LinkBundle

    private var store: ProjectStore { model.store }

    var body: some View {
        InspectorSection(title: "Svazek (LAG)") {
            InspectorRow(label: "Popisek") {
                CommitTextField("Po1 / bond1", value: bundle.label) { text in
                    model.perform("Svazek nelze přejmenovat") { try store.renameBundle(id: bundle.id, to: text) }
                }
                .textFieldStyle(.roundedBorder)
            }
            Text("Ve svazku: " + CzechText.cables(bundle.linkIDs.count) + ". Svazek je jen kresba, LACP se nesimuluje.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Vybrat celý svazek") {
                    store.selection = Set(bundle.linkIDs.map(SelectionItem.link))
                }
                Button("Zrušit svazek") {
                    model.perform("Svazek nelze zrušit") { try store.unbundle(id: bundle.id) }
                }
            }
            .controlSize(.small)
        }
    }
}

// MARK: - Annotation

struct AnnotationInspector: View {
    let model: AppModel
    let annotation: NetSketchCore.Annotation

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 10) {
                    Image(systemName: "note.text")
                        .font(.title2)
                        .foregroundStyle(Theme.teal)
                        .frame(width: 36, height: 36)
                    Text("Textová poznámka").font(.headline)
                }
                InspectorSection(title: "Text") {
                    CommitTextField("Text poznámky", value: annotation.text, axis: .vertical) { text in
                        model.perform { try model.store.setAnnotationText(id: annotation.id, text) }
                    }
                    .lineLimit(3...12)
                    .textFieldStyle(.roundedBorder)
                    Text("Nový řádek vložíte klávesami Option+Return.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Button(role: .destructive) {
                    model.perform("Poznámku nelze smazat") { try model.store.removeAnnotation(id: annotation.id) }
                } label: {
                    Label("Smazat poznámku", systemImage: "trash")
                }
            }
            .padding(14)
        }
    }
}

// MARK: - Several objects

struct MultiSelectionInspector: View {
    let model: AppModel

    @State private var bundleLabel = ""
    @State private var bundleError: String?

    private var store: ProjectStore { model.store }

    var body: some View {
        let linkIDs = store.selectedLinkIDs
        let deviceCount = store.selectedDeviceIDs.count
        let annotationCount = store.selectedAnnotationIDs.count
        let bundles = Set(linkIDs.compactMap { store.bundle(ofLink: $0)?.id })
        let unbundledCount = linkIDs.filter { store.bundle(ofLink: $0) == nil }.count

        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 10) {
                    Image(systemName: "square.on.square.dashed")
                        .font(.title2)
                        .foregroundStyle(Theme.teal)
                        .frame(width: 36, height: 36)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Vybráno objektů: \(store.selection.count)").font(.headline)
                        Text(summary(devices: deviceCount, links: linkIDs.count, annotations: annotationCount))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if bundles.count == 1, unbundledCount == 0, let id = bundles.first, let bundle = store.project.bundle(id: id) {
                    BundleSection(model: model, bundle: bundle)
                } else if linkIDs.count >= 2 {
                    groupSection(linkIDs: linkIDs)
                }

                Button(role: .destructive) {
                    model.deleteSelection()
                } label: {
                    Label("Smazat výběr", systemImage: "trash")
                }
            }
            .padding(14)
        }
        .onChange(of: store.selection) { _, _ in
            bundleError = nil
        }
    }

    private func groupSection(linkIDs: Set<UUID>) -> some View {
        InspectorSection(title: "Svazek (LAG)") {
            InspectorRow(label: "Popisek") {
                TextField("automaticky (Po1 / bond1)", text: $bundleLabel)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { createBundle(linkIDs) }
            }
            Button {
                createBundle(linkIDs)
            } label: {
                Label("Seskupit do svazku (LAG)", systemImage: "link.badge.plus")
            }
            if let bundleError {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "exclamationmark.circle.fill")
                    Text(bundleError).fixedSize(horizontal: false, vertical: true)
                }
                .font(.callout)
                .foregroundStyle(Theme.statusRed)
            }
            Text("Svazek je jen vizuální seskupení kabelů mezi stejnou dvojicí zařízení.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func createBundle(_ linkIDs: Set<UUID>) {
        do {
            try store.createBundle(linkIDs: linkIDs, label: bundleLabel)
            bundleLabel = ""
            bundleError = nil
        } catch {
            bundleError = CzechText.message(for: error, in: store.project)
        }
    }

    private func summary(devices: Int, links: Int, annotations: Int) -> String {
        var parts: [String] = []
        if devices > 0 { parts.append(CzechText.devices(devices)) }
        if links > 0 { parts.append(CzechText.cables(links)) }
        if annotations > 0 { parts.append(CzechText.notes(annotations)) }
        return parts.joined(separator: ", ")
    }
}

// MARK: - Nothing selected

struct ProjectInspector: View {
    let model: AppModel

    private var store: ProjectStore { model.store }

    var body: some View {
        let project = store.project
        let unverified = project.devices.filter(\.needsVerification).count

        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 10) {
                    Image(systemName: "point.3.connected.trianglepath.dotted")
                        .font(.title2)
                        .foregroundStyle(Theme.teal)
                        .frame(width: 36, height: 36)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.documentName).font(.headline).lineLimit(2)
                        Text(store.fileURL?.path ?? "Projekt ještě není uložen")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                    }
                }

                InspectorSection(title: "Projekt") {
                    InspectorRow(label: "Název") {
                        CommitTextField("Název projektu", value: project.name) { text in
                            store.renameProject(to: text)
                            return true
                        }
                        .textFieldStyle(.roundedBorder)
                    }
                    InspectorRow(label: "Zařízení") { Text(String(project.devices.count)) }
                    InspectorRow(label: "Kabely") { Text(String(project.links.count)) }
                    InspectorRow(label: "Svazky") { Text(String(project.bundles.count)) }
                    InspectorRow(label: "Poznámky") { Text(String(project.annotations.count)) }
                }

                if unverified > 0 {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        VerifyBadge()
                        Text("Neověřená zařízení: \(unverified). Počty a názvy portů z katalogu zkontrolujte podle skutečného hardwaru.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                InspectorSection(title: "Jak začít") {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Self.hints, id: \.self) { hint in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Circle().fill(Theme.teal).frame(width: 5, height: 5).offset(y: -2)
                                Text(hint).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .font(.callout)
                    .foregroundStyle(.secondary)
                }
            }
            .padding(14)
        }
    }

    static let hints = [
        "Zařízení přetáhněte z palety na plátno, nebo na něj v paletě dvakrát klikněte.",
        "Kabel vznikne kliknutím na jeden port a potom na druhý. Typ kabelu se volí na liště.",
        "Výběrem zařízení nebo kabelu se tady zobrazí jeho vlastnosti.",
        "Aplikace jen kreslí zapojení. Protokoly (STP, LACP, VLAN) se nesimulují.",
    ]
}
