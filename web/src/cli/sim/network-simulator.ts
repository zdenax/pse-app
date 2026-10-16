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
// Beyond the Swift original (web version only), the features in src/cli/features hook into it
// (see sim/packet.ts): dynamic routes (OSPF, RIP), packet filters (ACL, firewall), address
// translation (NAT), DHCP, spanning tree and link aggregation. Without any protocol configured
// the results are exactly those of the Swift app.
//
// What it does not model: MAC learning and flooding (only reachability and the path).
// It is rebuilt from the project for every command, so it always matches the diagram.
// It reads only the Project (never the store); run-time state lives in sim/runtime.ts.

import type { Device, DeviceCategory, L3InterfaceID, Link, Port, Project } from "../../core/model";
import { simFeatures } from "../features/sim-features";
import { SwitchportConfig } from "../switchport";
import { IPv4, IPv4Prefix } from "./ipv4";
import type { HopContext, Packet, PacketLinkStep, PacketSegment, SimFeature, Verdict } from "./packet";

/** One addressed, working layer-3 interface (NetworkSimulator.Interface in Swift). */
export interface SimInterface {
  readonly deviceID: string;
  readonly id: L3InterfaceID;
  readonly prefix: IPv4Prefix;
  /** The layer-2 domain the interface sits in. */
  readonly domain: number;
  readonly name: string;
  /** The layer-2 node of the interface (internal: the start and end of packet paths). */
  readonly node: string;
}

/** "dynamic": learned by a routing protocol (see `SimRoute.protocol`). */
export type RouteKind = "connected" | "local" | "staticRoute" | "dynamic";

/** One entry of a routing table (NetworkSimulator.Route in Swift). */
export interface SimRoute {
  readonly destination: IPv4Prefix;
  readonly kind: RouteKind;
  /** Next hop of a static route; null for connected networks. */
  readonly nextHop: IPv4 | null;
  readonly interface: SimInterface;
  /** Administrative distance: 0 connected/local, 1 static, 110 OSPF, 120 RIP. */
  readonly distance: number;
  readonly metric: number;
  /** "ospf", "rip" for dynamic routes. */
  readonly protocol?: string;
  /** The code of `show ip route` for dynamic routes ("O", "O IA", "O*E2", "R"). */
  readonly code?: string;
}

/** Why a packet did not arrive (NetworkSimulator.Failure in Swift). */
export type SimFailure =
  /** The device has no route to the destination. */
  | { readonly kind: "noRoute"; readonly deviceID: string }
  /** The next hop (or the destination on a connected network) does not answer ARP. */
  | { readonly kind: "unreachableNextHop"; readonly deviceID: string; readonly nextHop: IPv4 }
  /** A PC, server or layer-2 switch got a packet that is not for it. */
  | { readonly kind: "notForwarding"; readonly deviceID: string }
  | { readonly kind: "ttlExceeded" }
  /** A feature dropped the packet (ACL, firewall, NAT without a translation, ...). */
  | {
      readonly kind: "dropped";
      readonly deviceID: string;
      /** A complete Czech sentence. */
      readonly reason: string;
      /** What Cisco ping prints for it: "U" (unreachable sent back), "." or "A". */
      readonly symbol: "U" | "." | "A";
      readonly feature: string;
    }
  /** The layer-2 network on the way does not work (a loop without STP, ...). */
  | { readonly kind: "layer2"; readonly deviceID: string; readonly reason: string };

export class Delivery {
  /** The addresses at which the packet entered each next device, the last one being the destination. */
  hops: IPv4[];
  failure: SimFailure | null;
  /** The devices the packet entered, parallel to `hops`. */
  devices: string[] = [];
  /** The cables crossed between the layer-3 devices, one segment per hop (animation, timing). */
  segments: PacketSegment[] = [];
  /** The packet as it arrived (after NAT); null when it did not arrive. */
  packet: Packet | null = null;

  constructor(hops: IPv4[] = [], failure: SimFailure | null = null) {
    this.hops = hops;
    this.failure = failure;
  }

  /** The device where the packet stopped: the destination, or where it was dropped. */
  get lastDevice(): string | null {
    return this.devices.length > 0 ? this.devices[this.devices.length - 1] : null;
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

/** One cable end as the packet path sees it. */
interface Edge {
  readonly to: Node;
  readonly linkID: string;
  readonly fromDevice: string;
  readonly toDevice: string;
  readonly fromPort: string;
  readonly toPort: string;
  /** VLAN of the bridge at each end; null for a routed port. */
  readonly fromVLAN: number | null;
  readonly toVLAN: number | null;
}

function nodeVLAN(node: Node): number | null {
  if (!node.startsWith("bridge|")) return null;
  return Number(node.slice(node.lastIndexOf("|") + 1));
}

function nodeDevice(node: Node): string {
  const first = node.indexOf("|");
  const second = node.indexOf("|", first + 1);
  return node.slice(first + 1, second);
}

export class NetworkSimulator {
  readonly project: Project;
  /** The features hooked into this simulation (src/cli/features/sim-features.ts). */
  readonly features: readonly SimFeature[];
  private readonly allInterfaces: SimInterface[] = [];
  private readonly devicesByID = new Map<string, Device>();
  private readonly interfacesByDevice = new Map<string, SimInterface[]>();
  /** The first device with each id (what `Project.resolve` finds). */
  private readonly firstDeviceByID = new Map<string, Device>();
  /** The first cable plugged into each port (what `Project.link(at:)` finds). */
  private readonly linkAtPort = new Map<string, Link>();
  /** Ports that are operationally down for a feature, with the reason. */
  private readonly downPorts = new Map<string, string>();
  private readonly domains = new Domains();
  private readonly domainIDs = new Map<Node, number>();
  private readonly edges = new Map<Node, Edge[]>();
  private readonly routeCache = new Map<string, SimRoute[]>();

  constructor(project: Project, features: readonly SimFeature[] = simFeatures) {
    this.project = project;
    this.features = features;
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
    for (const feature of features) {
      if (!feature.portDown) continue;
      for (const device of project.devices) {
        for (const port of device.ports) {
          const key = refKey(device.id, port.id);
          if (this.downPorts.has(key)) continue;
          const reason = feature.portDown(project, device, port);
          if (reason !== null) this.downPorts.set(key, reason);
        }
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

  static isRouted(port: Port, device: Device): boolean {
    return !NetworkSimulator.isSwitching(device.category) || port.connector === "mgmt";
  }

  /** Why a port is operationally down for a feature (LACP suspended, err-disabled), or null. */
  portDownReason(deviceID: string, portID: string): string | null {
    return this.downPorts.get(refKey(deviceID, portID)) ?? null;
  }

  /** What a port puts on its cable, and where each channel leads inside the device. */
  private channels(port: Port, device: Device, vlans: Set<number>): Map<Channel, Node> {
    const result = new Map<Channel, Node>();
    if (port.connector === "console" || port.adminDown) return result;
    if (this.downPorts.has(refKey(device.id, port.id))) return result;
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

  /** The cables a frame crosses between two layer-2 nodes (interfaces); empty when none or the same. */
  framePath(from: { node: string }, to: { node: string }): PacketLinkStep[] {
    return this.layer2Path(from.node, to.node);
  }

  /**
   * The switches (and their VLAN numbers) that bridge layer-2 domain `domain`: the places a
   * broadcast of that domain reaches. Empty when no switch is in it.
   */
  bridgesInDomain(domain: number): { deviceID: string; vlan: number; node: string }[] {
    const result: { deviceID: string; vlan: number; node: string }[] = [];
    const vlans = this.knownVLANs();
    for (const device of this.project.devices) {
      if (!NetworkSimulator.isSwitching(device.category)) continue;
      for (const vlan of vlans) {
        if (this.domainOfBridge(device.id, vlan) === domain) {
          result.push({ deviceID: device.id, vlan, node: bridgeNode(device.id, vlan) });
        }
      }
    }
    return result;
  }

  /** The device and port at the other end of the cable plugged into the port. */
  peer(deviceID: string, portID: string): { device: Device; port: Port; link: Link } | null {
    const link = this.linkAtPort.get(refKey(deviceID, portID));
    if (!link) return null;
    const far = link.a.deviceID === deviceID && link.a.portID === portID ? link.b : link.a;
    const device = this.firstDeviceByID.get(far.deviceID);
    if (!device) return null;
    const port = device.ports.find((candidate) => candidate.id === far.portID);
    return port ? { device, port, link } : null;
  }

  /** True when the port has a cable whose far end is not shut down (nor down for a feature). */
  isLinkUp(device: Device, port: Port): boolean {
    if (port.adminDown || this.downPorts.has(refKey(device.id, port.id))) return false;
    const peer = this.peer(device.id, port.id);
    return peer !== null && !peer.port.adminDown && !this.downPorts.has(refKey(peer.device.id, peer.port.id));
  }

  private domainID(node: Node): number {
    const root = this.domains.find(node);
    const known = this.domainIDs.get(root);
    if (known !== undefined) return known;
    const id = this.domainIDs.size;
    this.domainIDs.set(root, id);
    return id;
  }

  /** The layer-2 domain of VLAN `vlan` inside a switch. */
  domainOfBridge(deviceID: string, vlan: number): number {
    return this.domainID(bridgeNode(deviceID, vlan));
  }

  /** The layer-2 domain a routed port (router, PC, management port) sits in. */
  domainOfPort(deviceID: string, portID: string): number {
    return this.domainID(portNode(deviceID, portID));
  }

  private addEdge(from: Node, to: Node, link: Link, fromPort: string, toPort: string): void {
    const list = this.edges.get(from) ?? [];
    list.push({
      to,
      linkID: link.id,
      fromDevice: nodeDevice(from),
      toDevice: nodeDevice(to),
      fromPort,
      toPort,
      fromVLAN: nodeVLAN(from),
      toVLAN: nodeVLAN(to),
    });
    this.edges.set(from, list);
  }

  private buildInterfaces(): void {
    const vlans = this.knownVLANs();
    const domains = this.domains;
    const channelMaps = new Map<string, Map<Channel, Node>>();
    for (const device of this.project.devices) {
      for (const port of device.ports) {
        channelMaps.set(refKey(device.id, port.id), this.channels(port, device, vlans));
      }
    }
    for (const link of this.project.links) {
      const a = channelMaps.get(refKey(link.a.deviceID, link.a.portID));
      const b = channelMaps.get(refKey(link.b.deviceID, link.b.portID));
      if (!a || !b) continue;
      for (const [channel, nodeA] of a) {
        const nodeB = b.get(channel);
        if (nodeB !== undefined) {
          domains.union(nodeA, nodeB);
          this.addEdge(nodeA, nodeB, link, link.a.portID, link.b.portID);
          this.addEdge(nodeB, nodeA, link, link.b.portID, link.a.portID);
        }
      }
    }

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
          const node = portNode(device.id, port.id);
          list.push({
            deviceID: device.id,
            id: entry.interface,
            prefix,
            domain: this.domainID(node),
            name: port.name,
            node,
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
          list.push({
            deviceID: device.id,
            id: entry.interface,
            prefix,
            domain: this.domainID(bridge),
            name: `Vlan${number}`,
            node: bridge,
          });
        }
      }
      this.interfacesByDevice.set(device.id, list);
      this.allInterfaces.push(...list);
    }
  }

  /** Whether a feature (spanning tree) blocks the cable end for its VLAN. */
  private forwards(deviceID: string, portID: string, vlan: number | null): boolean {
    const device = this.devicesByID.get(deviceID);
    const port = device ? findPort(device, portID) : undefined;
    if (!device || !port) return true;
    for (const feature of this.features) {
      if (feature.portForwards && !feature.portForwards(this, device, port, vlan)) return false;
    }
    return true;
  }

  /**
   * The cables a frame crosses from one layer-2 node to another (breadth first, so the fewest
   * cables), avoiding ports a feature blocks; ignoring the blocking when that finds no way.
   */
  private layer2Path(from: Node, to: Node): PacketLinkStep[] {
    const search = (respectBlocking: boolean): PacketLinkStep[] | null => {
      if (from === to) return [];
      const previous = new Map<Node, { node: Node; edge: Edge }>();
      const queue: Node[] = [from];
      const seen = new Set<Node>([from]);
      while (queue.length > 0) {
        const node = queue.shift() as Node;
        for (const edge of this.edges.get(node) ?? []) {
          if (seen.has(edge.to)) continue;
          if (
            respectBlocking &&
            (!this.forwards(edge.fromDevice, edge.fromPort, edge.fromVLAN) ||
              !this.forwards(edge.toDevice, edge.toPort, edge.toVLAN))
          ) {
            continue;
          }
          seen.add(edge.to);
          previous.set(edge.to, { node, edge });
          if (edge.to === to) {
            const steps: PacketLinkStep[] = [];
            let current: Node = to;
            while (current !== from) {
              const step = previous.get(current);
              if (!step) break;
              steps.unshift({ linkID: step.edge.linkID, fromDevice: step.edge.fromDevice, toDevice: step.edge.toDevice });
              current = step.node;
            }
            return steps;
          }
          queue.push(edge.to);
        }
      }
      return null;
    };
    return search(true) ?? search(false) ?? [];
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
   * Connected networks, then static routes and the default gateway whose next hop lies on a
   * connected network (the routing table of the Swift app).
   */
  baseRoutes(deviceID: string): SimRoute[] {
    const device = this.devicesByID.get(deviceID);
    if (!device) return [];
    const own = this.interfacesOf(deviceID);
    const routes: SimRoute[] = [];
    for (const iface of own) {
      routes.push({
        destination: iface.prefix.networkPrefix,
        kind: "connected",
        nextHop: null,
        interface: iface,
        distance: 0,
        metric: 0,
      });
      routes.push({
        destination: new IPv4Prefix(iface.prefix.address, 32),
        kind: "local",
        nextHop: null,
        interface: iface,
        distance: 0,
        metric: 0,
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
      routes.push({
        destination: destination.networkPrefix,
        kind: "staticRoute",
        nextHop: hop,
        interface: iface,
        distance: 1,
        metric: 0,
      });
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
          distance: 1,
          metric: 0,
        });
      }
    }
    return routes;
  }

  /**
   * The routing table of a device: `baseRoutes`, then the routes of the routing protocols
   * that win by administrative distance (a dynamic route is left out when a connected or
   * static route to the same network has a lower distance; among dynamic routes to one network
   * those with the lowest distance stay).
   */
  routes(deviceID: string): SimRoute[] {
    const cached = this.routeCache.get(deviceID);
    if (cached) return cached;
    const base = this.baseRoutes(deviceID);
    const dynamic: SimRoute[] = [];
    for (const feature of this.features) {
      if (feature.routes) dynamic.push(...feature.routes(this, deviceID));
    }
    const key = (route: SimRoute): string => route.destination.description;
    const best = new Map<string, number>();
    for (const route of [...base, ...dynamic]) {
      const known = best.get(key(route));
      if (known === undefined || route.distance < known) best.set(key(route), route.distance);
    }
    const result = [...base, ...dynamic.filter((route) => route.distance <= (best.get(key(route)) ?? route.distance))];
    this.routeCache.set(deviceID, result);
    return result;
  }

  /** Longest-prefix match. */
  lookup(destination: IPv4, deviceID: string): SimRoute | null {
    return firstMax(
      this.routes(deviceID).filter((route) => route.destination.contains(destination)),
      (route) => route.destination.length,
    );
  }

  /** The interface that owns `address` in the layer-2 domain `domain` (ARP), or answers for it. */
  owner(address: IPv4, domain: number): SimInterface | null {
    const own = this.allInterfaces.find((iface) => iface.domain === domain && iface.prefix.address.equals(address));
    if (own) return own;
    for (const feature of this.features) {
      const deviceID = feature.answers?.(this, address, domain) ?? null;
      if (deviceID === null) continue;
      const iface = this.interfacesOf(deviceID).find((candidate) => candidate.domain === domain);
      if (iface) return iface;
    }
    return null;
  }

  owns(deviceID: string, address: IPv4): boolean {
    return this.interfacesOf(deviceID).some((iface) => iface.prefix.address.equals(address));
  }

  /** An ICMP echo request (or reply) from `source` to `destination`. */
  static echo(source: IPv4, destination: IPv4, reply = false): Packet {
    return {
      source,
      destination,
      protocol: "icmp",
      icmpType: reply ? "echo-reply" : "echo",
      sourcePort: 0,
      destinationPort: 0,
      ttl: 255,
    };
  }

  /** Runs the hooks of one stage; the first drop wins. */
  private apply(
    stage: "inbound" | "outbound" | "local",
    context: HopContext,
    packet: Packet,
  ): { packet: Packet; drop: SimFailure | null } {
    const features = stage === "outbound" ? [...this.features].reverse() : this.features;
    let current = packet;
    for (const feature of features) {
      const hook = feature[stage];
      if (!hook) continue;
      const verdict: Verdict = hook.call(feature, context, current);
      if (verdict.kind === "drop") {
        return {
          packet: current,
          drop: {
            kind: "dropped",
            deviceID: context.deviceID,
            reason: verdict.reason,
            symbol: verdict.symbol,
            feature: verdict.feature,
          },
        };
      }
      current = verdict.packet;
    }
    return { packet: current, drop: null };
  }

  private domainProblem(domain: number): string | null {
    for (const feature of this.features) {
      const problem = feature.domainProblem?.(this, domain) ?? null;
      if (problem !== null) return problem;
    }
    return null;
  }

  /** Follows an ICMP echo from `deviceID` to `destination`, hop by hop. */
  deliver(from: string, to: IPv4): Delivery {
    const source = this.sourceAddress(from, to) ?? new IPv4(0);
    return this.deliverPacket(from, NetworkSimulator.echo(source, to));
  }

  /** Follows a packet from `from` through the features and the routing tables. */
  deliverPacket(from: string, sent: Packet): Delivery {
    const delivery = this.followPacket(from, sent);
    for (const feature of this.features) feature.delivered?.(this, from, delivery);
    return delivery;
  }

  private followPacket(from: string, sent: Packet): Delivery {
    const delivery = new Delivery();
    let packet = sent;
    let current = from;
    let ingress: SimInterface | null = null;
    for (let step = 0; step < 32; step++) {
      const base = { sim: this, deviceID: current, ingress, origin: from };
      if (ingress !== null) {
        const inbound = this.apply("inbound", { ...base, egress: null, route: null }, packet);
        packet = inbound.packet;
        if (inbound.drop) {
          delivery.failure = inbound.drop;
          return delivery;
        }
      }
      if (this.owns(current, packet.destination)) {
        if (ingress !== null) {
          const local = this.apply("local", { ...base, egress: null, route: null }, packet);
          packet = local.packet;
          if (local.drop) {
            delivery.failure = local.drop;
            return delivery;
          }
        }
        delivery.packet = packet;
        return delivery;
      }
      if (current !== from) {
        const device = this.devicesByID.get(current);
        if (device && !NetworkSimulator.isForwarding(device.category)) {
          delivery.failure = { kind: "notForwarding", deviceID: current };
          return delivery;
        }
      }
      const route = this.lookup(packet.destination, current);
      if (!route) {
        delivery.failure = { kind: "noRoute", deviceID: current };
        return delivery;
      }
      const outbound = this.apply("outbound", { ...base, egress: route.interface, route }, packet);
      packet = outbound.packet;
      if (outbound.drop) {
        delivery.failure = outbound.drop;
        return delivery;
      }
      const hop = route.nextHop ?? packet.destination;
      const problem = this.domainProblem(route.interface.domain);
      if (problem !== null) {
        delivery.failure = { kind: "layer2", deviceID: current, reason: problem };
        return delivery;
      }
      const next = this.owner(hop, route.interface.domain);
      if (!next) {
        delivery.failure = { kind: "unreachableNextHop", deviceID: current, nextHop: hop };
        return delivery;
      }
      delivery.hops.push(hop);
      delivery.devices.push(next.deviceID);
      delivery.segments.push({
        fromDevice: current,
        toDevice: next.deviceID,
        links: this.layer2Path(route.interface.node, next.node),
      });
      if (next.deviceID !== current) packet = { ...packet, ttl: packet.ttl - 1 };
      current = next.deviceID;
      ingress = next;
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
    const forward = this.deliverPacket(from, NetworkSimulator.echo(source, to));
    if (!forward.delivered) return new PingResult(source, to, forward, null);
    const arrived = forward.packet ?? NetworkSimulator.echo(source, to);
    const target =
      forward.lastDevice ?? this.allInterfaces.find((iface) => iface.prefix.address.equals(to))?.deviceID ?? from;
    // The reply goes from the address the request was sent to back to the address it came from
    // (after NAT, that is the translated one).
    const back = this.deliverPacket(target, NetworkSimulator.echo(arrived.destination, arrived.source, true));
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

  explainFailure(failure: SimFailure, destination: IPv4): string {
    switch (failure.kind) {
      case "noRoute":
        return `${this.name(failure.deviceID)} nemá trasu do sítě s adresou ${destination.description} (chybí statická trasa nebo výchozí brána).`;
      case "unreachableNextHop":
        return `${this.name(failure.deviceID)} nenašel ${failure.nextHop.description} ve své síti (zkontrolujte kabel, shutdown, VLAN a adresy).`;
      case "notForwarding":
        return `${this.name(failure.deviceID)} nesměruje pakety (není router), ale dostal paket pro ${destination.description}.`;
      case "ttlExceeded":
        return "paket koloval ve smyčce tras (TTL vypršelo).";
      case "dropped":
      case "layer2":
        return failure.reason;
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
