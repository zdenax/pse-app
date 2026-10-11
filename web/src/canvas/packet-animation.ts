// The animation of packets on the canvas: a small envelope runs along the drawn cables from
// device to device (the request in one colour, the reply in another), and a red cross marks the
// place where a packet got lost. Framework-free: `buildPacketPlan` turns a packet trace into a
// polyline over the scene's cable geometry, `PacketAnimator` plays plans one after another
// (several pings queue up) and answers "what is on screen at this moment".
//
// The trace types are structural copies of src/cli/sim/trace-events.ts; only ui/wiring.ts may
// import from src/cli, so the canvas never names them.

import type { Project } from "../core/model";
import { center, type Point } from "./geom";
import type { DiagramScene, LinkGeometry } from "./scene";

export interface TraceStepLike {
  readonly linkID: string;
  readonly fromDevice: string;
  readonly toDevice: string;
}

export interface TraceSegmentLike {
  readonly fromDevice: string;
  readonly toDevice: string;
  readonly links: readonly TraceStepLike[];
}

export interface PacketTraceLike {
  readonly kind: string;
  readonly deviceID: string;
  readonly forward: readonly TraceSegmentLike[];
  readonly back: readonly TraceSegmentLike[];
  readonly success: boolean;
  readonly failedAt: string | null;
}

/** Something the canvas can subscribe to for packet traces (ui/wiring.ts supplies it). */
export interface PacketSource {
  subscribe(listener: (trace: PacketTraceLike) => void): () => void;
}

export type PacketPhase = "request" | "reply";

/** A straight piece of the way: along a cable, or across a device from one port to the next. */
export interface Leg {
  readonly phase: PacketPhase;
  readonly from: Point;
  readonly to: Point;
  readonly length: number;
  /** Time the packet stays at the end of the leg (the device handles it), in ms. */
  readonly dwell: number;
}

export interface PacketPlan {
  readonly legs: readonly Leg[];
  /** Where a red cross is drawn when the packet failed; null for a successful trace. */
  readonly failure: Point | null;
}

const deviceDwell = 110;

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

interface CableInfo {
  readonly geometry: LinkGeometry;
  /** The device at `geometry.start` (the device of end a of the strand's lead cable). */
  readonly startDevice: string;
}

/** Every drawn cable by the id of each link it stands for. */
export function cablesOf(scene: DiagramScene, project: Project): Map<string, CableInfo> {
  const result = new Map<string, CableInfo>();
  const leads = new Map(project.links.map((link) => [link.id, link.a.deviceID]));
  for (const geometry of scene.links) {
    const startDevice = leads.get(geometry.id);
    if (startDevice === undefined) continue;
    for (const id of geometry.memberIDs) if (!result.has(id)) result.set(id, { geometry, startDevice });
  }
  return result;
}

/**
 * The way of a trace over the scene: the request along the forward cables, then the reply along
 * the back ones. Cables the scene does not draw are skipped. Null when nothing can be shown.
 */
export function buildPacketPlan(scene: DiagramScene, project: Project, trace: PacketTraceLike): PacketPlan | null {
  const cables = cablesOf(scene, project);
  const legs: Leg[] = [];
  let at: Point | null = null;

  const addLeg = (phase: PacketPhase, from: Point, to: Point, dwell: number) => {
    legs.push({ phase, from, to, length: distance(from, to), dwell });
  };
  const walk = (phase: PacketPhase, segments: readonly TraceSegmentLike[]) => {
    for (const segment of segments) {
      const first = legs.length;
      for (const step of segment.links) {
        const cable = cables.get(step.linkID);
        if (!cable) continue;
        const forward = step.fromDevice === cable.startDevice;
        const from = forward ? cable.geometry.start : cable.geometry.end;
        const to = forward ? cable.geometry.end : cable.geometry.start;
        // Across the device (port to port) before the next cable.
        if (at !== null && distance(at, from) > 0.5) addLeg(phase, at, from, 0);
        addLeg(phase, from, to, 0);
        at = to;
      }
      // The device the segment ends at handles the packet for a moment.
      if (legs.length > first) {
        const last = legs[legs.length - 1];
        legs[legs.length - 1] = { ...last, dwell: deviceDwell };
      }
    }
  };
  walk("request", trace.forward);
  walk("reply", trace.back);
  if (legs.length > 0) {
    const last = legs[legs.length - 1];
    legs[legs.length - 1] = { ...last, dwell: 0 };
  }

  let failure: Point | null = null;
  if (!trace.success) {
    if (legs.length > 0) failure = legs[legs.length - 1].to;
    else {
      const node = scene.node(trace.failedAt ?? trace.deviceID) ?? scene.node(trace.deviceID);
      failure = node ? center(node.iconRect) : null;
    }
  }
  if (legs.length === 0 && failure === null) return null;
  return { legs, failure };
}

// MARK: Playing

export interface AnimationFrame {
  /** The envelope and where it is; null when it is not moving (reduced motion, or the end). */
  readonly envelope: { readonly point: Point; readonly phase: PacketPhase; readonly angle: number } | null;
  /** Reduced motion: the path is highlighted instead of animated. */
  readonly highlight: { readonly legs: readonly Leg[]; readonly opacity: number } | null;
  /** The red cross of a failed packet. */
  readonly cross: { readonly point: Point; readonly opacity: number } | null;
}

export interface AnimatorOptions {
  /** Speed of the envelope in canvas points per second. */
  speed?: number;
  /** A trace never takes longer than this to play, in ms. */
  maxDuration?: number;
  /** How long the red cross stays after the packet stopped, in ms. */
  linger?: number;
  /** How long the path stays highlighted with reduced motion, in ms. */
  highlightDuration?: number;
  /** Traces waiting behind the one playing; older ones are dropped beyond this. */
  maxQueue?: number;
}

interface Job {
  readonly plan: PacketPlan;
  readonly reduced: boolean;
  /** When the trace was announced; it never starts earlier. */
  readonly queuedAt: number;
  startedAt: number | null;
  /** Start and end of every leg's movement, in ms from the start. */
  readonly timeline: { readonly start: number; readonly end: number }[];
  readonly movement: number;
  readonly total: number;
}

const minimumLeg = 90;

export class PacketAnimator {
  private readonly speed: number;
  private readonly maxDuration: number;
  private readonly linger: number;
  private readonly highlightDuration: number;
  private readonly maxQueue: number;
  private current: Job | null = null;
  private queue: Job[] = [];
  /** When the previous trace was over, so the next one starts right behind it. */
  private previousEnd = 0;

  constructor(options: AnimatorOptions = {}) {
    this.speed = options.speed ?? 420;
    this.maxDuration = options.maxDuration ?? 3200;
    this.linger = options.linger ?? 1100;
    this.highlightDuration = options.highlightDuration ?? 900;
    this.maxQueue = options.maxQueue ?? 8;
  }

  /** Traces still to be shown, including the one playing. */
  get pending(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  clear(): void {
    this.current = null;
    this.queue = [];
    this.previousEnd = 0;
  }

  enqueue(plan: PacketPlan, now: number, reduced = false): void {
    this.queue.push(this.makeJob(plan, now, reduced));
    while (this.queue.length > this.maxQueue) this.queue.shift();
  }

  private makeJob(plan: PacketPlan, now: number, reduced: boolean): Job {
    if (reduced) {
      return { plan, reduced, queuedAt: now, startedAt: null, timeline: [], movement: 0, total: this.highlightDuration };
    }
    const raw = plan.legs.map((leg) => Math.max(minimumLeg, (leg.length / this.speed) * 1000));
    const dwell = plan.legs.reduce((sum, leg) => sum + leg.dwell, 0);
    const movement = raw.reduce((sum, time) => sum + time, 0) + dwell;
    const scale = movement > this.maxDuration ? this.maxDuration / movement : 1;
    const timeline: { start: number; end: number }[] = [];
    let clock = 0;
    plan.legs.forEach((leg, index) => {
      const duration = raw[index] * scale;
      timeline.push({ start: clock, end: clock + duration });
      clock += duration + leg.dwell * scale;
    });
    const tail = plan.failure !== null ? this.linger : 120;
    return { plan, reduced, queuedAt: now, startedAt: null, timeline, movement: clock, total: clock + tail };
  }

  /** What is on screen at `now`; null when nothing is playing (the animation loop can stop). */
  frame(now: number): AnimationFrame | null {
    for (;;) {
      if (this.current === null) {
        const next = this.queue.shift();
        if (!next) return null;
        next.startedAt = Math.max(next.queuedAt, this.previousEnd);
        this.current = next;
      }
      const job = this.current;
      const startedAt = job.startedAt ?? now;
      // A frame time slightly before the announcement (animation frames are stamped at their start).
      const elapsed = Math.max(0, now - startedAt);
      if (elapsed >= job.total) {
        this.previousEnd = startedAt + job.total;
        this.current = null;
        continue;
      }
      return job.reduced ? this.reducedFrame(job, elapsed) : this.movingFrame(job, elapsed);
    }
  }

  private reducedFrame(job: Job, elapsed: number): AnimationFrame {
    const fade = Math.min(1, (job.total - elapsed) / 250);
    return {
      envelope: null,
      highlight: job.plan.legs.length > 0 ? { legs: job.plan.legs, opacity: fade } : null,
      cross: job.plan.failure ? { point: job.plan.failure, opacity: fade } : null,
    };
  }

  private movingFrame(job: Job, elapsed: number): AnimationFrame {
    const { plan, timeline } = job;
    if (elapsed >= job.movement) {
      const fade = Math.min(1, (job.total - elapsed) / 300);
      return {
        envelope: null,
        highlight: null,
        cross: plan.failure ? { point: plan.failure, opacity: fade } : null,
      };
    }
    // Between the legs the envelope waits at the end of the previous one (the device works).
    let index = timeline.findIndex((entry) => elapsed < entry.end);
    if (index < 0) index = timeline.length - 1;
    const leg = plan.legs[index];
    const entry = timeline[index];
    const progress = elapsed <= entry.start ? 0 : Math.min(1, (elapsed - entry.start) / Math.max(1, entry.end - entry.start));
    let point: Point;
    let phase = leg.phase;
    if (elapsed < entry.start && index > 0) {
      const previous = plan.legs[index - 1];
      point = previous.to;
      phase = previous.phase;
    } else {
      point = { x: leg.from.x + (leg.to.x - leg.from.x) * progress, y: leg.from.y + (leg.to.y - leg.from.y) * progress };
    }
    return {
      envelope: { point, phase, angle: Math.atan2(leg.to.y - leg.from.y, leg.to.x - leg.from.x) },
      highlight: null,
      cross: null,
    };
  }
}

// MARK: STP port markers

/** The state map of `spanningTreePortStates`: key "deviceID|portID". */
export type PortStateMap = ReadonlyMap<string, string>;

export interface StpMarker {
  /** Key of the port, for React. */
  readonly key: string;
  readonly point: Point;
  /** Direction of the cable at the marker, in radians. */
  readonly angle: number;
  readonly deviceID: string;
  readonly portID: string;
}

/** How far from the port the marker sits along the cable, in canvas points. */
const markerOffset = 11;

/**
 * A marker at the link end of every blocking port: on the cable, a little way from the port
 * (physical view) or from the device icon (logical view).
 */
export function stpMarkers(scene: DiagramScene, project: Project, states: PortStateMap): StpMarker[] {
  if (states.size === 0) return [];
  const cables = cablesOf(scene, project);
  const markers: StpMarker[] = [];
  for (const link of project.links) {
    const cable = cables.get(link.id);
    if (!cable) continue;
    const { geometry, startDevice } = cable;
    const length = distance(geometry.start, geometry.end);
    if (!(length > 1)) continue;
    const ends = [
      { ref: link.a, atStart: link.a.deviceID === startDevice },
      { ref: link.b, atStart: link.a.deviceID === link.b.deviceID ? false : link.b.deviceID === startDevice },
    ];
    for (const { ref, atStart } of ends) {
      const key = `${ref.deviceID}|${ref.portID}`;
      if (states.get(key) !== "blocking") continue;
      const from = atStart ? geometry.start : geometry.end;
      const to = atStart ? geometry.end : geometry.start;
      const inset = Math.min(markerOffset, length * 0.35);
      markers.push({
        key: `${link.id}|${key}`,
        point: { x: from.x + ((to.x - from.x) / length) * inset, y: from.y + ((to.y - from.y) / length) * inset },
        angle: Math.atan2(to.y - from.y, to.x - from.x),
        deviceID: ref.deviceID,
        portID: ref.portID,
      });
    }
  }
  return markers;
}
