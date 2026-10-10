// Fully resolved canvas colors for one appearance (port of Theme.swift `Palette`) and the cable
// look (CableStyle.swift). The renderer only talks to a `Palette`, so the same drawing code serves
// the light canvas, the dark canvas and the (always light) export.

import type { CableType, DeviceCategory, LinkStatus } from "../core/model";

/** An sRGB color; `a` is the alpha. */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function hex(value: number, alpha = 1): RGBA {
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff, a: alpha };
}

/** The color with its alpha multiplied by `alpha`. */
export function withOpacity(color: RGBA, alpha: number): RGBA {
  return { r: color.r, g: color.g, b: color.b, a: color.a * alpha };
}

const hexDigits = (value: number) => Math.round(value).toString(16).padStart(2, "0");

/** "#rrggbb" (alpha ignored). */
export function hexString(color: RGBA): string {
  return `#${hexDigits(color.r)}${hexDigits(color.g)}${hexDigits(color.b)}`;
}

/** A CSS color string including alpha. */
export function cssColor(color: RGBA, alpha = 1): string {
  const a = color.a * alpha;
  if (a >= 1) return hexString(color);
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${Number(a.toFixed(3))})`;
}

const round3 = (value: number) => Number(value.toFixed(3));

/** SVG fill attributes (hex color + fill-opacity, which every SVG consumer understands). */
export function fillOf(color: RGBA, alpha = 1): { fill: string; fillOpacity?: number } {
  const a = color.a * alpha;
  return a >= 1 ? { fill: hexString(color) } : { fill: hexString(color), fillOpacity: round3(a) };
}

/** SVG stroke attributes (hex color + stroke-opacity). */
export function strokeOf(color: RGBA, alpha = 1): { stroke: string; strokeOpacity?: number } {
  const a = color.a * alpha;
  return a >= 1 ? { stroke: hexString(color) } : { stroke: hexString(color), strokeOpacity: round3(a) };
}

export interface Palette {
  isDark: boolean;

  canvas: RGBA;
  gridDot: RGBA;
  ink: RGBA;
  secondaryInk: RGBA;

  panelFill: RGBA;
  panelStroke: RGBA;
  panelShadow: RGBA;
  portLabel: RGBA;

  portRJ45: RGBA;
  portOptic: RGBA;
  portConsole: RGBA;
  portMgmt: RGBA;
  portWireless: RGBA;

  cableCopper: RGBA;
  cableConsole: RGBA;
  cableFiber: RGBA;
  labelPlate: RGBA;
  bundlePlate: RGBA;
  bundleInk: RGBA;

  selection: RGBA;
  pending: RGBA;
  hover: RGBA;
  reject: RGBA;
  warning: RGBA;

  statusGreen: RGBA;
  statusOrange: RGBA;
  statusRed: RGBA;
  statusNone: RGBA;

  annotationFill: RGBA;
  annotationStroke: RGBA;

  tooltipFill: RGBA;
  tooltipInk: RGBA;

  iconGlyph: RGBA;
  tileSwitch: RGBA;
  tileL3Switch: RGBA;
  tileRouter: RGBA;
  tileAccessPoint: RGBA;
  tilePC: RGBA;
  tileServer: RGBA;
  tileStroke: RGBA;
}

const navy = 0x0b2545;
const teal = 0x13a89e;
const sand = 0xf4f1ea;
const slate = 0x5c6b7a;
const accent = 0xee6c4d;

export const lightPalette: Palette = {
  isDark: false,
  canvas: hex(sand),
  gridDot: hex(slate, 0.3),
  ink: hex(navy),
  secondaryInk: hex(slate),
  panelFill: hex(0xffffff),
  panelStroke: hex(0xb9b2a3),
  panelShadow: hex(navy, 0.1),
  portLabel: hex(0x4a5866),
  portRJ45: hex(navy),
  portOptic: hex(0x0e8f86),
  portConsole: hex(0x2f8fc9),
  portMgmt: hex(0x8a6fb8),
  portWireless: hex(accent),
  cableCopper: hex(navy),
  cableConsole: hex(0x4fa8d8),
  cableFiber: hex(accent),
  labelPlate: hex(sand, 0.92),
  bundlePlate: hex(navy),
  bundleInk: hex(0xffffff),
  selection: hex(accent),
  pending: hex(accent),
  hover: hex(teal),
  reject: hex(0xd64545),
  warning: hex(0xc98a00),
  statusGreen: hex(0x2ead5b),
  statusOrange: hex(0xf29d38),
  statusRed: hex(0xd64545),
  statusNone: hex(slate, 0.55),
  annotationFill: hex(0xfff6d6),
  annotationStroke: hex(0xd9c98f),
  tooltipFill: hex(navy, 0.95),
  tooltipInk: hex(0xffffff),
  iconGlyph: hex(0xffffff),
  tileSwitch: hex(teal),
  tileL3Switch: hex(0x0e7c8c),
  tileRouter: hex(navy),
  tileAccessPoint: hex(accent),
  tilePC: hex(slate),
  tileServer: hex(0x3d4c5c),
  tileStroke: hex(navy, 0.18),
};

export const darkPalette: Palette = {
  isDark: true,
  canvas: hex(0x081b33),
  gridDot: hex(0xffffff, 0.13),
  ink: hex(sand),
  secondaryInk: hex(0x9fb0c3),
  panelFill: hex(0x122c4f),
  panelStroke: hex(0x355680),
  panelShadow: hex(0x000000, 0.3),
  portLabel: hex(0xb4c2d2),
  portRJ45: hex(0xe8e3d8),
  portOptic: hex(0x2fd0c4),
  portConsole: hex(0x6bc1f0),
  portMgmt: hex(0xb59ce0),
  portWireless: hex(0xf58a6e),
  cableCopper: hex(0xe8e3d8),
  cableConsole: hex(0x6bc1f0),
  cableFiber: hex(0xf58a6e),
  labelPlate: hex(0x081b33, 0.9),
  bundlePlate: hex(sand),
  bundleInk: hex(navy),
  selection: hex(0xf58a6e),
  pending: hex(0xf58a6e),
  hover: hex(0x2fd0c4),
  reject: hex(0xef6b6b),
  warning: hex(0xf2b33d),
  statusGreen: hex(0x3dcb73),
  statusOrange: hex(0xf6ae4a),
  statusRed: hex(0xef6b6b),
  statusNone: hex(0x9fb0c3, 0.55),
  annotationFill: hex(0x3a3520),
  annotationStroke: hex(0x6b6238),
  tooltipFill: hex(sand, 0.96),
  tooltipInk: hex(navy),
  iconGlyph: hex(0xffffff),
  tileSwitch: hex(0x15a99f),
  tileL3Switch: hex(0x1489a0),
  tileRouter: hex(0x2a5c99),
  tileAccessPoint: hex(0xe8694a),
  tilePC: hex(0x6f8196),
  tileServer: hex(0x4f6379),
  tileStroke: hex(0xffffff, 0.16),
};

export function resolvePalette(dark: boolean): Palette {
  return dark ? darkPalette : lightPalette;
}

export function tileColor(category: DeviceCategory, palette: Palette): RGBA {
  switch (category) {
    case "switch":
      return palette.tileSwitch;
    case "L3 switch":
      return palette.tileL3Switch;
    case "router":
      return palette.tileRouter;
    case "AP":
      return palette.tileAccessPoint;
    case "PC":
      return palette.tilePC;
    case "server":
      return palette.tileServer;
    default:
      return palette.tilePC;
  }
}

/** Color of the status dot; null for "none". */
export function statusColor(status: LinkStatus, palette: Palette): RGBA | null {
  switch (status) {
    case "green":
      return palette.statusGreen;
    case "orange":
      return palette.statusOrange;
    case "red":
      return palette.statusRed;
    default:
      return null;
  }
}

/**
 * How a cable is stroked. THE one place that maps `CableType` to a look.
 *
 * | CableType  | Color         | Width | Pattern                |
 * |------------|---------------|-------|------------------------|
 * | straight   | copper (ink)  | 2.0   | solid                  |
 * | crossover  | copper (ink)  | 2.0   | dashed 7-4             |
 * | console    | light blue    | 1.4   | solid, thin (rollover) |
 * | fiber      | accent orange | 2.4   | dash-dot 10-3-2-3      |
 */
export interface CableStyle {
  color: RGBA;
  width: number;
  /** Dash pattern in canvas points; empty = solid. */
  dash: number[];
  cap: "round" | "butt";
}

export function cableStyle(type: CableType, palette: Palette): CableStyle {
  switch (type) {
    case "crossover":
      return { color: palette.cableCopper, width: 2.0, dash: [7, 4], cap: "butt" };
    case "console":
      return { color: palette.cableConsole, width: 1.4, dash: [], cap: "round" };
    case "fiber":
      return { color: palette.cableFiber, width: 2.4, dash: [10, 3, 2, 3], cap: "butt" };
    default:
      return { color: palette.cableCopper, width: 2.0, dash: [], cap: "round" };
  }
}

/** Gap between the two rails of a bundled (LAG) cable, center to center. */
export const bundleRailSpacing = 4.0;
/** Width factor applied to each rail of a bundled cable. */
export const bundleRailWidthFactor = 0.72;
