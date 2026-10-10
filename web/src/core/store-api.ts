// The contract of the editing engine (src/core/store.ts implements it, src/ui uses it).
// It mirrors ProjectStore of the Swift module NetSketchCore: every mutating operation is one
// undo step (or part of one inside beginUndoGroup/endUndoGroup), marks the project dirty and
// leaves the project untouched when it throws. Operations that change nothing record no step.

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
} from "./model";

export type SelectionItem =
  | { kind: "device"; id: string }
  | { kind: "link"; id: string }
  | { kind: "annotation"; id: string };

export type PortClickResult =
  | { kind: "pending"; port: PortRef }
  | { kind: "cancelled" }
  | { kind: "connected"; link: Link };

/** Why an edit was refused. `message` is Czech and ready for the UI. */
export type EditErrorCode =
  | "unknownDevice"
  | "unknownPort"
  | "unknownLink"
  | "unknownBundle"
  | "unknownAnnotation"
  | "unknownTemplate"
  | "emptyName"
  | "samePort"
  | "sameDevice"
  | "portInUse"
  | "bundleNeedsTwoLinks"
  | "bundleNeedsSameDevices"
  | "linkAlreadyBundled"
  | "invalidFile"
  | "newerFormat";

export interface ProjectStoreAPI {
  // MARK: State
  readonly project: Project;
  readonly catalog: CatalogAPI;
  /** Increases with every change of anything observable (for useSyncExternalStore). */
  readonly version: number;
  /** Calls `listener` after every change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;

  selection: SelectionItem[];
  snapToGrid: boolean;
  gridSize: number;
  activeCableType: CableType;
  viewMode: ViewMode;
  readonly pendingPort: PortRef | null;
  /** Name of the file the project was opened from or saved to; null for a new project. */
  readonly fileName: string | null;
  readonly isDirty: boolean;
  /** Problems found (and repaired) when the last file was opened, as Czech sentences. */
  readonly openIssues: string[];

  // MARK: Undo
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  undo(): boolean;
  redo(): boolean;
  beginUndoGroup(): void;
  endUndoGroup(): void;
  cancelUndoGroup(): void;

  // MARK: Selection
  select(item: SelectionItem, extending?: boolean): void;
  clearSelection(): void;
  selectAll(): void;
  removeSelection(): void;
  isSelected(item: SelectionItem): boolean;

  // MARK: Devices
  nextHostname(category: Device["category"]): string;
  addDevice(templateID: string, at: Point, hostname?: string): Device;
  addDeviceFromTemplate(template: DeviceTemplate, at: Point, hostname?: string): Device;
  removeDevices(ids: string[]): void;
  renameDevice(id: string, hostname: string): void;
  setDeviceNote(id: string, note: string): void;
  setVLANs(deviceID: string, vlans: VLANEntry[]): void;
  setPosition(deviceID: string, to: Point): void;
  snap(point: Point): Point;

  // MARK: Ports
  setPortDescription(ref: PortRef, text: string): void;
  setPortVLAN(ref: PortRef, text: string): void;
  setPortAdminDown(ref: PortRef, down: boolean): void;

  // MARK: IP configuration (set by the consoles)
  /** `address` null removes it. `interfaceID` is "port:<UUID>" or "vlan:<N>". */
  setAddress(deviceID: string, interfaceID: string, address: string | null): void;
  setDefaultGateway(deviceID: string, gateway: string): void;
  setStaticRoutes(deviceID: string, routes: StaticRoute[]): void;

  // MARK: Moving
  moveDevices(ids: string[], delta: Point): void;
  /** A drag is one undo step: beginDrag, any number of drag(), then endDrag or cancelDrag. */
  beginDrag(): void;
  drag(items: SelectionItem[], translation: Point): void;
  endDrag(): void;
  cancelDrag(): void;

  // MARK: Cables
  isPortUsed(ref: PortRef): boolean;
  connect(a: PortRef, b: PortRef, cable?: CableType): Link;
  /** Two-click cabling: first click remembers the port, the second connects. */
  clickPort(ref: PortRef): PortClickResult;
  cancelPendingPort(): void;
  removeLink(id: string): void;
  setCableType(linkID: string, type: CableType): void;
  setStatus(linkID: string, end: LinkEnd, status: LinkStatus): void;
  cycleStatus(linkID: string, end: LinkEnd): LinkStatus;
  setLinkNote(linkID: string, note: string): void;

  // MARK: Bundles (LAG)
  createBundle(linkIDs: string[], label?: string): LinkBundle;
  unbundle(id: string): void;
  renameBundle(id: string, label: string): void;

  // MARK: Annotations
  addAnnotation(text: string, at: Point): Annotation;
  moveAnnotation(id: string, to: Point): void;
  setAnnotationText(id: string, text: string): void;
  removeAnnotation(id: string): void;

  // MARK: Document
  renameProject(name: string): void;
  newProject(name?: string): void;
  /** Opens .netsketch JSON text; throws EditError("invalidFile" | "newerFormat"). */
  openText(text: string, fileName?: string): void;
  /** The project as .netsketch JSON text (same format as the Swift app writes). */
  serialize(): string;
  /** Marks the project saved under `fileName`. */
  markSaved(fileName: string): void;
}

export interface CatalogAPI {
  /** Built-in templates, then custom ones. */
  readonly templates: DeviceTemplate[];
  template(id: string): DeviceTemplate | undefined;
  /** Templates grouped by category in palette order (switch, router, L3 switch, AP, PC, server). */
  readonly groups: { category: Device["category"]; templates: DeviceTemplate[] }[];
  /** Problems found while loading, as Czech sentences. */
  readonly loadIssues: string[];
}
