// Spanning tree in the network simulation: which switch is the root, which port of each switch
// leads to it and which ports block.
//
// One tree per connected group of switches (all VLANs share it: PVST, Rapid-PVST, MST instance 0,
// STP and RSTP are computed identically, as in a network where every VLAN has the same topology).
// The result is a pure function of the project, so it is deterministic and the same for every
// caller (simulation, `show spanning-tree`, canvas markers).
//
// Rules (IEEE 802.1D-2004 / 802.1w):
//  - root bridge: the lowest (priority, MAC) of the group; the MAC is `bridgeMAC` of the device;
//  - root port: the port with the lowest path cost to the root (sum of the costs of the ports a
//    BPDU is received on); ties break by the neighbour's bridge id, the neighbour's port id and
//    the own port id;
//  - designated port: on each cable the end whose bridge offers the better (root path cost,
//    bridge id, port id); an end that is neither is "alternate" (or "backup" on a cable between
//    two ports of one switch) and blocks;
//  - ports towards devices that do not run STP (PCs, routers) are leaves: designated and edge.
// Only switches take part (`NetworkSimulator.isSwitching`). A switch with mode "none" neither
// sends nor relays BPDUs, so it is left out of the tree and none of its ports ever blocks.
//
// EtherChannel (etherchannel.ts): the bundled members of a port-channel are ONE port of the tree:
// one slot with the summed speed (2 x 1G costs 10000), one role and state for all members, and a
// failing member only lowers the cost. A suspended static member is a cable that is down.
//
// Simplifications: BPDUs cross every trunk and access link regardless of VLANs; port costs always
// use the long (RSTP) scale, because the labs expect 20000 for gigabit; ports change state at
// once (no listening/learning delay); only cabled ports are reported.

import type { Device, Port, Project } from "../../../core/model";
import { readSTPConfig, type STPConfig, type STPMode } from "../../../core/protocols/layer2";
import { bridgeMAC, macBytes } from "../../sim/mac";
import { channelPortDown, channelsOfDevice } from "./etherchannel";
import { NetworkSimulator } from "../../sim/network-simulator";
import type { STPPortState } from "./sim";

export type STPRole = "root" | "designated" | "alternate" | "backup" | "disabled";

export interface STPPortInfo {
  deviceID: string;
  portID: string;
  role: STPRole;
  state: STPPortState;
  cost: number;
  priority: number;
  /** PortFast, or a leaf port towards a device that does not run STP. */
  edge: boolean;
  /** The port-channel group when the port is a bundled member (all members share one tree port). */
  channel?: number;
}

export interface STPBridgeInfo {
  deviceID: string;
  /** "<priority>.<MAC>", e.g. "32768.0212.3456.789a" (the MAC in Cisco notation). */
  bridgeID: string;
  priority: number;
  mac: string;
  isRoot: boolean;
  rootBridgeID: string;
  /** Path cost to the root; 0 on the root. */
  rootCost: number;
  /** The port towards the root; absent on the root. */
  rootPortID?: string;
  /** The cabled ports in device order. */
  ports: STPPortInfo[];
  mode: STPMode;
}

export const defaultBridgePriority = 32768;
export const defaultPortPriority = 128;

/** Speed of a port in Mbit/s; an empty or unknown speed counts as gigabit. */
function speedValue(speed: string): number {
  const match = /^\s*([\d.]+)\s*([MG])/i.exec(speed);
  if (!match) return 1000;
  return Number(match[1]) * (match[2].toUpperCase() === "G" ? 1000 : 1);
}

/** Long (IEEE 802.1D-2004) path cost of a port speed: 10M 2000000, 100M 200000, 1G 20000, 10G 2000. */
export function defaultPortCost(speed: string): number {
  const mbit = speedValue(speed);
  if (!(mbit > 0)) return 20000;
  return Math.max(1, Math.min(200000000, Math.round(20000000 / mbit)));
}

/** The slowest end of a cable decides its cost. */
function linkCost(a: Port, b: Port): number {
  return defaultPortCost(speedValue(a.speed) <= speedValue(b.speed) ? a.speed : b.speed);
}

/** A port-channel costs as one link of the summed speed (the slower end of each cable counts). */
function bundleCost(
  _project: Project,
  slot: Slot,
  devices: Map<string, Device>,
  farEnd: Map<string, { deviceID: string; portID: string }>,
): number {
  let total = 0;
  for (const member of slot.members) {
    const far = farEnd.get(`${slot.bridge.device.id}|${member.id}`);
    const farPort = far ? devices.get(far.deviceID)?.ports.find((item) => item.id === far.portID) : undefined;
    total += farPort ? Math.min(speedValue(member.speed), speedValue(farPort.speed)) : speedValue(member.speed);
  }
  return total > 0 ? Math.max(1, Math.min(200000000, Math.round(20000000 / total))) : 20000;
}

function isStpPort(port: Port): boolean {
  return port.connector !== "console" && port.connector !== "mgmt" && port.connector !== "wireless";
}

/** The configured value for a port: the entry for all VLANs (0), else the lowest VLAN's. */
function perPort<T extends { vlan: number }>(entries: T[], matches: (entry: T) => boolean): T | undefined {
  const own = entries.filter(matches).sort((a, b) => a.vlan - b.vlan);
  return own.find((entry) => entry.vlan === 0) ?? own[0];
}

function bridgePriority(config: STPConfig): number {
  const entries = [...config.priorities].sort((a, b) => a.vlan - b.vlan);
  const entry = entries.find((item) => item.vlan === 0) ?? entries[0];
  const value = entry ? entry.priority : defaultBridgePriority;
  return Math.max(0, Math.min(61440, Math.round(value)));
}

function compareBytes(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

interface Bridge {
  device: Device;
  config: STPConfig;
  priority: number;
  mac: number[];
  bridgeID: string;
  ports: Slot[];
}

/** One cabled port of a switch (or all bundled members of one port-channel). */
interface Slot {
  bridge: Bridge;
  /** The port (the first member of a port-channel) that stands for the slot. */
  port: Port;
  /** All ports of the slot: one, or the bundled members of a port-channel. */
  members: Port[];
  /** The port-channel group of a bundle slot. */
  channel?: number;
  index: number;
  cost: number;
  priority: number;
  /** The slot at the other end when both ends are switches that run STP. */
  peer: Slot | null;
  /** The cable is up (neither end shut down). */
  up: boolean;
}

function compareBridges(a: Bridge, b: Bridge): number {
  return a.priority - b.priority || compareBytes(a.mac, b.mac);
}

function comparePortIDs(a: Slot, b: Slot): number {
  return a.priority - b.priority || a.index - b.index;
}

/** The BPDU a port received: the cost it adds to the sender's, and who sent it. */
interface Offer {
  cost: number;
  /** The receiving port. */
  via: Slot;
}

/** Whether `cost` received on `via` beats the `known` offer (cost, sender bridge, sender port, own port). */
function beats(cost: number, via: Slot, known: Offer): boolean {
  if (cost !== known.cost) return cost < known.cost;
  const sender = via.peer as Slot;
  const knownSender = known.via.peer as Slot;
  return (
    compareBridges(sender.bridge, knownSender.bridge) < 0 ||
    (sender.bridge === knownSender.bridge &&
      (comparePortIDs(sender, knownSender) < 0 ||
        (sender === knownSender && comparePortIDs(via, known.via) < 0)))
  );
}

export function computeSpanningTree(project: Project): Map<string, STPBridgeInfo> {
  const result = new Map<string, STPBridgeInfo>();
  const devices = new Map<string, Device>();
  for (const device of project.devices) if (!devices.has(device.id)) devices.set(device.id, device);
  const farEnd = new Map<string, { deviceID: string; portID: string }>();
  for (const link of project.links) {
    const a = `${link.a.deviceID}|${link.a.portID}`;
    const b = `${link.b.deviceID}|${link.b.portID}`;
    if (!farEnd.has(a)) farEnd.set(a, link.b);
    if (!farEnd.has(b)) farEnd.set(b, link.a);
  }

  // Switches and their cabled ports.
  const bridges = new Map<string, Bridge>();
  const slots = new Map<string, Slot>();
  for (const device of devices.values()) {
    if (!NetworkSimulator.isSwitching(device.category)) continue;
    const config = readSTPConfig(device.protocols?.stp ?? {}) as STPConfig;
    const priority = bridgePriority(config);
    const bridge: Bridge = {
      device,
      config,
      priority,
      mac: macBytes(device.ports[0]?.id ?? device.id),
      bridgeID: `${priority}.${bridgeMAC(device, "cisco")}`,
      ports: [],
    };
    bridges.set(device.id, bridge);
    // Bundled members of the same port-channel share one slot.
    const bundles = new Map<string, number>();
    const bundleSlots = new Map<number, Slot>();
    for (const info of channelsOfDevice(project, device)) {
      for (const member of info.members) if (member.state === "bundled") bundles.set(member.portID, info.group);
    }
    device.ports.forEach((port, index) => {
      const key = `${device.id}|${port.id}`;
      if (!isStpPort(port) || !farEnd.has(key)) return;
      const group = bundles.get(port.id);
      const shared = group === undefined ? undefined : bundleSlots.get(group);
      if (shared) {
        shared.members.push(port);
        slots.set(key, shared);
        return;
      }
      const slot: Slot = { bridge, port, members: [port], channel: group, index, cost: 0, priority: defaultPortPriority, peer: null, up: false };
      if (group !== undefined) bundleSlots.set(group, slot);
      bridge.ports.push(slot);
      slots.set(key, slot);
    });
  }
  const participates = (bridge: Bridge): boolean => bridge.config.mode !== "none";
  for (const slot of new Set(slots.values())) {
    const far = farEnd.get(`${slot.bridge.device.id}|${slot.port.id}`) as { deviceID: string; portID: string };
    const farDevice = devices.get(far.deviceID);
    const farPort = farDevice?.ports.find((item) => item.id === far.portID);
    slot.up =
      !!farPort &&
      !slot.port.adminDown &&
      !farPort.adminDown &&
      channelPortDown(project, slot.bridge.device, slot.port) === null &&
      (farDevice === undefined || channelPortDown(project, farDevice, farPort) === null);
    const peer = slots.get(`${far.deviceID}|${far.portID}`) ?? null;
    slot.peer = peer && participates(peer.bridge) && participates(slot.bridge) ? peer : null;
    const id = slot.port.id;
    const cost = perPort(slot.bridge.config.costs, (entry) => entry.port === id);
    slot.cost = cost
      ? Math.max(1, cost.cost)
      : slot.channel !== undefined
        ? bundleCost(project, slot, devices, farEnd)
        : farPort
          ? linkCost(slot.port, farPort)
          : defaultPortCost(slot.port.speed);
    const priority = perPort(slot.bridge.config.portPriorities, (entry) => entry.port === id);
    slot.priority = priority ? Math.max(0, Math.min(240, priority.priority)) : defaultPortPriority;
  }

  // Connected groups of switches over cables that are up; each group has its own root.
  const groups: Bridge[][] = [];
  const grouped = new Set<Bridge>();
  for (const start of bridges.values()) {
    if (!participates(start) || grouped.has(start)) continue;
    const group: Bridge[] = [];
    const stack = [start];
    grouped.add(start);
    while (stack.length > 0) {
      const bridge = stack.pop() as Bridge;
      group.push(bridge);
      for (const slot of bridge.ports) {
        const next = slot.up ? slot.peer?.bridge : undefined;
        if (next && !grouped.has(next)) {
          grouped.add(next);
          stack.push(next);
        }
      }
    }
    groups.push(group);
  }

  const costToRoot = new Map<Bridge, number>();
  const rootPorts = new Map<Bridge, Slot>();
  const rootOf = new Map<Bridge, Bridge>();
  for (const group of groups) {
    const root = group.reduce((best, bridge) => (compareBridges(bridge, best) < 0 ? bridge : best));
    // Dijkstra from the root: the bridge with the best (cost, bridge id) is settled next.
    const offers = new Map<Bridge, Offer>();
    const settled = new Set<Bridge>([root]);
    costToRoot.set(root, 0);
    const advertise = (from: Bridge): void => {
      for (const sender of from.ports) {
        const receiver = sender.up ? sender.peer : null;
        if (!receiver || settled.has(receiver.bridge)) continue;
        const cost = (costToRoot.get(from) as number) + receiver.cost;
        const known = offers.get(receiver.bridge);
        if (!known || beats(cost, receiver, known)) offers.set(receiver.bridge, { cost, via: receiver });
      }
    };
    advertise(root);
    while (settled.size < group.length) {
      let next: Bridge | null = null;
      for (const [bridge, offer] of offers) {
        if (settled.has(bridge)) continue;
        const current = next ? (offers.get(next) as Offer) : null;
        if (!current || offer.cost < current.cost || (offer.cost === current.cost && compareBridges(bridge, next as Bridge) < 0)) {
          next = bridge;
        }
      }
      if (!next) break;
      const offer = offers.get(next) as Offer;
      settled.add(next);
      costToRoot.set(next, offer.cost);
      rootPorts.set(next, offer.via);
      advertise(next);
    }
    for (const bridge of group) rootOf.set(bridge, root);
  }

  // Port roles.
  const roles = new Map<Slot, STPRole>();
  for (const bridge of bridges.values()) {
    for (const slot of bridge.ports) {
      if (!slot.up) roles.set(slot, "disabled");
      else if (!slot.peer) roles.set(slot, "designated");
      else if (rootPorts.get(bridge) === slot) roles.set(slot, "root");
    }
  }
  for (const bridge of bridges.values()) {
    for (const slot of bridge.ports) {
      if (roles.has(slot)) continue;
      // The two ends of the cable offer (root path cost, bridge id, port id); the better one is designated.
      const peer = slot.peer as Slot;
      let order = (costToRoot.get(bridge) as number) - (costToRoot.get(peer.bridge) as number);
      if (order === 0 && bridge !== peer.bridge) order = compareBridges(bridge, peer.bridge);
      if (order === 0) order = comparePortIDs(slot, peer);
      roles.set(slot, order < 0 ? "designated" : bridge === peer.bridge ? "backup" : "alternate");
    }
  }

  for (const bridge of bridges.values()) {
    const root = rootOf.get(bridge) ?? bridge;
    const ports: STPPortInfo[] = bridge.ports.flatMap((slot) => {
      const role = roles.get(slot) as STPRole;
      return slot.members.map((member): STPPortInfo => {
        const info: STPPortInfo = {
          deviceID: bridge.device.id,
          portID: member.id,
          role,
          state: role === "disabled" ? "disabled" : role === "alternate" || role === "backup" ? "blocking" : "forwarding",
          cost: slot.cost,
          priority: slot.priority,
          edge: !slot.peer || bridge.config.portfast.includes(member.id),
        };
        if (slot.channel !== undefined) info.channel = slot.channel;
        return info;
      });
    });
    const info: STPBridgeInfo = {
      deviceID: bridge.device.id,
      bridgeID: bridge.bridgeID,
      priority: bridge.priority,
      mac: bridgeMAC(bridge.device, "cisco"),
      isRoot: root === bridge,
      rootBridgeID: root.bridgeID,
      rootCost: costToRoot.get(bridge) ?? 0,
      ports,
      mode: bridge.config.mode,
    };
    const rootPort = rootPorts.get(bridge);
    if (rootPort) info.rootPortID = rootPort.port.id;
    result.set(bridge.device.id, info);
  }
  return result;
}
