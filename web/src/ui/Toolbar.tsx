// The toolbar of the main window (MainToolbar in Sources/NetSketch/Views/ContentView.swift),
// plus a "Soubor" menu and undo/redo, which the Mac app has in its menu bar.

import { memo, type ReactNode } from "react";
import type { CableType, ViewMode } from "../core/model";
import { cableDescription, cableName, cableTypes } from "./czech";
import { CableSwatch, MenuButton, type MenuItem } from "./components";
import { Icon, type IconName } from "./icons";
import { shortcutLabel } from "./platform";
import { useApp, useAppVersion, useStore, useStoreVersion, useViewport } from "./store-context";

/** A toolbar button. Disabled buttons keep their tooltip (it explains why). */
function ToolButton({
  icon,
  label,
  help,
  onClick,
  disabled,
  pressed,
  children,
}: {
  icon?: IconName;
  label: string;
  help: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children?: ReactNode;
}) {
  return (
    // The wrapper carries the tooltip: browsers show none on disabled buttons.
    <span className="tool-button-wrap" title={help}>
      <button
        type="button"
        className={pressed ? "tool-button pressed" : "tool-button"}
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
      >
        {icon && <Icon name={icon} />}
        {children}
      </button>
    </span>
  );
}

const viewModes: { mode: ViewMode; label: string }[] = [
  { mode: "physical", label: "Fyzický" },
  { mode: "logical", label: "Logický" },
];

export const Toolbar = memo(function Toolbar() {
  useStoreVersion();
  useAppVersion();
  const store = useStore();
  const app = useApp();
  const viewport = useViewport();
  const consoleState = app.consoleCommandState;

  const fileItems: MenuItem[] = [
    { label: "Nový projekt", shortcut: shortcutLabel("N"), onSelect: () => app.newDocument() },
    { label: "Otevřít…", shortcut: shortcutLabel("O"), onSelect: () => void app.openDocument() },
    { label: "Uložit", shortcut: shortcutLabel("S"), onSelect: () => void app.save(), separatorBefore: true },
    { label: "Uložit jako…", shortcut: shortcutLabel("S", { shift: true }), onSelect: () => void app.saveAs() },
  ];

  const exportItems: MenuItem[] = (["png", "pdf", "svg"] as const).map((kind) => ({
    label: app.exportMenuTitle(kind),
    onSelect: () => void app.exportAs(kind),
    disabled: !app.canExport(kind),
    title: app.canExport(kind) ? undefined : "Export bude k dispozici, až bude hotové plátno.",
  }));

  return (
    <header className="toolbar" role="toolbar" aria-label="Nástroje">
      <ToolButton
        icon="sidebarLeft"
        label={app.paletteVisible ? "Skrýt paletu" : "Zobrazit paletu"}
        help={app.paletteVisible ? "Skrýt paletu zařízení" : "Zobrazit paletu zařízení"}
        pressed={app.paletteVisible}
        onClick={() => (app.paletteVisible = !app.paletteVisible)}
      />
      <MenuButton label="Soubor" title="Nový projekt, otevření a uložení" items={fileItems} className="file-menu">
        <span className="menu-button-text">Soubor</span>
        <Icon name="chevronDown" size={11} />
      </MenuButton>
      <div className="tool-group" role="group" aria-label="Historie úprav">
        <ToolButton
          icon="undo"
          label="Zpět"
          help={`Zpět (${shortcutLabel("Z")})`}
          disabled={!store.canUndo}
          onClick={() => app.undo()}
        />
        <ToolButton
          icon="redo"
          label="Znovu"
          help={`Znovu (${shortcutLabel("Z", { shift: true })})`}
          disabled={!store.canRedo}
          onClick={() => app.redo()}
        />
      </div>

      <h1 className="toolbar-title" title={app.windowTitle}>
        <span className="toolbar-title-name">{store.fileName ?? app.documentName}</span>
        {store.isDirty && <span className="toolbar-title-dirty"> — upraveno</span>}
      </h1>

      <label className="cable-picker" title={"Typ kabelu pro nově kreslené spoje: " + cableDescription(store.activeCableType)}>
        <span className="visually-hidden">Typ kabelu</span>
        <CableSwatch type={store.activeCableType} />
        <select
          value={store.activeCableType}
          onChange={(event) => (store.activeCableType = event.target.value as CableType)}
        >
          {cableTypes.map((type) => (
            <option key={type} value={type}>
              {cableName(type)}
            </option>
          ))}
        </select>
      </label>

      <div
        className="segmented"
        role="group"
        aria-label="Zobrazení"
        title="Fyzický pohled ukazuje čelní panely a porty, logický jen ikony a spoje"
      >
        {viewModes.map(({ mode, label }) => (
          <button
            key={mode}
            type="button"
            className={store.viewMode === mode ? "segment selected" : "segment"}
            aria-pressed={store.viewMode === mode}
            onClick={() => (store.viewMode = mode)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="tool-group">
        <ToolButton
          icon="grid"
          label="Přichytávat k mřížce"
          help="Přichytávat zařízení a poznámky k mřížce"
          pressed={store.snapToGrid}
          onClick={() => (store.snapToGrid = !store.snapToGrid)}
        />
        <ToolButton
          icon="noteAdd"
          label="Přidat poznámku"
          help="Přidat na plátno textovou poznámku"
          onClick={() => app.addAnnotation()}
        />
        <ToolButton
          icon="linkAdd"
          label="Seskupit do svazku"
          help="Seskupit vybrané kabely do svazku (LAG)"
          disabled={!app.canBundleSelection}
          onClick={() => app.bundleSelectedLinks()}
        />
        <ToolButton
          icon="terminal"
          label="Konzole"
          help={consoleState.help}
          disabled={!consoleState.enabled}
          onClick={() => app.openConsoleForSelection()}
        />
      </div>

      <div className="tool-group zoom-group" role="group" aria-label="Lupa">
        <ToolButton icon="zoomOut" label="Oddálit" help="Oddálit" disabled={!viewport.canZoomOut} onClick={() => viewport.zoomOut()} />
        <ToolButton label="Skutečná velikost" help="Skutečná velikost (100 %)" onClick={() => viewport.reset()}>
          <span className="zoom-percent">{viewport.zoomPercent}&nbsp;%</span>
        </ToolButton>
        <ToolButton icon="zoomIn" label="Přiblížit" help="Přiblížit" disabled={!viewport.canZoomIn} onClick={() => viewport.zoomIn()} />
      </div>

      <MenuButton label="Export" title="Exportovat plátno jako obrázek nebo PDF" items={exportItems} align="end">
        <Icon name="share" />
        <Icon name="chevronDown" size={11} />
      </MenuButton>
      <ToolButton
        icon="sidebarRight"
        label="Inspektor"
        help={app.inspectorVisible ? "Skrýt inspektor" : "Zobrazit inspektor"}
        pressed={app.inspectorVisible}
        onClick={() => (app.inspectorVisible = !app.inspectorVisible)}
      />
    </header>
  );
});
