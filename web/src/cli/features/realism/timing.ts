// Realism of ping and traceroute: round-trip times and packet loss derived from the cables a
// packet crosses (Link.delay in ms, Link.loss in %), and the packet trace events the canvas
// animates. Everything is deterministic (no Math.random): the "random" numbers are a hash of the
// device, the destination, a per-device run counter and the echo / cable involved.
//
// While no cable on the path has a delay or a loss set, `TimingPlan.active` is false and the
// consoles print exactly what they always did (the golden outputs of the Swift app).

import type { Link, Project } from "../../../core/model";
import type { IPv4 } from "../../sim/ipv4";
import type { Delivery, NetworkSimulator, PingResult } from "../../sim/network-simulator";
import type { PacketLinkStep, PacketSegment } from "../../sim/packet";
import { NetworkRuntime } from "../../sim/runtime";
import { emitPacketTrace } from "../../sim/trace-events";

// MARK: Deterministic pseudo-random numbers

/** A number in [0, 1) that depends only on the parts (FNV-1a followed by a murmur3 finalizer). */
export function unitHash(...parts: readonly (string | number)[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const text = `${part}|`;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

interface RunCounter {
  count: number;
}

/** How many ping / traceroute runs this console has made (reset with NetworkRuntime.reset()). */
function nextRun(deviceID: string): number {
  const counter = NetworkRuntime.state<RunCounter>("realism.run", deviceID, () => ({ count: 0 }));
  counter.count += 1;
  return counter.count;
}

// MARK: Delays

/** Processing time of one forwarding hop (a router or the end host), in ms. */
const hopProcessing = 0.08;
/** Store-and-forward time of every switch on the way, in ms. */
const switchProcessing = 0.03;

/** One-way delay of a cable without `delay`, by its speed ("100M", "1G", "10G", "40G"), in ms. */
export function defaultCableDelay(speed: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([MGT])/i.exec(speed.trim());
  if (!match) return 0.05;
  const factor = { M: 1, G: 1000, T: 1_000_000 }[match[2].toUpperCase() as "M" | "G" | "T"];
  const mbit = Number(match[1]) * factor;
  if (mbit >= 10_000) return 0.01;
  if (mbit >= 1000) return 0.02;
  if (mbit >= 100) return 0.05;
  return 0.1;
}

/** What the project says about the cables of a path. */
class CableTable {
  private readonly links = new Map<string, Link>();

  constructor(private readonly project: Project) {
    for (const link of project.links) if (!this.links.has(link.id)) this.links.set(link.id, link);
  }

  link(linkID: string): Link | undefined {
    return this.links.get(linkID);
  }

  /** The slower of the two ports names the cable's speed. */
  private defaultDelay(link: Link): number {
    const speeds = [link.a, link.b].map((end) => {
      const device = this.project.devices.find((candidate) => candidate.id === end.deviceID);
      return device?.ports.find((candidate) => candidate.id === end.portID)?.speed ?? "";
    });
    return Math.max(...speeds.map(defaultCableDelay));
  }

  /** One-way delay of a cable in ms. */
  delay(linkID: string): number {
    const link = this.links.get(linkID);
    if (!link) return 0;
    return link.delay !== undefined && link.delay > 0 ? link.delay : this.defaultDelay(link);
  }

  /** Loss of a cable as a probability 0...1. */
  loss(linkID: string): number {
    const loss = this.links.get(linkID)?.loss;
    return loss !== undefined && loss > 0 ? Math.min(loss, 100) / 100 : 0;
  }

  /** True when the cable has a delay or a loss set by the user. */
  isShaped(linkID: string): boolean {
    const link = this.links.get(linkID);
    return link !== undefined && ((link.delay ?? 0) > 0 || (link.loss ?? 0) > 0);
  }
}

// MARK: Crossings

/** One crossing of a cable by an echo, in travel order. */
export interface Crossing {
  readonly step: PacketLinkStep;
  readonly phase: "forward" | "back";
  /** Index of the segment and of the cable within the segment, inside the phase. */
  readonly segment: number;
  readonly index: number;
}

function crossingsOf(forward: readonly PacketSegment[], back: readonly PacketSegment[]): Crossing[] {
  const result: Crossing[] = [];
  const add = (segments: readonly PacketSegment[], phase: "forward" | "back") => {
    segments.forEach((segment, segmentIndex) => {
      segment.links.forEach((step, index) => result.push({ step, phase, segment: segmentIndex, index }));
    });
  };
  add(forward, "forward");
  add(back, "back");
  return result;
}

/** The same way walked the other way round (the reply of a traceroute probe). */
export function reversedSegments(segments: readonly PacketSegment[]): PacketSegment[] {
  return [...segments].reverse().map((segment) => ({
    fromDevice: segment.toDevice,
    toDevice: segment.fromDevice,
    links: [...segment.links].reverse().map((step) => ({
      linkID: step.linkID,
      fromDevice: step.toDevice,
      toDevice: step.fromDevice,
    })),
  }));
}

/** Sum of the cable delays and processing times of the way there and back, in ms. */
function baseTime(table: CableTable, forward: readonly PacketSegment[], back: readonly PacketSegment[]): number {
  let total = 0;
  for (const segments of [forward, back]) {
    for (const segment of segments) {
      total += hopProcessing + Math.max(0, segment.links.length - 1) * switchProcessing;
      for (const step of segment.links) total += table.delay(step.linkID);
    }
  }
  return total;
}

// MARK: One echo

export interface EchoSample {
  readonly lost: boolean;
  /** Round-trip time in ms; 0 for a lost echo. */
  readonly rtt: number;
  /** The crossing at which a lost echo disappeared. */
  readonly lostAt: Crossing | null;
}

interface EchoSeed {
  readonly deviceID: string;
  readonly destination: string;
  readonly run: number;
}

/** Plays one echo over the way there and back: loss on every crossing, then the jittered time. */
function sampleEcho(
  table: CableTable,
  seed: EchoSeed,
  echo: number,
  forward: readonly PacketSegment[],
  back: readonly PacketSegment[],
): EchoSample {
  const crossings = crossingsOf(forward, back);
  for (const [position, crossing] of crossings.entries()) {
    const loss = table.loss(crossing.step.linkID);
    if (loss <= 0) continue;
    const draw = unitHash("loss", seed.deviceID, seed.destination, seed.run, echo, crossing.step.linkID, position);
    if (draw < loss) return { lost: true, rtt: 0, lostAt: crossing };
  }
  const base = baseTime(table, forward, back);
  const jitter = unitHash("jitter", seed.deviceID, seed.destination, seed.run, echo) * (0.15 + 0.03 * base);
  return { lost: false, rtt: base + jitter, lostAt: null };
}

// MARK: ping

export interface TimingPlan {
  /** False when no cable on the path has a delay or a loss: print the classic output. */
  readonly active: boolean;
  /** One entry per echo (empty while not active). */
  readonly samples: readonly EchoSample[];
  /** Routers the reply crossed on its way back: the TTL drops by one for each. */
  readonly routersOnReturn: number;
  readonly received: number;
  /** Round-trip times of the echoes that came back, in ms. */
  readonly minimum: number;
  readonly average: number;
  readonly maximum: number;
  /** Cables of the path that have a loss set, for the explanation of timeouts. */
  readonly lossy: readonly { linkID: string; loss: number }[];
  readonly sim: NetworkSimulator | null;
}

const inactivePlan: TimingPlan = {
  active: false,
  samples: [],
  routersOnReturn: 0,
  received: 0,
  minimum: 0,
  average: 0,
  maximum: 0,
  lossy: [],
  sim: null,
};

/**
 * The times and losses of `count` echoes of a ping that the simulation delivered. Call it once
 * per console command (it advances the run counter that varies the jitter and the losses).
 */
export function planPing(
  simulator: NetworkSimulator,
  deviceID: string,
  destination: IPv4,
  result: PingResult,
  count: number,
): TimingPlan {
  const run = nextRun(deviceID);
  if (!result.success || result.back === null) return inactivePlan;
  const table = new CableTable(simulator.project);
  const forward = result.forward.segments;
  const back = result.back.segments;
  const steps = [...forward, ...back].flatMap((segment) => segment.links);
  if (!steps.some((step) => table.isShaped(step.linkID))) return inactivePlan;

  const seed: EchoSeed = { deviceID, destination: destination.description, run };
  const samples = Array.from({ length: count }, (_, echo) => sampleEcho(table, seed, echo, forward, back));
  const times = samples.filter((sample) => !sample.lost).map((sample) => sample.rtt);
  const sum = times.reduce((total, time) => total + time, 0);
  return {
    active: true,
    samples,
    routersOnReturn: Math.max(0, result.back.hops.length - 1),
    received: times.length,
    minimum: times.length > 0 ? Math.min(...times) : 0,
    average: times.length > 0 ? sum / times.length : 0,
    maximum: times.length > 0 ? Math.max(...times) : 0,
    lossy: lossyCables(table, steps),
    sim: simulator,
  };
}

function lossyCables(table: CableTable, steps: readonly PacketLinkStep[]): { linkID: string; loss: number }[] {
  const seen = new Set<string>();
  const result: { linkID: string; loss: number }[] = [];
  for (const step of steps) {
    if (seen.has(step.linkID)) continue;
    seen.add(step.linkID);
    const loss = table.loss(step.linkID);
    if (loss > 0) result.push({ linkID: step.linkID, loss: loss * 100 });
  }
  return result;
}

/** Whole milliseconds as the consoles print them. */
export function wholeMilliseconds(time: number): number {
  return Math.round(time);
}

/** Whole milliseconds as Windows prints them: below a millisecond it is 0. */
export function windowsMilliseconds(rtt: number): number {
  return rtt < 1 ? 0 : Math.round(rtt);
}

/** "time=21ms" or, below a millisecond, "time<1ms" (the ping line of Windows). */
export function windowsTime(rtt: number): string {
  return rtt < 1 ? "time<1ms" : `time=${Math.round(rtt)}ms`;
}

/** "21 ms" or "<1 ms" (a tracert column). */
export function windowsTraceTime(rtt: number): string {
  return rtt < 1 ? "<1 ms" : `${Math.round(rtt)} ms`;
}

/** RouterOS time column: "21ms", "21ms345us" or, below a millisecond, "345us". */
export function routerOSTime(rtt: number): string {
  const microseconds = Math.round(rtt * 1000);
  const ms = Math.floor(microseconds / 1000);
  const rest = microseconds % 1000;
  if (ms === 0) return `${rest}us`;
  return rest === 0 ? `${ms}ms` : `${ms}ms${rest}us`;
}

/** Cisco "min/avg/max" in whole ms; a reply is never faster than 1 ms there. */
export function ciscoRoundTrip(plan: TimingPlan): string {
  const ms = (time: number) => Math.max(1, wholeMilliseconds(time));
  return `${ms(plan.minimum)}/${ms(plan.average)}/${ms(plan.maximum)}`;
}

/** A Czech line that names the cables with a loss when packets were lost; "" when none was. */
function describeLoss(
  simulator: NetworkSimulator | null,
  lossy: readonly { linkID: string; loss: number }[],
  lost: number,
  total: number,
  unit: string,
): string {
  if (simulator === null || lost === 0 || lossy.length === 0) return "";
  const names = lossy.map(({ linkID, loss }) => {
    const link = simulator.project.links.find((candidate) => candidate.id === linkID);
    const end = (ref: { deviceID: string; portID: string } | undefined) => {
      const device = simulator.project.devices.find((candidate) => candidate.id === ref?.deviceID);
      const port = device?.ports.find((candidate) => candidate.id === ref?.portID);
      return device ? `${device.hostname} ${port?.name ?? "?"}` : "?";
    };
    return `${end(link?.a)} – ${end(link?.b)} (ztrátovost ${Math.round(loss * 10) / 10} %)`;
  });
  const subject = lost === total ? `všechny ${unit} se ztratily` : `ztraceno ${lost} z ${total} ${unit}`;
  return `NetSketch: ${subject} na kabelu ${names.join(", ")}.`;
}

/** The notice after a ping in which echoes were lost; "" otherwise. */
export function lossNotice(plan: TimingPlan): string {
  return describeLoss(plan.sim, plan.lossy, plan.samples.length - plan.received, plan.samples.length, "pakety");
}

// MARK: traceroute

export interface TracerouteProbe {
  /** Round-trip time in ms, or null when the probe was lost. */
  readonly rtt: number | null;
}

export interface TraceroutePlan {
  readonly active: boolean;
  /** Three probes for every hop of `delivery.hops`. */
  readonly hops: readonly (readonly TracerouteProbe[])[];
  readonly lossy: readonly { linkID: string; loss: number }[];
  readonly sim: NetworkSimulator | null;
}

/** True when the traceroute got an answer from its last hop (at least one probe came back). */
export function tracerouteAnswered(plan: TraceroutePlan): boolean {
  const last = plan.hops[plan.hops.length - 1];
  return !plan.active || last === undefined || last.some((probe) => probe.rtt !== null);
}

/** The notice after a traceroute in which probes were lost; "" otherwise. */
export function tracerouteLossNotice(plan: TraceroutePlan): string {
  const probes = plan.hops.flat();
  const lost = probes.filter((probe) => probe.rtt === null).length;
  return describeLoss(plan.sim, plan.lossy, lost, probes.length, "sondy");
}

const tracerouteProbes = 3;

/** The times and losses of the three probes to every hop a traceroute reached. */
export function planTraceroute(simulator: NetworkSimulator, deviceID: string, destination: IPv4, delivery: Delivery): TraceroutePlan {
  const run = nextRun(deviceID);
  const table = new CableTable(simulator.project);
  const steps = delivery.segments.flatMap((segment) => segment.links);
  if (!steps.some((step) => table.isShaped(step.linkID))) return { active: false, hops: [], lossy: [], sim: null };
  const seed: EchoSeed = { deviceID, destination: destination.description, run };
  const hops = delivery.segments.map((_, hop) => {
    const forward = delivery.segments.slice(0, hop + 1);
    const back = reversedSegments(forward);
    return Array.from({ length: tracerouteProbes }, (__, probe): TracerouteProbe => {
      const sample = sampleEcho(table, seed, hop * tracerouteProbes + probe, forward, back);
      return { rtt: sample.lost ? null : sample.rtt };
    });
  });
  return { active: true, hops, lossy: lossyCables(table, steps), sim: simulator };
}

// MARK: Packet trace events (the canvas animates them)

/** The device where a delivery stopped: the one that dropped the packet, or the last it entered. */
function stopDevice(delivery: Delivery, start: string): string {
  const failure = delivery.failure;
  if (failure !== null && "deviceID" in failure) return failure.deviceID;
  return delivery.lastDevice ?? start;
}

/** The way up to (not including) the cable at `segment` / `index`; the packet got no further. */
function cutBefore(segments: readonly PacketSegment[], segment: number, index: number): PacketSegment[] {
  const result = segments.slice(0, segment);
  const partial = segments[segment];
  if (partial && index > 0) {
    result.push({
      fromDevice: partial.fromDevice,
      toDevice: partial.links[index].fromDevice,
      links: partial.links.slice(0, index),
    });
  }
  return result;
}

/**
 * Tells the canvas about the first echo of a ping: the way there, the way back, and where it
 * stopped. With a plan, the first echo may have been lost on a cable.
 */
export function announcePing(deviceID: string, result: PingResult, plan: TimingPlan): void {
  const forward = result.forward.segments;
  const back = result.back?.segments ?? [];
  const first = plan.active ? plan.samples[0] : undefined;
  if (first !== undefined && first.lost && first.lostAt !== null) {
    const cut = first.lostAt;
    const reached = cut.step.fromDevice;
    emitPacketTrace({
      kind: "ping",
      deviceID,
      forward: cut.phase === "forward" ? cutBefore(forward, cut.segment, cut.index) : forward,
      back: cut.phase === "forward" ? [] : cutBefore(back, cut.segment, cut.index),
      success: false,
      failedAt: reached,
    });
    return;
  }
  let failedAt: string | null = null;
  if (!result.forward.delivered) failedAt = stopDevice(result.forward, deviceID);
  else if (result.back !== null && !result.back.delivered) {
    failedAt = stopDevice(result.back, result.forward.lastDevice ?? deviceID);
  }
  emitPacketTrace({ kind: "ping", deviceID, forward, back, success: result.success, failedAt });
}

/** Tells the canvas about a traceroute: the probe's way to the last hop and the reply back. */
export function announceTraceroute(deviceID: string, delivery: Delivery): void {
  const forward = delivery.segments;
  emitPacketTrace({
    kind: "traceroute",
    deviceID,
    forward,
    back: delivery.delivered ? reversedSegments(forward) : [],
    success: delivery.delivered,
    failedAt: delivery.delivered ? null : stopDevice(delivery, deviceID),
  });
}
