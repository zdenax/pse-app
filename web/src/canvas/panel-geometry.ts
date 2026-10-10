// THE geometry of front panels and device nodes (port of PanelGeometry.swift): template/layout +
// device position -> port rectangles in canvas coordinates. Rendering, the link layer, hit testing
// and the exporter all go through these types, so cables always land exactly on the drawn ports.

import type { ConnectorType, Device, DeviceCategory, PanelLayout, Point, Port, ViewMode } from "../core/model";
import { devicePanelGrid, type PanelSlot } from "../core/panel-layout";
import { shortName } from "../core/port-naming";
import { deviceDisplayModel, deviceNeedsVerification } from "../core/project";
import { trimWhitespace } from "../core/util";
import {
  center,
  containsPoint,
  inset,
  maxX,
  maxY,
  midX,
  midY,
  rectAround,
  roundHalfAway,
  union,
  type Rect,
  type Size,
} from "./geom";
import { TextStyles, textMeasurerGeneration, textSize, textWidth, truncated, type TextStyle } from "./text";

/**
 * Sizes of the front-panel drawing. Everything derives from `cell`, the width of one RJ45
 * column and the height of one port row, so a panel can be drawn at any size.
 */
export class PanelMetrics {
  static readonly standardCell = 17;
  static readonly standard = new PanelMetrics(PanelMetrics.standardCell);

  /** Panels with at most this many ports get wide cells that fit the whole short port name. */
  readonly roomyPortLimit = 10;
  /** Sections with at most this many columns always get wide cells (uplinks, console, mgmt). */
  readonly roomySectionColumns = 2;

  /** Width of an RJ45 column = height of a port row, in canvas points. */
  constructor(readonly cell: number) {}

  get scale(): number {
    return this.cell / PanelMetrics.standardCell;
  }
  get paddingX(): number {
    return 8 * this.scale;
  }
  get paddingY(): number {
    return 5 * this.scale;
  }
  /** Height of the strip that carries the printed port labels above / below the rows. */
  get labelStrip(): number {
    return 10 * this.scale;
  }
  /** Height of the strip with section captions ("PoE+", "Uplink"). */
  get captionStrip(): number {
    return 10 * this.scale;
  }
  get cornerRadius(): number {
    return 6 * this.scale;
  }
  get minWidth(): number {
    return 84 * this.scale;
  }
  get maxRoomyPitch(): number {
    return 3.2 * this.cell;
  }
  get labelStyle(): TextStyle {
    return { size: 8 * this.scale, weight: "medium", monospacedDigits: true };
  }
  get captionStyle(): TextStyle {
    return { size: 7.5 * this.scale, weight: "semibold" };
  }

  /** Column width needed by a connector, relative to `cell`. */
  pitchFactor(connector: ConnectorType): number {
    switch (connector) {
      case "SFP":
      case "SFP+":
        return 1.35;
      case "QSFP+":
        return 1.7;
      default:
        return 1.0;
    }
  }

  /** Size of the drawn jack / cage of a connector inside a column of width `pitch`. */
  jackSize(connector: ConnectorType, pitch: number): Size {
    const gap = 3 * this.scale;
    switch (connector) {
      case "SFP":
      case "SFP+":
        return { width: Math.min(1.18 * this.cell, pitch - gap), height: 0.62 * this.cell };
      case "QSFP+":
        return { width: Math.min(1.53 * this.cell, pitch - gap), height: 0.74 * this.cell };
      default: {
        const side = 0.76 * this.cell;
        return { width: side, height: side };
      }
    }
  }
}

/** Where the printed label of a port goes. */
export type PortLabelPlacement = "above" | "below" | "hidden";

/** One port on a drawn front panel. */
export interface PortGeometry {
  /** Index into `Device.ports`. */
  index: number;
  portID: string;
  connector: ConnectorType;
  /** Administratively shut down; drawn struck through. */
  adminDown: boolean;
  /** The whole grid cell; used for hit testing so ports are easy to click. */
  cell: Rect;
  /** The drawn jack / cage. */
  rect: Rect;
  row: number;
  /** Text printed next to the port; empty when nothing readable fits. */
  label: string;
  labelPlacement: PortLabelPlacement;
  /** Center of the printed label. */
  labelCenter: Point;
  /** Where cables attach (center of `rect`). */
  center: Point;
}

export interface PanelCaption {
  text: string;
  /** Leading edge, vertical center. */
  anchor: Point;
}

export interface PanelBay {
  rect: Rect;
  label: string;
}

export type PanelPlacement = { kind: "center"; point: Point } | { kind: "origin"; point: Point };

interface PanelParts {
  metrics: PanelMetrics;
  frame: Rect;
  ports: PortGeometry[];
  captions: PanelCaption[];
  bays: PanelBay[];
  isRoomy: boolean;
  indexByID: Map<string, number>;
  local: PanelGeometry | null;
}

/** Local layouts per port list (ports are immutable values: a moved device keeps its array). */
const localLayouts = new WeakMap<readonly Port[], { key: string; layout: PanelLayout; panel: PanelGeometry }[]>();

/**
 * The resolved front panel of a device. The layout is computed once per device shape at the
 * origin (`local`) and translated to the device position, so moving a device costs only the
 * translation (and the renderer draws the local panel under a transform).
 */
export class PanelGeometry {
  readonly metrics: PanelMetrics;
  /** The panel plate. */
  readonly frame: Rect;
  /** One entry per drawn port, ordered like `Device.ports`. */
  readonly ports: PortGeometry[];
  readonly captions: PanelCaption[];
  /** Empty module bays. */
  readonly bays: PanelBay[];
  /** True when the cells were widened to fit full short port names. */
  readonly isRoomy: boolean;
  /** The same panel with its top-left corner at (0, 0); shared by all positions of a device. */
  readonly local: PanelGeometry;
  private readonly indexByID: Map<string, number>;

  private constructor(parts: PanelParts) {
    this.metrics = parts.metrics;
    this.frame = parts.frame;
    this.ports = parts.ports;
    this.captions = parts.captions;
    this.bays = parts.bays;
    this.isRoomy = parts.isRoomy;
    this.indexByID = parts.indexByID;
    this.local = parts.local ?? this;
  }

  /** Panel centered on `device.position`, or with its top-left corner at an origin (previews). */
  static of(device: Device, metrics: PanelMetrics = PanelMetrics.standard, placement?: PanelPlacement): PanelGeometry {
    const local = PanelGeometry.localLayout(device, metrics);
    const where: PanelPlacement = placement ?? { kind: "center", point: device.position };
    const { width, height } = local.frame;
    const origin =
      where.kind === "center"
        ? { x: roundHalfAway(where.point.x - width / 2), y: roundHalfAway(where.point.y - height / 2) }
        : where.point;
    return local.translated(origin.x, origin.y);
  }

  /** The panel of a device laid out at the origin, cached per port list, layout and cell size. */
  static localLayout(device: Device, metrics: PanelMetrics = PanelMetrics.standard): PanelGeometry {
    const key = `${metrics.cell}|${textMeasurerGeneration()}`;
    const entries = localLayouts.get(device.ports) ?? [];
    const cached = entries.find((entry) => entry.key === key && entry.layout === device.layout);
    if (cached) return cached.panel;
    const panel = new PanelGeometry(computeLocalPanel(device, metrics));
    localLayouts.set(device.ports, [...entries.slice(-3), { key, layout: device.layout, panel }]);
    return panel;
  }

  /** The panel moved by (dx, dy). */
  translated(dx: number, dy: number): PanelGeometry {
    const local = this.local;
    if (dx === 0 && dy === 0 && this === local) return this;
    const move = (r: Rect): Rect => ({ x: r.x + dx, y: r.y + dy, width: r.width, height: r.height });
    const movePoint = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
    return new PanelGeometry({
      metrics: local.metrics,
      frame: move(local.frame),
      ports: local.ports.map((port) => ({
        ...port,
        cell: move(port.cell),
        rect: move(port.rect),
        labelCenter: movePoint(port.labelCenter),
        center: movePoint(port.center),
      })),
      captions: local.captions.map((caption) => ({ text: caption.text, anchor: movePoint(caption.anchor) })),
      bays: local.bays.map((bay) => ({ rect: move(bay.rect), label: bay.label })),
      isRoomy: local.isRoomy,
      indexByID: local.indexByID,
      local,
    });
  }

  port(id: string): PortGeometry | undefined {
    const index = this.indexByID.get(id);
    return index === undefined ? undefined : this.ports[index];
  }

  /** The port whose cell contains `point`. */
  portAt(point: Point): PortGeometry | undefined {
    if (!containsPoint(this.frame, point)) return undefined;
    return this.ports.find((port) => containsPoint(port.cell, point));
  }

  /**
   * The readable subset of a port name that fits `maxWidth`: the whole short name if possible,
   * else its trailing number, else a short abbreviation.
   */
  static printedLabel(name: string, maxWidth: number, style: TextStyle): string {
    const fits = (candidate: string) => candidate !== "" && textWidth(candidate, style) <= maxWidth;
    if (fits(name)) return name;

    // Trailing number: "Gi1/0/24" -> "24", "ether5" -> "5".
    const digits = /[0-9]*$/.exec(name)?.[0] ?? "";
    if (fits(digits)) return digits;
    // Even the number does not fit (very long numbers): give up rather than print noise.
    if (digits !== "") return "";

    // Named ports: "Console" -> "Con", "Management" -> "Man".
    const firstWord = name.split(/[ \-/]/).find((part) => part !== "") ?? name;
    if (fits(firstWord)) return firstWord;
    const characters = Array.from(firstWord);
    for (const length of [4, 3, 2]) {
      if (characters.length <= length) continue;
      const candidate = characters.slice(0, length).join("");
      if (fits(candidate)) return candidate;
    }
    return "";
  }
}

/** Lays out the panel of a device with its top-left corner at (0, 0). */
function computeLocalPanel(device: Device, m: PanelMetrics): PanelParts {
    const grid = devicePanelGrid(device);
    const ports = device.ports;
    const cell = m.cell;
    const roomy = ports.length > 0 && ports.length <= m.roomyPortLimit;
    const shortNames = ports.map((port) => shortName(port.name));
    const validPort = (index: number) => index >= 0 && index < ports.length;

    // Slots per section.
    const slotsBySection = new Map<number, PanelSlot[]>();
    for (const slot of grid.slots) {
      if (!validPort(slot.portIndex)) continue;
      const list = slotsBySection.get(slot.section);
      if (list) list.push(slot);
      else slotsBySection.set(slot.section, [slot]);
    }

    // Horizontal extent of every section. A section is as wide as its widest connector needs
    // (cages are wider than RJ45 jacks); sparse panels get roomy cells for full names.
    const boxes = grid.sections.map(() => ({ x: 0, width: 0, pitch: 0 }));
    let cursor = 0;
    let lastGap = 0;
    grid.sections.forEach((section, index) => {
      const box = { x: cursor, width: 0, pitch: 0 };
      const slots = slotsBySection.get(index) ?? [];
      if (section.isPlaceholder || slots.length === 0) {
        box.pitch = cell;
        box.width = Math.max(section.width, 1) * cell;
      } else {
        let pitch = Math.max(...slots.map((slot) => m.pitchFactor(ports[slot.portIndex].connector))) * cell;
        const columnCount = Math.max(...slots.map((slot) => slot.column)) + 1;
        // Sparse panels, and small sections of dense ones (uplinks, console, management),
        // have room for the whole short name under each port.
        if (roomy || columnCount <= m.roomySectionColumns) {
          const widest = Math.max(0, ...slots.map((slot) => textWidth(shortNames[slot.portIndex], m.labelStyle)));
          pitch = Math.min(Math.max(pitch, Math.ceil(widest + 7 * m.scale)), Math.max(m.maxRoomyPitch, pitch));
        }
        // Whatever the core grid added on top of the plain columns are block gaps.
        const extraGaps = Math.max(section.width - columnCount, 0) * cell;
        box.pitch = pitch;
        box.width = columnCount * pitch + extraGaps;
      }
      boxes[index] = box;
      const next = grid.sections[index + 1];
      const nextGap = next ? Math.max(next.x - (section.x + section.width), 0) * cell : 0;
      lastGap = nextGap;
      cursor += box.width + nextGap;
    });
    const contentWidth = Math.max(cursor - lastGap, 0);

    // Vertical structure: [captions] [labels of the top row] rows [labels of the bottom row].
    const rows = Math.max(grid.rows, 1);
    const hasCaptions = grid.sections.some((section) => !section.isPlaceholder && (section.label ?? "") !== "");
    const hasTopLabels = rows > 1;
    const rowsTopInset = m.paddingY + (hasCaptions ? m.captionStrip : 0) + (hasTopLabels ? m.labelStrip : 0);
    const rowsHeight = rows * cell;
    const height = rowsTopInset + rowsHeight + m.labelStrip + m.paddingY;
    const width = Math.max(contentWidth + 2 * m.paddingX, m.minWidth);

    const frame: Rect = { x: 0, y: 0, width, height };
    const contentLeft = frame.x + (width - contentWidth) / 2;
    const rowsTop = frame.y + rowsTopInset;

    // Ports.
    const geometry: (PortGeometry | undefined)[] = new Array(ports.length).fill(undefined);
    for (const slot of grid.slots) {
      if (!validPort(slot.portIndex) || slot.section < 0 || slot.section >= grid.sections.length) continue;
      const section = grid.sections[slot.section];
      const box = boxes[slot.section];
      const port = ports[slot.portIndex];
      const extra = Math.max(slot.x - section.x - slot.column, 0) * cell;
      const x = contentLeft + box.x + slot.column * box.pitch + extra;
      const y = rowsTop + slot.row * cell;
      const cellRect: Rect = { x, y, width: box.pitch, height: cell };
      const jack = rectAround(center(cellRect), m.jackSize(port.connector, box.pitch));

      let labelPlacement: PortLabelPlacement;
      let labelY: number;
      if (rows > 1 && slot.row === 0) {
        labelPlacement = "above";
        labelY = rowsTop - m.labelStrip / 2;
      } else if (slot.row === rows - 1) {
        labelPlacement = "below";
        labelY = rowsTop + rowsHeight + m.labelStrip / 2;
      } else {
        labelPlacement = "hidden";
        labelY = midY(cellRect);
      }
      const label =
        labelPlacement === "hidden"
          ? ""
          : PanelGeometry.printedLabel(shortNames[slot.portIndex], box.pitch - 1.5 * m.scale, m.labelStyle);
      geometry[slot.portIndex] = {
        index: slot.portIndex,
        portID: port.id,
        connector: port.connector,
        adminDown: port.adminDown,
        cell: cellRect,
        rect: jack,
        row: slot.row,
        label,
        labelPlacement: label === "" ? "hidden" : labelPlacement,
        labelCenter: { x: midX(cellRect), y: labelY },
        center: center(jack),
      };
    }
    const resolved = geometry.filter((port): port is PortGeometry => port !== undefined);

    // Captions and empty bays.
    const captions: PanelCaption[] = [];
    const bays: PanelBay[] = [];
    grid.sections.forEach((section, index) => {
      const box = boxes[index];
      const label = trimWhitespace(section.label ?? "");
      if (section.isPlaceholder || (slotsBySection.get(index) ?? []).length === 0) {
        const bayRect: Rect = {
          x: contentLeft + box.x,
          y: rowsTop + 1.5 * m.scale,
          width: box.width,
          height: rowsHeight - 3 * m.scale,
        };
        bays.push({ rect: bayRect, label: truncated(label, m.captionStyle, box.width - 4 * m.scale) });
      } else if (hasCaptions && label !== "") {
        // Allow the caption to spill into the gap towards the next section, but not beyond.
        const available = box.width + (index + 1 < grid.sections.length ? 0.3 * cell : 0);
        const fitted = truncated(label, m.captionStyle, available);
        if (Array.from(fitted).length >= Math.min(Array.from(label).length, 3)) {
          captions.push({
            text: fitted,
            anchor: { x: contentLeft + box.x + 1 * m.scale, y: frame.y + m.paddingY + m.captionStrip / 2 },
          });
        }
      }
    });

    const indexByID = new Map<string, number>();
    resolved.forEach((port, offset) => indexByID.set(port.portID, offset));
    return { metrics: m, frame, ports: resolved, captions, bays, isRoomy: roomy, indexByID, local: null };
}

/** Complete geometry of one device node (icon, texts, warning glyph and - in the physical view - the panel). */
export class NodeGeometry {
  static readonly physicalIconSize = 30;
  static readonly logicalIconSize = 46;
  static readonly warningSize = 13;

  readonly deviceID: string;
  readonly category: DeviceCategory;
  readonly mode: ViewMode;
  /** `Device.position`: center of the panel (physical) or of the icon (logical). */
  readonly anchor: Point;
  readonly iconRect: Rect;
  readonly hostname: string;
  readonly hostnameRect: Rect;
  readonly typeText: string;
  readonly typeRect: Rect;
  /** Frame of the "verify against hardware" glyph; null when the device is verified. */
  readonly warningRect: Rect | null;
  readonly panel: PanelGeometry | null;
  /** Icon and texts: the drag handle and rename target. */
  readonly headerRect: Rect;
  /** The solid body links attach to: the panel (physical) or the icon (logical). */
  readonly bodyRect: Rect;
  /** Everything that belongs to the node. */
  readonly bounds: Rect;
  /** True when texts are centered under the icon (logical view). */
  readonly centeredLabels: boolean;

  constructor(device: Device, mode: ViewMode, metrics: PanelMetrics = PanelMetrics.standard) {
    const hostnameSize = textSize(device.hostname === "" ? " " : device.hostname, TextStyles.hostname);
    const typeText = deviceDisplayModel(device);
    const typeSize = textSize(typeText === "" ? " " : typeText, TextStyles.deviceType);
    const needsWarning = deviceNeedsVerification(device);
    const warning = NodeGeometry.warningSize;
    const hostnameWidth = Math.ceil(hostnameSize.width);
    const hostnameHeight = Math.ceil(hostnameSize.height);
    const typeWidth = Math.ceil(typeSize.width);
    const typeHeight = Math.ceil(typeSize.height);

    this.deviceID = device.id;
    this.category = device.category;
    this.mode = mode;
    this.anchor = device.position;
    this.hostname = device.hostname;
    this.typeText = typeText;

    if (mode === "physical") {
      const panel = PanelGeometry.of(device, metrics);
      const icon = NodeGeometry.physicalIconSize;
      const iconRect: Rect = { x: panel.frame.x, y: panel.frame.y - 7 - icon, width: icon, height: icon };
      const textX = maxX(iconRect) + 8;
      const hostnameRect: Rect = { x: textX, y: iconRect.y - 1, width: hostnameWidth, height: hostnameHeight };
      const typeRect: Rect = { x: textX, y: maxY(hostnameRect), width: typeWidth, height: typeHeight };
      const warningRect: Rect | null = needsWarning
        ? { x: maxX(hostnameRect) + 6, y: midY(hostnameRect) - warning / 2, width: warning, height: warning }
        : null;
      let header = union(union(iconRect, hostnameRect), typeRect);
      if (warningRect) header = union(header, warningRect);

      this.iconRect = iconRect;
      this.hostnameRect = hostnameRect;
      this.typeRect = typeRect;
      this.warningRect = warningRect;
      this.panel = panel;
      this.headerRect = header;
      this.bodyRect = panel.frame;
      this.bounds = union(header, panel.frame);
      this.centeredLabels = false;
    } else {
      const icon = NodeGeometry.logicalIconSize;
      const iconRect = rectAround(
        { x: roundHalfAway(device.position.x), y: roundHalfAway(device.position.y) },
        { width: icon, height: icon },
      );
      const hostnameRect: Rect = {
        x: midX(iconRect) - hostnameWidth / 2,
        y: maxY(iconRect) + 5,
        width: hostnameWidth,
        height: hostnameHeight,
      };
      const typeRect: Rect = {
        x: midX(iconRect) - typeWidth / 2,
        y: maxY(hostnameRect),
        width: typeWidth,
        height: typeHeight,
      };
      const warningRect: Rect | null = needsWarning
        ? { x: maxX(hostnameRect) + 5, y: midY(hostnameRect) - warning / 2, width: warning, height: warning }
        : null;
      let header = union(union(iconRect, hostnameRect), typeRect);
      if (warningRect) header = union(header, warningRect);

      this.iconRect = iconRect;
      this.hostnameRect = hostnameRect;
      this.typeRect = typeRect;
      this.warningRect = warningRect;
      this.panel = null;
      this.headerRect = header;
      this.bodyRect = iconRect;
      this.bounds = header;
      this.centeredLabels = true;
    }
  }

  private cachedLabelPlate: Rect | null = null;

  /** The plate behind hostname, type and warning glyph. */
  get labelPlateRect(): Rect {
    if (this.cachedLabelPlate) return this.cachedLabelPlate;
    let plate = union(this.hostnameRect, this.typeRect);
    if (this.warningRect) plate = union(plate, this.warningRect);
    this.cachedLabelPlate = inset(plate, -4, -1);
    return this.cachedLabelPlate;
  }

  /** Rect offered to the inline hostname editor (roomier than the text itself). */
  get hostnameEditRect(): Rect {
    const minWidth = 120;
    const width = Math.max(this.hostnameRect.width + 24, minWidth);
    const r = this.hostnameRect;
    if (this.centeredLabels) {
      return { x: midX(r) - width / 2, y: r.y - 3, width, height: r.height + 6 };
    }
    return { x: r.x - 4, y: r.y - 3, width, height: r.height + 6 };
  }
}
