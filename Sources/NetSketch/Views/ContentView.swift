import SwiftUI
import NetSketchCore
import NetSketchCanvas

/// The main window: palette, canvas and inspector, plus the toolbar.
struct ContentView: View {
    @Bindable var model: AppModel

    private var store: ProjectStore { model.store }

    var body: some View {
        NavigationSplitView {
            PaletteView(model: model)
                .navigationSplitViewColumnWidth(min: 210, ideal: 250, max: 420)
        } detail: {
            CanvasView(store: store, viewport: model.viewport)
                .inspector(isPresented: $model.isInspectorVisible) {
                    InspectorView(model: model)
                        .inspectorColumnWidth(min: 280, ideal: 310, max: 480)
                }
        }
        .navigationTitle(model.windowTitle)
        .toolbar { MainToolbar(model: model) }
        .frame(minWidth: 1100, minHeight: 700)
        .background(WindowAccessor { window in model.attachMainWindow(window) })
        .alert(
            model.alert?.title ?? "",
            isPresented: Binding(get: { model.alert != nil }, set: { if !$0 { model.alert = nil } }),
            presenting: model.alert
        ) { _ in
            Button("OK", role: .cancel) {}
        } message: { alert in
            Text(alert.message)
        }
        .sheet(item: $model.deviceEditor) { request in
            DeviceEditorView(catalog: store.catalog, request: request)
        }
    }
}

/// Toolbar of the main window.
struct MainToolbar: ToolbarContent {
    @Bindable var model: AppModel

    private var store: ProjectStore { model.store }

    var body: some ToolbarContent {
        ToolbarItem {
            cablePicker
        }
        ToolbarItem {
            Picker("Zobrazení", selection: Bindable(store).viewMode) {
                ForEach(ViewMode.allCases, id: \.self) { mode in
                    Text(mode.czechName).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .help("Fyzický pohled ukazuje čelní panely a porty, logický jen ikony a spoje")
        }
        ToolbarItemGroup {
            Toggle(isOn: Bindable(store).snapToGrid) {
                Label("Přichytávat k mřížce", systemImage: "grid")
            }
            .help("Přichytávat zařízení a poznámky k mřížce")

            Button {
                model.addAnnotation()
            } label: {
                Label("Přidat poznámku", systemImage: "note.text.badge.plus")
            }
            .help("Přidat na plátno textovou poznámku")

            Button {
                model.bundleSelectedLinks()
            } label: {
                Label("Seskupit do svazku", systemImage: "link.badge.plus")
            }
            .disabled(!model.canBundleSelection)
            .help("Seskupit vybrané kabely do svazku (LAG)")

            Button {
                model.openConsoleForSelection()
            } label: {
                Label("Konzole", systemImage: "terminal")
            }
            .disabled(!canOpenConsole)
            .help(consoleHelp)
        }
        ToolbarItem {
            Spacer()
        }
        ToolbarItem {
            ControlGroup {
                Button {
                    model.viewport.zoomOut()
                } label: {
                    Label("Oddálit", systemImage: "minus.magnifyingglass")
                }
                .help("Oddálit")

                Button {
                    model.viewport.reset()
                } label: {
                    Text("\(model.viewport.zoomPercent) %")
                        .monospacedDigit()
                        .frame(minWidth: 44)
                }
                .help("Skutečná velikost (100 %)")

                Button {
                    model.viewport.zoomIn()
                } label: {
                    Label("Přiblížit", systemImage: "plus.magnifyingglass")
                }
                .help("Přiblížit")
            }
        }
        ToolbarItem {
            Menu {
                Button("Exportovat jako PNG…") { model.exportPNG() }
                Button("Exportovat jako PDF…") { model.exportPDF() }
            } label: {
                Label("Export", systemImage: "square.and.arrow.up")
            }
            .help("Exportovat plátno jako obrázek nebo PDF")
        }
        ToolbarItem {
            Button {
                model.isInspectorVisible.toggle()
            } label: {
                Label("Inspektor", systemImage: "sidebar.trailing")
            }
            .help(model.isInspectorVisible ? "Skrýt inspektor" : "Zobrazit inspektor")
        }
    }

    private var cablePicker: some View {
        Picker(selection: Bindable(store).activeCableType) {
            ForEach(CableType.allCases, id: \.self) { type in
                Label {
                    Text(type.czechName)
                } icon: {
                    Image(nsImage: CableSwatch.image(for: type))
                }
                .tag(type)
            }
        } label: {
            Text("Typ kabelu")
        }
        .pickerStyle(.menu)
        .labelStyle(.titleAndIcon)
        .help("Typ kabelu pro nově kreslené spoje: " + store.activeCableType.czechDescription)
    }

    private var canOpenConsole: Bool {
        guard let device = model.singleSelectedDevice else { return false }
        return model.consoleUnavailableReason(for: device) == nil
    }

    private var consoleHelp: String {
        guard let device = model.singleSelectedDevice else {
            return "Otevřít konzoli: nejprve vyberte jedno zařízení"
        }
        return model.consoleUnavailableReason(for: device) ?? "Otevřít konzoli zařízení \(device.hostname)"
    }
}
