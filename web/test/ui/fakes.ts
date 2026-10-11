// In-memory fakes for testing the UI shell without src/core and src/cli implementations.
// FakeStore implements ProjectStoreAPI with plain snapshots for undo; FakeSession implements
// ConsoleSession with a tiny scripted IOS-like command set.

import type {
  Annotation,
  CableType,
  Device,
  DeviceTemplate,
  Link,
  LinkBundle,
  LinkEnd,
  LinkStatus,
  Point,
  PortRef,
  Project,
  StaticRoute,
  VLANEntry,
  ViewMode,
} from "../../src/core/model";
import type { DeviceProtocols } from "../../src/core/protocols";
import type {
  CatalogAPI,
  EditErrorCode,
  PortClickResult,
  ProjectStoreAPI,
  SelectionItem,
} from "../../src/core/store-api";
import type { CLIDialect, ConsoleSession } from "../../src/cli/session-api";
import { categoryOrder, portNames } from "../../src/ui/czech";
import type { ExportKind, OpenedFile, ProjectFiles, SavedFile, WritableFileHandle } from "../../src/ui/files";

export class FakeEditError extends Error {
  constructor(
    readonly code: EditErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const sampleTemplates: DeviceTemplate[] = [
  {
    id: "cisco-catalyst-2960-24",
    vendor: "Cisco",
    model: "Catalyst 2960-24",
    category: "switch",
    portGroups: [
      { prefix: "Fa0/", rangeStart: 1, rangeEnd: 24, speed: "100M", connector: "RJ45" },
      { prefix: "Gi0/", rangeStart: 1, rangeEnd: 2, speed: "1G", connector: "RJ45" },
      { names: ["Console"], speed: "", connector: "console" },
    ],
  },
  {
    id: "cisco-isr-4321",
    vendor: "Cisco",
    model: "ISR 4321",
    category: "router",
    portGroups: [{ prefix: "Gi0/0/", rangeStart: 0, rangeEnd: 1, speed: "1G", connector: "RJ45", verified: true }],
    verified: true,
  },
  {
    id: "generic-pc",
    vendor: "Generic",
    model: "PC",
    category: "PC",
    portGroups: [{ names: ["eth0"], speed: "1G", connector: "RJ45" }],
  },
  {
    id: "generic-ap",
    vendor: "Generic",
    model: "Access Point",
    category: "AP",
    portGroups: [
      { names: ["eth0"], speed: "1G", connector: "RJ45" },
      { names: ["wlan0"], speed: "", connector: "wireless" },
    ],
  },
];

export class FakeCatalog implements CatalogAPI {
  constructor(
    readonly templates: DeviceTemplate[] = sampleTemplates,
    readonly loadIssues: string[] = [],
  ) {}

  template(id: string): DeviceTemplate | undefined {
    return this.templates.find((template) => template.id === id);
  }

  get groups(): { category: Device["category"]; templates: DeviceTemplate[] }[] {
    return categoryOrder
      .map((category) => ({ category, templates: this.templates.filter((t) => t.category === category) }))
      .filter((group) => group.templates.length > 0);
  }
}

export function emptyProject(name = "Bez názvu"): Project {
  return { formatVersion: 1, name, devices: [], links: [], bundles: [], annotations: [], viewMode: "physical" };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class FakeStore implements ProjectStoreAPI {
  readonly catalog: CatalogAPI;
  private _project: Project;
  private _version = 0;
  private listeners = new Set<() => void>();
  private _selection: SelectionItem[] = [];
  private _snapToGrid = false;
  private _activeCableType: CableType = "straight";
  gridSize = 20;
  pendingPort: PortRef | null = null;
  fileName: string | null = null;
  isDirty = false;
  openIssues: string[] = [];
  /** Issues reported by the next openText() call (test hook). */
  nextOpenIssues: string[] = [];
  private undoStack: Project[] = [];
  private redoStack: Project[] = [];
  private groupDepth = 0;
  private groupStart: Project | null = null;
  private counter = 0;

  constructor(catalog: CatalogAPI = new FakeCatalog(), project: Project = emptyProject()) {
    this.catalog = catalog;
    this._project = project;
  }

  // MARK: Observation

  get project(): Project {
    return this._project;
  }

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

  private newID(): string {
    this.counter += 1;
    return `00000000-0000-0000-0000-${String(this.counter).padStart(12, "0")}`;
  }

  private mutate(body: (draft: Project) => void): void {
    const before = this._project;
    const draft = clone(before);
    body(draft);
    if (JSON.stringify(draft) === JSON.stringify(before)) return;
    if (this.groupDepth === 0) {
      this.undoStack.push(before);
      this.redoStack = [];
    }
    this._project = draft;
    this.isDirty = true;
    this.pruneSelection();
    this.changed();
  }

  private pruneSelection(): void {
    this._selection = this._selection.filter((item) => this.exists(item));
  }

  private exists(item: SelectionItem): boolean {
    const p = this._project;
    if (item.kind === "device") return p.devices.some((d) => d.id === item.id);
    if (item.kind === "link") return p.links.some((l) => l.id === item.id);
    return p.annotations.some((a) => a.id === item.id);
  }

  private device(draft: Project, id: string): Device {
    const device = draft.devices.find((d) => d.id === id);
    if (!device) throw new FakeEditError("unknownDevice", "Zařízení už v projektu není.");
    return device;
  }

  private link(draft: Project, id: string): Link {
    const link = draft.links.find((l) => l.id === id);
    if (!link) throw new FakeEditError("unknownLink", "Kabel už v projektu není.");
    return link;
  }

  // MARK: Settings

  get selection(): SelectionItem[] {
    return this._selection;
  }

  set selection(items: SelectionItem[]) {
    this._selection = items.filter((item) => this.exists(item));
    this.changed();
  }

  get snapToGrid(): boolean {
    return this._snapToGrid;
  }

  set snapToGrid(value: boolean) {
    this._snapToGrid = value;
    this.changed();
  }

  get activeCableType(): CableType {
    return this._activeCableType;
  }

  set activeCableType(value: CableType) {
    this._activeCableType = value;
    this.changed();
  }

  get viewMode(): ViewMode {
    return this._project.viewMode;
  }

  set viewMode(value: ViewMode) {
    this._project = { ...this._project, viewMode: value };
    this.changed();
  }

  // MARK: Undo

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const previous = this.undoStack.pop();
    if (!previous) return false;
    this.redoStack.push(this._project);
    this._project = previous;
    this.isDirty = true;
    this.pruneSelection();
    this.changed();
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this._project);
    this._project = next;
    this.isDirty = true;
    this.pruneSelection();
    this.changed();
    return true;
  }

  beginUndoGroup(): void {
    if (this.groupDepth === 0) this.groupStart = this._project;
    this.groupDepth += 1;
  }

  endUndoGroup(): void {
    this.groupDepth = Math.max(0, this.groupDepth - 1);
    if (this.groupDepth === 0 && this.groupStart && this.groupStart !== this._project) {
      this.undoStack.push(this.groupStart);
      this.redoStack = [];
    }
    if (this.groupDepth === 0) this.groupStart = null;
  }

  cancelUndoGroup(): void {
    if (this.groupStart) this._project = this.groupStart;
    this.groupDepth = 0;
    this.groupStart = null;
    this.changed();
  }

  // MARK: Selection

  select(item: SelectionItem, extending = false): void {
    if (!extending) {
      this.selection = [item];
      return;
    }
    this.selection = this.isSelected(item)
      ? this._selection.filter((other) => !(other.kind === item.kind && other.id === item.id))
      : [...this._selection, item];
  }

  clearSelection(): void {
    this.selection = [];
  }

  selectAll(): void {
    const p = this._project;
    this.selection = [
      ...p.devices.map((d) => ({ kind: "device" as const, id: d.id })),
      ...p.links.map((l) => ({ kind: "link" as const, id: l.id })),
      ...p.annotations.map((a) => ({ kind: "annotation" as const, id: a.id })),
    ];
  }

  removeSelection(): void {
    const devices = new Set(this._selection.filter((i) => i.kind === "device").map((i) => i.id));
    const links = new Set(this._selection.filter((i) => i.kind === "link").map((i) => i.id));
    const notes = new Set(this._selection.filter((i) => i.kind === "annotation").map((i) => i.id));
    this.mutate((draft) => {
      draft.devices = draft.devices.filter((d) => !devices.has(d.id));
      draft.links = draft.links.filter(
        (l) => !links.has(l.id) && !devices.has(l.a.deviceID) && !devices.has(l.b.deviceID),
      );
      draft.annotations = draft.annotations.filter((a) => !notes.has(a.id));
    });
    this.selection = [];
  }

  isSelected(item: SelectionItem): boolean {
    return this._selection.some((other) => other.kind === item.kind && other.id === item.id);
  }

  // MARK: Devices

  nextHostname(category: Device["category"]): string {
    const prefix = { switch: "SW", router: "R", "L3 switch": "L3SW", AP: "AP", PC: "PC", server: "SRV" }[category];
    let n = 1;
    while (this._project.devices.some((d) => d.hostname === `${prefix}${n}`)) n += 1;
    return `${prefix}${n}`;
  }

  addDevice(templateID: string, at: Point, hostname?: string): Device {
    const template = this.catalog.template(templateID);
    if (!template) throw new FakeEditError("unknownTemplate", `Šablona zařízení „${templateID}“ v katalogu neexistuje.`);
    return this.addDeviceFromTemplate(template, at, hostname);
  }

  addDeviceFromTemplate(template: DeviceTemplate, at: Point, hostname?: string): Device {
    const device: Device = {
      id: this.newID(),
      templateID: template.id,
      vendor: template.vendor,
      model: template.model,
      category: template.category,
      hostname: hostname ?? this.nextHostname(template.category),
      position: { ...at },
      ports: template.portGroups.flatMap((group, groupIndex) =>
        portNames(group).map((name) => ({
          id: this.newID(),
          name,
          connector: group.connector,
          speed: group.speed,
          verified: group.verified ?? false,
          description: "",
          vlan: "",
          groupIndex,
          adminDown: false,
        })),
      ),
      note: "",
      layout: { rows: 2, sections: [] },
      verified: template.verified ?? false,
      vlans: [],
      addresses: [],
      defaultGateway: "",
      staticRoutes: [],
    };
    this.mutate((draft) => {
      draft.devices.push(device);
    });
    return device;
  }

  removeDevices(ids: string[]): void {
    const set = new Set(ids);
    this.mutate((draft) => {
      draft.devices = draft.devices.filter((d) => !set.has(d.id));
      draft.links = draft.links.filter((l) => !set.has(l.a.deviceID) && !set.has(l.b.deviceID));
    });
  }

  renameDevice(id: string, hostname: string): void {
    const name = hostname.trim();
    if (name === "") throw new FakeEditError("emptyName", "Název nesmí být prázdný.");
    this.mutate((draft) => {
      this.device(draft, id).hostname = name;
    });
  }

  setDeviceNote(id: string, note: string): void {
    this.mutate((draft) => {
      this.device(draft, id).note = note;
    });
  }

  setVLANs(deviceID: string, vlans: VLANEntry[]): void {
    this.mutate((draft) => {
      this.device(draft, deviceID).vlans = clone(vlans);
    });
  }

  setPosition(deviceID: string, to: Point): void {
    this.mutate((draft) => {
      this.device(draft, deviceID).position = { ...to };
    });
  }

  snap(point: Point): Point {
    return {
      x: Math.round(point.x / this.gridSize) * this.gridSize,
      y: Math.round(point.y / this.gridSize) * this.gridSize,
    };
  }

  // MARK: Ports

  private port(draft: Project, ref: PortRef) {
    const port = this.device(draft, ref.deviceID).ports.find((p) => p.id === ref.portID);
    if (!port) throw new FakeEditError("unknownPort", "Port nebo jeho zařízení už v projektu není.");
    return port;
  }

  setPortDescription(ref: PortRef, text: string): void {
    this.mutate((draft) => {
      this.port(draft, ref).description = text;
    });
  }

  setPortVLAN(ref: PortRef, text: string): void {
    this.mutate((draft) => {
      this.port(draft, ref).vlan = text;
    });
  }

  setPortAdminDown(ref: PortRef, down: boolean): void {
    this.mutate((draft) => {
      this.port(draft, ref).adminDown = down;
    });
  }

  setAddress(deviceID: string, interfaceID: string, address: string | null): void {
    this.mutate((draft) => {
      const device = this.device(draft, deviceID);
      device.addresses = device.addresses.filter((entry) => entry.interface !== interfaceID);
      if (address) device.addresses.push({ interface: interfaceID, address });
    });
  }

  setDefaultGateway(deviceID: string, gateway: string): void {
    this.mutate((draft) => {
      this.device(draft, deviceID).defaultGateway = gateway;
    });
  }

  setStaticRoutes(deviceID: string, routes: StaticRoute[]): void {
    this.mutate((draft) => {
      this.device(draft, deviceID).staticRoutes = clone(routes);
    });
  }

  // MARK: Moving

  moveDevices(ids: string[], delta: Point): void {
    this.mutate((draft) => {
      for (const id of ids) {
        const device = this.device(draft, id);
        device.position = { x: device.position.x + delta.x, y: device.position.y + delta.y };
      }
    });
  }

  beginDrag(): void {
    this.beginUndoGroup();
  }

  drag(items: SelectionItem[], translation: Point): void {
    this.moveDevices(
      items.filter((item) => item.kind === "device").map((item) => item.id),
      translation,
    );
  }

  endDrag(): void {
    this.endUndoGroup();
  }

  cancelDrag(): void {
    this.cancelUndoGroup();
  }

  // MARK: Cables

  isPortUsed(ref: PortRef): boolean {
    return this._project.links.some(
      (l) =>
        (l.a.deviceID === ref.deviceID && l.a.portID === ref.portID) ||
        (l.b.deviceID === ref.deviceID && l.b.portID === ref.portID),
    );
  }

  connect(a: PortRef, b: PortRef, cable: CableType = this._activeCableType): Link {
    if (a.deviceID === b.deviceID) throw new FakeEditError("sameDevice", "Kabel nelze zapojit oběma konci do stejného zařízení.");
    if (this.isPortUsed(a) || this.isPortUsed(b)) {
      throw new FakeEditError("portInUse", "V portu už kabel je. Do jednoho portu lze zapojit jen jeden kabel.");
    }
    const link: Link = { id: this.newID(), a, b, cableType: cable, statusA: "none", statusB: "none", note: "" };
    this.mutate((draft) => {
      this.port(draft, a);
      this.port(draft, b);
      draft.links.push(link);
    });
    return link;
  }

  clickPort(ref: PortRef): PortClickResult {
    if (!this.pendingPort) {
      this.pendingPort = ref;
      this.changed();
      return { kind: "pending", port: ref };
    }
    const first = this.pendingPort;
    this.pendingPort = null;
    if (first.deviceID === ref.deviceID && first.portID === ref.portID) {
      this.changed();
      return { kind: "cancelled" };
    }
    return { kind: "connected", link: this.connect(first, ref) };
  }

  cancelPendingPort(): void {
    this.pendingPort = null;
    this.changed();
  }

  removeLink(id: string): void {
    this.mutate((draft) => {
      this.link(draft, id);
      draft.links = draft.links.filter((l) => l.id !== id);
      for (const bundle of draft.bundles) bundle.linkIDs = bundle.linkIDs.filter((linkID) => linkID !== id);
      draft.bundles = draft.bundles.filter((bundle) => bundle.linkIDs.length >= 2);
    });
  }

  setCableType(linkID: string, type: CableType): void {
    this.mutate((draft) => {
      this.link(draft, linkID).cableType = type;
    });
  }

  setStatus(linkID: string, end: LinkEnd, status: LinkStatus): void {
    this.mutate((draft) => {
      const link = this.link(draft, linkID);
      if (end === "a") link.statusA = status;
      else link.statusB = status;
    });
  }

  cycleStatus(linkID: string, end: LinkEnd): LinkStatus {
    const link = this.link(this._project, linkID);
    const order: LinkStatus[] = ["none", "green", "orange", "red"];
    const current = end === "a" ? link.statusA : link.statusB;
    const next = order[(order.indexOf(current) + 1) % order.length];
    this.setStatus(linkID, end, next);
    return next;
  }

  setProtocols(deviceID: string, protocols: DeviceProtocols): void {
    this.mutate((draft) => {
      const device = this.device(draft, deviceID);
      if (Object.keys(protocols).length === 0) delete device.protocols;
      else device.protocols = clone(protocols);
    });
  }

  setLinkQuality(linkID: string, quality: { delay?: number; loss?: number }): void {
    this.mutate((draft) => {
      const link = this.link(draft, linkID);
      delete link.delay;
      delete link.loss;
      if ((quality.delay ?? 0) > 0) link.delay = quality.delay;
      if ((quality.loss ?? 0) > 0) link.loss = Math.min(100, quality.loss ?? 0);
    });
  }

  setLinkNote(linkID: string, note: string): void {
    this.mutate((draft) => {
      this.link(draft, linkID).note = note;
    });
  }

  // MARK: Bundles

  createBundle(linkIDs: string[], label?: string): LinkBundle {
    if (linkIDs.length < 2) throw new FakeEditError("bundleNeedsTwoLinks", "Svazek (LAG) potřebuje alespoň dva kabely.");
    const bundle: LinkBundle = { id: this.newID(), label: label?.trim() || "Po1", linkIDs: [...linkIDs] };
    this.mutate((draft) => {
      for (const id of linkIDs) {
        const link = this.link(draft, id);
        if (link.bundleID) {
          throw new FakeEditError(
            "linkAlreadyBundled",
            "Některý z vybraných kabelů už patří do jiného svazku. Nejprve ten svazek zrušte.",
          );
        }
        link.bundleID = bundle.id;
      }
      draft.bundles.push(bundle);
    });
    return bundle;
  }

  unbundle(id: string): void {
    this.mutate((draft) => {
      if (!draft.bundles.some((b) => b.id === id)) throw new FakeEditError("unknownBundle", "Svazek už v projektu není.");
      draft.bundles = draft.bundles.filter((b) => b.id !== id);
      for (const link of draft.links) if (link.bundleID === id) delete link.bundleID;
    });
  }

  renameBundle(id: string, label: string): void {
    this.mutate((draft) => {
      const bundle = draft.bundles.find((b) => b.id === id);
      if (!bundle) throw new FakeEditError("unknownBundle", "Svazek už v projektu není.");
      bundle.label = label;
    });
  }

  // MARK: Annotations

  addAnnotation(text: string, at: Point): Annotation {
    const annotation: Annotation = { id: this.newID(), text, position: { ...at } };
    this.mutate((draft) => {
      draft.annotations.push(annotation);
    });
    return annotation;
  }

  moveAnnotation(id: string, to: Point): void {
    this.mutate((draft) => {
      const note = draft.annotations.find((a) => a.id === id);
      if (note) note.position = { ...to };
    });
  }

  setAnnotationText(id: string, text: string): void {
    this.mutate((draft) => {
      const note = draft.annotations.find((a) => a.id === id);
      if (!note) throw new FakeEditError("unknownAnnotation", "Poznámka už v projektu není.");
      note.text = text;
    });
  }

  removeAnnotation(id: string): void {
    this.mutate((draft) => {
      draft.annotations = draft.annotations.filter((a) => a.id !== id);
    });
  }

  // MARK: Document

  renameProject(name: string): void {
    this.mutate((draft) => {
      draft.name = name;
    });
  }

  newProject(name?: string): void {
    this._project = emptyProject(name);
    this.fileName = null;
    this.isDirty = false;
    this.undoStack = [];
    this.redoStack = [];
    this._selection = [];
    this.changed();
  }

  openText(text: string, fileName?: string): void {
    let parsed: Project;
    try {
      parsed = JSON.parse(text) as Project;
    } catch {
      throw new FakeEditError("invalidFile", "Soubor není platný projekt NetSketch.");
    }
    if (parsed.formatVersion > 1) {
      throw new FakeEditError("newerFormat", "Soubor je ve formátu novější verze.");
    }
    this._project = parsed;
    this.fileName = fileName ?? null;
    this.isDirty = false;
    this.undoStack = [];
    this.redoStack = [];
    this._selection = [];
    this.openIssues = this.nextOpenIssues;
    this.nextOpenIssues = [];
    this.changed();
  }

  serialize(): string {
    return JSON.stringify(this._project, null, 2);
  }

  markSaved(fileName: string): void {
    this.fileName = fileName;
    this.isDirty = false;
    this.changed();
  }
}

// MARK: Console session

/**
 * A scripted console: "enable" switches to privileged mode, "configure terminal" to config
 * mode, "end" back, "exit" at the top level closes the session, "hostname X" renames the
 * device through the store. Unknown commands print an IOS-style "%" error.
 */
export class FakeSession implements ConsoleSession {
  readonly dialect: CLIDialect;
  readonly banner: string;
  isClosed = false;
  mode: "user" | "exec" | "config" = "user";
  executed: string[] = [];
  completions: Record<string, string[]> = {
    "": ["configure", "enable", "exit", "show"],
    sh: ["show"],
    "show ": ["interfaces", "ip", "running-config", "vlan"],
    "show ip ": ["interface", "route"],
    "/ip address add ": ["address=", "interface="],
  };

  constructor(
    readonly deviceID: string,
    private readonly hostname: () => string = () => "SW1",
    options: { dialect?: CLIDialect; banner?: string; rename?: (name: string) => void } = {},
  ) {
    this.dialect = options.dialect ?? "ios";
    this.banner = options.banner ?? "\nNetSketch — konzole zařízení\nNápověda: ?\n\n";
    this.rename = options.rename ?? null;
  }

  private readonly rename: ((name: string) => void) | null;

  get prompt(): string {
    const name = this.hostname();
    if (this.mode === "user") return `${name}>`;
    if (this.mode === "exec") return `${name}#`;
    return `${name}(config)#`;
  }

  execute(line: string): string {
    this.executed.push(line);
    const command = line.trim();
    if (command === "") return "";
    if (command === "enable") {
      this.mode = "exec";
      return "";
    }
    if (command === "configure terminal" || command === "conf t") {
      this.mode = "config";
      return "Enter configuration commands, one per line.  End with CNTL/Z.\n";
    }
    if (command === "end") {
      if (this.mode === "config") this.mode = "exec";
      return "";
    }
    if (command === "exit") {
      if (this.mode === "config") this.mode = "exec";
      else this.isClosed = true;
      return "";
    }
    if (command.startsWith("hostname ") && this.mode === "config") {
      this.rename?.(command.slice("hostname ".length));
      return "";
    }
    if (command === "show multi") return "line one\n  % warning line\nline three\n\n";
    return `% Invalid input detected at '^' marker.\n`;
  }

  complete(partial: string): string[] {
    return this.completions[partial] ?? [];
  }

  help(partial: string): string {
    return partial === "" ? "  enable  Turn on privileged commands\n  exit    Exit from the EXEC\n" : "";
  }
}

// MARK: Files

/** Files fake: queued answers for the pickers, records of what was written. */
export class FakeFiles implements ProjectFiles {
  nextOpen: OpenedFile | null = null;
  /** Name chosen in the next save dialog; null = cancelled. */
  nextSaveName: string | null = "projekt.netsketch";
  /** Whether a save dialog returns a writable handle (File System Access API). */
  givesHandles = true;
  saved: { text: string; suggestedName: string; usedHandle: boolean }[] = [];
  exported: { suggestedName: string; kind: ExportKind; size: number }[] = [];

  async openProject(): Promise<OpenedFile | null> {
    return this.nextOpen;
  }

  async saveProject(text: string, suggestedName: string, handle: WritableFileHandle | null): Promise<SavedFile | null> {
    if (handle) {
      this.saved.push({ text, suggestedName, usedHandle: true });
      return { name: handle.name, handle };
    }
    if (this.nextSaveName === null) return null;
    this.saved.push({ text, suggestedName, usedHandle: false });
    const name = this.nextSaveName;
    const newHandle: WritableFileHandle | null = this.givesHandles
      ? {
          name,
          createWritable: async () => ({ write: async () => {}, close: async () => {} }),
        }
      : null;
    return { name, handle: newHandle };
  }

  async saveExport(data: Blob, suggestedName: string, kind: ExportKind): Promise<boolean> {
    this.exported.push({ suggestedName, kind, size: data.size });
    return true;
  }
}
