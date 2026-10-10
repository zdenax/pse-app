// Front-panel layout: a rectangle `rows` port-rows tall, filled left to right by sections
// (PanelLayout.swift).
//
// The layout itself holds no ports. Call `panelGrid` (or `devicePanelGrid`) to get the position
// of every port in cell units, then multiply by your cell size.

import { isModularConnector, usesTwoRows } from "./enums";
import type { Device, PanelLayout, PanelSection, Port, PortArrangement, PortGroup } from "./model";
import { isPlaceholder, portCount } from "./port-group";

/** Default horizontal gap between two sections, in cells. */
export const sectionGap = 0.5;
/** Default extra gap between port blocks inside a section, in cells. */
export const blockGap = 0.25;
/** Default width of an empty module bay, in cells. */
export const defaultPlaceholderWidth = 4;

/** Position of one port. */
export interface PanelSlot {
  /** Index into the device's (or template's) port array. */
  portIndex: number;
  /** Index into `PanelGrid.sections`. */
  section: number;
  /** Column inside the section (0-based, without gaps). */
  column: number;
  /** Row on the panel, 0 = top. */
  row: number;
  /** Left edge of the cell in cell units, gaps included. The cell centre is (x + 0.5, row + 0.5). */
  x: number;
}

/** Horizontal extent of one section, for captions, separators and empty bays. */
export interface PanelSectionFrame {
  /** Port-group indices drawn in this section. */
  groups: number[];
  x: number;
  width: number;
  label?: string;
  /** True for an empty module bay (no slots; draw a blank plate with the label). */
  isPlaceholder: boolean;
}

/**
 * A resolved front panel in cell units: one port cell is 1 wide and 1 tall,
 * the origin is the panel's top-left corner, x grows right and rows grow down.
 */
export interface PanelGrid {
  /** Number of port rows. */
  rows: number;
  /** Total width in cells, gaps included. */
  width: number;
  /** One slot per port, ordered by `portIndex`. */
  slots: PanelSlot[];
  /** Sections left to right. */
  sections: PanelSectionFrame[];
}

/** A layout with at least one row. */
export function makePanelLayout(rows = 1, sections: PanelSection[] = []): PanelLayout {
  return { rows: Math.max(1, rows), sections };
}

/** A section; optional fields are only set when given (an absent key equals Swift's nil). */
export function makePanelSection(
  groups: number[],
  options: {
    arrangement?: PortArrangement;
    row?: number;
    blockColumns?: number;
    label?: string;
    placeholderWidth?: number;
  } = {},
): PanelSection {
  const section: PanelSection = { groups, arrangement: options.arrangement ?? "singleRow" };
  if (options.row !== undefined) section.row = options.row;
  if (options.blockColumns !== undefined) section.blockColumns = options.blockColumns;
  if (options.label !== undefined) section.label = options.label;
  if (options.placeholderWidth !== undefined) section.placeholderWidth = options.placeholderWidth;
  return section;
}

/**
 * A reasonable layout derived from the port groups alone: one section per group,
 * two rows (odd on top) for copper/cage groups of 12 or more ports, otherwise a single row.
 */
export function automaticLayout(groups: readonly PortGroup[]): PanelLayout {
  const sections = groups.map((group, index) => automaticSection(index, group));
  return makePanelLayout(sections.some((section) => usesTwoRows(section.arrangement)) ? 2 : 1, sections);
}

function automaticSection(index: number, group: PortGroup): PanelSection {
  const count = portCount(group);
  const dense = count >= 12 && (group.connector === "RJ45" || isModularConnector(group.connector));
  return makePanelSection([index], {
    arrangement: dense ? "oddTopEvenBottom" : "singleRow",
    blockColumns: dense && count >= 24 ? 6 : undefined,
    label: group.label,
    placeholderWidth: isPlaceholder(group) ? defaultPlaceholderWidth : undefined,
  });
}

/**
 * The layout made consistent with `groups`: unknown or repeated group indices are dropped,
 * groups no section mentions are appended with an automatic section (so every port is
 * always drawn), missing captions are taken from the group label, placeholder groups get
 * a width, and `rows` is raised to 2 when a two-row arrangement is used. Idempotent.
 */
export function normalizeLayout(layout: PanelLayout, groups: readonly PortGroup[]): PanelLayout {
  const seen = new Set<number>();
  const result: PanelSection[] = [];
  for (const section of layout.sections) {
    const indices = section.groups.filter((index) => {
      if (!Number.isInteger(index) || index < 0 || index >= groups.length || seen.has(index)) return false;
      seen.add(index);
      return true;
    });
    if (indices.length === 0) continue;
    let label = section.label;
    if (label === undefined && indices.length === 1) label = groups[indices[0]].label;
    let placeholderWidth = section.placeholderWidth;
    if (placeholderWidth === undefined && indices.every((index) => isPlaceholder(groups[index]))) {
      placeholderWidth = defaultPlaceholderWidth;
    }
    result.push(
      makePanelSection(indices, {
        arrangement: section.arrangement,
        row: section.row,
        blockColumns: section.blockColumns !== undefined && section.blockColumns <= 0 ? undefined : section.blockColumns,
        label,
        placeholderWidth,
      }),
    );
  }
  groups.forEach((group, index) => {
    if (!seen.has(index)) result.push(automaticSection(index, group));
  });
  const needed = result.some((section) => usesTwoRows(section.arrangement)) ? 2 : 1;
  return makePanelLayout(Math.max(layout.rows, needed), result);
}

/**
 * Positions of all ports in cell units.
 *
 * `groupIndices` holds for every port (in device order) the index of its port group.
 * Ports whose group no section mentions are appended in a trailing single-row section,
 * so the grid always contains exactly one slot per port.
 */
export function panelGrid(
  layout: PanelLayout,
  groupIndices: readonly number[],
  gap: number = sectionGap,
  blockSpacing: number = blockGap,
): PanelGrid {
  const portsByGroup = new Map<number, number[]>();
  groupIndices.forEach((group, portIndex) => {
    const list = portsByGroup.get(group);
    if (list) list.push(portIndex);
    else portsByGroup.set(group, [portIndex]);
  });

  // Tolerate layouts that were never normalized: a two-row arrangement implies two rows.
  const rows = Math.max(1, layout.rows, layout.sections.some((section) => usesTwoRows(section.arrangement)) ? 2 : 1);
  const slots: PanelSlot[] = [];
  const frames: PanelSectionFrame[] = [];
  let cursor = 0;
  let maxRow = 0;
  const consumed = new Set<number>();

  const place = (section: PanelSection): void => {
    const groups = section.groups.filter((group) => {
      if (consumed.has(group)) return false;
      consumed.add(group);
      return true;
    });
    const ports = groups.flatMap((group) => portsByGroup.get(group) ?? []);
    const frameIndex = frames.length;

    if (ports.length === 0) {
      const width = section.placeholderWidth;
      if (width === undefined || !(width > 0)) return;
      frames.push(frame(groups, cursor, width, section.label, true));
      cursor += width + gap;
      return;
    }

    const block = section.blockColumns !== undefined && section.blockColumns > 0 ? section.blockColumns : undefined;
    const offset = (column: number): number =>
      column + (block !== undefined ? blockSpacing * Math.floor(column / block) : 0);

    let lastColumn = 0;
    const perRow = Math.floor((ports.length + 1) / 2);
    ports.forEach((portIndex, i) => {
      let column: number;
      let row: number;
      switch (section.arrangement) {
        case "oddTopEvenBottom":
          column = Math.floor(i / 2);
          row = i % 2;
          break;
        case "evenTopOddBottom":
          column = Math.floor(i / 2);
          row = 1 - (i % 2);
          break;
        case "topRowThenBottomRow":
          column = i < perRow ? i : i - perRow;
          row = i < perRow ? 0 : 1;
          break;
        default:
          column = i;
          row = Math.min(Math.max(0, section.row ?? rows - 1), rows - 1);
      }
      lastColumn = Math.max(lastColumn, column);
      maxRow = Math.max(maxRow, row);
      slots.push({ portIndex, section: frameIndex, column, row, x: cursor + offset(column) });
    });

    const width = offset(lastColumn) + 1;
    frames.push(frame(groups, cursor, width, section.label, false));
    cursor += width + gap;
  };

  for (const section of layout.sections) place(section);
  const leftovers = [...portsByGroup.keys()].sort((a, b) => a - b);
  for (const group of leftovers) {
    if (!consumed.has(group)) place(makePanelSection([group]));
  }

  return {
    rows: Math.max(rows, maxRow + 1),
    width: frames.length === 0 ? 0 : cursor - gap,
    slots: slots.sort((a, b) => a.portIndex - b.portIndex),
    sections: frames,
  };
}

function frame(groups: number[], x: number, width: number, label: string | undefined, placeholder: boolean): PanelSectionFrame {
  const result: PanelSectionFrame = { groups, x, width, isPlaceholder: placeholder };
  if (label !== undefined) result.label = label;
  return result;
}

/** Positions of `ports` in cell units (uses each port's `groupIndex`). */
export function gridForPorts(layout: PanelLayout, ports: readonly Port[]): PanelGrid {
  return panelGrid(layout, ports.map((port) => port.groupIndex));
}

/** Front panel of a placed device in cell units; `slots[i]` belongs to `ports[i]`. */
export function devicePanelGrid(device: Device): PanelGrid {
  return gridForPorts(device.layout, device.ports);
}

/** The slot of the port at `index`, if it exists. */
export function slotForPortIndex(grid: PanelGrid, index: number): PanelSlot | undefined {
  const direct = grid.slots[index];
  if (direct !== undefined && direct.portIndex === index) return direct;
  return grid.slots.find((slot) => slot.portIndex === index);
}
