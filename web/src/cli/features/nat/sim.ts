// Address translation in the packet path.
//
// Cisco IOS: a packet that comes in on an `ip nat inside` interface and leaves on an
// `ip nat outside` one gets its source translated (static rule, then a known flow, then the
// first dynamic rule whose access list permits it); a packet that comes in on an outside
// interface to an inside global address gets its destination translated back before routing.
// MikroTik: `dstnat` rules run on the way in (before routing), `srcnat`/`masquerade` rules on
// the way out (after routing); replies of a translated flow are translated back by the flow.
//
// The translations are kept in NetworkRuntime (state.ts) and survive between pings.
//
// The simulation has no ICMP query ids, so the reply of an overloaded ping is matched to its
// flow by the address pair plus a "request waits for its reply" mark (`Translation.pending`):
// this keeps a ping of the router itself from being taken for the reply of a translated host.

import type { Device } from "../../../core/model";
import type { NATConfig, NATRule } from "../../../core/protocols/nat";
import { IPv4, IPv4Prefix } from "../../sim/ipv4";
import type { NetworkSimulator, SimInterface } from "../../sim/network-simulator";
import { pass, type HopContext, type Packet, type SimFeature, type Verdict } from "../../sim/packet";
import { aclPermits } from "./acl-match";
import { activeRules, dynamicRuleText, natState, poolRange, type NATState, type Translation } from "./state";

const maxTranslations = 4096;
const maxPoolScan = 65536;

type Direction = "inbound" | "outbound";

function isReply(packet: Packet): boolean {
  return packet.protocol === "icmp" && packet.icmpType === "echo-reply";
}

// MARK: Rewriting

function withSource(packet: Packet, address: string, port: number): Packet {
  const ip = IPv4.parse(address);
  if (ip === null) return packet;
  return { ...packet, source: ip, sourcePort: packet.protocol === "icmp" ? packet.sourcePort : port };
}

function withDestination(packet: Packet, address: string, port: number): Packet {
  const ip = IPv4.parse(address);
  if (ip === null) return packet;
  return { ...packet, destination: ip, destinationPort: packet.protocol === "icmp" ? packet.destinationPort : port };
}

// MARK: Flows

/** A flow matches a packet that travels towards the inside (source = remote, destination = global). */
function matchesInbound(flow: Translation, packet: Packet): boolean {
  if (flow.protocol !== packet.protocol) return false;
  if (packet.source.description !== flow.remote || packet.destination.description !== flow.global) return false;
  if (packet.protocol === "icmp") {
    if (flow.initiator === "outside") return !isReply(packet);
    return flow.simple || (isReply(packet) && flow.pending > 0);
  }
  return packet.sourcePort === flow.remotePort && packet.destinationPort === flow.globalPort;
}

/** A flow matches a packet that travels towards the outside (source = local, destination = remote). */
function matchesOutbound(flow: Translation, packet: Packet): boolean {
  if (flow.protocol !== packet.protocol) return false;
  if (packet.source.description !== flow.local || packet.destination.description !== flow.remote) return false;
  if (packet.protocol === "icmp") {
    if (flow.initiator === "outside") return isReply(packet) && flow.pending > 0;
    return !isReply(packet);
  }
  return packet.sourcePort === flow.localPort && packet.destinationPort === flow.remotePort;
}

function findFlow(state: NATState, packet: Packet, direction: Direction, style: Translation["style"]): Translation | null {
  let best: Translation | null = null;
  for (const flow of state.translations) {
    if (flow.style !== style || flow.kind === "static") continue;
    const matches = direction === "inbound" ? matchesInbound(flow, packet) : matchesOutbound(flow, packet);
    if (matches && (best === null || flow.used > best.used)) best = flow;
  }
  return best;
}

/** Bookkeeping of a packet that travels through a flow: clock and the ICMP request/reply mark. */
function touch(state: NATState, flow: Translation, packet: Packet, direction: Direction): void {
  flow.used = ++state.clock;
  if (packet.protocol !== "icmp" || flow.kind === "static") return;
  const request = (direction === "outbound") === (flow.initiator === "inside");
  if (request) {
    if (!flow.simple || flow.initiator === "outside") flow.pending = 1;
  } else {
    flow.pending = Math.max(0, flow.pending - 1);
  }
}

/** A packet that found its flow already in the table (a hit of `show ip nat statistics`). */
function use(state: NATState, flow: Translation, packet: Packet, direction: Direction): void {
  state.hits += 1;
  touch(state, flow, packet, direction);
}

function freeGlobalPort(state: NATState, flow: { protocol: string; global: string; remote: string; remotePort: number }, preferred: number): number {
  const taken = (port: number): boolean =>
    state.translations.some(
      (other) =>
        other.protocol === flow.protocol &&
        other.global === flow.global &&
        other.globalPort === port &&
        other.remote === flow.remote &&
        other.remotePort === flow.remotePort,
    );
  if (preferred > 0 && !taken(preferred)) return preferred;
  for (let port = 1024; port <= 65535; port++) if (!taken(port)) return port;
  return preferred;
}

type FlowSpec = Omit<Translation, "id" | "used" | "pending" | "globalPort">;

/**
 * The flow of a packet: the existing one, or a new entry. `globalPort` decides the global port
 * of a new TCP/UDP flow; ICMP flows get a query id (the model has none) as both ports.
 */
function obtainFlow(
  state: NATState,
  spec: FlowSpec,
  globalPort: (flow: FlowSpec) => number,
): { flow: Translation; created: boolean } {
  const existing = state.translations.find(
    (flow) =>
      flow.style === spec.style &&
      flow.kind === spec.kind &&
      (spec.kind === "static" || flow.initiator === spec.initiator) &&
      flow.protocol === spec.protocol &&
      flow.local === spec.local &&
      flow.global === spec.global &&
      flow.remote === spec.remote &&
      (spec.protocol === "icmp" || (flow.localPort === spec.localPort && flow.remotePort === spec.remotePort)),
  );
  if (existing) return { flow: existing, created: false };
  let localPort = spec.localPort;
  let remotePort = spec.remotePort;
  let port: number;
  if (spec.protocol === "icmp") {
    state.icmpID += 1;
    localPort = state.icmpID;
    remotePort = state.icmpID;
    port = state.icmpID;
  } else {
    port = globalPort(spec);
  }
  if (state.translations.length >= maxTranslations) {
    const oldest = state.translations.reduce((a, b) => (b.used < a.used ? b : a));
    state.translations.splice(state.translations.indexOf(oldest), 1);
  }
  const flow: Translation = { ...spec, localPort, remotePort, globalPort: port, id: state.nextID++, pending: 0, used: ++state.clock };
  state.translations.push(flow);
  state.peak = Math.max(state.peak, state.translations.length);
  return { flow, created: true };
}

function toInside(flow: Translation, packet: Packet): Packet {
  return withDestination(packet, flow.local, flow.localPort);
}

function toOutside(flow: Translation, packet: Packet): Packet {
  return withSource(packet, flow.global, flow.globalPort);
}

// MARK: Cisco IOS

function iosStaticFlow(state: NATState, rule: Extract<NATRule, { kind: "static" }>, packet: Packet, initiator: "inside" | "outside"): Translation {
  const toInsideDirection = initiator === "outside";
  const remote = toInsideDirection ? packet.source : packet.destination;
  const localPort = toInsideDirection ? packet.destinationPort : packet.sourcePort;
  const remotePort = toInsideDirection ? packet.sourcePort : packet.destinationPort;
  const { flow } = obtainFlow(
    state,
    {
      style: "ios",
      kind: "static",
      rule: `ip nat inside source static ${rule.local} ${rule.global}`,
      initiator,
      protocol: packet.protocol,
      local: rule.local,
      localPort,
      global: rule.global,
      remote: remote.description,
      remotePort,
      simple: true,
    },
    () => localPort,
  );
  flow.used = ++state.clock;
  return flow;
}

/** Outside to inside on an outside interface: the destination is an inside global address. */
function iosInbound(config: NATConfig, state: NATState, packet: Packet): Packet | null {
  const destination = packet.destination.description;
  for (const rule of activeRules(config.rules)) {
    if (rule.kind !== "static" || rule.global !== destination) continue;
    const flow = iosStaticFlow(state, rule, packet, "outside");
    state.hits += 1;
    return withDestination(packet, rule.local, flow.localPort);
  }
  const flow = findFlow(state, packet, "inbound", "ios");
  if (flow) {
    use(state, flow, packet, "inbound");
    return toInside(flow, packet);
  }
  // A mapping without overload also lets other outside hosts reach the inside host.
  const mapping = state.translations.find(
    (candidate) =>
      candidate.style === "ios" && candidate.kind === "dynamic" && candidate.simple && candidate.global === destination,
  );
  if (mapping) {
    const { flow: created } = obtainFlow(
      state,
      {
        style: "ios",
        kind: "dynamic",
        rule: mapping.rule,
        initiator: "outside",
        protocol: packet.protocol,
        local: mapping.local,
        localPort: packet.destinationPort,
        global: mapping.global,
        remote: packet.source.description,
        remotePort: packet.sourcePort,
        simple: true,
        pool: mapping.pool,
        list: mapping.list,
      },
      () => packet.destinationPort,
    );
    use(state, created, packet, "inbound");
    return toInside(created, packet);
  }
  return null;
}

interface GlobalChoice {
  address: string;
  /** Why no address could be given (a pool without overload ran out). */
  exhausted: string | null;
}

/** The inside global address a dynamic rule gives to `local`, or null when the rule cannot be used. */
function chooseGlobal(
  sim: NetworkSimulator,
  device: Device,
  config: NATConfig,
  state: NATState,
  rule: Extract<NATRule, { kind: "dynamic" }>,
  ruleText: string,
  local: string,
): GlobalChoice | null {
  const staticGlobals = new Set<string>();
  for (const item of config.rules) if (item.kind === "static") staticGlobals.add(item.global);
  const ownedBy = (address: string): boolean => sim.interfacesOf(device.id).some((iface) => iface.prefix.address.description === address);
  const holder = (address: string): string | undefined =>
    state.translations.find((flow) => flow.style === "ios" && flow.simple && flow.kind === "dynamic" && flow.global === address && flow.initiator === "inside")?.local;

  if (rule.pool !== undefined) {
    const pool = config.pools.find((candidate) => candidate.name === rule.pool);
    const range = pool === undefined ? null : poolRange(pool);
    if (range === null) return null;
    const own = state.translations.find(
      (flow) => flow.style === "ios" && flow.simple && flow.kind === "dynamic" && flow.local === local && flow.rule === ruleText,
    );
    if (!rule.overload && own) return { address: own.global, exhausted: null };
    const last = Math.min(range.last, range.first + maxPoolScan - 1);
    for (let value = range.first; value <= last; value++) {
      const address = new IPv4(value).description;
      if (staticGlobals.has(address)) continue;
      if (rule.overload) return { address, exhausted: null };
      const user = holder(address);
      if (user === undefined && !ownedBy(address)) return { address, exhausted: null };
    }
    return {
      address: "",
      exhausted: `překladový pool ${rule.pool} nemá volnou adresu (pravidlo „${ruleText}“ je bez overload, jedna globální adresa slouží jen jednomu vnitřnímu hostu)`,
    };
  }

  const iface = sim.interfacesOf(device.id).find((candidate) => candidate.id === rule.interface);
  if (iface === undefined) return null;
  const address = iface.prefix.address.description;
  if (!rule.overload) {
    const user = holder(address);
    if (user !== undefined && user !== local) {
      return {
        address: "",
        exhausted: `adresa rozhraní ${iface.name} už je přeložena pro ${user} (pravidlo „${ruleText}“ je bez overload)`,
      };
    }
  }
  return { address, exhausted: null };
}

/** Inside to outside: static rule, known flow, then the first dynamic rule whose list permits. */
function iosOutbound(context: HopContext, device: Device, config: NATConfig, state: NATState, packet: Packet): Verdict | null {
  const source = packet.source.description;
  const rules = activeRules(config.rules);
  for (const rule of rules) {
    if (rule.kind !== "static" || rule.local !== source) continue;
    const flow = iosStaticFlow(state, rule, packet, "inside");
    state.hits += 1;
    return pass(withSource(packet, rule.global, flow.globalPort));
  }
  const known = findFlow(state, packet, "outbound", "ios");
  if (known) {
    use(state, known, packet, "outbound");
    return pass(toOutside(known, packet));
  }
  for (const rule of rules) {
    if (rule.kind !== "dynamic" || !aclPermits(device, rule.list, packet)) continue;
    const interfaceName = rule.interface === undefined ? null : context.sim.interfacesOf(device.id).find((iface) => iface.id === rule.interface)?.name ?? null;
    const ruleText = dynamicRuleText(rule, interfaceName);
    const choice = chooseGlobal(context.sim, device, config, state, rule, ruleText, source);
    if (choice === null) continue;
    if (choice.exhausted !== null) {
      return {
        kind: "drop",
        reason: `${device.hostname} zahodil paket od ${source}: ${choice.exhausted}.`,
        symbol: "U",
        feature: "nat",
      };
    }
    const { flow, created } = obtainFlow(
      state,
      {
        style: "ios",
        kind: rule.overload ? "overload" : "dynamic",
        rule: ruleText,
        initiator: "inside",
        protocol: packet.protocol,
        local: source,
        localPort: packet.sourcePort,
        global: choice.address,
        remote: packet.destination.description,
        remotePort: packet.destinationPort,
        simple: !rule.overload,
        pool: rule.pool,
        list: rule.list,
      },
      (spec) => (rule.overload ? freeGlobalPort(state, spec, packet.sourcePort) : packet.sourcePort),
    );
    if (created) state.misses += 1;
    touch(state, flow, packet, "outbound");
    return pass(toOutside(flow, packet));
  }
  return null;
}

// MARK: MikroTik RouterOS

function firstAddress(text: string): string | null {
  const first = text.split("-")[0].trim();
  return IPv4.parse(first) === null ? null : first;
}

function addressMatches(spec: string, address: IPv4): boolean {
  if (spec === "") return true;
  const prefix = IPv4Prefix.fromCIDR(spec);
  if (prefix !== null) return prefix.contains(address);
  return IPv4.parse(spec)?.equals(address) ?? false;
}

/** "80", "80-90", "80,443" against a port. */
function portMatches(spec: string, port: number): boolean {
  return spec.split(",").some((part) => {
    const bounds = part.trim().split("-").map((value) => Number(value));
    if (bounds.some((value) => !Number.isInteger(value))) return false;
    return bounds.length === 1 ? port === bounds[0] : bounds.length === 2 && port >= bounds[0] && port <= bounds[1];
  });
}

function routerOSInbound(context: HopContext, config: NATConfig, state: NATState, packet: Packet): Packet | null {
  const ingress = context.ingress;
  const flow = findFlow(state, packet, "inbound", "routeros");
  if (flow) {
    use(state, flow, packet, "inbound");
    return toInside(flow, packet);
  }
  for (const rule of activeRules(config.rules)) {
    if (rule.kind !== "dstnat") continue;
    if (rule.inInterface !== undefined && rule.inInterface !== ingress?.id) continue;
    if (!addressMatches(rule.dstAddress, packet.destination)) continue;
    if (rule.protocol !== undefined && rule.protocol !== packet.protocol) continue;
    if (rule.dstPort !== undefined && (packet.protocol === "icmp" || !portMatches(rule.dstPort, packet.destinationPort))) continue;
    const target = firstAddress(rule.toAddress);
    if (target === null) continue;
    const toPort = rule.toPort === undefined ? null : Number(rule.toPort.split("-")[0]);
    const localPort = toPort !== null && Number.isInteger(toPort) ? toPort : packet.destinationPort;
    const { flow: made, created } = obtainFlow(
      state,
      {
        style: "routeros",
        kind: "dstnat",
        rule: "chain=dstnat action=dst-nat",
        initiator: "outside",
        protocol: packet.protocol,
        local: target,
        localPort,
        global: packet.destination.description,
        remote: packet.source.description,
        remotePort: packet.sourcePort,
        simple: false,
      },
      () => packet.destinationPort,
    );
    if (created) state.misses += 1;
    touch(state, made, packet, "inbound");
    return toInside(made, packet);
  }
  return null;
}

function routerOSOutbound(context: HopContext, config: NATConfig, state: NATState, packet: Packet): Packet | null {
  const egress = context.egress;
  if (egress === null) return null;
  const flow = findFlow(state, packet, "outbound", "routeros");
  if (flow) {
    use(state, flow, packet, "outbound");
    return toOutside(flow, packet);
  }
  for (const rule of activeRules(config.rules)) {
    if (rule.kind !== "masquerade" && rule.kind !== "srcnat") continue;
    if (rule.outInterface !== undefined && rule.outInterface !== egress.id) continue;
    if (!addressMatches(rule.srcAddress, packet.source)) continue;
    const global = rule.kind === "masquerade" ? egress.prefix.address.description : firstAddress(rule.toAddress);
    if (global === null) continue;
    const { flow: made, created } = obtainFlow(
      state,
      {
        style: "routeros",
        kind: rule.kind,
        rule: rule.kind === "masquerade" ? "chain=srcnat action=masquerade" : "chain=srcnat action=src-nat",
        initiator: "inside",
        protocol: packet.protocol,
        local: packet.source.description,
        localPort: packet.sourcePort,
        global,
        remote: packet.destination.description,
        remotePort: packet.destinationPort,
        simple: false,
      },
      (spec) => freeGlobalPort(state, spec, packet.sourcePort),
    );
    if (created) state.misses += 1;
    touch(state, made, packet, "outbound");
    return toOutside(made, packet);
  }
  return null;
}

// MARK: Feature

function natConfigOf(context: HopContext): { device: Device; config: NATConfig } | null {
  const device = context.sim.device(context.deviceID);
  const config = device?.protocols?.nat;
  return device && config ? { device, config } : null;
}

/** True when the device answers ARP for `address` on an outside interface in `domain`. */
function answersFor(sim: NetworkSimulator, device: Device, address: IPv4, domain: number): boolean {
  const config = device.protocols?.nat;
  if (!config || config.outside.length === 0) return false;
  const onOutside = sim.interfacesOf(device.id).some((iface: SimInterface) => iface.domain === domain && config.outside.includes(iface.id));
  if (!onOutside) return false;
  for (const rule of activeRules(config.rules)) {
    if (rule.kind === "static" && rule.global === address.description) return true;
    if (rule.kind !== "dynamic" || rule.pool === undefined) continue;
    const pool = config.pools.find((candidate) => candidate.name === rule.pool);
    const range = pool === undefined ? null : poolRange(pool);
    if (range !== null && address.value >= range.first && address.value <= range.last) return true;
  }
  return false;
}

export const natSimFeature: SimFeature = {
  name: "nat",

  answers(sim, address, domain) {
    for (const device of sim.project.devices) {
      if (answersFor(sim, device, address, domain)) return device.id;
    }
    return null;
  },

  inbound(context, packet) {
    const found = natConfigOf(context);
    if (!found || context.ingress === null) return pass(packet);
    const state = natState(found.device.id);
    if (found.config.outside.includes(context.ingress.id)) {
      const translated = iosInbound(found.config, state, packet);
      if (translated) return pass(translated);
    }
    return pass(routerOSInbound(context, found.config, state, packet) ?? packet);
  },

  outbound(context, packet) {
    const found = natConfigOf(context);
    if (!found || context.ingress === null || context.egress === null) return pass(packet);
    const state = natState(found.device.id);
    if (found.config.inside.includes(context.ingress.id) && found.config.outside.includes(context.egress.id)) {
      const verdict = iosOutbound(context, found.device, found.config, state, packet);
      if (verdict) return verdict;
    }
    return pass(routerOSOutbound(context, found.config, state, packet) ?? packet);
  },
};
