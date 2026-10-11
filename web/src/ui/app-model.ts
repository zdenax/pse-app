// App-level state and commands shared by the toolbar, the palette, the inspector, the keyboard
// shortcuts and the console windows. The document itself lives in the store; this class only
// adds what the shell needs around it. Framework-free port of Sources/NetSketch/AppModel.swift.

import type { Device } from "../core/model";
import type { ProjectStoreAPI } from "../core/store-api";
import { ConsoleManager, type Area, type ConsoleBackend } from "./console-manager";
import { plural, withExtension, withoutExtension } from "./czech";
import { consoleShortcutLabel } from "./platform";
import type { ExportKind, ProjectFiles, WritableFileHandle } from "./files";
import { bundleOfLink, findDevice, freeSpot, selectedIDs } from "./project-helpers";
import { Viewport } from "./viewport";

/** A message shown as a small modal alert. */
export interface AppAlert {
  id: number;
  title: string;
  message: string;
}

/**
 * Canvas exporters, supplied by the canvas implementation. Each renders the current project and
 * returns the file contents, or null when there is nothing to export.
 */
export interface ExportHandlers {
  png?: (store: ProjectStoreAPI) => Blob | null | Promise<Blob | null>;
  pdf?: (store: ProjectStoreAPI) => Blob | null | Promise<Blob | null>;
  svg?: (store: ProjectStoreAPI) => Blob | null | Promise<Blob | null>;
}

export interface AppModelOptions {
  store: ProjectStoreAPI;
  consoles: ConsoleBackend;
  files: ProjectFiles;
  exporters?: ExportHandlers;
  /** Asks a yes/no question; window.confirm in the browser. */
  confirm?: (message: string) => boolean;
  /** Runs a function after the next layout (the canvas learns its content then). */
  afterLayout?: (fn: () => void) => void;
  viewport?: Viewport;
  /** Where per-user conveniences are remembered; the browser's local storage by default. */
  settings?: SettingsStorage;
}

/** A tiny key-value store for remembered toolbar settings. Reads and writes never throw. */
export interface SettingsStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Local storage of the page; blocked or missing storage (private window) just forgets. */
export const browserSettings: SettingsStorage = {
  get(key) {
    try {
      return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
    } catch {
      // Storage full or blocked: the setting lasts until the page is closed.
    }
  },
};

/** Key of the "Animace paketů" toggle in the settings. */
export const packetAnimationKey = "netsketch.packetAnimation";

const exportTitles: Record<ExportKind, { menu: string; failed: string; empty: string }> = {
  png: {
    menu: "Exportovat jako PNG…",
    failed: "Export do PNG se nezdařil",
    empty: "Projekt je prázdný nebo se obrázek nepodařilo vykreslit.",
  },
  pdf: {
    menu: "Exportovat jako PDF…",
    failed: "Export do PDF se nezdařil",
    empty: "Projekt je prázdný nebo se dokument nepodařilo vykreslit.",
  },
  svg: {
    menu: "Exportovat jako SVG…",
    failed: "Export do SVG se nezdařil",
    empty: "Projekt je prázdný nebo se obrázek nepodařilo vykreslit.",
  },
};

/** Czech message of any error (EditError carries a ready Czech `message`). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

export class AppModel {
  readonly store: ProjectStoreAPI;
  readonly viewport: Viewport;
  readonly consoles: ConsoleManager;
  readonly exporters: ExportHandlers;
  private readonly files: ProjectFiles;
  private readonly confirmQuestion: (message: string) => boolean;
  private readonly afterLayout: (fn: () => void) => void;

  private readonly settings: SettingsStorage;
  private _inspectorVisible = true;
  private _paletteVisible = true;
  private _packetAnimation = true;
  private _alert: AppAlert | null = null;
  private _deviceEditorOpen = false;
  private alertCounter = 0;
  /** Where "Uložit" writes without asking; null when the browser gave us no writable handle. */
  private fileHandle: WritableFileHandle | null = null;
  private didReportCatalog = false;

  private _version = 0;
  private listeners = new Set<() => void>();

  constructor(options: AppModelOptions) {
    this.store = options.store;
    this.viewport = options.viewport ?? new Viewport();
    this.files = options.files;
    this.exporters = options.exporters ?? {};
    this.consoles = new ConsoleManager(options.store, options.consoles);
    this.settings = options.settings ?? browserSettings;
    this._packetAnimation = this.settings.get(packetAnimationKey) !== "off";
    this.confirmQuestion =
      options.confirm ?? ((message) => (typeof window === "undefined" ? true : window.confirm(message)));
    this.afterLayout =
      options.afterLayout ??
      ((fn) => {
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => fn());
        else setTimeout(fn, 0);
      });
  }

  /** Starts following the store (console windows). Pair with detach(). */
  attach(): void {
    this.consoles.start();
    if (!this.didReportCatalog) {
      this.didReportCatalog = true;
      this.reportCatalogIssues();
    }
  }

  detach(): void {
    this.consoles.stop();
  }

  // MARK: Observation

  get version(): number {
    return this._version;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    this._version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  // MARK: Shell state

  get inspectorVisible(): boolean {
    return this._inspectorVisible;
  }

  set inspectorVisible(value: boolean) {
    if (value === this._inspectorVisible) return;
    this._inspectorVisible = value;
    this.changed();
  }

  get paletteVisible(): boolean {
    return this._paletteVisible;
  }

  set paletteVisible(value: boolean) {
    if (value === this._paletteVisible) return;
    this._paletteVisible = value;
    this.changed();
  }

  /** Whether packets of ping and traceroute are animated on the canvas (remembered). */
  get packetAnimation(): boolean {
    return this._packetAnimation;
  }

  set packetAnimation(value: boolean) {
    if (value === this._packetAnimation) return;
    this._packetAnimation = value;
    this.settings.set(packetAnimationKey, value ? "on" : "off");
    this.changed();
  }

  get deviceEditorOpen(): boolean {
    return this._deviceEditorOpen;
  }

  set deviceEditorOpen(value: boolean) {
    if (value === this._deviceEditorOpen) return;
    this._deviceEditorOpen = value;
    this.changed();
  }

  get alert(): AppAlert | null {
    return this._alert;
  }

  showAlert(title: string, message: string): void {
    this.alertCounter += 1;
    this._alert = { id: this.alertCounter, title, message };
    this.changed();
  }

  dismissAlert(): void {
    if (!this._alert) return;
    this._alert = null;
    this.changed();
  }

  /** True while a modal (alert or dialog) is shown; global shortcuts pause then. */
  get isModalOpen(): boolean {
    return this._alert !== null || this._deviceEditorOpen;
  }

  // MARK: Errors

  present(error: unknown, title: string): void {
    this.showAlert(title, errorMessage(error));
  }

  /** Runs an editing operation and shows its error, if any. Returns true on success. */
  perform(title: string, body: () => void): boolean;
  perform(body: () => void): boolean;
  perform(titleOrBody: string | (() => void), maybeBody?: () => void): boolean {
    const title = typeof titleOrBody === "string" ? titleOrBody : "Akci nelze provést";
    const body = typeof titleOrBody === "string" ? maybeBody! : titleOrBody;
    try {
      body();
      return true;
    } catch (error) {
      this.present(error, title);
      return false;
    }
  }

  private reportCatalogIssues(): void {
    const catalog = this.store.catalog;
    if (catalog.templates.length === 0) {
      this.showAlert(
        "Katalog zařízení je prázdný",
        "Soubor devices.json se nepodařilo najít nebo načíst. Vlastní zařízení lze přidat tlačítkem „Nové zařízení…“." +
          (catalog.loadIssues.length === 0 ? "" : "\n\n" + catalog.loadIssues.join("\n")),
      );
    } else if (catalog.loadIssues.length > 0) {
      this.showAlert("Katalog zařízení se nenačetl celý", catalog.loadIssues.join("\n"));
    }
  }

  // MARK: Document

  /** File name without extension, the project name, or a placeholder. */
  get documentName(): string {
    if (this.store.fileName) return withoutExtension(this.store.fileName);
    const name = this.store.project.name.trim();
    return name === "" ? "Bez názvu" : name;
  }

  get windowTitle(): string {
    const name = this.store.fileName ?? this.documentName;
    return this.store.isDirty ? `${name} — upraveno` : name;
  }

  /**
   * Asks about unsaved changes. Returns true when it is fine to throw the current project away
   * (nothing to lose, or the user agreed to lose the changes).
   */
  confirmDiscardingChanges(): boolean {
    if (!this.store.isDirty) return true;
    return this.confirmQuestion(
      `Projekt „${this.documentName}“ obsahuje neuložené změny. Pokud je neuložíte, budou ztraceny.\n\nPokračovat bez uložení?`,
    );
  }

  newDocument(): void {
    if (!this.confirmDiscardingChanges()) return;
    this.store.newProject();
    this.fileHandle = null;
    this.viewport.set(1, { x: 0, y: 0 });
    this.changed();
  }

  async openDocument(): Promise<void> {
    if (!this.confirmDiscardingChanges()) return;
    let opened;
    try {
      opened = await this.files.openProject();
    } catch (error) {
      this.present(error, "Soubor se nepodařilo otevřít");
      return;
    }
    if (!opened) return;
    this.openText(opened.text, opened.name, opened.handle);
  }

  /** Opens project text without asking about unsaved changes. Returns true on success. */
  openText(text: string, fileName: string, handle: WritableFileHandle | null = null): boolean {
    try {
      this.store.openText(text, fileName);
    } catch (error) {
      this.present(error, `Soubor „${fileName}“ se nepodařilo otevřít`);
      return false;
    }
    this.fileHandle = handle;
    const issues = [...new Set(this.store.openIssues)];
    if (this.store.openIssues.length > 0) {
      const count = this.store.openIssues.length;
      this.showAlert(
        "Soubor obsahoval nekonzistence",
        `Při otevření bylo opraveno ${count} ${plural(count, "nekonzistence", "nekonzistence", "nekonzistencí")}. ` +
          "Chybné objekty byly vynechány; původní soubor se změní až po uložení.\n\n" +
          issues.join("\n"),
      );
    }
    this.changed();
    // The canvas learns its content after the next layout pass; fit the view then.
    this.afterLayout(() => this.viewport.fit());
    return true;
  }

  /** "Uložit": writes into the same file when the browser allows it, otherwise like saveAs(). */
  async save(): Promise<boolean> {
    if (!this.fileHandle) return this.saveAs();
    return this.write(this.fileHandle);
  }

  async saveAs(): Promise<boolean> {
    return this.write(null);
  }

  private async write(handle: WritableFileHandle | null): Promise<boolean> {
    try {
      const text = this.store.serialize();
      const suggested = withExtension(this.documentName, "netsketch");
      const saved = await this.files.saveProject(text, suggested, handle);
      if (!saved) return false;
      this.fileHandle = saved.handle;
      this.store.markSaved(saved.name);
      this.changed();
      return true;
    } catch (error) {
      this.present(error, "Projekt se nepodařilo uložit");
      return false;
    }
  }

  // MARK: Export

  canExport(kind: ExportKind): boolean {
    return typeof this.exporters[kind] === "function";
  }

  exportMenuTitle(kind: ExportKind): string {
    return exportTitles[kind].menu;
  }

  async exportAs(kind: ExportKind): Promise<boolean> {
    const exporter = this.exporters[kind];
    const titles = exportTitles[kind];
    if (!exporter) {
      this.showAlert(titles.failed, "Export bude k dispozici, až bude hotové plátno.");
      return false;
    }
    let data: Blob | null;
    try {
      data = await exporter(this.store);
    } catch (error) {
      this.present(error, titles.failed);
      return false;
    }
    if (!data) {
      this.showAlert(titles.failed, titles.empty);
      return false;
    }
    try {
      return await this.files.saveExport(data, withExtension(this.documentName, kind), kind);
    } catch (error) {
      this.present(error, "Export se nepodařilo uložit");
      return false;
    }
  }

  // MARK: Editing commands

  undo(): void {
    this.store.undo();
  }

  redo(): void {
    this.store.redo();
  }

  deleteSelection(): void {
    if (this.store.selection.length === 0) return;
    this.perform("Výběr nelze smazat", () => this.store.removeSelection());
  }

  selectAll(): void {
    this.store.selectAll();
  }

  /** Adds a device from the catalog at a free spot near the middle of the visible canvas. */
  addDevice(templateID: string): void {
    const point = freeSpot(this.store.project, this.viewport.visibleCenter());
    this.perform("Zařízení nelze přidat", () => {
      const device = this.store.addDevice(templateID, point);
      this.store.selection = [{ kind: "device", id: device.id }];
    });
  }

  /** Adds a text label near the middle of the visible canvas and selects it for editing. */
  addAnnotation(): void {
    const center = this.viewport.visibleCenter();
    const point = freeSpot(this.store.project, { x: center.x - 60, y: center.y - 120 });
    this.perform("Poznámku nelze přidat", () => {
      const annotation = this.store.addAnnotation("Poznámka", point);
      this.store.selection = [{ kind: "annotation", id: annotation.id }];
    });
    this.inspectorVisible = true;
  }

  get selectedLinkIDs(): string[] {
    return selectedIDs(this.store.selection, "link");
  }

  get canBundleSelection(): boolean {
    return this.selectedLinkIDs.length >= 2;
  }

  get selectionHasBundle(): boolean {
    const project = this.store.project;
    return this.selectedLinkIDs.some((id) => bundleOfLink(project, id) !== undefined);
  }

  /** Groups the selected links into a bundle (LAG). Returns true on success. */
  bundleSelectedLinks(label?: string): boolean {
    const ids = this.selectedLinkIDs;
    return this.perform("Kabely nelze seskupit", () => {
      this.store.createBundle(ids, label);
    });
  }

  /** Dissolves every bundle that has a member among the selected links. */
  unbundleSelectedLinks(): void {
    const project = this.store.project;
    const bundleIDs = new Set<string>();
    for (const id of this.selectedLinkIDs) {
      const bundle = bundleOfLink(project, id);
      if (bundle) bundleIDs.add(bundle.id);
    }
    if (bundleIDs.size === 0) return;
    this.store.beginUndoGroup();
    try {
      for (const id of bundleIDs) {
        if (!this.perform("Svazek nelze zrušit", () => this.store.unbundle(id))) return;
      }
    } finally {
      this.store.endUndoGroup();
    }
  }

  /** The device when exactly one device (and nothing else) is selected. */
  get singleSelectedDevice(): Device | undefined {
    const selection = this.store.selection;
    if (selection.length !== 1 || selection[0].kind !== "device") return undefined;
    return findDevice(this.store.project, selection[0].id);
  }

  // MARK: Console

  /** Why the console of this device cannot be opened; null when it can. */
  consoleUnavailableReason(device: Device): string | null {
    return this.consoles.supportsConsole(device) ? null : "Toto zařízení nemá konfigurační konzoli.";
  }

  /** Tooltip / disabled state of the "Konzole" toolbar button. */
  get consoleCommandState(): { enabled: boolean; help: string } {
    const device = this.singleSelectedDevice;
    if (!device) return { enabled: false, help: "Otevřít konzoli: nejprve vyberte jedno zařízení" };
    const reason = this.consoleUnavailableReason(device);
    return reason ? { enabled: false, help: reason } : { enabled: true, help: `Otevřít konzoli zařízení ${device.hostname} (${consoleShortcutLabel()})` };
  }

  openConsole(deviceID: string, area?: Area): void {
    const device = findDevice(this.store.project, deviceID);
    if (!device) return;
    const reason = this.consoleUnavailableReason(device);
    if (reason) {
      this.showAlert("Konzoli nelze otevřít", reason);
      return;
    }
    this.consoles.open(deviceID, area ?? AppModel.screenArea());
  }

  openConsoleForSelection(): void {
    const device = this.singleSelectedDevice;
    if (device) this.openConsole(device.id);
  }

  private static screenArea(): Area {
    if (typeof window === "undefined") return { width: 1280, height: 800 };
    return { width: window.innerWidth, height: window.innerHeight };
  }
}
