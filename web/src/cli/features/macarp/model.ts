// MAC address tables of switches and ARP tables of every device: the run-time state and the
// views of it. Vendor independent: the Cisco commands are in ios.ts, other consoles can read
// the same tables with `macTable` / `arpTable` and clear them with `clearMacTable` /
// `clearArpCache`.
//
// Model (deterministic, no time):
// - Nothing is stored in the project. The tables are run-time state (sim/runtime.ts) filled by
//   traffic: sim.ts calls `learn` for every packet the simulation followed (ping, traceroute,
//   TCP, DHCP ...). They are lost when the page is reloaded, like on a real device after reload.
// - MAC learning, one hop of a packet (sender interface S -> receiver interface R, same
//   layer-2 domain): the ARP request is a broadcast, so EVERY switch that bridges the domain
//   learns S's MAC on the port that faces S. The unicast reply travels the path back, so the
//   switches ON the path between S and R learn R's MAC on the port that faces R.
// - ARP learning, same hop: the sender learns R's address -> MAC, the receiver learns S's.
//   In addition every router port gets an entry for the device at the other end of its cable
//   when that is a routed port too (a directly connected neighbour that announced itself when
//   the link came up). Those are seeded once; `clear arp-cache` removes them for good.
// - No aging, no table size limit, no MAC moves other than "the newest port wins".
// - Entries are checked when the table is read: a port without a working cable, an interface
//   that no longer has the address, are left out (the diagram changed after the learning).
// - MAC addresses are the deterministic ones of sim/mac.ts, kept here in the Cisco notation
//   (0212.3456.789a); `formatMAC` converts them for other vendors.

import type { Device, L3InterfaceID, Port } from "../../../core/model";
import { IPv4 } from "../../sim/ipv4";
import { bridgeMAC, macAddress, type MACFormat } from "../../sim/mac";
import { NetworkSimulator, type Delivery, type SimInterface } from "../../sim/network-simulator";
import { NetworkRuntime } from "../../sim/runtime";
import { macSourceOf } from "../dhcp/model";

// MARK: State

/** One learned MAC address of a switch. */
export interface LearnedMAC {
  readonly mac: string;
  readonly vlan: number;
  readonly portID: string;
}

/** One learned ARP entry of a device. */
export interface LearnedARP {
  readonly address: string;
  readonly mac: string;
  readonly interfaceID: L3InterfaceID;
}

interface MACState {
  /** Key "vlan|mac"; a re-learned entry moves to the end (newest port wins). */
  entries: Map<string, LearnedMAC>;
}

interface ARPState {
  /** Key "interface|address". */
  entries: Map<string, LearnedARP>;
  /** Direct neighbours already put in once (so that `clear arp-cache` is not undone). */
  seeded: Set<string>;
}

const macKey = "mac-table";
const arpKey = "arp-table";

function macState(deviceID: string): MACState {
  return NetworkRuntime.state<MACState>(macKey, deviceID, () => ({ entries: new Map() }));
}

function arpState(deviceID: string): ARPState {
  return NetworkRuntime.state<ARPState>(arpKey, deviceID, () => ({ entries: new Map(), seeded: new Set() }));
}

// MARK: MAC addresses

/** The MAC address of a layer-3 interface: that of its port, or the bridge MAC of an SVI. */
export function interfaceMAC(device: Device, interfaceID: L3InterfaceID): string {
  return macAddress(macSourceOf(device, interfaceID), "cisco");
}

/** A MAC in Cisco notation ("0212.3456.789a") in another vendor's notation. */
export function formatMAC(mac: string, format: MACFormat): string {
  const hex = mac.replace(/\./g, "").toLowerCase();
  const pairs = hex.match(/.{2}/g) ?? [];
  switch (format) {
    case "cisco":
      return mac;
    case "windows":
      return pairs.join("-").toUpperCase();
    case "colon":
      return pairs.join(":").toUpperCase();
  }
}

// MARK: Learning

function receivingPort(sim: NetworkSimulator, linkID: string, deviceID: string): Port | null {
  const link = sim.project.links.find((candidate) => candidate.id === linkID);
  if (!link) return null;
  const end = link.a.deviceID === deviceID ? link.a : link.b.deviceID === deviceID ? link.b : null;
  const device = sim.device(deviceID);
  return end && device ? (device.ports.find((port) => port.id === end.portID) ?? null) : null;
}

/** The switch learns `mac` in `vlan` on the port the last cable of `path` ends in. */
function learnMAC(
  sim: NetworkSimulator,
  switchID: string,
  vlan: number,
  mac: string,
  path: { linkID: string; toDevice: string }[],
): void {
  const last = path[path.length - 1];
  if (!last || last.toDevice !== switchID) return;
  const port = receivingPort(sim, last.linkID, switchID);
  if (!port) return;
  const entries = macState(switchID).entries;
  const key = `${vlan}|${mac}`;
  entries.delete(key);
  entries.set(key, { mac, vlan, portID: port.id });
}

function learnARP(device: Device, iface: SimInterface, address: IPv4, mac: string): void {
  if (address.equals(iface.prefix.address)) return;
  const entries = arpState(device.id).entries;
  const key = `${iface.id}|${address.description}`;
  entries.delete(key);
  entries.set(key, { address: address.description, mac, interfaceID: iface.id });
}

/**
 * Learns from a followed packet: one hop per entry of `delivery.hops`. Called by the
 * simulation feature (sim.ts) after every packet.
 */
export function learn(sim: NetworkSimulator, delivery: Delivery): void {
  for (let index = 0; index < delivery.hops.length; index++) {
    const segment = delivery.segments[index];
    const receiverID = delivery.devices[index];
    const hop = delivery.hops[index];
    if (!segment || receiverID === undefined || hop === undefined) continue;
    const to = sim.interfacesOf(receiverID).find((iface) => iface.prefix.address.equals(hop));
    const from = to ? sim.interfacesOf(segment.fromDevice).find((iface) => iface.domain === to.domain) : undefined;
    const sender = sim.device(segment.fromDevice);
    const receiver = sim.device(receiverID);
    if (!to || !from || !sender || !receiver || sender.id === receiver.id) continue;
    const fromMAC = interfaceMAC(sender, from.id);
    const toMAC = interfaceMAC(receiver, to.id);

    learnARP(sender, from, hop, toMAC);
    learnARP(receiver, to, from.prefix.address, fromMAC);

    const bridges = sim.bridgesInDomain(to.domain);
    // The broadcast request reaches every switch of the domain ...
    for (const bridge of bridges) {
      learnMAC(sim, bridge.deviceID, bridge.vlan, fromMAC, sim.framePath(from, bridge));
    }
    // ... the unicast reply only the switches on the way back.
    const onPath = new Set(segment.links.flatMap((step) => [step.fromDevice, step.toDevice]));
    for (const bridge of bridges) {
      if (onPath.has(bridge.deviceID)) {
        learnMAC(sim, bridge.deviceID, bridge.vlan, toMAC, sim.framePath(to, bridge));
      }
    }
  }
}

// MARK: Views

export type MACType = "DYNAMIC";

export interface MACRow {
  readonly vlan: number;
  /** Cisco notation. */
  readonly mac: string;
  readonly type: MACType;
  readonly port: Port;
}

export function isSwitch(device: Device | null | undefined): device is Device {
  return !!device && NetworkSimulator.isSwitching(device.category);
}

/** The MAC address table of a switch, ascending by VLAN, then MAC. Empty for other devices. */
export function macTable(sim: NetworkSimulator, deviceID: string): MACRow[] {
  const device = sim.device(deviceID);
  if (!isSwitch(device)) return [];
  const rows: MACRow[] = [];
  for (const entry of macState(deviceID).entries.values()) {
    const port = device.ports.find((candidate) => candidate.id === entry.portID);
    if (!port || !sim.isLinkUp(device, port)) continue;
    rows.push({ vlan: entry.vlan, mac: entry.mac, type: "DYNAMIC", port });
  }
  return rows.sort((a, b) => a.vlan - b.vlan || (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0));
}

/** `clear mac address-table dynamic`: all entries, or only those of a VLAN / port. */
export function clearMacTable(deviceID: string, filter: { vlan?: number; portIDs?: Set<string> } = {}): void {
  const entries = macState(deviceID).entries;
  for (const [key, entry] of [...entries]) {
    if (filter.vlan !== undefined && entry.vlan !== filter.vlan) continue;
    if (filter.portIDs && !filter.portIDs.has(entry.portID)) continue;
    entries.delete(key);
  }
}

export type ARPKind = "own" | "dynamic";

export interface ARPRow {
  readonly address: IPv4;
  /** Cisco notation. */
  readonly mac: string;
  readonly interfaceID: L3InterfaceID;
  /** "own": the address of the device's own interface (Cisco prints "-" as the age). */
  readonly kind: ARPKind;
}

/** The direct neighbours of a device: its routed port, the far end's routed port and address. */
function directNeighbours(sim: NetworkSimulator, device: Device): { iface: SimInterface; peer: SimInterface }[] {
  const result: { iface: SimInterface; peer: SimInterface }[] = [];
  for (const iface of sim.interfacesOf(device.id)) {
    if (!iface.id.startsWith("port:")) continue;
    const far = sim.peer(device.id, iface.id.slice(5));
    if (!far || !NetworkSimulator.isRouted(far.port, far.device)) continue;
    const peer = sim.interfacesOf(far.device.id).find((candidate) => candidate.id === `port:${far.port.id}`);
    if (peer && peer.domain === iface.domain) result.push({ iface, peer });
  }
  return result;
}

function seedNeighbours(sim: NetworkSimulator, device: Device): void {
  const state = arpState(device.id);
  for (const { iface, peer } of directNeighbours(sim, device)) {
    const key = `${iface.id}|${peer.deviceID}|${peer.id}`;
    if (state.seeded.has(key)) continue;
    state.seeded.add(key);
    const owner = sim.device(peer.deviceID);
    if (owner) learnARP(device, iface, peer.prefix.address, interfaceMAC(owner, peer.id));
  }
}

/** The ARP table of any device: its own interfaces first, then the learned entries (oldest first). */
export function arpTable(sim: NetworkSimulator, deviceID: string): ARPRow[] {
  const device = sim.device(deviceID);
  if (!device) return [];
  seedNeighbours(sim, device);
  const own = sim.interfacesOf(deviceID);
  const rows: ARPRow[] = own.map((iface) => ({
    address: iface.prefix.address,
    mac: interfaceMAC(device, iface.id),
    interfaceID: iface.id,
    kind: "own",
  }));
  for (const entry of arpState(deviceID).entries.values()) {
    const iface = own.find((candidate) => candidate.id === entry.interfaceID);
    const address = IPv4.parse(entry.address);
    if (!iface || !address || !iface.prefix.contains(address)) continue;
    rows.push({ address, mac: entry.mac, interfaceID: entry.interfaceID, kind: "dynamic" });
  }
  return rows;
}

/** `clear arp-cache`: the learned entries of a device (its own addresses stay). */
export function clearArpCache(deviceID: string): void {
  arpState(deviceID).entries.clear();
}
