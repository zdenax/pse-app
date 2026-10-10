// A static, reachability-level IPv4 simulation of the project
// (port of NetSketchCLI/Simulation/NetworkSimulator.swift).
//
// What it models:
// - Layer 2: every switch (and access point) bridges its ports per VLAN according to the
//   canonical switchport text of each port (`SwitchportConfig`): access ports carry their VLAN
//   untagged, trunks carry the allowed VLANs tagged and the native VLAN untagged. A cable joins
//   what both ends carry; a shut-down port carries nothing. Routers, PCs and servers end the
//   layer-2 domain at each port. Loops do no harm (no STP, no flooding: only reachability).
// - Layer 3: interface addresses, connected networks, static routes and default gateways.
//   Routers and layer-3 switches forward packets; PCs, servers and layer-2 switches do not.
//   A next hop must exist as an address in the layer-2 domain of the outgoing interface (ARP).
//
// What it does not model: timing, MAC learning, STP, DHCP, dynamic routing, ACLs, NAT.
// It is rebuilt from the project for every command, so it always matches the diagram.
// It reads only the Project (never the store).

import type { Device, DeviceCategory, L3InterfaceID, Link, Port, Project } from "../../core/model";
import { SwitchportConfig } from "../switchport";
import { IPv4, IPv4Prefix } from "./ipv4";

/** One addressed, working layer-3 interface (NetworkSimulator.Interface in Swift). */
export interface SimInterface {
  readonly deviceID: string;
  readonly id: L3InterfaceID;
  readonly prefix: IPv4Prefix;
  /** The layer-2 domain the interface sits in. */
  readonly domain: number;
  readonly name: string;
}

export type RouteKind = "connected" | "local" | "staticRoute";

/** One entry of a routing table (NetworkSimulator.Route in Swift). */
export interface SimRoute {
  readonly destination: IPv4Prefix;
  readonly kind: RouteKind;
  /** Next hop of a static route; null for connected networks. */
  readonly nextHop: IPv4 | null;
  readonly interface: SimInterface;
}

/** Why a packet did not arrive (NetworkSimulator.Failure in Swift). */
export type SimFailure =
  /** The device has no route to the destination. */
  | { readonly kind: "noRoute"; readonly deviceID: string }
  /** The next hop (or the destination on a connected network) does not answer ARP. */
  | { readonly kind: "unreachableNextHop"; readonly deviceID: string; readonly nextHop: IPv4 }
  /** A PC, server or layer-2 switch got a packet that is not for it. */
  | { readonly kind: "notForwarding"; readonly deviceID: string }
  | { readonly kind: "ttlExceeded" };

export class Delivery {
  /** The addresses at which the packet entered each next device, the last one being the destination. */
  hops: IPv4[];
  failure: SimFailure | null;

  constructor(hops: IPv4[] = [], failure: SimFailure | null = null) {
    this.hops = hops;
    this.failure = failure;
  }

  get delivered(): boolean {
    return this.failure === null;
  }
}

export class PingResult {
  readonly source: IPv4 | null;
  readonly destination: IPv4;
  readonly forward: Delivery;
  readonly back: Delivery | null;

  constructor(source: IPv4 | null, destination: IPv4, forward: Delivery, back: Delivery | null) {
    this.source = source;
    this.destination = destination;
    this.forward = forward;
    this.back = back;
  }

  /** The sender has no usable address towards the destination. */
  get noSource(): boolean {
    return this.source === null;
  }

  get success(): boolean {
    return this.forward.delivered && (this.back?.delivered ?? false);
  }

  get hopCount(): number {
    return this.forward.hops.length;
  }
}

// MARK: Layer-2 helpers

/** A layer-2 node: the bridge of one VLAN inside a switch, or a routed port. */
type Node = string;

function bridgeNode(deviceID: string, vlan: number): Node {
  return `bridge|${deviceID}|${vlan}`;
}

function portNode(deviceID: string, portID: string): Node {
  return `port|${deviceID}|${portID}`;
}

/** A channel on a cable: "untagged" or "tagged|N". */
type Channel = string;
const untagged: Channel = "untagged";

function tagged(vlan: number): Channel {
  return `tagged|${vlan}`;
}

function refKey(deviceID: string, portID: string): string {
  return `${deviceID}|${portID}`;
}

/** Union-find over layer-2 nodes. */
class Domains {
  private readonly parent = new Map<Node, Node>();

  find(node: Node): Node {
    let root = node;
    for (;;) {
      const next = this.parent.get(root);
      if (next === undefined || next === root) break;
      root = next;
    }
    let current = node;
    for (;;) {
      const next = this.parent.get(current);
      if (next === undefined || next === root) break;
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  union(a: Node, b: Node): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootA, rootB);
  }
}

type ParsedL3 = { kind: "port"; portID: string } | { kind: "vlan"; number: number };

/** "port:<UUID>" or "vlan:<N>" (1...4094); null for anything else. */
function parseL3(id: L3InterfaceID): ParsedL3 | null {
  if (id.startsWith("port:")) {
    const portID = id.slice(5);
    return portID.length > 0 ? { kind: "port", portID } : null;
  }
  if (id.startsWith("vlan:")) {
    const text = id.slice(5);
    if (!/^[+-]?[0-9]+$/.test(text)) return null;
    const number = Number(text);
    return number >= 1 && number <= 4094 ? { kind: "vlan", number } : null;
  }
  return null;
}

function findPort(device: Device, portID: string): Port | undefined {
  const exact = device.ports.find((port) => port.id === portID);
  if (exact) return exact;
  // UUIDs compare by value in Swift: accept a lower-case spelling as well.
  const upper = portID.toUpperCase();
  return device.ports.find((port) => port.id.toUpperCase() === upper);
}


/** Swift's `max(by:)`: the FIRST element with the greatest key. */
function firstMax<T>(items: readonly T[], key: (item: T) => number): T | null {
  let result: T | null = null;
  let best = 0;
  for (const item of items) {
    const value = key(item);
    if (result === null || value > best) {
      result = item;
      best = value;
    }
  }
  return result;
}

export class NetworkSimulator {
  readonly project: Project;
  private readonly allInterfaces: SimInterface[] = [];
  private readonly devicesByID = new Map<string, Device>();
  private readonly interfacesByDevice = new Map<string, SimInterface[]>();
  /** The first device with each id (what `Project.resolve` finds). */
  private readonly firstDeviceByID = new Map<string, Device>();
  /** The first cable plugged into each port (what `Project.link(at:)` finds). */
  private readonly linkAtPort = new Map<string, Link>();

  constructor(project: Project) {
    this.project = project;
    for (const device of project.devices) {
      this.devicesByID.set(device.id, device);
      if (!this.firstDeviceByID.has(device.id)) this.firstDeviceByID.set(device.id, device);
    }
    for (const link of project.links) {
      for (const end of [link.a, link.b]) {
        const key = refKey(end.deviceID, end.portID);
        if (!this.linkAtPort.has(key)) this.linkAtPort.set(key, link);
      }
    }
    this.buildInterfaces();
  }

  /** Every addressed, working layer-3 interface of the project, in device order. */
  get interfaces(): SimInterface[] {
    return this.allInterfaces;
  }

  // MARK: Device roles

  static isSwitching(category: DeviceCategory): boolean {
    return category === "switch" || category === "L3 switch" || category === "AP";
  }

  static isForwarding(category: DeviceCategory): boolean {
    return category === "router" || category === "L3 switch";
  }

  // MARK: Layer 2

  private static isRouted(port: Port, device: Device): boolean {
    return !NetworkSimulator.isSwitching(device.category) || port.connector === "mgmt";
  }

  /** What a port puts on its cable, and where each channel leads inside the device. */
  private static channels(port: Port, device: Device, vlans: Set<number>): Map<Channel, Node> {
    const result = new Map<Channel, Node>();
    if (port.connector === "console" || port.adminDown) return result;
    if (NetworkSimulator.isRouted(port, device)) {
      result.set(untagged, portNode(device.id, port.id));
      return result;
    }
    const config = SwitchportConfig.parse(port.vlan) ?? new SwitchportConfig();
    if (config.mode === "trunk") {
      if (config.allows(config.nativeVLAN)) result.set(untagged, bridgeNode(device.id, config.nativeVLAN));
      const carried: Iterable<number> = config.allowedVLANs ?? vlans;
      for (const vlan of carried) {
        if (vlan !== config.nativeVLAN) result.set(tagged(vlan), bridgeNode(device.id, vlan));
      }
      return result;
    }
    // access or not set
    result.set(untagged, bridgeNode(device.id, config.accessVLAN));
    return result;
  }

  /** The VLAN numbers that occur anywhere: what an unrestricted trunk has to carry. */
  private knownVLANs(): Set<number> {
    const vlans = new Set<number>([1]);
    for (const device of this.project.devices) {
      for (const entry of device.vlans) vlans.add(entry.id);
      for (const address of device.addresses) {
        const parsed = parseL3(address.interface);
        if (parsed?.kind === "vlan") vlans.add(parsed.number);
      }
      for (const port of device.ports) {
        const config = SwitchportConfig.parse(port.vlan);
        if (!config) continue;
        vlans.add(config.accessVLAN);
        vlans.add(config.nativeVLAN);
        for (const vlan of config.allowedVLANs ?? []) vlans.add(vlan);
      }
    }
    return vlans;
  }

  /** The device and port at the other end of the cable plugged into the port. */
  private peer(deviceID: string, portID: string): { device: Device; port: Port } | null {
    const link = this.linkAtPort.get(refKey(deviceID, portID));
    if (!link) return null;
    const far = link.a.deviceID === deviceID && link.a.portID === portID ? link.b : link.a;
    const device = this.firstDeviceByID.get(far.deviceID);
    if (!device) return null;
    const port = device.ports.find((candidate) => candidate.id === far.portID);
    return port ? { device, port } : null;
  }

  /** True when the port has a cable whose far end is not shut down. */
  private isLinkUp(device: Device, port: Port): boolean {
    if (port.adminDown) return false;
    const peer = this.peer(device.id, port.id);
    return peer !== null && !peer.port.adminDown;
  }

  private buildInterfaces(): void {
    const vlans = this.knownVLANs();
    const domains = new Domains();
    const channelMaps = new Map<string, Map<Channel, Node>>();
    for (const device of this.project.devices) {
      for (const port of device.ports) {
        channelMaps.set(refKey(device.id, port.id), NetworkSimulator.channels(port, device, vlans));
      }
    }
    for (const link of this.project.links) {
      const a = channelMaps.get(refKey(link.a.deviceID, link.a.portID));
      const b = channelMaps.get(refKey(link.b.deviceID, link.b.portID));
      if (!a || !b) continue;
      for (const [channel, nodeA] of a) {
        const nodeB = b.get(channel);
        if (nodeB !== undefined) domains.union(nodeA, nodeB);
      }
    }

    const domainIDs = new Map<Node, number>();
    const domainID = (node: Node): number => {
      const root = domains.find(node);
      const known = domainIDs.get(root);
      if (known !== undefined) return known;
      const id = domainIDs.size;
      domainIDs.set(root, id);
      return id;
    };

    for (const device of this.project.devices) {
      const list: SimInterface[] = [];
      for (const entry of device.addresses) {
        const prefix = IPv4Prefix.fromCIDR(entry.address);
        if (!prefix) continue;
        const parsed = parseL3(entry.interface);
        if (!parsed) continue;
        if (parsed.kind === "port") {
          const port = findPort(device, parsed.portID);
          if (!port || !NetworkSimulator.isRouted(port, device) || !this.isLinkUp(device, port)) continue;
          list.push({
            deviceID: device.id,
            id: entry.interface,
            prefix,
            domain: domainID(portNode(device.id, port.id)),
            name: port.name,
          });
        } else {
          const number = parsed.number;
          if (!NetworkSimulator.isSwitching(device.category)) continue;
          // Like a Cisco SVI: up while at least one cabled port carries the VLAN.
          const bridge = bridgeNode(device.id, number);
          const carried = device.ports.some((port) => {
            if (!this.isLinkUp(device, port)) return false;
            const map = channelMaps.get(refKey(device.id, port.id));
            if (!map) return false;
            for (const node of map.values()) if (node === bridge) return true;
            return false;
          });
          if (!carried) continue;
          list.push({ deviceID: device.id, id: entry.interface, prefix, domain: domainID(bridge), name: `Vlan${number}` });
        }
      }
      this.interfacesByDevice.set(device.id, list);
      this.allInterfaces.push(...list);
    }
  }

  // MARK: Layer 3

  /** The working interfaces of one device (`interfaces(of:)` in Swift). */
  interfacesOf(deviceID: string): SimInterface[] {
    return this.interfacesByDevice.get(deviceID) ?? [];
  }

  device(id: string): Device | null {
    return this.devicesByID.get(id) ?? null;
  }

  /**
   * The routing table of a device: connected networks, then static routes and the default
   * gateway whose next hop lies on a connected network.
   */
  routes(deviceID: string): SimRoute[] {
    const device = this.devicesByID.get(deviceID);
    if (!device) return [];
    const own = this.interfacesOf(deviceID);
    const routes: SimRoute[] = [];
    for (const iface of own) {
      routes.push({ destination: iface.prefix.networkPrefix, kind: "connected", nextHop: null, interface: iface });
      routes.push({
        destination: new IPv4Prefix(iface.prefix.address, 32),
        kind: "local",
        nextHop: null,
        interface: iface,
      });
    }
    const connectedInterface = (hop: IPv4): SimInterface | null =>
      firstMax(
        own.filter((iface) => iface.prefix.contains(hop)),
        (iface) => iface.prefix.length,
      );
    for (const entry of device.staticRoutes) {
      const destination = IPv4Prefix.fromCIDR(entry.destination);
      const hop = IPv4.parse(entry.nextHop);
      if (!destination || !hop) continue;
      const iface = connectedInterface(hop);
      if (!iface) continue;
      routes.push({ destination: destination.networkPrefix, kind: "staticRoute", nextHop: hop, interface: iface });
    }
    const gateway = IPv4.parse(device.defaultGateway ?? "");
    if (gateway) {
      const iface = connectedInterface(gateway);
      if (iface && !routes.some((route) => route.destination.length === 0)) {
        routes.push({
          destination: new IPv4Prefix(new IPv4(0), 0),
          kind: "staticRoute",
          nextHop: gateway,
          interface: iface,
        });
      }
    }
    return routes;
  }

  /** Longest-prefix match. */
  lookup(destination: IPv4, deviceID: string): SimRoute | null {
    return firstMax(
      this.routes(deviceID).filter((route) => route.destination.contains(destination)),
      (route) => route.destination.length,
    );
  }

  /** The interface that owns `address` in the layer-2 domain `domain` (ARP). */
  owner(address: IPv4, domain: number): SimInterface | null {
    return this.allInterfaces.find((iface) => iface.domain === domain && iface.prefix.address.equals(address)) ?? null;
  }

  owns(deviceID: string, address: IPv4): boolean {
    return this.interfacesOf(deviceID).some((iface) => iface.prefix.address.equals(address));
  }

  /** Follows a packet from `deviceID` to `destination`, hop by hop. */
  deliver(from: string, to: IPv4): Delivery {
    const delivery = new Delivery();
    let current = from;
    for (let step = 0; step < 32; step++) {
      if (this.owns(current, to)) return delivery;
      if (current !== from) {
        const device = this.devicesByID.get(current);
        if (device && !NetworkSimulator.isForwarding(device.category)) {
          delivery.failure = { kind: "notForwarding", deviceID: current };
          return delivery;
        }
      }
      const route = this.lookup(to, current);
      if (!route) {
        delivery.failure = { kind: "noRoute", deviceID: current };
        return delivery;
      }
      const hop = route.nextHop ?? to;
      const next = this.owner(hop, route.interface.domain);
      if (!next) {
        delivery.failure = { kind: "unreachableNextHop", deviceID: current, nextHop: hop };
        return delivery;
      }
      delivery.hops.push(next.prefix.address);
      current = next.deviceID;
    }
    delivery.failure = { kind: "ttlExceeded" };
    return delivery;
  }

  /** The address a device sends from towards `destination` (that of the outgoing interface). */
  sourceAddress(deviceID: string, destination: IPv4): IPv4 | null {
    if (this.owns(deviceID, destination)) return destination;
    return this.lookup(destination, deviceID)?.interface.prefix.address ?? null;
  }

  /** An echo request and its reply. */
  ping(from: string, to: IPv4): PingResult {
    const source = this.sourceAddress(from, to);
    if (!source) {
      return new PingResult(null, to, new Delivery([], { kind: "noRoute", deviceID: from }), null);
    }
    const forward = this.deliver(from, to);
    if (!forward.delivered) return new PingResult(source, to, forward, null);
    const target = this.allInterfaces.find((iface) => iface.prefix.address.equals(to))?.deviceID ?? from;
    const back = this.deliver(target, source);
    return new PingResult(source, to, forward, back);
  }

  // MARK: Explanations

  private name(deviceID: string): string {
    return this.devicesByID.get(deviceID)?.hostname ?? "?";
  }

  /** A Czech sentence that says where and why a ping failed ("" when it succeeded). */
  explain(result: PingResult): string {
    if (result.noSource) {
      return (
        `NetSketch: zařízení nemá IP adresu na funkčním rozhraní ani trasu do ${result.destination.description} ` +
        "(chybí adresa, kabel, výchozí brána nebo statická trasa)."
      );
    }
    if (result.forward.failure) {
      return "NetSketch: požadavek nedošel – " + this.explainFailure(result.forward.failure, result.destination);
    }
    if (result.back?.failure) {
      return (
        "NetSketch: požadavek došel, ale odpověď ne – " +
        this.explainFailure(result.back.failure, result.source ?? result.destination)
      );
    }
    return "";
  }

  private explainFailure(failure: SimFailure, destination: IPv4): string {
    switch (failure.kind) {
      case "noRoute":
        return `${this.name(failure.deviceID)} nemá trasu do sítě s adresou ${destination.description} (chybí statická trasa nebo výchozí brána).`;
      case "unreachableNextHop":
        return `${this.name(failure.deviceID)} nenašel ${failure.nextHop.description} ve své síti (zkontrolujte kabel, shutdown, VLAN a adresy).`;
      case "notForwarding":
        return `${this.name(failure.deviceID)} nesměruje pakety (není router), ale dostal paket pro ${destination.description}.`;
      case "ttlExceeded":
        return "paket koloval ve smyčce tras (TTL vypršelo).";
    }
  }
}

// The Swift nested type names, as types: NetworkSimulator.Interface, .Route, .Failure, ...
type RouteKindType = RouteKind;
type DeliveryType = Delivery;
type PingResultType = PingResult;

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace NetworkSimulator {
  export type Interface = SimInterface;
  export type Route = SimRoute;
  export type Failure = SimFailure;
  export type RouteKind = RouteKindType;
  export type Delivery = DeliveryType;
  export type PingResult = PingResultType;
}
