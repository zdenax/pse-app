// Plain 2D geometry used by the canvas: points, rectangles (CGRect semantics) and the segment
// helpers of the Swift `Geometry` enum (DiagramScene.swift). Framework-free.

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** A rectangle with its origin top-left (y grows down), like a CGRect in a flipped context. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Swift's `CGFloat.rounded()`: halves away from zero (`-2.5` -> `-3`). */
export function roundHalfAway(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

export function rectAround(center: Point, size: Size): Rect {
  return { x: center.x - size.width / 2, y: center.y - size.height / 2, width: size.width, height: size.height };
}

export const minX = (r: Rect): number => r.x;
export const minY = (r: Rect): number => r.y;
export const maxX = (r: Rect): number => r.x + r.width;
export const maxY = (r: Rect): number => r.y + r.height;
export const midX = (r: Rect): number => r.x + r.width / 2;
export const midY = (r: Rect): number => r.y + r.height / 2;

export function center(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** CGRect.insetBy: positive values shrink, negative values grow. */
export function inset(r: Rect, dx: number, dy: number = dx): Rect {
  return { x: r.x + dx, y: r.y + dy, width: r.width - 2 * dx, height: r.height - 2 * dy };
}

export function offset(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, width: r.width, height: r.height };
}

export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(maxX(a), maxX(b)) - x, height: Math.max(maxY(a), maxY(b)) - y };
}

/** CGRect.contains(point): the minimum edges are inside, the maximum edges are not. */
export function containsPoint(r: Rect, p: Point): boolean {
  return r.width > 0 && r.height > 0 && p.x >= r.x && p.x < maxX(r) && p.y >= r.y && p.y < maxY(r);
}

/** CGRect.intersects: true when the rectangles overlap with a positive area. */
export function intersects(a: Rect, b: Rect): boolean {
  return a.x < maxX(b) && b.x < maxX(a) && a.y < maxY(b) && b.y < maxY(a);
}

/** CGRect.integral: the smallest rectangle with integer edges that contains `r`. */
export function integral(r: Rect): Rect {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return { x, y, width: Math.ceil(maxX(r)) - x, height: Math.ceil(maxY(r)) - y };
}

/** The rectangle spanned by two corners. */
export function rectFromCorners(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function rectEquals(a: Rect | null | undefined, b: Rect | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Distance from `p` to the segment a-b. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!(lengthSquared > 0.0001)) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared, 0), 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * For a segment that starts inside `r`, the parameter (0...1) at which it leaves the rect.
 * Returns 0 when the start is outside and 1 when the whole segment stays inside.
 */
export function exitParameter(start: Point, end: Point, r: Rect): number {
  if (!containsPoint(r, start)) return 0;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let t = 1;
  if (dx > 0) t = Math.min(t, (maxX(r) - start.x) / dx);
  if (dx < 0) t = Math.min(t, (r.x - start.x) / dx);
  if (dy > 0) t = Math.min(t, (maxY(r) - start.y) / dy);
  if (dy < 0) t = Math.min(t, (r.y - start.y) / dy);
  return Math.min(Math.max(t, 0), 1);
}

/** Parameter range (within 0...1) in which the segment runs inside `r`; null when it misses it. */
export function clipInterval(start: Point, end: Point, r: Rect): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  // Liang-Barsky: one (p, q) pair per rect edge.
  const edges: [number, number][] = [
    [-dx, start.x - r.x],
    [dx, maxX(r) - start.x],
    [-dy, start.y - r.y],
    [dy, maxY(r) - start.y],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return null;
    } else {
      const ratio = q / p;
      if (p < 0) {
        if (ratio > t1) return null;
        t0 = Math.max(t0, ratio);
      } else {
        if (ratio < t0) return null;
        t1 = Math.min(t1, ratio);
      }
    }
  }
  return t0 <= t1 ? [t0, t1] : null;
}

export function pointAt(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
