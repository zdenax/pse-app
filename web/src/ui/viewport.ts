// Zoom and pan state of the canvas, shared by the toolbar (zoom buttons, menu shortcuts) and the
// canvas (wheel/pinch zoom, panning, coordinate conversion). Framework-free and observable.
// Port of Sources/NetSketchCanvas/CanvasViewport.swift.
//
// Mapping: viewPoint = canvasPoint * zoom + offset (view space has its origin top-left, y down).
//
// The canvas is expected to:
//   - keep `viewSize` up to date (setViewSize) whenever its element is resized,
//   - install `contentBoundsProvider` so that reset() and fit() know the diagram's extent,
//   - re-render on subscribe() notifications (or useViewportVersion in React).

import type { Point } from "../core/model";

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class Viewport {
  static readonly minZoom = 0.2;
  static readonly maxZoom = 4.0;
  /** Factor of one zoomIn() / zoomOut() step. */
  static readonly zoomStep = 1.25;

  private _zoom = 1;
  private _offset: Point = { x: 0, y: 0 };
  private _viewSize: Size = { width: 0, height: 0 };
  private _version = 0;
  private listeners = new Set<() => void>();

  /** Bounding box of the current content in canvas coordinates; installed by the canvas. */
  contentBoundsProvider: (() => Rect | null) | null = null;

  // MARK: Observation

  /** Increases with every change (for useSyncExternalStore). */
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

  // MARK: State

  /** Zoom factor, 1 = 100 %. Values outside minZoom...maxZoom are clamped when used. */
  get zoom(): number {
    return this._zoom;
  }

  set zoom(value: number) {
    if (value === this._zoom) return;
    this._zoom = value;
    this.changed();
  }

  /** Translation of the canvas origin in view pixels. */
  get offset(): Point {
    return this._offset;
  }

  set offset(value: Point) {
    if (value.x === this._offset.x && value.y === this._offset.y) return;
    this._offset = { x: value.x, y: value.y };
    this.changed();
  }

  /** Size of the canvas element in view pixels; kept up to date by the canvas. */
  get viewSize(): Size {
    return this._viewSize;
  }

  setViewSize(size: Size): void {
    if (size.width === this._viewSize.width && size.height === this._viewSize.height) return;
    this._viewSize = { width: size.width, height: size.height };
    this.changed();
  }

  /** Sets zoom and offset at once, with a single notification. */
  set(zoom: number, offset: Point): void {
    if (zoom === this._zoom && offset.x === this._offset.x && offset.y === this._offset.y) return;
    this._zoom = zoom;
    this._offset = { x: offset.x, y: offset.y };
    this.changed();
  }

  /** Zoom clamped to the supported range. */
  get clampedZoom(): number {
    const value = Number.isFinite(this._zoom) ? this._zoom : 1;
    return Math.min(Math.max(value, Viewport.minZoom), Viewport.maxZoom);
  }

  /** Zoom as a whole percentage, handy for the toolbar label. */
  get zoomPercent(): number {
    return Math.round(this.clampedZoom * 100);
  }

  get canZoomIn(): boolean {
    return this.clampedZoom < Viewport.maxZoom - 1e-9;
  }

  get canZoomOut(): boolean {
    return this.clampedZoom > Viewport.minZoom + 1e-9;
  }

  // MARK: Commands

  zoomIn(): void {
    this.zoomBy(Viewport.zoomStep);
  }

  zoomOut(): void {
    this.zoomBy(1 / Viewport.zoomStep);
  }

  /** Back to 100 %. If the canvas knows its content, the content is brought back into view. */
  reset(): void {
    const bounds = this.contentBoundsProvider?.() ?? null;
    const { width, height } = this._viewSize;
    if (width <= 0 || height <= 0 || !bounds || bounds.width <= 0 || bounds.height <= 0) {
      this.set(1, { x: 0, y: 0 });
      return;
    }
    // Center content that fits; otherwise pin its top-left corner with a small margin.
    const margin = 32;
    const x = bounds.width + 2 * margin <= width ? (width - bounds.width) / 2 - bounds.x : margin - bounds.x;
    const y = bounds.height + 2 * margin <= height ? (height - bounds.height) / 2 - bounds.y : margin - bounds.y;
    this.set(1, { x: Math.round(x), y: Math.round(y) });
  }

  /**
   * Scales and centers the view so that `bounds` (canvas coordinates) is visible. Without
   * bounds the content bounds of the canvas are used; without those it is reset().
   * A tiny diagram is never blown up beyond 100 %.
   */
  fit(bounds?: Rect | null, margin = 48): void {
    const target = bounds ?? this.contentBoundsProvider?.() ?? null;
    if (!target) {
      this.reset();
      return;
    }
    const { width, height } = this._viewSize;
    if (width <= 0 || height <= 0 || target.width <= 0 || target.height <= 0) {
      this.set(1, { x: 0, y: 0 });
      return;
    }
    const availableWidth = Math.max(width - 2 * margin, 40);
    const availableHeight = Math.max(height - 2 * margin, 40);
    const scale = Math.min(availableWidth / target.width, availableHeight / target.height);
    const zoom = Math.min(Math.max(Math.min(scale, 1), Viewport.minZoom), Viewport.maxZoom);
    this.set(zoom, {
      x: Math.round((width - target.width * zoom) / 2 - target.x * zoom),
      y: Math.round((height - target.height * zoom) / 2 - target.y * zoom),
    });
  }

  /** Multiplies the zoom by `factor`, keeping `anchor` (view coordinates) fixed on screen. */
  zoomBy(factor: number, anchor?: Point): void {
    this.setZoom(this.clampedZoom * factor, anchor);
  }

  /** Sets an absolute zoom, keeping `anchor` (view coordinates; default the view center) in place. */
  setZoom(value: number, anchor?: Point): void {
    const old = this.clampedZoom;
    const zoom = Math.min(Math.max(Number.isFinite(value) ? value : 1, Viewport.minZoom), Viewport.maxZoom);
    const pivot = anchor ?? { x: this._viewSize.width / 2, y: this._viewSize.height / 2 };
    // Keep the canvas point under the pivot where it is.
    const canvasX = (pivot.x - this._offset.x) / old;
    const canvasY = (pivot.y - this._offset.y) / old;
    this.set(zoom, { x: pivot.x - canvasX * zoom, y: pivot.y - canvasY * zoom });
  }

  /** Pans by a delta given in view pixels. */
  pan(delta: Point): void {
    if (delta.x === 0 && delta.y === 0) return;
    this.offset = { x: this._offset.x + delta.x, y: this._offset.y + delta.y };
  }

  // MARK: Coordinate conversion

  canvasPoint(viewPoint: Point): Point {
    const z = this.clampedZoom;
    return { x: (viewPoint.x - this._offset.x) / z, y: (viewPoint.y - this._offset.y) / z };
  }

  viewPoint(canvasPoint: Point): Point {
    const z = this.clampedZoom;
    return { x: canvasPoint.x * z + this._offset.x, y: canvasPoint.y * z + this._offset.y };
  }

  canvasRect(viewRect: Rect): Rect {
    const z = this.clampedZoom;
    return {
      x: (viewRect.x - this._offset.x) / z,
      y: (viewRect.y - this._offset.y) / z,
      width: viewRect.width / z,
      height: viewRect.height / z,
    };
  }

  viewRect(canvasRect: Rect): Rect {
    const z = this.clampedZoom;
    return {
      x: canvasRect.x * z + this._offset.x,
      y: canvasRect.y * z + this._offset.y,
      width: canvasRect.width * z,
      height: canvasRect.height * z,
    };
  }

  /** The canvas point in the middle of the visible area; (400, 300) before the canvas has a size. */
  visibleCenter(): Point {
    const { width, height } = this._viewSize;
    if (width <= 0 || height <= 0) return { x: 400, y: 300 };
    return this.canvasPoint({ x: width / 2, y: height / 2 });
  }
}
