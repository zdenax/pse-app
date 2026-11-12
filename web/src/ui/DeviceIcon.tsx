// Hand-drawn device glyphs: a colored tile with a white line glyph, described in a 100x100 box
// (origin top-left, y down). Port of Sources/NetSketchCanvas/DeviceIcons.swift.
// `deviceIconArt` is exported so the SVG canvas can draw the same icons.

import { memo } from "react";
import type { DeviceCategory } from "../core/model";

export interface IconLayer {
  /** SVG path data in the 100x100 box. */
  d: string;
  paint: "fill" | "stroke";
  /** Stroke width in box units (stroke layers only). */
  width?: number;
}

export interface DeviceIconArt {
  /** Routers get a round tile (the classic "puck"), everything else a rounded square. */
  tile: "circle" | "roundedSquare";
  /** Corner radius of the rounded square, relative to the side (0.24). */
  cornerRadius: number;
  layers: IconLayer[];
}

const S = 100;
/** Default line width of glyph strokes, relative to the icon size. */
const strokeWidth = 0.068 * S;

type P = [number, number];

const fmt = (n: number) => Number((n * S).toFixed(2));

/** An arrow from `start` to `end` with an open head at `end` (unit coordinates). */
function arrow(start: P, end: P, head = 0.11): string {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.max(Math.sqrt(dx * dx + dy * dy), 0.0001);
  const ux = dx / length;
  const uy = dy / length;
  // Two wings at +-40 degrees from the reversed direction.
  const angle = 0.7;
  let d = `M${fmt(start[0])} ${fmt(start[1])}L${fmt(end[0])} ${fmt(end[1])}`;
  for (const sign of [1, -1]) {
    const cosA = Math.cos(angle * sign);
    const sinA = Math.sin(angle * sign);
    const wx = -(ux * cosA - uy * sinA);
    const wy = -(ux * sinA + uy * cosA);
    d += `M${fmt(end[0])} ${fmt(end[1])}L${fmt(end[0] + wx * head)} ${fmt(end[1] + wy * head)}`;
  }
  return d;
}

function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const [X, Y, W, H, R] = [x, y, w, h, r].map((v) => v * S);
  return (
    `M${X + R} ${Y}H${X + W - R}A${R} ${R} 0 0 1 ${X + W} ${Y + R}V${Y + H - R}` +
    `A${R} ${R} 0 0 1 ${X + W - R} ${Y + H}H${X + R}A${R} ${R} 0 0 1 ${X} ${Y + H - R}` +
    `V${Y + R}A${R} ${R} 0 0 1 ${X + R} ${Y}Z`
  );
}

function circle(cx: number, cy: number, r: number): string {
  const [X, Y, R] = [cx * S, cy * S, r * S];
  return `M${X - R} ${Y}A${R} ${R} 0 1 0 ${X + R} ${Y}A${R} ${R} 0 1 0 ${X - R} ${Y}Z`;
}

function line(a: P, b: P): string {
  return `M${fmt(a[0])} ${fmt(a[1])}L${fmt(b[0])} ${fmt(b[1])}`;
}

/** L2 switch: two opposing horizontal arrows. */
const switchGlyph: IconLayer[] = [
  { d: arrow([0.24, 0.38], [0.76, 0.38]) + arrow([0.76, 0.62], [0.24, 0.62]), paint: "stroke", width: strokeWidth },
];

/** L3 switch: a routing ring with four arrows bursting out diagonally. */
const l3SwitchGlyph: IconLayer[] = (() => {
  const inner = 0.13;
  const outer = 0.29;
  let arrows = "";
  for (const [sx, sy] of [
    [1, -1],
    [1, 1],
    [-1, 1],
    [-1, -1],
  ]) {
    arrows += arrow([0.5 + sx * inner, 0.5 + sy * inner], [0.5 + sx * outer, 0.5 + sy * outer], 0.12);
  }
  return [
    { d: arrows, paint: "stroke", width: strokeWidth },
    { d: circle(0.5, 0.5, 0.1), paint: "stroke", width: strokeWidth },
  ];
})();

/** Router: two arrows in, two arrows out. */
const routerGlyph: IconLayer[] = [
  {
    d:
      arrow([0.17, 0.5], [0.41, 0.5]) +
      arrow([0.83, 0.5], [0.59, 0.5]) +
      arrow([0.5, 0.42], [0.5, 0.18]) +
      arrow([0.5, 0.58], [0.5, 0.82]),
    paint: "stroke",
    width: strokeWidth,
  },
];

/** Access point: a radiating dot. */
const accessPointGlyph: IconLayer[] = (() => {
  const [cx, cy] = [0.5, 0.73];
  let arcs = "";
  for (const r of [0.17, 0.3, 0.43]) {
    const start: P = [cx + r * Math.cos(-Math.PI * 0.75), cy + r * Math.sin(-Math.PI * 0.75)];
    const end: P = [cx + r * Math.cos(-Math.PI * 0.25), cy + r * Math.sin(-Math.PI * 0.25)];
    arcs += `M${fmt(start[0])} ${fmt(start[1])}A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(end[0])} ${fmt(end[1])}`;
  }
  return [
    { d: arcs, paint: "stroke", width: strokeWidth },
    { d: circle(cx, cy, 0.055), paint: "fill" },
  ];
})();

/** PC: a monitor on a stand. */
const pcGlyph: IconLayer[] = [
  { d: roundedRect(0.2, 0.23, 0.6, 0.4, 0.05), paint: "stroke", width: strokeWidth },
  { d: line([0.5, 0.63], [0.5, 0.77]) + line([0.34, 0.78], [0.66, 0.78]), paint: "stroke", width: strokeWidth },
];

/** Patch panel: a strip of jacks. */
const patchPanelGlyph: IconLayer[] = (() => {
  let jacks = "";
  for (let i = 0; i < 4; i++) jacks += roundedRect(0.19 + i * 0.14, 0.44, 0.1, 0.14, 0.02);
  return [
    { d: roundedRect(0.14, 0.34, 0.72, 0.34, 0.04), paint: "stroke", width: strokeWidth * 0.9 },
    { d: jacks, paint: "fill" },
  ];
})();

/** Server: three stacked units with status lights. */
const serverGlyph: IconLayer[] = (() => {
  let units = "";
  let lights = "";
  for (let i = 0; i < 3; i++) {
    const y = 0.2 + i * 0.215;
    units += roundedRect(0.24, y, 0.52, 0.17, 0.04);
    lights += circle(0.315 + 0.032, y + 0.085, 0.032);
  }
  return [
    { d: units, paint: "stroke", width: strokeWidth * 0.9 },
    { d: lights, paint: "fill" },
  ];
})();

export function deviceIconArt(category: DeviceCategory): DeviceIconArt {
  const tile = category === "router" ? "circle" : "roundedSquare";
  const layers = (() => {
    switch (category) {
      case "switch":
        return switchGlyph;
      case "L3 switch":
        return l3SwitchGlyph;
      case "router":
        return routerGlyph;
      case "AP":
        return accessPointGlyph;
      case "PC":
        return pcGlyph;
      case "server":
        return serverGlyph;
      case "patch panel":
        return patchPanelGlyph;
      default:
        return pcGlyph;
    }
  })();
  return { tile, cornerRadius: 0.24, layers };
}

/** CSS class that colors the tile of a category (see --tile-* in styles.css). */
export function tileClass(category: DeviceCategory): string {
  switch (category) {
    case "switch":
      return "tile-switch";
    case "L3 switch":
      return "tile-l3switch";
    case "router":
      return "tile-router";
    case "AP":
      return "tile-ap";
    case "PC":
      return "tile-pc";
    case "server":
      return "tile-server";
    case "patch panel":
      return "tile-patchpanel";
    default:
      return "tile-pc";
  }
}

/** The NetSketch icon of a device category: a colored tile with a white glyph. */
export const DeviceIcon = memo(function DeviceIcon({ category, size }: { category: DeviceCategory; size: number }) {
  const art = deviceIconArt(category);
  const inset = 1;
  const side = S - 2 * inset;
  return (
    <svg
      className="device-icon"
      width={size}
      height={size}
      viewBox={`0 0 ${S} ${S}`}
      aria-hidden="true"
      focusable="false"
    >
      {art.tile === "circle" ? (
        <circle className={`device-tile ${tileClass(category)}`} cx={S / 2} cy={S / 2} r={side / 2} />
      ) : (
        <rect
          className={`device-tile ${tileClass(category)}`}
          x={inset}
          y={inset}
          width={side}
          height={side}
          rx={side * art.cornerRadius}
        />
      )}
      {art.layers.map((layer, index) =>
        layer.paint === "fill" ? (
          <path key={index} className="device-glyph-fill" d={layer.d} />
        ) : (
          <path key={index} className="device-glyph-stroke" d={layer.d} strokeWidth={layer.width} />
        ),
      )}
    </svg>
  );
});
