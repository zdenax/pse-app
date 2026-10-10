// Pointer, keyboard, wheel and drop handling of the canvas as a framework-free state machine
// (port of CanvasNSView+Input.swift). The React view feeds it plain events in view coordinates
// and renders what it exposes (interaction, hover, editor, feedback, cursor); it never touches
// the DOM, so it can be unit-tested with a real ProjectStore.
//
// Gesture scheme:
//  click                      select device / cable / note; click a free port to start or finish a cable
//  Shift- or Cmd-click        toggle in the selection
//  drag an object             move the whole selection (one undo step)
//  drag on empty canvas       rubber-band selection (Shift / Cmd adds to the selection)
//  scroll (two fingers/wheel) pan
//  Cmd/Ctrl-scroll, pinch     zoom around the pointer
//  Space-drag, Alt-drag on empty canvas, middle-button drag   pan
//  double-click               rename device / edit note / rename bundle; on empty canvas: new note
//  Esc                        cancel drag, cabling or selection;   Delete: remove the selection
//  arrow keys                 nudge the selection by one grid step

import type { LinkEnd, PortRef } from "../core/model";
import { cableTypes, linkEnds, linkStatuses } from "../core/enums";
import { linkAt, linkDevicePairKey, linkStatus, sameRef } from "../core/project";
import type { ProjectStoreAPI, SelectionItem } from "../core/store-api";
import { makeDevice } from "../core/template";
import { trimWhitespaceAndNewlines } from "../core/util";
import { rectFromCorners, type Point, type Rect } from "./geom";
import { NodeGeometry } from "./panel-geometry";
import { emptyHit, hitDeviceID, hitsEqual, type CanvasHit, type DiagramScene } from "./scene";
import { CanvasStrings, cableName, capitalized, portTitle, statusName } from "./strings";

/** What the canvas needs of the viewport (ui/viewport.ts `Viewport` fits). */
export interface CanvasViewportLike {
  readonly clampedZoom: number;
  readonly viewSize: { width: number; height: number };
  canvasPoint(viewPoint: Point): Point;
  viewPoint(canvasPoint: Point): Point;
  viewRect(canvasRect: Rect): Rect;
  pan(delta: Point): void;
  zoomBy(factor: number, anchor?: Point): void;
  setZoom(value: number, anchor?: Point): void;
  fit(): void;
  reset(): void;
}

/** Timers and clock, injectable for tests. */
export interface Scheduler {
  now(): number;
  later(ms: number, fn: () => void): () => void;
}

export const browserScheduler: Scheduler = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  later: (ms, fn) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
};

/** Optional services of the app shell. */
export interface CanvasInputHost {
  /** Opens the configuration console of a device; the context menu offers it when set. */
  openConsole?: (deviceID: string) => void;
  /** Whether the device has a console (defaults to true when `openConsole` is set). */
  canOpenConsole?: (deviceID: string) => boolean;
}

/** What the primary pointer button is currently doing. */
export type Interaction =
  | { kind: "idle" }
  /** Button is down, the pointer has not moved far enough to be a drag yet. */
  | {
      kind: "pressed";
      hit: CanvasHit;
      startView: Point;
      startCanvas: Point;
      extending: boolean;
      collapseTo: SelectionItem | null;
    }
  /** Moving the selection; `store.beginDrag()` is open. */
  | { kind: "draggingItems"; startCanvas: Point }
  | { kind: "rubberBand"; startCanvas: Point; currentCanvas: Point; base: SelectionItem[] }
  | { kind: "panning"; lastView: Point };

/** What the inline text field edits. */
export type EditTarget =
  | { kind: "hostname"; id: string }
  | { kind: "annotation"; id: string }
  | { kind: "newAnnotation"; point: Point }
  | { kind: "bundleLabel"; id: string };

export interface EditSession {
  target: EditTarget;
  /** Text the field starts with. */
  initialText: string;
  /** Current text of the field (kept up to date by the view). */
  draft: string;
  placeholder: string | null;
  multiline: boolean;
}

export type MenuEntry =
  | {
      kind: "item";
      label: string;
      enabled: boolean;
      checked?: boolean;
      action?: () => void;
      submenu?: MenuEntry[];
    }
  | { kind: "separator" };

export interface PointerDownOptions {
  clickCount: number;
  /** Shift or Cmd/Ctrl: toggle in the selection. */
  extending: boolean;
  /** Alt: pan when pressing on empty canvas. */
  panModifier: boolean;
}

export interface KeyInput {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
}

export const dragThreshold = 3;
export const tooltipDelay = 550;
export const rejectFlashDuration = 800;
export const feedbackDuration = 3500;

function itemKey(item: SelectionItem): string {
  return `${item.kind}:${item.id}`;
}

/** Czech message of anything thrown by the store. */
export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error !== "") return error;
  return CanvasStrings.operationFailed;
}

/** Counts clicks of a multi-click (the DOM pointerdown carries no reliable click count). */
export class ClickCounter {
  private last: { time: number; x: number; y: number; button: number; count: number } | null = null;

  constructor(
    private readonly interval = 500,
    private readonly slop = 5,
  ) {}

  register(time: number, point: Point, button = 0): number {
    const last = this.last;
    const continues =
      last !== null &&
      last.button === button &&
      time - last.time <= this.interval &&
      Math.hypot(point.x - last.x, point.y - last.y) <= this.slop;
    const count = continues && last ? last.count + 1 : 1;
    this.last = { time, x: point.x, y: point.y, button, count };
    return count;
  }

  reset(): void {
    this.last = null;
  }
}

export class CanvasInput {
  readonly store: ProjectStoreAPI;
  readonly viewport: CanvasViewportLike;
  private readonly sceneProvider: () => DiagramScene;
  private readonly scheduler: Scheduler;
  host: CanvasInputHost;

  private _interaction: Interaction = { kind: "idle" };
  private _hover: CanvasHit = emptyHit;
  private hoverSince = 0;
  private _pointerView: Point | null = null;
  private _isSpaceDown = false;
  private _rejectedPort: PortRef | null = null;
  private rejectedGeneration = 0;
  private _dropGhost: NodeGeometry | null = null;
  private _editing: EditSession | null = null;
  private isFinishingEdit = false;
  private _feedback: string | null = null;
  private feedbackGeneration = 0;
  private cancelTimers = new Set<() => void>();

  private _version = 0;
  private listeners = new Set<() => void>();

  constructor(options: {
    store: ProjectStoreAPI;
    viewport: CanvasViewportLike;
    scene: () => DiagramScene;
    scheduler?: Scheduler;
    host?: CanvasInputHost;
  }) {
    this.store = options.store;
    this.viewport = options.viewport;
    this.sceneProvider = options.scene;
    this.scheduler = options.scheduler ?? browserScheduler;
    this.host = options.host ?? {};
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

  /**
   * Stops timers and closes an open drag (keeps `beginDrag`/`endDrag` balanced on unmount).
   * The object stays usable (React StrictMode runs effect cleanups and setups twice).
   */
  dispose(): void {
    this.endInterruptedDrag();
    for (const cancel of this.cancelTimers) cancel();
    this.cancelTimers.clear();
  }

  private later(ms: number, fn: () => void): void {
    let cancel: (() => void) | null = null;
    cancel = this.scheduler.later(ms, () => {
      if (cancel) this.cancelTimers.delete(cancel);
      fn();
    });
    this.cancelTimers.add(cancel);
  }

  // MARK: State

  get interaction(): Interaction {
    return this._interaction;
  }

  get hover(): CanvasHit {
    return this._hover;
  }

  /** Last known pointer position in view coordinates; null while the pointer is outside. */
  get pointerView(): Point | null {
    return this._pointerView;
  }

  get isSpaceDown(): boolean {
    return this._isSpaceDown;
  }

  /** Port that just refused a click (flashes red). */
  get rejectedPort(): PortRef | null {
    return this._rejectedPort;
  }

  /** Outline of the device that a palette drag would drop. */
  get dropGhost(): NodeGeometry | null {
    return this._dropGhost;
  }

  get editing(): EditSession | null {
    return this._editing;
  }

  /** Transient message shown as a banner (e.g. "port in use"). */
  get feedback(): string | null {
    return this._feedback;
  }

  get scene(): DiagramScene {
    return this.sceneProvider();
  }

  /** Pick slop in canvas points (constant on screen). */
  get hitTolerance(): number {
    return 5 / this.viewport.clampedZoom;
  }

  hitAt(viewPoint: Point): CanvasHit {
    return this.scene.hitTest(this.viewport.canvasPoint(viewPoint), this.hitTolerance);
  }

  private get isGrouping(): boolean {
    const value = (this.store as { isGrouping?: unknown }).isGrouping;
    return typeof value === "boolean" ? value : true;
  }

  // MARK: Feedback

  showFeedback(text: string, duration = feedbackDuration): void {
    this.feedbackGeneration += 1;
    const generation = this.feedbackGeneration;
    this._feedback = text;
    this.changed();
    this.later(duration, () => {
      if (this.feedbackGeneration !== generation) return;
      this._feedback = null;
      this.changed();
    });
  }

  clearFeedback(): void {
    this.feedbackGeneration += 1;
    if (this._feedback !== null) {
      this._feedback = null;
      this.changed();
    }
  }

  /** Runs a store operation and shows a refusal in the banner. Returns true on success. */
  perform(body: () => void): boolean {
    try {
      body();
      return true;
    } catch (error) {
      this.showFeedback(messageOf(error));
      return false;
    }
  }

  // MARK: Pointer logic

  pointerDown(viewPoint: Point, options: PointerDownOptions): void {
    this.finishEditing(true);
    this.endInterruptedDrag();
    this._pointerView = viewPoint;
    const canvas = this.viewport.canvasPoint(viewPoint);
    const hit = this.hitAt(viewPoint);

    if (this._isSpaceDown || (options.panModifier && hit.kind === "empty")) {
      this._interaction = { kind: "panning", lastView: viewPoint };
      this.changed();
      return;
    }
    if (options.clickCount >= 2 && this.handleDoubleClick(hit, canvas)) {
      this._interaction = { kind: "idle" };
      this.changed();
      return;
    }
    // The first click of a double-click on a port already did the cabling step; a second one
    // would report the freshly plugged port as taken, or cancel what was just started.
    if (options.clickCount >= 2 && hit.kind === "port") {
      this._interaction = { kind: "idle" };
      this.changed();
      return;
    }

    let collapseTo: SelectionItem | null = null;
    switch (hit.kind) {
      case "deviceHeader":
      case "devicePanel":
      case "warning":
        collapseTo = this.pressSelect({ kind: "device", id: hit.deviceID }, options.extending);
        break;
      case "annotation":
        collapseTo = this.pressSelect({ kind: "annotation", id: hit.id }, options.extending);
        break;
      case "link":
        this.selectLinks(hit.ids, options.extending);
        break;
      case "bundleLabel":
        this.selectLinks(hit.linkIDs, options.extending);
        break;
      default:
        break;
    }
    this._interaction = {
      kind: "pressed",
      hit,
      startView: viewPoint,
      startCanvas: canvas,
      extending: options.extending,
      collapseTo,
    };
    this.changed();
  }

  pointerDragged(viewPoint: Point): void {
    this._pointerView = viewPoint;
    const canvas = this.viewport.canvasPoint(viewPoint);
    const interaction = this._interaction;
    switch (interaction.kind) {
      case "idle":
        return;
      case "pressed": {
        const moved = Math.hypot(viewPoint.x - interaction.startView.x, viewPoint.y - interaction.startView.y);
        if (moved < dragThreshold) return;
        const item = this.draggableItem(interaction.hit);
        if (item) {
          if (!this.store.isSelected(item)) {
            if (interaction.hit.kind === "port") {
              this.store.select(item, interaction.extending);
            } else if (interaction.extending) {
              // The press just toggled it off: nothing to drag.
              this._interaction = { kind: "idle" };
              this.changed();
              return;
            } else {
              this.store.select(item);
            }
          }
          this.store.beginDrag();
          this._interaction = { kind: "draggingItems", startCanvas: interaction.startCanvas };
          this.store.drag(this.store.selection, {
            x: canvas.x - interaction.startCanvas.x,
            y: canvas.y - interaction.startCanvas.y,
          });
        } else {
          this._interaction = {
            kind: "rubberBand",
            startCanvas: interaction.startCanvas,
            currentCanvas: canvas,
            base: interaction.extending ? [...this.store.selection] : [],
          };
          this.applyRubberBand();
        }
        break;
      }
      case "draggingItems":
        // Undo, redo or saving mid-drag closes the drag's undo group; outside a group every
        // event would move the selection by the whole translation again, so the drag ends here.
        if (!this.isGrouping) {
          this._interaction = { kind: "idle" };
          break;
        }
        this.store.drag(this.store.selection, {
          x: canvas.x - interaction.startCanvas.x,
          y: canvas.y - interaction.startCanvas.y,
        });
        break;
      case "rubberBand":
        this._interaction = { ...interaction, currentCanvas: canvas };
        this.applyRubberBand();
        break;
      case "panning":
        this.viewport.pan({ x: viewPoint.x - interaction.lastView.x, y: viewPoint.y - interaction.lastView.y });
        this._interaction = { kind: "panning", lastView: viewPoint };
        break;
    }
    this.changed();
  }

  pointerUp(viewPoint: Point): void {
    const finished = this._interaction;
    this._interaction = { kind: "idle" };
    switch (finished.kind) {
      case "pressed": {
        const hit = finished.hit;
        switch (hit.kind) {
          case "port":
            this.clickPort(hit.ref);
            break;
          case "statusDot":
            this.perform(() => {
              this.store.cycleStatus(hit.linkID, hit.end);
            });
            break;
          case "empty":
            if (this.store.pendingPort !== null) this.store.cancelPendingPort();
            if (!finished.extending && this.store.selection.length > 0) this.store.clearSelection();
            break;
          default:
            // A plain click on one of several selected objects narrows the selection to it.
            if (finished.collapseTo) this.store.select(finished.collapseTo);
        }
        break;
      }
      case "draggingItems":
        this.store.endDrag();
        break;
      default:
        break;
    }
    this.pointerMoved(viewPoint);
    this.changed();
  }

  /** The pointer sequence was taken away (pointercancel, lost capture): close what is open. */
  pointerCancelled(): void {
    const finished = this._interaction;
    if (finished.kind === "idle") return;
    this._interaction = { kind: "idle" };
    if (finished.kind === "draggingItems") this.store.endDrag();
    this.changed();
  }

  /**
   * Closes a drag whose pointer-up never arrived (e.g. swallowed by a context menu), so that
   * `store.beginDrag()` stays balanced and later edits do not pile into the drag's undo step.
   */
  endInterruptedDrag(): void {
    if (this._interaction.kind !== "draggingItems") return;
    this.store.endDrag();
    this._interaction = { kind: "idle" };
    this.changed();
  }

  /** Pointer moved without a button; null = left the view. */
  pointerMoved(viewPoint: Point | null): void {
    this._pointerView = viewPoint;
    if (viewPoint === null) {
      this.setHover(emptyHit);
      return;
    }
    if (this._interaction.kind === "idle") this.setHover(this.hitAt(viewPoint));
    if (this.store.pendingPort !== null || this._dropGhost !== null) this.changed();
  }

  private setHover(next: CanvasHit): void {
    if (hitsEqual(next, this._hover)) return;
    this._hover = next;
    this.hoverSince = this.scheduler.now();
    this.changed();
    if (next.kind === "statusDot" || next.kind === "link" || next.kind === "bundleLabel") {
      // Delayed tooltip: repaint once the delay has passed (if still hovering the same thing).
      this.later(tooltipDelay + 30, () => {
        if (hitsEqual(this._hover, next)) this.changed();
      });
    }
  }

  /** True when a cable cannot be plugged into `ref` right now. */
  isPortBlocked(ref: PortRef): boolean {
    if (this.scene.isPortUsed(ref)) return true;
    const pending = this.store.pendingPort;
    return pending !== null && !sameRef(pending, ref) && pending.deviceID === ref.deviceID;
  }

  /** CSS cursor for the current state. */
  get cursor(): string {
    const kind = this._interaction.kind;
    if (kind === "panning" || kind === "draggingItems") return "grabbing";
    if (this._isSpaceDown) return "grab";
    const hover = this._hover;
    switch (hover.kind) {
      case "port":
        return this.isPortBlocked(hover.ref) ? "not-allowed" : "pointer";
      case "statusDot":
        return "pointer";
      case "empty":
        return this.store.pendingPort !== null ? "crosshair" : "default";
      default:
        return "default";
    }
  }

  /** True when the hover tag of the hovered element should show now. */
  get tooltipIsDue(): boolean {
    if (this._interaction.kind !== "idle" || this._editing !== null || this._pointerView === null) return false;
    switch (this._hover.kind) {
      case "port":
      case "warning":
        return true;
      case "statusDot":
      case "link":
      case "bundleLabel":
        return this.scheduler.now() - this.hoverSince >= tooltipDelay;
      default:
        return false;
    }
  }

  // MARK: Selection helpers

  /** Selects on press. Returns the item the selection should collapse to on a plain release. */
  private pressSelect(item: SelectionItem, extending: boolean): SelectionItem | null {
    if (extending) {
      this.store.select(item, true);
      return null;
    }
    if (this.store.isSelected(item)) {
      return this.store.selection.length > 1 ? item : null;
    }
    this.store.select(item);
    return null;
  }

  private selectLinks(ids: string[], extending: boolean): void {
    const items: SelectionItem[] = ids.map((id) => ({ kind: "link", id }));
    if (items.length === 0) return;
    if (extending) {
      const keys = new Set(items.map(itemKey));
      const allSelected = items.every((item) => this.store.isSelected(item));
      this.store.selection = allSelected
        ? this.store.selection.filter((item) => !keys.has(itemKey(item)))
        : [...this.store.selection, ...items];
    } else {
      this.store.selection = items;
    }
  }

  private draggableItem(hit: CanvasHit): SelectionItem | null {
    switch (hit.kind) {
      case "deviceHeader":
      case "devicePanel":
      case "warning":
        return { kind: "device", id: hit.deviceID };
      case "port":
        return { kind: "device", id: hit.ref.deviceID };
      case "annotation":
        return { kind: "annotation", id: hit.id };
      default:
        return null;
    }
  }

  /** The rubber band in canvas coordinates, while one is being dragged. */
  get rubberBandRect(): Rect | null {
    const interaction = this._interaction;
    if (interaction.kind !== "rubberBand") return null;
    return rectFromCorners(interaction.startCanvas, interaction.currentCanvas);
  }

  private applyRubberBand(): void {
    const interaction = this._interaction;
    if (interaction.kind !== "rubberBand") return;
    const caught = this.scene.elementsIn(rectFromCorners(interaction.startCanvas, interaction.currentCanvas));
    this.store.selection = [
      ...interaction.base,
      ...caught.devices.map((id): SelectionItem => ({ kind: "device", id })),
      ...caught.links.map((id): SelectionItem => ({ kind: "link", id })),
      ...caught.annotations.map((id): SelectionItem => ({ kind: "annotation", id })),
    ];
  }

  // MARK: Cabling

  clickPort(ref: PortRef): void {
    const wasIdle = this.store.pendingPort === null;
    try {
      const result = this.store.clickPort(ref);
      this.clearFeedback();
      if (result.kind === "connected") this.store.select({ kind: "link", id: result.link.id });
    } catch (error) {
      this.showFeedback(messageOf(error));
      this.flashRejected(ref);
      // Clicking an occupied port outside of cabling shows what occupies it.
      const code = (error as { code?: unknown }).code;
      const used = (error as { ref?: PortRef }).ref ?? ref;
      if (wasIdle && code === "portInUse") {
        const link = linkAt(this.store.project, used);
        if (link) this.store.select({ kind: "link", id: link.id });
      }
    }
  }

  private flashRejected(ref: PortRef): void {
    this._rejectedPort = ref;
    this.rejectedGeneration += 1;
    const generation = this.rejectedGeneration;
    this.changed();
    this.later(rejectFlashDuration, () => {
      if (this.rejectedGeneration !== generation) return;
      this._rejectedPort = null;
      this.changed();
    });
  }

  /** Where the cable being pulled from the pending port ends (pointer, or the hovered port). */
  pendingCable(): { start: Point; end: Point } | null {
    const pending = this.store.pendingPort;
    const pointer = this._pointerView;
    if (!pending || !pointer) return null;
    const scene = this.scene;
    const start = scene.portCenter(pending);
    if (!start) return null;
    let end = this.viewport.canvasPoint(pointer);
    const hover = this._hover;
    if (hover.kind === "port" && !sameRef(hover.ref, pending)) {
      end = scene.portCenter(hover.ref) ?? end;
    }
    return { start, end };
  }

  // MARK: Double click

  private handleDoubleClick(hit: CanvasHit, canvas: Point): boolean {
    switch (hit.kind) {
      case "deviceHeader":
      case "devicePanel":
      case "warning":
        this.store.select({ kind: "device", id: hit.deviceID });
        this.beginEditing({ kind: "hostname", id: hit.deviceID });
        return true;
      case "annotation":
        this.store.select({ kind: "annotation", id: hit.id });
        this.beginEditing({ kind: "annotation", id: hit.id });
        return true;
      case "bundleLabel":
        this.beginEditing({ kind: "bundleLabel", id: hit.bundleID });
        return true;
      case "empty":
        if (this.store.pendingPort !== null) return false;
        this.beginEditing({ kind: "newAnnotation", point: canvas });
        return true;
      default:
        return false;
    }
  }

  // MARK: Wheel and pinch

  /**
   * A wheel event with deltas in view pixels (DOM convention: positive y scrolls down).
   * `zoom`: Cmd/Ctrl held or a trackpad pinch (browsers report pinches as Ctrl-wheel).
   */
  wheel(at: Point, deltaX: number, deltaY: number, zoom: boolean): void {
    this.finishEditing(true);
    if (zoom) {
      if (deltaY === 0) return;
      const clamped = Math.min(Math.max(deltaY, -25), 25);
      this.viewport.zoomBy(Math.exp(-clamped * 0.01), at);
    } else {
      if (deltaX === 0 && deltaY === 0) return;
      this.viewport.pan({ x: -deltaX, y: -deltaY });
    }
    this.refreshAfterViewportChange(at);
  }

  /** Pinch gesture (Safari gesture events): multiplies the zoom around `at`. */
  pinch(factor: number, at: Point): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.finishEditing(true);
    this.viewport.zoomBy(factor, at);
    this.refreshAfterViewportChange(at);
  }

  private refreshAfterViewportChange(pointer: Point): void {
    // The content moved under a resting pointer.
    if (this._interaction.kind === "idle") this.pointerMoved(pointer);
    this.changed();
  }

  /** Middle button: pans - unless the primary button is busy (that would leave beginDrag open). */
  middleDown(viewPoint: Point): boolean {
    if (this._interaction.kind !== "idle") return false;
    this.finishEditing(true);
    this._interaction = { kind: "panning", lastView: viewPoint };
    this.changed();
    return true;
  }

  middleUp(viewPoint: Point): void {
    if (this._interaction.kind === "panning") this._interaction = { kind: "idle" };
    this.pointerMoved(viewPoint);
    this.changed();
  }

  // MARK: Keyboard

  /** Handles a key press on the focused canvas; returns true when it was consumed. */
  keyDown(event: KeyInput): boolean {
    if (event.metaKey || event.ctrlKey) return false;
    switch (event.key) {
      case "Escape":
        this.cancelCurrentOperation();
        return true;
      case "Backspace":
      case "Delete":
        if (this.store.selection.length === 0) return false;
        this.deleteSelection();
        return true;
      case " ":
      case "Spacebar":
        if (!event.repeat && !this._isSpaceDown) {
          this._isSpaceDown = true;
          this.changed();
        }
        return true;
      case "ArrowLeft":
        return this.nudge(-1, 0);
      case "ArrowRight":
        return this.nudge(1, 0);
      case "ArrowDown":
        return this.nudge(0, 1);
      case "ArrowUp":
        return this.nudge(0, -1);
      case "Enter": {
        // Edit the single selected object.
        const selection = this.store.selection;
        if (selection.length !== 1) return false;
        const item = selection[0];
        if (item.kind === "device") this.beginEditing({ kind: "hostname", id: item.id });
        else if (item.kind === "annotation") this.beginEditing({ kind: "annotation", id: item.id });
        else return false;
        return true;
      }
      default:
        return false;
    }
  }

  keyUp(event: KeyInput): void {
    if (event.key === " " || event.key === "Spacebar") this.spaceReleased();
  }

  /** Space went up or the canvas lost the keyboard. */
  spaceReleased(): void {
    if (!this._isSpaceDown) return;
    this._isSpaceDown = false;
    this.changed();
  }

  /** Esc: abort whatever is in progress, innermost first. */
  cancelCurrentOperation(): void {
    const interaction = this._interaction;
    switch (interaction.kind) {
      case "draggingItems":
        this.store.cancelDrag();
        this._interaction = { kind: "idle" };
        break;
      case "rubberBand":
        this.store.selection = interaction.base;
        this._interaction = { kind: "idle" };
        break;
      case "panning":
      case "pressed":
        this._interaction = { kind: "idle" };
        break;
      case "idle":
        if (this.store.pendingPort !== null) {
          this.store.cancelPendingPort();
        } else if (this.store.selection.length > 0) {
          this.store.clearSelection();
        }
        break;
    }
    this.clearFeedback();
    this.changed();
  }

  deleteSelection(): void {
    if (this.store.selection.length === 0) return;
    if (this._interaction.kind === "draggingItems") {
      this.store.cancelDrag();
      this._interaction = { kind: "idle" };
    }
    this.perform(() => this.store.removeSelection());
    this.changed();
  }

  /** Moves the selection by one grid step (or one point without snapping) as one undo step. */
  nudge(dx: number, dy: number): boolean {
    if (this.store.selection.length === 0) return false;
    const step = this.store.snapToGrid && this.store.gridSize > 0 ? this.store.gridSize : 1;
    const delta = { x: dx * step, y: dy * step };
    const store = this.store as ProjectStoreAPI & { moveSelection?: (delta: Point) => void };
    this.perform(() => {
      if (typeof store.moveSelection === "function") store.moveSelection(delta);
      else store.drag(store.selection, delta);
    });
    return true;
  }

  selectAll(): void {
    this.store.selectAll();
  }

  // MARK: Context menu

  /** The context menu for a secondary click; also adjusts the selection like the Mac app. */
  contextMenu(viewPoint: Point): MenuEntry[] | null {
    this.finishEditing(true);
    this.endInterruptedDrag();
    if (this._interaction.kind !== "idle") {
      this._interaction = { kind: "idle" };
      this.changed();
    }
    const canvas = this.viewport.canvasPoint(viewPoint);
    const hit = this.hitAt(viewPoint);
    const store = this.store;
    const project = store.project;
    const item = (label: string, action: () => void, enabled = true, checked?: boolean): MenuEntry => ({
      kind: "item",
      label,
      action,
      enabled,
      checked,
    });
    const separator: MenuEntry = { kind: "separator" };

    switch (hit.kind) {
      case "deviceHeader":
      case "devicePanel":
      case "warning":
      case "port": {
        const id = hitDeviceID(hit);
        if (id === null) return null;
        const device: SelectionItem = { kind: "device", id };
        if (!store.isSelected(device)) store.select(device);
        const entries: MenuEntry[] = [item(CanvasStrings.menuRename, () => this.beginEditing({ kind: "hostname", id }))];
        const openConsole = this.host.openConsole;
        if (openConsole) {
          const enabled = this.host.canOpenConsole ? this.host.canOpenConsole(id) : true;
          entries.push(item(CanvasStrings.menuOpenConsole, () => openConsole(id), enabled));
        }
        entries.push(separator, item(CanvasStrings.menuDelete, () => this.deleteSelection()));
        return entries;
      }
      case "annotation": {
        const note: SelectionItem = { kind: "annotation", id: hit.id };
        if (!store.isSelected(note)) store.select(note);
        return [
          item(CanvasStrings.menuEditText, () => this.beginEditing({ kind: "annotation", id: hit.id })),
          separator,
          item(CanvasStrings.menuDelete, () => this.deleteSelection()),
        ];
      }
      case "link":
      case "bundleLabel":
      case "statusDot": {
        const ids = hit.kind === "link" ? hit.ids : hit.kind === "bundleLabel" ? hit.linkIDs : [hit.linkID];
        const items: SelectionItem[] = ids.map((id) => ({ kind: "link", id }));
        if (!items.every((entry) => store.isSelected(entry))) store.selection = items;
        const selectedLinks = store.project.links.filter((link) => store.isSelected({ kind: "link", id: link.id }));
        const first = selectedLinks[0];
        if (!first) return null;

        const entries: MenuEntry[] = [];
        entries.push({
          kind: "item",
          label: CanvasStrings.menuCableType,
          enabled: true,
          submenu: cableTypes.map((type) =>
            item(
              cableName(type),
              () => {
                store.beginUndoGroup();
                try {
                  for (const link of selectedLinks) this.perform(() => store.setCableType(link.id, type));
                } finally {
                  store.endUndoGroup();
                }
              },
              true,
              selectedLinks.every((link) => link.cableType === type),
            ),
          ),
        });
        if (selectedLinks.length === 1) {
          for (const end of linkEnds as readonly LinkEnd[]) {
            const title = `${end === "a" ? CanvasStrings.menuStatusA : CanvasStrings.menuStatusB} (${portTitle(
              end === "a" ? first.a : first.b,
              project,
            )})`;
            entries.push({
              kind: "item",
              label: title,
              enabled: true,
              submenu: linkStatuses.map((status) =>
                item(
                  capitalized(statusName(status)),
                  () => this.perform(() => store.setStatus(first.id, end, status)),
                  true,
                  linkStatus(first, end) === status,
                ),
              ),
            });
          }
        }
        entries.push(separator);
        const bundleIDs = new Set(
          selectedLinks.map((link) => link.bundleID).filter((id): id is string => id !== undefined),
        );
        if (bundleIDs.size === 0) {
          const parallel = new Set(selectedLinks.map(linkDevicePairKey)).size === 1;
          entries.push(
            item(
              CanvasStrings.menuBundle,
              () =>
                this.perform(() => {
                  store.createBundle(selectedLinks.map((link) => link.id));
                }),
              selectedLinks.length >= 2 && parallel,
            ),
          );
        } else if (bundleIDs.size === 1) {
          const bundleID = [...bundleIDs][0];
          entries.push(
            item(CanvasStrings.menuRenameBundle, () => this.beginEditing({ kind: "bundleLabel", id: bundleID })),
            item(CanvasStrings.menuUnbundle, () => this.perform(() => store.unbundle(bundleID))),
          );
        }
        entries.push(separator, item(CanvasStrings.menuDeleteCable, () => this.deleteSelection()));
        return entries;
      }
      case "empty":
        return [
          item(CanvasStrings.menuAddAnnotation, () => this.beginEditing({ kind: "newAnnotation", point: canvas })),
          item(
            CanvasStrings.menuSelectAll,
            () => store.selectAll(),
            !(project.devices.length === 0 && project.annotations.length === 0),
          ),
          separator,
          item(CanvasStrings.menuZoomToFit, () => this.viewport.fit()),
          item(CanvasStrings.menuActualSize, () => this.viewport.reset()),
        ];
    }
  }

  // MARK: Inline editing

  beginEditing(target: EditTarget): void {
    this.finishEditing(true);
    const scene = this.scene;
    let initialText = "";
    let placeholder: string | null = null;
    let multiline = false;
    switch (target.kind) {
      case "hostname": {
        const node = scene.node(target.id);
        if (!node) return;
        initialText = node.hostname;
        break;
      }
      case "annotation": {
        const note = scene.annotations.find((annotation) => annotation.id === target.id);
        if (!note) return;
        initialText = note.text;
        multiline = true;
        break;
      }
      case "newAnnotation":
        multiline = true;
        placeholder = CanvasStrings.newAnnotationPlaceholder;
        break;
      case "bundleLabel": {
        const bundle = scene.bundles.find((candidate) => candidate.id === target.id);
        if (!bundle) return;
        initialText = bundle.label;
        break;
      }
    }
    this._editing = { target, initialText, draft: initialText, placeholder, multiline };
    this.changed();
  }

  /** The view reports every change of the field. */
  setEditDraft(text: string): void {
    if (this._editing) this._editing.draft = text;
  }

  /** Ends inline editing; `commit` applies the typed text. */
  finishEditing(commit: boolean): void {
    const session = this._editing;
    if (!session || this.isFinishingEdit) return;
    this.isFinishingEdit = true;
    try {
      this._editing = null;
      this.changed();
      if (commit) this.applyEdit(session.target, session.draft);
    } finally {
      this.isFinishingEdit = false;
    }
  }

  private applyEdit(target: EditTarget, raw: string): void {
    const trimmed = trimWhitespaceAndNewlines(raw);
    const store = this.store;
    switch (target.kind) {
      case "hostname": {
        const name = trimmed.replace(/\n/g, " ");
        // An emptied field keeps the old name.
        if (name === "") return;
        if (name === this.scene.node(target.id)?.hostname) return;
        this.perform(() => store.renameDevice(target.id, name));
        return;
      }
      case "annotation":
        if (trimmed === "") this.perform(() => store.removeAnnotation(target.id));
        else this.perform(() => store.setAnnotationText(target.id, trimmed));
        return;
      case "newAnnotation": {
        if (trimmed === "") return;
        this.perform(() => {
          const annotation = store.addAnnotation(trimmed, target.point);
          store.select({ kind: "annotation", id: annotation.id });
        });
        return;
      }
      case "bundleLabel":
        if (trimmed === "") return;
        this.perform(() => store.renameBundle(target.id, trimmed.replace(/\n/g, " ")));
        return;
    }
  }

  // MARK: Drop target (palette -> canvas)

  /** A palette drag moves over the canvas; `templateID` is null when the payload is unknown yet. */
  dragOver(viewPoint: Point, templateID: string | null): void {
    this._pointerView = viewPoint;
    const template = templateID ? this.store.catalog.template(templateID) : undefined;
    if (template) {
      const point = this.store.snap(this.viewport.canvasPoint(viewPoint));
      const preview = makeDevice(template, "", point);
      this._dropGhost = new NodeGeometry(preview, this.store.viewMode);
    } else {
      this._dropGhost = null;
    }
    this.changed();
  }

  clearDropGhost(): void {
    if (this._dropGhost === null) return;
    this._dropGhost = null;
    this.changed();
  }

  /** Places the device of a palette drag at a view location. Returns true on success. */
  drop(viewPoint: Point, templateID: string): boolean {
    this.clearDropGhost();
    try {
      const device = this.store.addDevice(templateID, this.viewport.canvasPoint(viewPoint));
      this.store.select({ kind: "device", id: device.id });
      this.clearFeedback();
      return true;
    } catch (error) {
      this.showFeedback(messageOf(error));
      return false;
    }
  }
}
