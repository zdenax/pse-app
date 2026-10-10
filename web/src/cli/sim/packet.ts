// The packet pipeline of the network simulation: what a feature (ACL, NAT, dynamic routing,
// spanning tree, ...) can hook into. NetworkSimulator calls the hooks of every feature in
// src/cli/features/sim-features.ts.
//
// Order at each device a packet passes (as on a Cisco router):
//   inbound hooks (ingress ACL, NAT outside->inside)  -> local delivery (local hooks: firewall
//   input chain) or forwarding: routing lookup -> outbound hooks in REVERSE feature order
//   (NAT inside->outside, egress ACL) -> ARP of the next hop -> next device.

import type { Device, Port, Project } from "../../core/model";
import type { IPv4 } from "./ipv4";
import type { NetworkSimulator, SimInterface, SimRoute } from "./network-simulator";

export type PacketProtocol = "icmp" | "tcp" | "udp";

/** One IPv4 packet as the simulation follows it. */
export interface Packet {
  readonly source: IPv4;
  readonly destination: IPv4;
  readonly protocol: PacketProtocol;
  /** ICMP: "echo" or "echo-reply"; "" otherwise. */
  readonly icmpType: string;
  /** TCP/UDP ports; 0 for ICMP. */
  readonly sourcePort: number;
  readonly destinationPort: number;
  /** TTL when it left the sender. */
  readonly ttl: number;
}

/** Where the packet is when a hook runs. */
export interface HopContext {
  readonly sim: NetworkSimulator;
  readonly deviceID: string;
  /** The interface it came in on; null on the sending device. */
  readonly ingress: SimInterface | null;
  /** The interface it leaves on; null for inbound and local hooks. */
  readonly egress: SimInterface | null;
  /** The route chosen; null for inbound and local hooks. */
  readonly route: SimRoute | null;
  /** The device that sent the packet originally. */
  readonly origin: string;
}

export type Verdict =
  | { readonly kind: "pass"; readonly packet: Packet }
  /**
   * The packet is dropped. `reason` is a Czech sentence ending with a period (used after
   * "NetSketch: požadavek nedošel – "), `symbol` what Cisco ping prints for it ("U" when the
   * router answers "administratively prohibited", "." when it stays silent).
   */
  | { readonly kind: "drop"; readonly reason: string; readonly symbol: "U" | "." | "A"; readonly feature: string };

export function pass(packet: Packet): Verdict {
  return { kind: "pass", packet };
}

/** A feature of the simulation. Every hook is optional. */
export interface SimFeature {
  readonly name: string;

  /**
   * Layer 1/2: a reason (Czech) why the port is operationally down although cabled and not shut
   * down (LACP suspended member, BPDU guard err-disabled), or null. A down port carries nothing.
   * Gets only the project: it runs while the simulator is being built.
   */
  portDown?(project: Project, device: Device, port: Port): string | null;

  /**
   * Layer 2: false when the port does not forward frames of `vlan` (STP blocking). Used for
   * the path of a packet through switches (animation, `show` outputs); reachability itself is
   * decided by the layer-2 domains, which a correct spanning tree never splits.
   */
  portForwards?(sim: NetworkSimulator, device: Device, port: Port, vlan: number | null): boolean;

  /** Layer 2: a problem of a whole broadcast domain (e.g. a loop without STP), or null. */
  domainProblem?(sim: NetworkSimulator, domain: number): string | null;

  /**
   * Layer 3: routes learned by a dynamic protocol. They are compared with the connected and
   * static routes by administrative distance (`SimRoute.distance`). Use `sim.baseRoutes` here,
   * never `sim.routes` (that would recurse).
   */
  routes?(sim: NetworkSimulator, deviceID: string): SimRoute[];

  /** ARP: the device that answers for `address` in `domain` although no interface has it (NAT). */
  answers?(sim: NetworkSimulator, address: IPv4, domain: number): string | null;

  inbound?(context: HopContext, packet: Packet): Verdict;
  outbound?(context: HopContext, packet: Packet): Verdict;
  /** The packet is for this device. */
  local?(context: HopContext, packet: Packet): Verdict;
}

/** One cable a packet crosses, in the direction it travels. */
export interface PacketLinkStep {
  readonly linkID: string;
  readonly fromDevice: string;
  readonly toDevice: string;
}

/** The way between two layer-3 devices: the cables through the switches in between. */
export interface PacketSegment {
  readonly fromDevice: string;
  readonly toDevice: string;
  readonly links: PacketLinkStep[];
}
