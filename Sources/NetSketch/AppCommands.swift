import SwiftUI
import NetSketchCore
import NetSketchCanvas

/// The menu bar. Undo/redo are wired to the store's own history, not to an `UndoManager`.
///
/// Delete/Backspace and Cmd+A for the canvas are not menu key equivalents: they are handled in
/// `AppModel.intercept(_:)`, which can tell whether a text field is being edited.
struct AppCommands: Commands {
    @Bindable var model: AppModel

    private var store: ProjectStore { model.store }

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("Nový projekt") { model.newDocument() }
                .keyboardShortcut("n", modifiers: .command)
            Button("Otevřít…") { model.openDocument() }
                .keyboardShortcut("o", modifiers: .command)
        }

        CommandGroup(replacing: .saveItem) {
            Button("Uložit") { model.save() }
                .keyboardShortcut("s", modifiers: .command)
            Button("Uložit jako…") { model.saveAs() }
                .keyboardShortcut("s", modifiers: [.command, .shift])
            Divider()
            Button("Exportovat jako PNG…") { model.exportPNG() }
                .keyboardShortcut("e", modifiers: [.command, .shift])
            Button("Exportovat jako PDF…") { model.exportPDF() }
                .keyboardShortcut("p", modifiers: [.command, .shift])
        }

        CommandGroup(replacing: .undoRedo) {
            Button("Zpět") { model.undo() }
                .keyboardShortcut("z", modifiers: .command)
                .disabled(!store.canUndo)
            Button("Znovu") { model.redo() }
                .keyboardShortcut("z", modifiers: [.command, .shift])
                .disabled(!store.canRedo)
        }

        CommandGroup(after: .pasteboard) {
            Divider()
            Button("Smazat vybrané objekty (klávesa Delete)") { model.deleteSelection() }
                .disabled(store.selection.isEmpty)
            Button("Vybrat vše na plátně") { model.selectAll() }
            Button("Zrušit výběr") { store.clearSelection() }
                .disabled(store.selection.isEmpty)
            Divider()
            Button("Přidat poznámku") { model.addAnnotation() }
                .keyboardShortcut("m", modifiers: [.command, .shift])
        }

        CommandGroup(before: .toolbar) {
            Toggle("Fyzický pohled", isOn: viewModeBinding(.physical))
                .keyboardShortcut("1", modifiers: .command)
            Toggle("Logický pohled", isOn: viewModeBinding(.logical))
                .keyboardShortcut("2", modifiers: .command)
            Divider()
            Button("Přiblížit") { model.viewport.zoomIn() }
                .keyboardShortcut("+", modifiers: .command)
            Button("Oddálit") { model.viewport.zoomOut() }
                .keyboardShortcut("-", modifiers: .command)
            Button("Skutečná velikost") { model.viewport.reset() }
                .keyboardShortcut("0", modifiers: .command)
            Button("Přizpůsobit zobrazení") { model.viewport.fit() }
                .keyboardShortcut("9", modifiers: .command)
            Divider()
            Toggle("Přichytávat k mřížce", isOn: Bindable(store).snapToGrid)
                .keyboardShortcut("g", modifiers: [.command, .option])
            Toggle("Inspektor", isOn: $model.isInspectorVisible)
                .keyboardShortcut("i", modifiers: [.command, .option])
            Divider()
        }

        CommandMenu("Zařízení") {
            Button("Otevřít konzoli") { model.openConsoleForSelection() }
                .keyboardShortcut("t", modifiers: .command)
                .disabled(!canOpenConsole)
            Divider()
            Button("Nové zařízení v katalogu…") { model.deviceEditor = .new }
                .keyboardShortcut("n", modifiers: [.command, .shift])
        }

        CommandMenu("Kabely") {
            Section("Typ nového kabelu") {
                ForEach(Array(CableType.allCases.enumerated()), id: \.element) { index, type in
                    Toggle(type.czechDescription, isOn: cableTypeBinding(type))
                        .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: [.command, .option])
                }
            }
            Divider()
            Button("Seskupit do svazku (LAG)") { model.bundleSelectedLinks() }
                .keyboardShortcut("g", modifiers: .command)
                .disabled(!model.canBundleSelection)
            Button("Zrušit svazek") { model.unbundleSelectedLinks() }
                .keyboardShortcut("g", modifiers: [.command, .shift])
                .disabled(!model.selectionHasBundle)
        }
    }

    /// Menu check mark for one view mode; choosing the checked one again changes nothing.
    private func viewModeBinding(_ mode: ViewMode) -> Binding<Bool> {
        Binding(get: { store.viewMode == mode }, set: { _ in store.viewMode = mode })
    }

    private func cableTypeBinding(_ type: CableType) -> Binding<Bool> {
        Binding(get: { store.activeCableType == type }, set: { _ in store.activeCableType = type })
    }

    private var canOpenConsole: Bool {
        guard let device = model.singleSelectedDevice else { return false }
        return model.consoleUnavailableReason(for: device) == nil
    }
}
