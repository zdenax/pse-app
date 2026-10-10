// Everything the canvas shows, laid out in canvas coordinates (port of DiagramScene.swift).
// Built from the project in one pass and shared by rendering, hit testing and export.
// Framework-free.

import type { Annotation, CableType, Device, Link, LinkBundle, LinkEnd, LinkStatus, PortRef, Project, ViewMode } from "../core/model";
import { devicePair, devicePairKey, refKey, type DevicePair } from "../core/project";
import { shortName } from "../core/port-naming";
import {
  center,
  clipInterval,
  containsPoint,
  distanceToSegment,
  exitParameter,
  inset,
  intersects,
  pointAt,
  rectAround,
  rectFromCorners,
  roundHalfAway,
  union,
  type Point,
  type Rect,
  type Size,
} from "./geom";
import { NodeGeometry, PanelMetrics, type PortGeometry } from "./panel-geometry";
import { TextStyles, blockSize, textMeasurerGeneration, textSize } from "./text";

/** A text plate that sits on a cable (port name at a cable end). */
export interface LinkEndLabel {
  text: string;
  center: Point;
  /** Size of the plate (text plus padding). */
  size: Size;
  rect: Rect;
}

/**
 * One drawn cable. In the physical view this is exactly one `Link` between two port centers;
 * in the logical view a whole bundle collapses into one strand between two device icons.
 */
export interface LinkGeometry {
  /** Identity of the strand (the id of its first member link). */
  id: string;
  /** Links represented by this strand. */
  memberIDs: string[];
  cableType: CableType;
  /** End `a`. */
  start: Point;
  /** End `b`. */
  end: Point;
  /** Drawn as a double line (member of a LAG). */
  isBundled: boolean;
  statusA: LinkStatus;
  statusB: LinkStatus;
  /** Status dot centers; null in the logical view. */
  dotA: Point | null;
  dotB: Point | null;
  /** Port names at the ends; null in the logical view. */
  labelA: LinkEndLabel | null;
  labelB: LinkEndLabel | null;
}

export function linkMidpoint(link: LinkGeometry): Point {
  return { x: (link.start.x + link.end.x) / 2, y: (link.start.y + link.end.y) / 2 };
}

export function linkLength(link: LinkGeometry): number {
  return Math.hypot(link.end.x - link.start.x, link.end.y - link.start.y);
}

export function linkDot(link: LinkGeometry, end: LinkEnd): Point | null {
  return end === "a" ? link.dotA : link.dotB;
}

export function linkEndStatus(link: LinkGeometry, end: LinkEnd): LinkStatus {
  return end === "a" ? link.statusA : link.statusB;
}

/** Bounding box of the cable line. */
export function linkBox(link: LinkGeometry): Rect {
  return rectFromCorners(link.start, link.end);
}

/** Caption of a LAG and the tie that visually groups its member cables. */
export interface BundleGeometry {
  id: string;
  label: string;
  labelCenter: Point;
  /** Size of the caption plate. */
  labelSize: Size;
  labelRect: Rect;
  /** Midpoints of the member cables (physical view); the tie line runs through them. */
  tie: Point[];
  linkIDs: string[];
}

export interface AnnotationGeometry {
  id: string;
  text: string;
  /** Top-left corner of the text (`Annotation.position`). */
  textOrigin: Point;
  /** The note plate around the text. */
  frame: Rect;
}

export const annotationPadding = { x: 7, y: 4 } as const;

export function annotationGeometry(annotation: Annotation): AnnotationGeometry {
  const size = blockSize(annotation.text === "" ? " " : annotation.text, TextStyles.annotation);
  return {
    id: annotation.id,
    text: annotation.text,
    textOrigin: annotation.position,
    frame: {
      x: annotation.position.x - annotationPadding.x,
      y: annotation.position.y - annotationPadding.y,
      width: Math.max(size.width, 12) + 2 * annotationPadding.x,
      height: size.height + 2 * annotationPadding.y,
    },
  };
}

export const endLabelPadding = { width: 4, height: 1.5 } as const;
export const dotRadius = 4;
export const bundleLabelPadding = { width: 7, height: 2.5 } as const;

export function bundleLabelSize(label: string): Size {
  const size = textSize(label === "" ? " " : label, TextStyles.bundle);
  return {
    width: Math.ceil(size.width) + 2 * bundleLabelPadding.width,
    height: Math.ceil(size.height) + 2 * bundleLabelPadding.height,
  };
}

/**
 * Distance along the cable from `start` at which it is clear of its own device: out of the panel
 * and, when it runs on through the icon and name above the panel, past those too. Status dots
 * and port names go there instead of on top of the device's name.
 */
export function clearance(start: Point, end: Point, node: NodeGeometry): number {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (!(length > 1)) return 0;
  let distance = exitParameter(start, end, node.bodyRect) * length;
  const interval = clipInterval(start, end, inset(node.headerRect, -2, -2));
  if (interval) {
    const [enter, leave] = interval;
    if (enter * length <= distance + 12 && leave * length < length / 2) {
      distance = Math.max(distance, leave * length);
    }
  }
  return distance;
}

// MARK: Hit testing

/** What lies under a canvas point. */
export type CanvasHit =
  | { kind: "port"; ref: PortRef }
  | { kind: "statusDot"; linkID: string; end: LinkEnd }
  | { kind: "warning"; deviceID: string }
  /** The icon / name part of a device. */
  | { kind: "deviceHeader"; deviceID: string }
  /** The panel plate of a device (between ports). */
  | { kind: "devicePanel"; deviceID: string }
  | { kind: "annotation"; id: string }
  /** A cable; carries every link of the strand (a whole bundle in the logical view). */
  | { kind: "link"; ids: string[] }
  | { kind: "bundleLabel"; bundleID: string; linkIDs: string[] }
  | { kind: "empty" };

export const emptyHit: CanvasHit = { kind: "empty" };

export function hitDeviceID(hit: CanvasHit): string | null {
  switch (hit.kind) {
    case "port":
      return hit.ref.deviceID;
    case "warning":
    case "deviceHeader":
    case "devicePanel":
      return hit.deviceID;
    default:
      return null;
  }
}

export function hitsEqual(a: CanvasHit, b: CanvasHit): boolean {
  if (a === b) return true;
  switch (a.kind) {
    case "port":
      return b.kind === "port" && a.ref.deviceID === b.ref.deviceID && a.ref.portID === b.ref.portID;
    case "statusDot":
      return b.kind === "statusDot" && a.linkID === b.linkID && a.end === b.end;
    case "warning":
    case "deviceHeader":
    case "devicePanel":
      return b.kind === a.kind && b.deviceID === a.deviceID;
    case "annotation":
      return b.kind === "annotation" && a.id === b.id;
    case "link":
      return b.kind === "link" && a.ids.length === b.ids.length && a.ids.every((id, i) => id === b.ids[i]);
    case "bundleLabel":
      return (
        b.kind === "bundleLabel" &&
        a.bundleID === b.bundleID &&
        a.linkIDs.length === b.linkIDs.length &&
        a.linkIDs.every((id, i) => id === b.linkIDs[i])
      );
    case "empty":
      return b.kind === "empty";
  }
}

/** What a rubber band catches. */
export interface CaughtElements {
  devices: string[];
  links: string[];
  annotations: string[];
}

/** Builds node geometry for a device; lets a cache reuse the geometry of unchanged devices. */
export type NodeFactory = (device: Device, mode: ViewMode) => NodeGeometry;

const defaultNodeFactory: NodeFactory = (device, mode) => new NodeGeometry(device, mode);

export class DiagramScene {
  readonly mode: ViewMode;
  /** Device nodes in project order (later = on top). */
  readonly nodes: NodeGeometry[];
  readonly links: LinkGeometry[];
  readonly bundles: BundleGeometry[];
  readonly annotations: AnnotationGeometry[];
  /** Ports that have a cable plugged in (keys from `refKey`). */
  readonly usedPorts: Set<string>;
  /** Used port ids per device, sorted (stable keys for memoized rendering). */
  readonly usedPortsByDevice: Map<string, string[]>;
  /** Bounding box of all content; null for an empty project. */
  readonly contentBounds: Rect | null;
  private readonly nodeIndex = new Map<string, number>();

  constructor(project: Project, mode: ViewMode, nodeFactory: NodeFactory = defaultNodeFactory) {
    this.mode = mode;
    const nodes = project.devices.map((device) => nodeFactory(device, mode));
    nodes.forEach((node, index) => {
      if (!this.nodeIndex.has(node.deviceID)) this.nodeIndex.set(node.deviceID, index);
    });
    this.nodes = nodes;

    const used = new Set<string>();
    const byDevice = new Map<string, string[]>();
    const markUsed = (ref: PortRef) => {
      used.add(refKey(ref));
      const list = byDevice.get(ref.deviceID);
      if (list) list.push(ref.portID);
      else byDevice.set(ref.deviceID, [ref.portID]);
    };
    for (const link of project.links) {
      markUsed(link.a);
      markUsed(link.b);
    }
    for (const list of byDevice.values()) list.sort();
    this.usedPorts = used;
    this.usedPortsByDevice = byDevice;
    this.annotations = project.annotations.map(annotationGeometry);

    const devicesByID = new Map<string, Device>();
    for (const device of project.devices) if (!devicesByID.has(device.id)) devicesByID.set(device.id, device);
    const bundleByID = new Map<string, LinkBundle>();
    for (const bundle of project.bundles) if (!bundleByID.has(bundle.id)) bundleByID.set(bundle.id, bundle);
    const isBundled = (link: Link) => link.bundleID !== undefined && bundleByID.has(link.bundleID);

    const links: LinkGeometry[] = [];
    const bundles: BundleGeometry[] = [];

    if (mode === "physical") {
      // Device names and panels are obstacles for cable-end labels.
      const occupied: Rect[] = nodes.map((node) => inset(node.headerRect, -2, -2));
      const panels = nodes.map((node) => node.bodyRect);

      for (const link of project.links) {
        const nodeA = this.node(link.a.deviceID);
        const nodeB = this.node(link.b.deviceID);
        const portA = nodeA?.panel?.port(link.a.portID);
        const portB = nodeB?.panel?.port(link.b.portID);
        const deviceA = devicesByID.get(link.a.deviceID);
        const deviceB = devicesByID.get(link.b.deviceID);
        if (!nodeA || !nodeB || !portA || !portB || !deviceA || !deviceB) continue;
        const start = portA.center;
        const end = portB.center;
        const length = Math.hypot(end.x - start.x, end.y - start.y);
        const nameA = deviceA.ports[portA.index] ? shortName(deviceA.ports[portA.index].name) : "";
        const nameB = deviceB.ports[portB.index] ? shortName(deviceB.ports[portB.index].name) : "";

        let dotA: Point | null = null;
        let dotB: Point | null = null;
        let labelA: LinkEndLabel | null = null;
        let labelB: LinkEndLabel | null = null;
        if (length > 1) {
          const ux = (end.x - start.x) / length;
          const uy = (end.y - start.y) / length;
          // Distances along the cable (from end a) at which it is clear of the two devices.
          let exitA = clearance(start, end, nodeA);
          let exitB = length - clearance(end, start, nodeB);
          if (exitB - exitA < 4) {
            // Overlapping panels: fall back to fixed fractions of the whole cable.
            exitA = length * 0.12;
            exitB = length * 0.88;
          }
          const middle = (exitA + exitB) / 2;
          const dotOffset = Math.min(dotRadius + 4, Math.max((exitB - exitA) * 0.2, 0));
          dotA = { x: start.x + ux * (exitA + dotOffset), y: start.y + uy * (exitA + dotOffset) };
          dotB = { x: start.x + ux * (exitB - dotOffset), y: start.y + uy * (exitB - dotOffset) };

          const place = (name: string, exit: number, direction: number): LinkEndLabel | null => {
            if (name === "") return null;
            const textBox = textSize(name, TextStyles.cableEnd);
            const size: Size = {
              width: Math.ceil(textBox.width) + 2 * endLabelPadding.width,
              height: Math.ceil(textBox.height) + 2 * endLabelPadding.height,
            };
            const halfExtent = (Math.abs(ux) * size.width + Math.abs(uy) * size.height) / 2;
            const base = dotOffset + dotRadius + 3 + halfExtent;
            // Stay on the own half of the cable so the two end labels never swap sides.
            const limit = Math.max(Math.abs(middle - exit) - halfExtent - 1, Math.min(base, Math.abs(middle - exit)));
            const centerAt = (distance: number): Point => {
              const s = exit + direction * distance;
              return { x: roundHalfAway(start.x + ux * s), y: roundHalfAway(start.y + uy * s) };
            };
            const step = size.height + 2;
            let chosen = centerAt(Math.min(base, limit));
            for (let attempt = 0; attempt < 7; attempt++) {
              const distance = base + attempt * step;
              if (distance > limit) break;
              const candidate = centerAt(distance);
              const box = inset(rectAround(candidate, size), -1, -1);
              const blocked =
                occupied.some((rect) => intersects(rect, box)) || panels.some((rect) => intersects(rect, box));
              if (!blocked) {
                chosen = candidate;
                break;
              }
            }
            const label: LinkEndLabel = { text: name, center: chosen, size, rect: rectAround(chosen, size) };
            occupied.push(label.rect);
            return label;
          };
          labelA = place(nameA, exitA, 1);
          labelB = place(nameB, exitB, -1);
        }

        links.push({
          id: link.id,
          memberIDs: [link.id],
          cableType: link.cableType,
          start,
          end,
          isBundled: isBundled(link),
          statusA: link.statusA,
          statusB: link.statusB,
          dotA,
          dotB,
          labelA,
          labelB,
        });
      }

      const linkByID = new Map<string, LinkGeometry>();
      for (const link of links) if (!linkByID.has(link.id)) linkByID.set(link.id, link);
      for (const bundle of project.bundles) {
        const members = bundle.linkIDs
          .map((id) => linkByID.get(id))
          .filter((link): link is LinkGeometry => link !== undefined);
        if (members.length === 0) continue;
        const midpoints = members.map(linkMidpoint).sort((p, q) => (p.x !== q.x ? p.x - q.x : p.y - q.y));
        const centroid = {
          x: midpoints.reduce((sum, p) => sum + p.x, 0) / midpoints.length,
          y: midpoints.reduce((sum, p) => sum + p.y, 0) / midpoints.length,
        };
        const labelCenter = { x: roundHalfAway(centroid.x), y: roundHalfAway(centroid.y) };
        const labelSize = bundleLabelSize(bundle.label);
        bundles.push({
          id: bundle.id,
          label: bundle.label,
          labelCenter,
          labelSize,
          labelRect: rectAround(labelCenter, labelSize),
          tie: midpoints,
          linkIDs: members.map((link) => link.id),
        });
      }
    } else {
      // Group parallel cables per device pair; a bundle is one strand, every other cable its own.
      interface Strand {
        members: Link[];
        bundle: LinkBundle | null;
      }
      const pairOrder: { key: string; pair: DevicePair }[] = [];
      const strandsByPair = new Map<string, Strand[]>();
      const strandOfBundle = new Map<string, { pairKey: string; index: number }>();
      for (const link of project.links) {
        if (link.a.deviceID === link.b.deviceID) continue;
        if (!this.node(link.a.deviceID) || !this.node(link.b.deviceID)) continue;
        const key = devicePairKey(link.a.deviceID, link.b.deviceID);
        let strands = strandsByPair.get(key);
        if (!strands) {
          strands = [];
          strandsByPair.set(key, strands);
          pairOrder.push({ key, pair: devicePair(link.a.deviceID, link.b.deviceID) });
        }
        const bundle = link.bundleID !== undefined ? bundleByID.get(link.bundleID) : undefined;
        if (link.bundleID !== undefined && bundle) {
          const existing = strandOfBundle.get(link.bundleID);
          if (existing && existing.pairKey === key) {
            strands[existing.index].members.push(link);
          } else {
            strandOfBundle.set(link.bundleID, { pairKey: key, index: strands.length });
            strands.push({ members: [link], bundle });
          }
        } else {
          strands.push({ members: [link], bundle: null });
        }
      }

      const spacing = 9;
      for (const { key, pair } of pairOrder) {
        const strands = strandsByPair.get(key);
        const first = this.node(pair.first);
        const second = this.node(pair.second);
        if (!strands || !first || !second) continue;
        const from = center(first.iconRect);
        const to = center(second.iconRect);
        const length = Math.hypot(to.x - from.x, to.y - from.y);
        if (!(length > 1)) continue;
        // Normal of the canonical direction, so parallel strands fan out consistently.
        const nx = -(to.y - from.y) / length;
        const ny = (to.x - from.x) / length;
        strands.forEach((strand, index) => {
          const lead = strand.members[0];
          if (!lead) return;
          const shift = (index - (strands.length - 1) / 2) * spacing;
          const p1 = { x: from.x + nx * shift, y: from.y + ny * shift };
          const p2 = { x: to.x + nx * shift, y: to.y + ny * shift };
          // A strand becomes visible where it has left the icon AND the name plate of its device.
          const hidden = (a: Point, b: Point, node: NodeGeometry): number => {
            let t = exitParameter(a, b, inset(node.iconRect, -3, -3));
            const interval = clipInterval(a, b, node.labelPlateRect);
            if (interval && interval[1] > t) t = interval[1];
            return t;
          };
          const t1 = hidden(p1, p2, first);
          const t2 = hidden(p2, p1, second);
          if (!(t1 + t2 < 1)) return;
          const visibleFirst = pointAt(p1, p2, t1);
          const visibleSecond = pointAt(p2, p1, t2);
          // Keep the a -> b orientation of the lead link.
          const leadStartsAtFirst = lead.a.deviceID === pair.first;
          const geometry: LinkGeometry = {
            id: lead.id,
            memberIDs: strand.members.map((link) => link.id),
            cableType: lead.cableType,
            start: leadStartsAtFirst ? visibleFirst : visibleSecond,
            end: leadStartsAtFirst ? visibleSecond : visibleFirst,
            isBundled: strand.bundle !== null,
            statusA: lead.statusA,
            statusB: lead.statusB,
            dotA: null,
            dotB: null,
            labelA: null,
            labelB: null,
          };
          links.push(geometry);
          if (strand.bundle) {
            const mid = linkMidpoint(geometry);
            const labelCenter = { x: roundHalfAway(mid.x), y: roundHalfAway(mid.y) };
            const labelSize = bundleLabelSize(strand.bundle.label);
            bundles.push({
              id: strand.bundle.id,
              label: strand.bundle.label,
              labelCenter,
              labelSize,
              labelRect: rectAround(labelCenter, labelSize),
              tie: [],
              linkIDs: strand.members.map((link) => link.id),
            });
          }
        });
      }
    }

    this.links = links;
    this.bundles = bundles;

    let bounds: Rect | null = null;
    const include = (rect: Rect) => {
      if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return;
      bounds = bounds ? union(bounds, rect) : rect;
    };
    nodes.forEach((node) => include(node.bounds));
    this.annotations.forEach((annotation) => include(annotation.frame));
    for (const link of links) {
      if (link.labelA) include(link.labelA.rect);
      if (link.labelB) include(link.labelB.rect);
      include(linkBox(link));
    }
    bundles.forEach((bundle) => include(bundle.labelRect));
    this.contentBounds = bounds;
  }

  node(deviceID: string): NodeGeometry | undefined {
    const index = this.nodeIndex.get(deviceID);
    return index === undefined ? undefined : this.nodes[index];
  }

  /** Center of a port in the physical view. */
  portCenter(ref: PortRef): Point | undefined {
    return this.node(ref.deviceID)?.panel?.port(ref.portID)?.center;
  }

  portGeometry(ref: PortRef): PortGeometry | undefined {
    return this.node(ref.deviceID)?.panel?.port(ref.portID);
  }

  isPortUsed(ref: PortRef): boolean {
    return this.usedPorts.has(refKey(ref));
  }

  /** Topmost element at `point` (canvas coordinates). `tolerance` is the pick slop in canvas points. */
  hitTest(point: Point, tolerance: number): CanvasHit {
    // Drawing order is panels < cables < icons and names < cable decorations < bundles < annotations,
    // so test in reverse - except that ports win over the cable ends that sit on them, otherwise
    // a plugged port could not be clicked.
    for (let i = this.annotations.length - 1; i >= 0; i--) {
      const annotation = this.annotations[i];
      if (containsPoint(annotation.frame, point)) return { kind: "annotation", id: annotation.id };
    }
    const dotReach = dotRadius + Math.max(tolerance * 0.6, 2);
    for (let i = this.links.length - 1; i >= 0; i--) {
      const link = this.links[i];
      for (const end of ["a", "b"] as const) {
        const dot = linkDot(link, end);
        if (dot && Math.hypot(point.x - dot.x, point.y - dot.y) <= dotReach) {
          return { kind: "statusDot", linkID: link.id, end };
        }
      }
    }
    for (let i = this.bundles.length - 1; i >= 0; i--) {
      const bundle = this.bundles[i];
      if (containsPoint(bundle.labelRect, point)) {
        return { kind: "bundleLabel", bundleID: bundle.id, linkIDs: bundle.linkIDs };
      }
    }
    // Icons and name plates hide the cables running behind them (in both views).
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i];
      if (node.warningRect && containsPoint(inset(node.warningRect, -3, -3), point)) {
        return { kind: "warning", deviceID: node.deviceID };
      }
      if (containsPoint(node.iconRect, point) || containsPoint(node.labelPlateRect, point)) {
        return { kind: "deviceHeader", deviceID: node.deviceID };
      }
    }
    // Only the topmost panel under the point counts: it hides the ports of the panels below it.
    let topmost: NodeGeometry | undefined;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      if (containsPoint(this.nodes[i].bodyRect, point)) {
        topmost = this.nodes[i];
        break;
      }
    }
    const port = topmost?.panel?.portAt(point);
    if (topmost && port) return { kind: "port", ref: { deviceID: topmost.deviceID, portID: port.portID } };

    // Cables are thin: prefer them over the plates they cross, but only close to the line.
    let best: { distance: number; link: LinkGeometry } | null = null;
    for (const link of this.links) {
      const distance = distanceToSegment(point, link.start, link.end);
      if (distance <= tolerance && distance < (best?.distance ?? Number.POSITIVE_INFINITY)) {
        best = { distance, link };
      }
    }
    if (best) return { kind: "link", ids: best.link.memberIDs };

    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i];
      if (containsPoint(inset(node.headerRect, -3, -3), point)) return { kind: "deviceHeader", deviceID: node.deviceID };
      if (containsPoint(node.bodyRect, point)) {
        return node.panel ? { kind: "devicePanel", deviceID: node.deviceID } : { kind: "deviceHeader", deviceID: node.deviceID };
      }
    }
    return emptyHit;
  }

  /** Ids of everything whose frame intersects `rect` (rubber-band selection). */
  elementsIn(rect: Rect): CaughtElements {
    const devices = this.nodes
      .filter((node) => intersects(node.bodyRect, rect) || intersects(node.headerRect, rect))
      .map((node) => node.deviceID);
    const annotations = this.annotations.filter((note) => intersects(note.frame, rect)).map((note) => note.id);
    // A cable is caught when both of its ends are inside the rubber band.
    const links = this.links
      .filter((link) => containsPoint(rect, link.start) && containsPoint(rect, link.end))
      .flatMap((link) => link.memberIDs);
    return { devices, links, annotations };
  }
}

/**
 * Reuses node geometry of devices that did not change (projects are immutable values, so an
 * unchanged device keeps its object identity) and the whole scene while the project and the
 * view mode stay the same. Dragging one device of fifty re-lays out one node.
 */
export class SceneCache {
  private nodes: Record<ViewMode, WeakMap<Device, NodeGeometry>> = {
    physical: new WeakMap(),
    logical: new WeakMap(),
  };
  private generation = textMeasurerGeneration();
  private last: { project: Project; mode: ViewMode; scene: DiagramScene } | null = null;
  private readonly metrics: PanelMetrics;

  constructor(metrics: PanelMetrics = PanelMetrics.standard) {
    this.metrics = metrics;
  }

  private checkGeneration(): void {
    const current = textMeasurerGeneration();
    if (current === this.generation) return;
    this.generation = current;
    this.nodes = { physical: new WeakMap(), logical: new WeakMap() };
    this.last = null;
  }

  node(device: Device, mode: ViewMode): NodeGeometry {
    this.checkGeneration();
    const cache = this.nodes[mode];
    let node = cache.get(device);
    if (!node) {
      node = new NodeGeometry(device, mode, this.metrics);
      cache.set(device, node);
    }
    return node;
  }

  scene(project: Project, mode: ViewMode): DiagramScene {
    this.checkGeneration();
    const last = this.last;
    if (last && last.project === project && last.mode === mode) return last.scene;
    const scene = new DiagramScene(project, mode, (device, viewMode) => this.node(device, viewMode));
    this.last = { project, mode, scene };
    return scene;
  }
}
