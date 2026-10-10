// SVG path-data helpers (the CGPath shapes the Swift renderer uses).

import type { Point, Rect } from "../geom";

/** A number with at most two decimals, for compact path data. */
export function n(value: number): number {
  return Math.round(value * 100) / 100;
}

/** CGPath(roundedRect:) with the radius clamped to half the shorter side. */
export function roundedRectD(r: Rect, radius: number): string {
  if (!(r.width > 0) || !(r.height > 0)) return `M${n(r.x)} ${n(r.y)}h${n(r.width)}v${n(r.height)}h${n(-r.width)}Z`;
  const k = Math.max(Math.min(radius, r.width / 2, r.height / 2), 0);
  if (k === 0) return `M${n(r.x)} ${n(r.y)}h${n(r.width)}v${n(r.height)}h${n(-r.width)}Z`;
  const x0 = r.x;
  const y0 = r.y;
  const x1 = r.x + r.width;
  const y1 = r.y + r.height;
  return (
    `M${n(x0 + k)} ${n(y0)}H${n(x1 - k)}A${n(k)} ${n(k)} 0 0 1 ${n(x1)} ${n(y0 + k)}` +
    `V${n(y1 - k)}A${n(k)} ${n(k)} 0 0 1 ${n(x1 - k)} ${n(y1)}` +
    `H${n(x0 + k)}A${n(k)} ${n(k)} 0 0 1 ${n(x0)} ${n(y1 - k)}` +
    `V${n(y0 + k)}A${n(k)} ${n(k)} 0 0 1 ${n(x0 + k)} ${n(y0)}Z`
  );
}

export function rectD(r: Rect): string {
  return `M${n(r.x)} ${n(r.y)}h${n(r.width)}v${n(r.height)}h${n(-r.width)}Z`;
}

/** An ellipse inscribed in `r` as path data. */
export function ellipseD(r: Rect): string {
  const rx = r.width / 2;
  const ry = r.height / 2;
  const cy = r.y + ry;
  return (
    `M${n(r.x)} ${n(cy)}A${n(rx)} ${n(ry)} 0 1 0 ${n(r.x + r.width)} ${n(cy)}` +
    `A${n(rx)} ${n(ry)} 0 1 0 ${n(r.x)} ${n(cy)}Z`
  );
}

export function lineD(a: Point, b: Point): string {
  return `M${n(a.x)} ${n(a.y)}L${n(b.x)} ${n(b.y)}`;
}

/** An arc around `c` from `startAngle` to `endAngle` (radians, increasing = clockwise on screen). */
export function arcD(c: Point, radius: number, startAngle: number, endAngle: number): string {
  const start = { x: c.x + radius * Math.cos(startAngle), y: c.y + radius * Math.sin(startAngle) };
  const end = { x: c.x + radius * Math.cos(endAngle), y: c.y + radius * Math.sin(endAngle) };
  const large = Math.abs(endAngle - startAngle) > Math.PI ? 1 : 0;
  return `M${n(start.x)} ${n(start.y)}A${n(radius)} ${n(radius)} 0 ${large} 1 ${n(end.x)} ${n(end.y)}`;
}

/** Polyline through the points. */
export function polylineD(points: Point[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${n(p.x)} ${n(p.y)}`).join("");
}

/**
 * Vector warning triangle with rounded corners (SymbolRenderer.drawVectorWarning): returns the
 * outline, the exclamation stem and the dot.
 */
export function warningShapes(r: Rect): { outline: string; stem: string; dot: Rect; lineWidth: number } {
  const box = { x: r.x + r.width * 0.04, y: r.y + r.height * 0.09, width: r.width * 0.92, height: r.height * 0.82 };
  const top = { x: box.x + box.width / 2, y: box.y };
  const right = { x: box.x + box.width, y: box.y + box.height };
  const left = { x: box.x, y: box.y + box.height };
  const radius = box.width * 0.13;
  const toward = (from: Point, to: Point, distance: number): Point => {
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    return { x: from.x + ((to.x - from.x) / length) * distance, y: from.y + ((to.y - from.y) / length) * distance };
  };
  const corners = [top, right, left];
  let outline = "";
  corners.forEach((corner, index) => {
    const previous = corners[(index + 2) % 3];
    const next = corners[(index + 1) % 3];
    const enter = toward(corner, previous, radius);
    const leave = toward(corner, next, radius);
    outline += `${index === 0 ? "M" : "L"}${n(enter.x)} ${n(enter.y)}Q${n(corner.x)} ${n(corner.y)} ${n(leave.x)} ${n(leave.y)}`;
  });
  outline += "Z";
  const midXBox = box.x + box.width / 2;
  const stem = lineD({ x: midXBox, y: box.y + box.height * 0.36 }, { x: midXBox, y: box.y + box.height * 0.6 });
  const dotSize = Math.max(r.width * 0.12, 1);
  const dotCenter = { x: midXBox, y: box.y + box.height * 0.79 };
  return {
    outline,
    stem,
    dot: { x: dotCenter.x - dotSize / 2, y: dotCenter.y - dotSize / 2, width: dotSize, height: dotSize },
    lineWidth: Math.max(r.width * 0.095, 0.8),
  };
}
