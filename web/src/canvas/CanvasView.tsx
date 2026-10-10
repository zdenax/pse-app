// The topology canvas: devices with their front panels, cables, bundles and notes, drawn as SVG
// by React (port of CanvasView.swift / CanvasNSView.swift). All input logic lives in CanvasInput
// (input.ts); this component translates DOM events into its calls and renders the scene.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { PortRef } from "../core/model";
import type { ProjectStoreAPI } from "../core/store-api";
import type { Point, Rect } from "./geom";
import { containsPoint } from "./geom";
import { ClickCounter, CanvasInput, browserScheduler, type CanvasInputHost, type CanvasViewportLike, type MenuEntry } from "./input";
import { tooltipLayout } from "./overlay";
import { cableStyle, cssColor, resolvePalette } from "./palette";
import { PendingCable } from "./render/cables";
import { DiagramLayers, diagramTextAttributes, type RenderOptions } from "./render/DiagramLayers";
import { Banners, ContextMenu, DropGhost, EmptyHint, GridDots, InlineEditor, RubberBand, Tooltip } from "./render/overlays";
import { SceneCache } from "./scene";
import { CanvasStrings, tooltipLines } from "./strings";
import { installBrowserMeasurer } from "./text";
import "./canvas.css";

/** Default drag type of palette templates (ui/Palette.tsx). */
export const defaultTemplateDragType = "application/x-netsketch-template";
const templateDragPrefix = "netsketch-template:";

/** The viewport the canvas drives (ui/viewport.ts `Viewport` fits). */
export interface CanvasViewport extends CanvasViewportLike {
  readonly version: number;
  subscribe(listener: () => void): () => void;
  readonly zoom: number;
  readonly offset: Point;
  setViewSize(size: { width: number; height: number }): void;
  contentBoundsProvider: (() => Rect | null) | null;
}

export interface CanvasViewProps {
  store: ProjectStoreAPI;
  viewport: CanvasViewport;
  /** Optional services of the shell (console from the context menu). */
  host?: CanvasInputHost;
  /** dataTransfer type of palette drags. */
  templateDragType?: string;
}

interface Observable {
  readonly version: number;
  subscribe(listener: () => void): () => void;
}

function useVersion(source: Observable): number {
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source]);
  const snapshot = () => source.version;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Follows the system appearance (the shell's CSS uses prefers-color-scheme as well). */
function usePrefersDark(): boolean {
  const query = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!query) return () => {};
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => query?.matches ?? false,
    () => false,
  );
}

const isMacPlatform =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

// The palette sets its drag data in dragstart; during dragover the browser only exposes the
// types. A bubbling window listener runs after the palette's handler and can still read it.
let draggedTemplateID: string | null = null;
let dragTrackingInstalled = false;

function trackTemplateDrags(type: string): void {
  if (dragTrackingInstalled || typeof window === "undefined") return;
  dragTrackingInstalled = true;
  window.addEventListener("dragstart", (event) => {
    const data = event.dataTransfer;
    if (!data) return;
    const id = data.getData(type);
    const text = data.getData("text/plain");
    draggedTemplateID = id !== "" ? id : text.startsWith(templateDragPrefix) ? text.slice(templateDragPrefix.length) : null;
  });
  window.addEventListener("dragend", () => {
    draggedTemplateID = null;
  });
}

function templateIDFromDrop(data: DataTransfer, type: string): string | null {
  const id = data.getData(type);
  if (id !== "") return id;
  const text = data.getData("text/plain");
  if (text.startsWith(templateDragPrefix) && text.length > templateDragPrefix.length) {
    return text.slice(templateDragPrefix.length);
  }
  return draggedTemplateID;
}

const emptySet: ReadonlySet<string> = new Set();

// Geometry must measure text with the browser's font engine before the first scene is built.
installBrowserMeasurer();

export function CanvasView({ store, viewport, host, templateDragType = defaultTemplateDragType }: CanvasViewProps) {
  useEffect(() => trackTemplateDrags(templateDragType), [templateDragType]);
  useVersion(store);
  useVersion(viewport);
  const dark = usePrefersDark();
  const palette = resolvePalette(dark);

  const [cache] = useState(() => new SceneCache());
  const input = useMemo(
    () =>
      new CanvasInput({
        store,
        viewport,
        scene: () => cache.scene(store.project, store.viewMode),
        scheduler: browserScheduler,
      }),
    [store, viewport, cache],
  );
  input.host = host ?? {};
  useVersion(input);
  useEffect(() => () => input.dispose(), [input]);

  const hostRef = useRef<HTMLDivElement>(null);
  const [clicks] = useState(() => new ClickCounter());
  const [menu, setMenu] = useState<{ at: Point; entries: MenuEntry[] } | null>(null);
  const middlePointer = useRef<number | null>(null);
  const gridID = useId().replace(/:/g, "");

  const project = store.project;
  const scene = cache.scene(project, store.viewMode);
  const zoom = viewport.clampedZoom;
  const offset = viewport.offset;
  const viewSize = viewport.viewSize;

  // The viewport learns the content extent from the scene.
  useEffect(() => {
    const provider = () => cache.scene(store.project, store.viewMode).contentBounds;
    viewport.contentBoundsProvider = provider;
    return () => {
      if (viewport.contentBoundsProvider === provider) viewport.contentBoundsProvider = null;
    };
  }, [viewport, store, cache]);

  // Report the visible size; the first layout brings a freshly opened project into view.
  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    let didInitialLayout = false;
    const report = () => {
      const size = { width: element.clientWidth, height: element.clientHeight };
      viewport.setViewSize(size);
      if (!didInitialLayout && size.width > 1 && size.height > 1) {
        didInitialLayout = true;
        const content = cache.scene(store.project, store.viewMode).contentBounds;
        const untouched = viewport.zoom === 1 && viewport.offset.x === 0 && viewport.offset.y === 0;
        const visible = { x: 0, y: 0, ...size };
        if (untouched && content && !containsRect(visible, content)) viewport.fit();
      }
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [viewport, store, cache]);

  const viewPointOf = (event: { clientX: number; clientY: number }): Point => {
    const element = hostRef.current;
    if (!element) return { x: event.clientX, y: event.clientY };
    const bounds = element.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  const focusCanvas = useCallback(() => {
    hostRef.current?.focus({ preventScroll: true });
  }, []);

  // Wheel and Safari pinch need non-passive native listeners to stop the page from scrolling.
  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    const point = (event: { clientX: number; clientY: number }): Point => {
      const bounds = element.getBoundingClientRect();
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      let dx = event.deltaX * unit;
      let dy = event.deltaY * unit;
      const zoomGesture = event.ctrlKey || event.metaKey;
      // Shift + mouse wheel scrolls sideways on platforms that do not convert it themselves.
      if (!zoomGesture && event.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      input.wheel(point(event), dx, dy, zoomGesture);
    };
    let lastScale = 1;
    let lastPoint: Point = { x: element.clientWidth / 2, y: element.clientHeight / 2 };
    type GestureEvent = Event & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      lastScale = 1;
      const gesture = event as GestureEvent;
      if (typeof gesture.clientX === "number") lastPoint = point(gesture);
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as GestureEvent;
      if (!(gesture.scale > 0)) return;
      input.pinch(gesture.scale / lastScale, lastPoint);
      lastScale = gesture.scale;
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("gesturestart", onGestureStart);
    element.addEventListener("gesturechange", onGestureChange);
    element.addEventListener("gestureend", onGestureChange);
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("gesturestart", onGestureStart);
      element.removeEventListener("gesturechange", onGestureChange);
      element.removeEventListener("gestureend", onGestureChange);
    };
  }, [input]);

  // Space released elsewhere, focus lost, Esc while nothing else has the keyboard.
  useEffect(() => {
    const onKeyUp = (event: KeyboardEvent) => input.keyUp(event);
    const onBlur = () => {
      input.spaceReleased();
      input.pointerCancelled();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      const active = document.activeElement;
      if (active === null || active === document.body) input.cancelCurrentOperation();
    };
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [input]);

  const closeMenu = useCallback(() => {
    setMenu(null);
    focusCanvas();
  }, [focusCanvas]);

  // MARK: Pointer

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (menu) setMenu(null);
    const point = viewPointOf(event);
    if (event.button === 1) {
      event.preventDefault();
      focusCanvas();
      if (input.middleDown(point)) {
        middlePointer.current = event.pointerId;
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }
      return;
    }
    if (event.button !== 0) return;
    // Control-click on the Mac is the secondary click; the contextmenu event follows.
    if (isMacPlatform && event.ctrlKey) return;
    event.preventDefault();
    focusCanvas();
    const clickCount = clicks.register(event.timeStamp, point, 0);
    input.pointerDown(point, {
      clickCount,
      extending: event.shiftKey || event.metaKey || (!isMacPlatform && event.ctrlKey),
      panModifier: event.altKey,
    });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = viewPointOf(event);
    if (input.interaction.kind !== "idle") input.pointerDragged(point);
    else input.pointerMoved(point);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = viewPointOf(event);
    if (middlePointer.current === event.pointerId && event.button === 1) {
      middlePointer.current = null;
      input.middleUp(point);
    } else if (event.button === 0) {
      input.pointerUp(point);
    }
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onPointerCancel = () => {
    middlePointer.current = null;
    input.pointerCancelled();
  };

  const onPointerLeave = () => {
    if (input.interaction.kind === "idle") input.pointerMoved(null);
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    focusCanvas();
    const point = viewPointOf(event);
    const entries = input.contextMenu(point);
    setMenu(entries && entries.length > 0 ? { at: point, entries } : null);
  };

  // MARK: Keyboard

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (input.keyDown(event)) event.preventDefault();
  };

  // MARK: Palette drops

  const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    const types = Array.from(event.dataTransfer.types);
    const ours = types.includes(templateDragType) || draggedTemplateID !== null;
    if (!ours) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    input.dragOver(viewPointOf(event), draggedTemplateID);
  };

  const onDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    input.clearDropGhost();
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    const id = templateIDFromDrop(event.dataTransfer, templateDragType);
    input.clearDropGhost();
    if (!id) return;
    event.preventDefault();
    draggedTemplateID = null;
    input.drop(viewPointOf(event), id);
    focusCanvas();
  };

  // MARK: Render state

  const selection = store.selection;
  const selected = useMemo(() => {
    const devices = new Set<string>();
    const links = new Set<string>();
    const annotations = new Set<string>();
    for (const item of selection) {
      if (item.kind === "device") devices.add(item.id);
      else if (item.kind === "link") links.add(item.id);
      else annotations.add(item.id);
    }
    return { devices, links, annotations };
  }, [selection]);

  const hover = input.hover;
  const hoverLinks = useMemo<ReadonlySet<string>>(() => {
    if (hover.kind === "link") return new Set(hover.ids);
    if (hover.kind === "bundleLabel") return new Set(hover.linkIDs);
    return emptySet;
  }, [hover]);

  const pendingPort = store.pendingPort;
  let hoverPort: PortRef | null = null;
  let hoverPortRejected = false;
  if (hover.kind === "port") {
    hoverPort = hover.ref;
    hoverPortRejected = input.isPortBlocked(hover.ref);
  }
  const editing = input.editing;
  const options: RenderOptions = {
    palette,
    zoom,
    isExport: false,
    selectedDevices: selected.devices,
    selectedLinks: selected.links,
    selectedAnnotations: selected.annotations,
    pendingPort,
    hoverPort,
    hoverPortRejected,
    rejectedPort: input.rejectedPort,
    hoverLinks,
    editingDevice: editing?.target.kind === "hostname" ? editing.target.id : null,
    editingAnnotation: editing?.target.kind === "annotation" ? editing.target.id : null,
  };

  const pendingCable = input.pendingCable();
  const rubberBand = input.rubberBandRect;
  const rubberBandView = rubberBand ? viewport.viewRect(rubberBand) : null;
  const dropGhost = input.dropGhost;
  const showEmptyHint =
    project.devices.length === 0 && project.annotations.length === 0 && dropGhost === null && editing === null;
  const pointer = input.pointerView;
  const tooltip =
    input.tooltipIsDue && pointer
      ? tooltipLayout(tooltipLines(hover, project), hover, scene, viewport, pointer, viewSize)
      : null;

  return (
    <div
      ref={hostRef}
      className="ns-canvas"
      tabIndex={0}
      role="application"
      aria-label={CanvasStrings.canvasLabel}
      data-view-mode={store.viewMode}
      style={{ cursor: input.cursor, background: cssColor(palette.canvas) }}
      onPointerDown={onPointerDown}
      onMouseDown={(event) => {
        // Keeps the middle button from starting the browser's autoscroll.
        if (event.button === 1) event.preventDefault();
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => input.keyUp(event)}
      onBlur={(event) => {
        if (event.target === event.currentTarget) input.spaceReleased();
      }}
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <svg className="ns-canvas-svg" width="100%" height="100%" {...diagramTextAttributes} aria-hidden="true">
        <GridDots id={`ns-grid-${gridID}`} gridSize={store.gridSize} zoom={zoom} offset={offset} palette={palette} />
        <g transform={`translate(${offset.x} ${offset.y}) scale(${zoom})`}>
          <DiagramLayers scene={scene} options={options} />
          {dropGhost && <DropGhost ghost={dropGhost} palette={palette} />}
          {pendingCable && (
            <PendingCable
              start={pendingCable.start}
              end={pendingCable.end}
              style={cableStyle(store.activeCableType, palette)}
            />
          )}
        </g>
        {rubberBandView && <RubberBand rect={rubberBandView} palette={palette} />}
        {showEmptyHint && <EmptyHint text={CanvasStrings.emptyCanvasHint} size={viewSize} palette={palette} />}
        {tooltip && <Tooltip layout={tooltip} palette={palette} />}
      </svg>
      <Banners
        feedback={input.feedback}
        pendingHint={pendingPort ? CanvasStrings.pendingHint : null}
        palette={palette}
      />
      {editing && (
        <InlineEditor
          key={editingKey(editing.target)}
          session={editing}
          scene={scene}
          viewport={viewport}
          viewSize={viewSize}
          palette={palette}
          onDraft={(text) => input.setEditDraft(text)}
          onFinish={(commit, refocus) => {
            input.finishEditing(commit);
            if (refocus) focusCanvas();
          }}
        />
      )}
      {menu && <ContextMenu at={menu.at} entries={menu.entries} viewSize={viewSize} onClose={closeMenu} />}
    </div>
  );
}

function editingKey(target: NonNullable<CanvasInput["editing"]>["target"]): string {
  return target.kind === "newAnnotation" ? `new:${target.point.x},${target.point.y}` : `${target.kind}:${target.id}`;
}

function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    containsPoint(outer, { x: inner.x, y: inner.y }) &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}
