// The editing engine (ProjectStore.swift): owns the project, the editor state the UI binds to,
// and the undo history.
//
// Every mutating operation is one undo step (or part of one, inside `beginUndoGroup()` /
// `endUndoGroup()`), marks the project dirty, and leaves the project untouched when it throws.
// Operations that change nothing record no undo step. Projects are immutable values: every
// change creates new objects along the changed path and keeps the untouched ones, so the UI can
// compare by reference. `subscribe` listeners run after every observable change.

import { Catalog } from "./catalog";
import { hostnamePrefix, nextLinkStatus } from "./enums";
import { EditError } from "./errors";
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
  Port,
  PortRef,
  Project,
  StaticRoute,
  VLANEntry,
  ViewMode,
} from "./model";
import {
  bundleOfLink,
  connectionsOfDevice,
  emptyProject,
  findAnnotation,
  findBundle,
  findDevice,
  findLink,
  findPort,
  formatInterfaceID,
  isPortUsed,
  linkAt,
  linkDevicePairKey,
  linkStatus,
  makeLink,
  parseInterfaceID,
  peerOf,
  sameRef,
  withoutBundle,
  type PortConnection,
  type PortPeer,
} from "./project";
import {
  decodeProject,
  encodeProject,
  issueSentence,
  repairProject,
  validateProject,
  type ProjectIssue,
} from "./project-io";
import type { CatalogAPI, PortClickResult, ProjectStoreAPI, SelectionItem } from "./store-api";
import { makeDevice } from "./template";
import { deepEqual, newUUID, roundHalfAwayFromZero, trimWhitespaceAndNewlines } from "./util";

/** A string that identifies a selection item (for sets and maps). */
export function selectionKey(item: SelectionItem): string {
  return `${item.kind}:${item.id}`;
}

/** True when both projects are equal apart from the view mode (view state is not content). */
function sameContent(a: Project, b: Project): boolean {
  return (
    a === b ||
    (a.formatVersion === b.formatVersion &&
      a.name === b.name &&
      deepEqual(a.devices, b.devices) &&
      deepEqual(a.links, b.links) &&
      deepEqual(a.bundles, b.bundles) &&
      deepEqual(a.annotations, b.annotations))
  );
}

/** `next` unless it holds exactly the elements of `previous` (then `previous`, for stable references). */
function stable<T>(previous: T[], next: T[]): T[] {
  return previous.length === next.length && previous.every((element, index) => element === next[index]) ? previous : next;
}

export class ProjectStore implements ProjectStoreAPI {
  readonly catalog: CatalogAPI;
  /** Maximum number of undo steps kept. */
  undoLimit = 200;

  private _project: Project;
  private _version = 0;
  private readonly listeners = new Set<() => void>();
  private _selection: SelectionItem[] = [];
  private _snapToGrid = true;
  private _gridSize = 20;
  private _pendingPort: PortRef | null = null;
  private _activeCableType: CableType = "straight";
  private _fileName: string | null = null;
  private _isDirty = false;
  private _openIssues: ProjectIssue[] = [];
  private _openIssueTexts: string[] = [];

  private undoStack: Project[] = [];
  private redoStack: Project[] = [];
  /** The last saved (or freshly created/opened) project; compared without the view mode. */
  private cleanState: Project;
  private groupDepth = 0;
  private groupBase: Project | null = null;
  /** Unsnapped positions of the items moved inside the open group (drag accumulation). */
  private rawPositions = new Map<string, Point>();
  private batchDepth = 0;
  private notifyPending = false;

  /**
   * @param catalog defaults to the built-in catalog (memory only).
   * @param project the initial document; an empty project by default.
   */
  constructor(catalog: CatalogAPI = new Catalog(), project: Project = emptyProject()) {
    this.catalog = catalog;
    this._project = project;
    this.cleanState = project;
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

  /** Reports a change now, or at the end of the running batch. */
  private changed(): void {
    if (this.batchDepth > 0) {
      this.notifyPending = true;
      return;
    }
    this._version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  /** Runs `body` and reports all of its changes as one notification. */
  private batch<T>(body: () => T): T {
    this.batchDepth += 1;
    try {
      return body();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.notifyPending) {
        this.notifyPending = false;
        this.changed();
      }
    }
  }

  // MARK: State

  /** The document. Read-only for the UI; change it through the operations below. */
  get project(): Project {
    return this._project;
  }

  /**
   * Selected devices, links and annotations. Freely writable; stale ids are pruned
   * automatically whenever the project changes. Duplicates are dropped.
   */
  get selection(): SelectionItem[] {
    return this._selection;
  }

  set selection(items: SelectionItem[]) {
    const unique = new Map<string, SelectionItem>();
    for (const item of items) unique.set(selectionKey(item), { kind: item.kind, id: item.id });
    const current = new Set(this._selection.map(selectionKey));
    if (unique.size === current.size && [...unique.keys()].every((key) => current.has(key))) return;
    this._selection = [...unique.values()];
    this.changed();
  }

  /** When true, new and moved devices and annotations land on the grid. */
  get snapToGrid(): boolean {
    return this._snapToGrid;
  }

  set snapToGrid(value: boolean) {
    if (value === this._snapToGrid) return;
    this._snapToGrid = value;
    this.changed();
  }

  /** Grid pitch in canvas points. */
  get gridSize(): number {
    return this._gridSize;
  }

  set gridSize(value: number) {
    if (value === this._gridSize) return;
    this._gridSize = value;
    this.changed();
  }

  /** Cable type used by `clickPort` and by `connect` when none is given. */
  get activeCableType(): CableType {
    return this._activeCableType;
  }

  set activeCableType(value: CableType) {
    if (value === this._activeCableType) return;
    this._activeCableType = value;
    this.changed();
  }

  /** Current view mode. Stored in the project file; changing it is neither undoable nor dirtying. */
  get viewMode(): ViewMode {
    return this._project.viewMode;
  }

  set viewMode(value: ViewMode) {
    if (this._project.viewMode === value) return;
    this._project = { ...this._project, viewMode: value };
    if (this.groupBase) this.groupBase = { ...this.groupBase, viewMode: value };
    this.changed();
  }

  /** The first port clicked while cabling, see `clickPort`. */
  get pendingPort(): PortRef | null {
    return this._pendingPort;
  }

  /** Name of the file the project was opened from or last saved to. */
  get fileName(): string | null {
    return this._fileName;
  }

  /** True when the project differs from the last saved (or freshly created/opened) state. */
  get isDirty(): boolean {
    return this._isDirty;
  }

  /** Inconsistencies found (and repaired) by the last `openText`, as Czech sentences. */
  get openIssues(): string[] {
    return this._openIssueTexts;
  }

  /** The same inconsistencies as structured values. */
  get openIssueList(): ProjectIssue[] {
    return this._openIssues;
  }

  // MARK: Undo / redo

  get canUndo(): boolean {
    return (
      this.undoStack.length > 0 ||
      (this.groupDepth > 0 && this.groupBase !== null && !deepEqual(this.groupBase, this._project))
    );
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** True between `beginUndoGroup()` / `beginDrag()` and the matching end. */
  get isGrouping(): boolean {
    return this.groupDepth > 0;
  }

  /** Reverts the last undo step. An open undo group is closed first. Returns false when there is nothing to undo. */
  undo(): boolean {
    return this.batch(() => {
      this.closeAllGroups();
      const previous = this.undoStack.pop();
      if (previous === undefined) return false;
      this.redoStack.push(this._project);
      this.restore(previous);
      return true;
    });
  }

  /** Re-applies the last undone step. Returns false when there is nothing to redo. */
  redo(): boolean {
    return this.batch(() => {
      this.closeAllGroups();
      const next = this.redoStack.pop();
      if (next === undefined) return false;
      this.undoStack.push(this._project);
      this.restore(next);
      return true;
    });
  }

  /**
   * Starts coalescing: every operation until the matching `endUndoGroup()` becomes ONE undo step.
   * Groups nest. Use it for drags and for text fields that write on every keystroke.
   */
  beginUndoGroup(): void {
    if (this.groupDepth === 0) {
      this.groupBase = this._project;
      this.rawPositions.clear();
    }
    this.groupDepth += 1;
    this.changed();
  }

  /** Ends the group started by `beginUndoGroup()`; records one undo step if anything changed. */
  endUndoGroup(): void {
    if (this.groupDepth === 0) return;
    this.groupDepth -= 1;
    if (this.groupDepth > 0) return;
    const base = this.groupBase;
    if (base !== null && !deepEqual(base, this._project)) this.pushUndo(base);
    this.groupBase = null;
    this.rawPositions.clear();
    this.changed();
  }

  /** Abandons the open group (all nesting levels) and restores the project as it was when it began. */
  cancelUndoGroup(): void {
    if (this.groupDepth === 0) return;
    this.batch(() => {
      this.groupDepth = 0;
      const base = this.groupBase;
      this.groupBase = null;
      this.rawPositions.clear();
      if (base !== null) this.restore(base);
      this.changed();
    });
  }

  // MARK: Grid

  /** The nearest grid point when `snapToGrid` is on; a copy of `point` otherwise. */
  snap(point: Point): Point {
    const size = this._gridSize;
    if (!this._snapToGrid || !(size > 0)) return { x: point.x, y: point.y };
    return {
      x: roundHalfAwayFromZero(point.x / size) * size,
      y: roundHalfAwayFromZero(point.y / size) * size,
    };
  }

  // MARK: Selection

  get selectedDeviceIDs(): string[] {
    return this._selection.filter((item) => item.kind === "device").map((item) => item.id);
  }

  get selectedLinkIDs(): string[] {
    return this._selection.filter((item) => item.kind === "link").map((item) => item.id);
  }

  get selectedAnnotationIDs(): string[] {
    return this._selection.filter((item) => item.kind === "annotation").map((item) => item.id);
  }

  isSelected(item: SelectionItem): boolean {
    const key = selectionKey(item);
    return this._selection.some((candidate) => selectionKey(candidate) === key);
  }

  /** Selects `item`. With `extending` the item is toggled in the existing selection (shift-click). */
  select(item: SelectionItem, extending = false): void {
    if (!extending) {
      this.selection = [item];
      return;
    }
    const key = selectionKey(item);
    this.selection = this.isSelected(item)
      ? this._selection.filter((candidate) => selectionKey(candidate) !== key)
      : [...this._selection, item];
  }

  clearSelection(): void {
    this.selection = [];
  }

  /** Selects every device, link and annotation. */
  selectAll(): void {
    const project = this._project;
    this.selection = [
      ...project.devices.map((device): SelectionItem => ({ kind: "device", id: device.id })),
      ...project.links.map((link): SelectionItem => ({ kind: "link", id: link.id })),
      ...project.annotations.map((annotation): SelectionItem => ({ kind: "annotation", id: annotation.id })),
    ];
  }

  /** Deletes everything selected (devices with their cables, links, annotations) as one undo step. */
  removeSelection(): void {
    const devices = new Set(this.selectedDeviceIDs);
    const links = new Set(this.selectedLinkIDs);
    const annotations = new Set(this.selectedAnnotationIDs);
    this.mutate((draft) => removeObjects(draft, devices, links, annotations));
  }

  // MARK: Devices

  /** The next free automatic hostname for a category: "SW1", "SW2", "R1", "AP1", "PC1", "SRV1". */
  nextHostname(category: Device["category"]): string {
    const used = new Set(this._project.devices.map((device) => device.hostname.toLowerCase()));
    const prefix = hostnamePrefix(category);
    let number = 1;
    while (used.has(`${prefix}${number}`.toLowerCase())) number += 1;
    return `${prefix}${number}`;
  }

  /**
   * Places a new device created from a catalog template. `at` is the device centre and is
   * snapped when `snapToGrid` is on. The hostname is generated unless one is given.
   */
  addDevice(templateID: string, at: Point, hostname?: string): Device {
    const template = this.catalog.template(templateID);
    if (!template) throw new EditError("unknownTemplate", { id: templateID });
    return this.addDeviceFromTemplate(template, at, hostname);
  }

  /** Places a new device created from any template (it does not have to be in the catalog). */
  addDeviceFromTemplate(template: DeviceTemplate, at: Point, hostname?: string): Device {
    const given = trimWhitespaceAndNewlines(hostname ?? "");
    const device = makeDevice(template, given === "" ? this.nextHostname(template.category) : given, this.snap(at));
    this.mutate((draft) => {
      draft.devices.push(device);
    });
    return device;
  }

  /**
   * Removes the devices together with every cable plugged into them; bundles left with
   * fewer than two links are dissolved. Throws "unknownDevice" (and changes nothing) for an unknown id.
   */
  removeDevices(ids: string[]): void {
    this.mutate((draft) => {
      for (const id of ids) {
        if (!findDevice(draft, id)) throw new EditError("unknownDevice", { id });
      }
      removeObjects(draft, new Set(ids), new Set(), new Set());
    });
  }

  removeDevice(id: string): void {
    this.removeDevices([id]);
  }

  /** Sets the hostname (trimmed). Throws "emptyName" for an empty one. Duplicates are allowed. */
  renameDevice(id: string, hostname: string): void {
    const trimmed = trimWhitespaceAndNewlines(hostname);
    if (trimmed === "") throw new EditError("emptyName");
    this.updateDevice(id, (device) => ({ ...device, hostname: trimmed }));
  }

  setDeviceNote(id: string, note: string): void {
    this.updateDevice(id, (device) => ({ ...device, note }));
  }

  /**
   * Replaces the device's VLAN table. Entries are stored sorted by VLAN number; when a
   * number occurs more than once the first entry wins. No logic is attached.
   */
  setVLANs(deviceID: string, vlans: VLANEntry[]): void {
    const seen = new Set<number>();
    const table = vlans
      .filter((entry) => {
        if (seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      })
      .map((entry) => ({ id: entry.id, name: entry.name }))
      .sort((a, b) => a.id - b.id);
    this.updateDevice(deviceID, (device) => ({ ...device, vlans: table }));
  }

  // MARK: IP configuration (set from the consoles; used by the network simulation of the CLI)

  /**
   * Sets or, with null, removes the address of one layer-3 interface of the device.
   * `interfaceID` is "port:<UUID>" or "vlan:<1...4094>"; anything else is a programming error
   * (TypeError), because the Swift app could not read such a file.
   */
  setAddress(deviceID: string, interfaceID: string, address: string | null): void {
    const parsed = parseInterfaceID(interfaceID);
    if (!parsed) throw new TypeError(`Invalid layer-3 interface id "${interfaceID}"`);
    const key = formatInterfaceID(parsed);
    this.updateDevice(deviceID, (device) => {
      const index = device.addresses.findIndex((entry) => entry.interface === key);
      if (index >= 0 && address !== null) {
        const addresses = [...device.addresses];
        addresses[index] = { interface: key, address };
        return { ...device, addresses };
      }
      if (index >= 0) return { ...device, addresses: device.addresses.filter((_, i) => i !== index) };
      if (address !== null) return { ...device, addresses: [...device.addresses, { interface: key, address }] };
      return device;
    });
  }

  setDefaultGateway(deviceID: string, gateway: string): void {
    this.updateDevice(deviceID, (device) => ({ ...device, defaultGateway: gateway }));
  }

  /** Replaces the static routes; a route that occurs more than once is kept once. */
  setStaticRoutes(deviceID: string, routes: StaticRoute[]): void {
    const seen = new Set<string>();
    const unique = routes
      .filter((route) => {
        const key = `${route.destination}\u0000${route.nextHop}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((route) => ({ destination: route.destination, nextHop: route.nextHop }));
    this.updateDevice(deviceID, (device) => ({ ...device, staticRoutes: unique }));
  }

  /** Moves the device centre to `to` (snapped when `snapToGrid` is on). */
  setPosition(deviceID: string, to: Point): void {
    const target = this.snap(to);
    this.updateDevice(deviceID, (device) => ({ ...device, position: target }));
  }

  // MARK: Ports

  setPortDescription(ref: PortRef, text: string): void {
    this.updatePort(ref, (port) => ({ ...port, description: text }));
  }

  /** Sets the free-text VLAN field of a port. */
  setPortVLAN(ref: PortRef, text: string): void {
    this.updatePort(ref, (port) => ({ ...port, vlan: text }));
  }

  /** Marks the port administratively down (IOS `shutdown`) or up again. Stored only. */
  setPortAdminDown(ref: PortRef, down: boolean): void {
    this.updatePort(ref, (port) => ({ ...port, adminDown: down }));
  }

  // MARK: Moving

  /**
   * Moves devices and annotations by `delta` (links in the list are ignored, unknown ids skipped).
   *
   * The results are snapped when `snapToGrid` is on. Outside an undo group each call is one
   * undo step. Inside a group (a drag) the unsnapped positions are accumulated, so many
   * small deltas add up correctly even with snapping.
   */
  move(items: SelectionItem[], delta: Point): void {
    if (delta.x === 0 && delta.y === 0) return;
    this.mutate((draft) => {
      for (const item of uniqueItems(items)) {
        const current = positionOf(item, draft);
        if (!current) continue;
        const key = selectionKey(item);
        const raw = (this.groupDepth > 0 ? this.rawPositions.get(key) : undefined) ?? current;
        const moved = { x: raw.x + delta.x, y: raw.y + delta.y };
        if (this.groupDepth > 0) this.rawPositions.set(key, moved);
        setPositionOf(item, this.snap(moved), draft);
      }
    });
  }

  /** Moves devices by `delta`, see `move`. */
  moveDevices(ids: string[], delta: Point): void {
    this.move(
      ids.map((id) => ({ kind: "device", id })),
      delta,
    );
  }

  /** Moves the selected devices and annotations by `delta`, see `move`. */
  moveSelection(delta: Point): void {
    this.move(this._selection, delta);
  }

  /** Starts a drag: everything until `endDrag()` is one undo step. Same as `beginUndoGroup()`. */
  beginDrag(): void {
    this.beginUndoGroup();
  }

  /**
   * Positions `items` at "where they were when the drag began" + `translation` (snapped when
   * `snapToGrid` is on). `translation` is the TOTAL offset since `beginDrag()`.
   * Outside a drag it behaves like `move`.
   */
  drag(items: SelectionItem[], translation: Point): void {
    const base = this.groupBase;
    if (this.groupDepth === 0 || base === null) {
      this.move(items, translation);
      return;
    }
    this.mutate((draft) => {
      for (const item of uniqueItems(items)) {
        const origin = positionOf(item, base);
        if (!origin) continue;
        const moved = { x: origin.x + translation.x, y: origin.y + translation.y };
        this.rawPositions.set(selectionKey(item), moved);
        setPositionOf(item, this.snap(moved), draft);
      }
    });
  }

  /** Drags the selected devices and annotations, see `drag`. */
  dragSelection(translation: Point): void {
    this.drag(this._selection, translation);
  }

  /** Ends the drag and records one undo step if anything moved. Same as `endUndoGroup()`. */
  endDrag(): void {
    this.endUndoGroup();
  }

  /** Aborts the drag and puts everything back. Same as `cancelUndoGroup()`. */
  cancelDrag(): void {
    this.cancelUndoGroup();
  }

  // MARK: Cabling

  isPortUsed(ref: PortRef): boolean {
    return isPortUsed(this._project, ref);
  }

  /** The cable plugged into the port, if any. */
  linkAt(ref: PortRef): Link | undefined {
    return linkAt(this._project, ref);
  }

  /** The device and port at the other end of the cable plugged into `ref`. */
  peerOf(ref: PortRef): PortPeer | undefined {
    return peerOf(this._project, ref);
  }

  /** Every port of the device with what is plugged into it ("what is plugged where"). */
  connections(deviceID: string): PortConnection[] {
    return connectionsOfDevice(this._project, deviceID);
  }

  /**
   * Plugs a cable between two ports. `cable` defaults to `activeCableType`.
   *
   * Refuses with "unknownPort", "samePort", "sameDevice" (both ends on one device)
   * or "portInUse" (a port takes one cable only). Connector and cable type are not checked.
   */
  connect(a: PortRef, b: PortRef, cable?: CableType): Link {
    const cableType = cable ?? this._activeCableType;
    return this.mutate((draft) => {
      if (!findPort(draft, a)) throw new EditError("unknownPort", { ref: a });
      if (!findPort(draft, b)) throw new EditError("unknownPort", { ref: b });
      if (sameRef(a, b)) throw new EditError("samePort");
      if (a.deviceID === b.deviceID) throw new EditError("sameDevice");
      if (isPortUsed(draft, a)) throw new EditError("portInUse", { ref: a }, draft);
      if (isPortUsed(draft, b)) throw new EditError("portInUse", { ref: b }, draft);
      const link = makeLink(a, b, { cableType });
      draft.links.push(link);
      return link;
    });
  }

  /**
   * The two-click cabling flow.
   *
   * - No pending port: the port becomes `pendingPort` ("pending"); throws "portInUse" or
   *   "unknownPort" and stays idle when the port cannot start a cable.
   * - Clicking the pending port again cancels ("cancelled").
   * - Any other port: `connect(pendingPort, ref, activeCableType)`. On success the pending port
   *   is cleared ("connected"); on failure the error is thrown and the pending port is KEPT so
   *   the user can pick another target (call `cancelPendingPort()` on Esc).
   */
  clickPort(ref: PortRef): PortClickResult {
    return this.batch((): PortClickResult => {
      if (!findPort(this._project, ref)) throw new EditError("unknownPort", { ref });
      const first = this._pendingPort;
      if (first === null) {
        if (isPortUsed(this._project, ref)) throw new EditError("portInUse", { ref }, this._project);
        this.setPendingPort({ deviceID: ref.deviceID, portID: ref.portID });
        return { kind: "pending", port: { deviceID: ref.deviceID, portID: ref.portID } };
      }
      if (sameRef(first, ref)) {
        this.setPendingPort(null);
        return { kind: "cancelled" };
      }
      const link = this.connect(first, ref, this._activeCableType);
      this.setPendingPort(null);
      return { kind: "connected", link };
    });
  }

  /** Forgets the first clicked port. */
  cancelPendingPort(): void {
    this.setPendingPort(null);
  }

  private setPendingPort(ref: PortRef | null): void {
    if (ref === this._pendingPort || (ref !== null && this._pendingPort !== null && sameRef(ref, this._pendingPort))) return;
    this._pendingPort = ref;
    this.changed();
  }

  /** Unplugs a cable. A bundle left with fewer than two links is dissolved. */
  removeLink(id: string): void {
    this.mutate((draft) => {
      if (!findLink(draft, id)) throw new EditError("unknownLink", { id });
      removeObjects(draft, new Set(), new Set([id]), new Set());
    });
  }

  setCableType(linkID: string, type: CableType): void {
    this.updateLink(linkID, (link) => ({ ...link, cableType: type }));
  }

  /** Sets the status dot at one end of a link. */
  setStatus(linkID: string, end: LinkEnd, status: LinkStatus): void {
    this.updateLink(linkID, (link) => (end === "a" ? { ...link, statusA: status } : { ...link, statusB: status }));
  }

  /** Advances the status dot at one end: none -> green -> orange -> red -> none. Returns the new status. */
  cycleStatus(linkID: string, end: LinkEnd): LinkStatus {
    const link = findLink(this._project, linkID);
    if (!link) throw new EditError("unknownLink", { id: linkID });
    const next = nextLinkStatus(linkStatus(link, end));
    this.setStatus(linkID, end, next);
    return next;
  }

  setLinkNote(linkID: string, note: string): void {
    this.updateLink(linkID, (link) => ({ ...link, note }));
  }

  // MARK: Bundles

  /** The bundle the link belongs to, if any. */
  bundleOfLink(linkID: string): LinkBundle | undefined {
    return bundleOfLink(this._project, linkID);
  }

  /**
   * Groups links into a visual bundle (LAG).
   *
   * Needs two or more distinct links ("bundleNeedsTwoLinks") that all connect the same pair
   * of devices ("bundleNeedsSameDevices") and are not bundled yet ("linkAlreadyBundled").
   * Without a label the next free "Po1 / bond1", "Po2 / bond2", ... is used.
   */
  createBundle(linkIDs: string[], label?: string): LinkBundle {
    const requested = new Set(linkIDs);
    const given = trimWhitespaceAndNewlines(label ?? "");
    return this.mutate((draft) => {
      for (const id of requested) {
        if (!findLink(draft, id)) throw new EditError("unknownLink", { id });
      }
      if (requested.size < 2) throw new EditError("bundleNeedsTwoLinks");
      const members = draft.links.filter((link) => requested.has(link.id));
      const bundled = members.find((link) => link.bundleID !== undefined);
      if (bundled) throw new EditError("linkAlreadyBundled", { id: bundled.id });
      if (new Set(members.map(linkDevicePairKey)).size !== 1) throw new EditError("bundleNeedsSameDevices");

      const bundle: LinkBundle = {
        id: newUUID(),
        label: given === "" ? nextBundleLabel(draft) : given,
        linkIDs: members.map((link) => link.id),
      };
      draft.bundles.push(bundle);
      draft.links = draft.links.map((link) => (requested.has(link.id) ? { ...link, bundleID: bundle.id } : link));
      return bundle;
    });
  }

  /** Dissolves a bundle; its links stay. */
  unbundle(id: string): void {
    this.mutate((draft) => {
      if (!findBundle(draft, id)) throw new EditError("unknownBundle", { id });
      draft.bundles = draft.bundles.filter((bundle) => bundle.id !== id);
      draft.links = draft.links.map((link) => (link.bundleID === id ? withoutBundle(link) : link));
    });
  }

  /** Sets the bundle caption (trimmed). Throws "emptyName" for an empty one. */
  renameBundle(id: string, label: string): void {
    const trimmed = trimWhitespaceAndNewlines(label);
    if (trimmed === "") throw new EditError("emptyName");
    this.mutate((draft) => {
      const index = draft.bundles.findIndex((bundle) => bundle.id === id);
      if (index < 0) throw new EditError("unknownBundle", { id });
      draft.bundles[index] = { ...draft.bundles[index], label: trimmed };
    });
  }

  // MARK: Annotations

  /** Adds a text label; `at` is its top-left corner (snapped when `snapToGrid` is on). */
  addAnnotation(text: string, at: Point): Annotation {
    const annotation: Annotation = { id: newUUID(), text, position: this.snap(at) };
    this.mutate((draft) => {
      draft.annotations.push(annotation);
    });
    return annotation;
  }

  moveAnnotation(id: string, to: Point): void {
    const target = this.snap(to);
    this.updateAnnotation(id, (annotation) => ({ ...annotation, position: target }));
  }

  setAnnotationText(id: string, text: string): void {
    this.updateAnnotation(id, (annotation) => ({ ...annotation, text }));
  }

  removeAnnotation(id: string): void {
    this.mutate((draft) => {
      if (!findAnnotation(draft, id)) throw new EditError("unknownAnnotation", { id });
      draft.annotations = draft.annotations.filter((annotation) => annotation.id !== id);
    });
  }

  // MARK: Document

  /** Sets the project name (undoable). */
  renameProject(name: string): void {
    this.mutate((draft) => {
      draft.name = name;
    });
  }

  /** Replaces the document with a new empty project and clears history, selection and file name. */
  newProject(name = ""): void {
    this.batch(() => {
      this.reset(emptyProject(name, this._project.viewMode), null, null);
      this.setOpenIssues([], undefined);
    });
  }

  /**
   * Opens ".netsketch" JSON text. Throws `EditError` "invalidFile" or "newerFormat" when the
   * text cannot be decoded (the current project is then kept). An inconsistent file is repaired
   * on the way in: the problems are listed in `openIssues` and the project starts out dirty.
   */
  openText(text: string, fileName?: string): void {
    const loaded = decodeProject(text);
    const issues = validateProject(loaded);
    this.batch(() => {
      this.reset(issues.length === 0 ? loaded : repairProject(loaded), fileName ?? null, loaded);
      this.setOpenIssues(issues, loaded);
    });
  }

  /** The project as ".netsketch" JSON text (byte-identical to what the Swift app writes). */
  serialize(): string {
    return encodeProject(this._project);
  }

  /** Marks the current project as saved under `fileName` (call it after writing `serialize()`). History is kept. */
  markSaved(fileName: string): void {
    this.batch(() => {
      this.closeAllGroups();
      this._fileName = fileName;
      this.cleanState = this._project;
      this._isDirty = false;
      this.changed();
    });
  }

  // MARK: Internals

  /** Runs `body` on a draft of the project and commits the draft only when `body` returns. */
  private mutate<T>(body: (draft: Project) => T): T {
    const current = this._project;
    const draft: Project = {
      ...current,
      devices: [...current.devices],
      links: [...current.links],
      bundles: [...current.bundles],
      annotations: [...current.annotations],
    };
    const result = body(draft);
    this.commit(draft);
    return result;
  }

  private commit(draft: Project): void {
    const current = this._project;
    if (deepEqual(draft, current)) return;
    // Keep the references of untouched collections, so the UI can skip them.
    const next: Project = {
      ...draft,
      devices: stable(current.devices, draft.devices),
      links: stable(current.links, draft.links),
      bundles: stable(current.bundles, draft.bundles),
      annotations: stable(current.annotations, draft.annotations),
    };
    if (this.groupDepth === 0) this.pushUndo(current);
    this.redoStack = [];
    this._project = next;
    this.projectDidChange();
  }

  private pushUndo(snapshot: Project): void {
    this.undoStack.push(snapshot);
    const limit = Math.max(1, this.undoLimit);
    if (this.undoStack.length > limit) this.undoStack.splice(0, this.undoStack.length - limit);
    this.redoStack = [];
  }

  /** Swaps in a snapshot while keeping the current view mode (view state is not undoable). */
  private restore(snapshot: Project): void {
    const viewMode = this._project.viewMode;
    this._project = snapshot.viewMode === viewMode ? snapshot : { ...snapshot, viewMode };
    this.projectDidChange();
  }

  private closeAllGroups(): void {
    if (this.groupDepth === 0) return;
    this.groupDepth = 1;
    this.endUndoGroup();
  }

  /** Prunes the selection and the pending port, recomputes the dirty flag and notifies. */
  private projectDidChange(): void {
    const project = this._project;
    const live = this._selection.filter((item) => {
      switch (item.kind) {
        case "device":
          return findDevice(project, item.id) !== undefined;
        case "link":
          return findLink(project, item.id) !== undefined;
        case "annotation":
          return findAnnotation(project, item.id) !== undefined;
      }
    });
    if (live.length !== this._selection.length) this._selection = live;
    const pending = this._pendingPort;
    if (pending !== null && (!findPort(project, pending) || isPortUsed(project, pending))) this._pendingPort = null;
    this._isDirty = !sameContent(project, this.cleanState);
    this.changed();
  }

  private reset(project: Project, fileName: string | null, clean: Project | null): void {
    this.groupDepth = 0;
    this.groupBase = null;
    this.rawPositions.clear();
    this.undoStack = [];
    this.redoStack = [];
    this._selection = [];
    this._pendingPort = null;
    this._fileName = fileName;
    this._project = project;
    this.cleanState = clean ?? project;
    this._isDirty = !sameContent(project, this.cleanState);
    this.changed();
  }

  private setOpenIssues(issues: ProjectIssue[], project: Project | undefined): void {
    this._openIssues = issues;
    this._openIssueTexts = issues.map((issue) => issueSentence(issue, project));
    this.changed();
  }

  private updateDevice(id: string, change: (device: Device) => Device): void {
    this.mutate((draft) => {
      const index = draft.devices.findIndex((device) => device.id === id);
      if (index < 0) throw new EditError("unknownDevice", { id });
      draft.devices[index] = change(draft.devices[index]);
    });
  }

  private updatePort(ref: PortRef, change: (port: Port) => Port): void {
    this.mutate((draft) => {
      const deviceIndex = draft.devices.findIndex((device) => device.id === ref.deviceID);
      const device = deviceIndex < 0 ? undefined : draft.devices[deviceIndex];
      const portIndex = device ? device.ports.findIndex((port) => port.id === ref.portID) : -1;
      if (!device || portIndex < 0) throw new EditError("unknownPort", { ref });
      const ports = [...device.ports];
      ports[portIndex] = change(ports[portIndex]);
      draft.devices[deviceIndex] = { ...device, ports };
    });
  }

  private updateLink(id: string, change: (link: Link) => Link): void {
    this.mutate((draft) => {
      const index = draft.links.findIndex((link) => link.id === id);
      if (index < 0) throw new EditError("unknownLink", { id });
      draft.links[index] = change(draft.links[index]);
    });
  }

  private updateAnnotation(id: string, change: (annotation: Annotation) => Annotation): void {
    this.mutate((draft) => {
      const index = draft.annotations.findIndex((annotation) => annotation.id === id);
      if (index < 0) throw new EditError("unknownAnnotation", { id });
      draft.annotations[index] = change(draft.annotations[index]);
    });
  }
}

// MARK: Helpers

function uniqueItems(items: readonly SelectionItem[]): SelectionItem[] {
  const unique = new Map<string, SelectionItem>();
  for (const item of items) unique.set(selectionKey(item), item);
  return [...unique.values()];
}

function positionOf(item: SelectionItem, project: Project): Point | undefined {
  switch (item.kind) {
    case "device":
      return findDevice(project, item.id)?.position;
    case "annotation":
      return findAnnotation(project, item.id)?.position;
    case "link":
      return undefined;
  }
}

function setPositionOf(item: SelectionItem, point: Point, draft: Project): void {
  switch (item.kind) {
    case "device": {
      const index = draft.devices.findIndex((device) => device.id === item.id);
      if (index >= 0) draft.devices[index] = { ...draft.devices[index], position: point };
      break;
    }
    case "annotation": {
      const index = draft.annotations.findIndex((annotation) => annotation.id === item.id);
      if (index >= 0) draft.annotations[index] = { ...draft.annotations[index], position: point };
      break;
    }
    case "link":
      break;
  }
}

/**
 * Removes objects and everything that depends on them: cables of removed devices, and
 * bundles that would be left with fewer than two links.
 */
function removeObjects(draft: Project, devices: Set<string>, links: Set<string>, annotations: Set<string>): void {
  const doomedLinks = new Set(links);
  if (devices.size > 0) {
    for (const link of draft.links) {
      if (devices.has(link.a.deviceID) || devices.has(link.b.deviceID)) doomedLinks.add(link.id);
    }
    draft.devices = draft.devices.filter((device) => !devices.has(device.id));
  }
  if (doomedLinks.size > 0) {
    draft.links = draft.links.filter((link) => !doomedLinks.has(link.id));
    const dissolved = new Set<string>();
    draft.bundles = draft.bundles.flatMap((bundle) => {
      const linkIDs = bundle.linkIDs.filter((id) => !doomedLinks.has(id));
      if (linkIDs.length < 2) {
        dissolved.add(bundle.id);
        return [];
      }
      return [linkIDs.length === bundle.linkIDs.length ? bundle : { ...bundle, linkIDs }];
    });
    draft.links = draft.links.map((link) =>
      link.bundleID !== undefined && dissolved.has(link.bundleID) ? withoutBundle(link) : link,
    );
  }
  if (annotations.size > 0) {
    draft.annotations = draft.annotations.filter((annotation) => !annotations.has(annotation.id));
  }
}

function nextBundleLabel(project: Project): string {
  const used = new Set(project.bundles.map((bundle) => bundle.label));
  let number = 1;
  while (used.has(`Po${number} / bond${number}`)) number += 1;
  return `Po${number} / bond${number}`;
}
