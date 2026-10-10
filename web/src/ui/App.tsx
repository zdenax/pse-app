// The main window: palette, canvas and inspector, plus the toolbar, the console windows and the
// alerts. Port of Sources/NetSketch/Views/ContentView.swift (layout) and of the parts of
// NetSketchApp/AppModel that wire keyboard shortcuts and the unsaved-changes guard.
//
// Everything the shell needs from the other modules is injected through props, so this file
// imports no implementation from src/core or src/cli (see ui/wiring.ts).

import { useEffect, useState } from "react";
import type { Device } from "../core/model";
import type { ProjectStoreAPI } from "../core/store-api";
import type { ConsoleSession } from "../cli/session-api";
import { AppModel, type ExportHandlers } from "./app-model";
import { CanvasHost } from "./CanvasHost";
import { ConsoleWindows } from "./ConsoleWindows";
import { AlertHost, DeviceEditorHost } from "./Dialogs";
import { browserFiles, type ProjectFiles } from "./files";
import { Inspector } from "./Inspector";
import { Palette } from "./Palette";
import { isMac } from "./platform";
import { isEditingText, shortcutFor, type ShortcutCommand } from "./shortcuts";
import { AppModelProvider, useObservable } from "./store-context";
import { Toolbar } from "./Toolbar";
import "./styles.css";

export interface AppProps {
  /** The editing engine (src/core/store.ts, ProjectStore). */
  store: ProjectStoreAPI;
  /** Opens a console session of a device (src/cli). */
  createSession: (deviceID: string) => ConsoleSession;
  /** Whether a device has a configuration console (src/cli). */
  supportsConsole: (device: Device) => boolean;
  /** Canvas exporters (PNG/PDF/SVG); menu items without one are disabled. */
  exporters?: ExportHandlers;
  /** File access; defaults to the browser implementation (File System Access API or fallbacks). */
  files?: ProjectFiles;
  /** Yes/no question for unsaved changes; defaults to window.confirm. */
  confirm?: (message: string) => boolean;
}

/** What ui/wiring.ts hands to <App>. */
export type AppWiring = Pick<AppProps, "store" | "createSession" | "supportsConsole" | "exporters">;

export function App(props: AppProps) {
  const [app] = useState(
    () =>
      new AppModel({
        store: props.store,
        consoles: { createSession: props.createSession, supportsConsole: props.supportsConsole },
        exporters: props.exporters,
        files: props.files ?? browserFiles,
        confirm: props.confirm,
      }),
  );

  useEffect(() => {
    app.attach();
    return () => app.detach();
  }, [app]);

  return (
    <AppModelProvider app={app}>
      <AppShell app={app} />
    </AppModelProvider>
  );
}

function AppShell({ app }: { app: AppModel }) {
  useObservable(app);
  const store = app.store;
  const storeVersion = useObservable(store);

  // Window title with the dirty marker, like the Mac title bar.
  useEffect(() => {
    document.title = `${app.windowTitle} – NetSketch`;
  }, [app, storeVersion]);

  // Unsaved changes: the browser asks before the page goes away.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!store.isDirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [store]);

  // Keyboard shortcuts of the main window.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || app.isModalOpen) return;
      const command = shortcutFor(event, isMac, isEditingText(document.activeElement));
      if (!command) return;
      if (command === "delete" && store.selection.length === 0) return;
      event.preventDefault();
      runShortcut(app, command);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [app, store]);

  const className = [
    "app",
    app.paletteVisible ? "with-palette" : "",
    app.inspectorVisible ? "with-inspector" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className}>
      <Toolbar />
      {app.paletteVisible && <Palette />}
      <main className="canvas-area" aria-label="Plátno">
        <CanvasHost store={store} viewport={app.viewport} />
      </main>
      {app.inspectorVisible && <Inspector />}
      <ConsoleWindows />
      <DeviceEditorHost />
      <AlertHost />
    </div>
  );
}

function runShortcut(app: AppModel, command: ShortcutCommand): void {
  const store = app.store;
  switch (command) {
    case "new":
      app.newDocument();
      break;
    case "open":
      void app.openDocument();
      break;
    case "save":
      void app.save();
      break;
    case "saveAs":
      void app.saveAs();
      break;
    case "undo":
      app.undo();
      break;
    case "redo":
      app.redo();
      break;
    case "console":
      app.openConsoleForSelection();
      break;
    case "viewPhysical":
      store.viewMode = "physical";
      break;
    case "viewLogical":
      store.viewMode = "logical";
      break;
    case "zoomIn":
      app.viewport.zoomIn();
      break;
    case "zoomOut":
      app.viewport.zoomOut();
      break;
    case "zoomReset":
      app.viewport.reset();
      break;
    case "zoomFit":
      app.viewport.fit();
      break;
    case "delete":
      app.deleteSelection();
      break;
    case "selectAll":
      app.selectAll();
      break;
    case "bundle":
      if (app.canBundleSelection) app.bundleSelectedLinks();
      break;
    case "unbundle":
      app.unbundleSelectedLinks();
      break;
    case "addNote":
      app.addAnnotation();
      break;
  }
}
