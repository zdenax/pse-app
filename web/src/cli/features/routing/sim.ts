// OSPF and RIP routes in the network simulation (see docs/protokoly/ospf-rip.md).
//
// No packets are exchanged: for the whole project the converged result is computed from the
// configuration and the cabling. Two routers become neighbors when interfaces of both are up,
// sit in one layer-2 domain (a cable, or switches between them), are in one subnet, take part in
// the protocol and are not passive. Shutting a port or removing a cable removes the interface from
// the simulation, so the neighbor, and every route learned through it, disappears.
//
// Simplifications (all documented):
//  OSPF  one process per router, cost = reference bandwidth / bandwidth (or `ip ospf cost`), Dijkstra
//        over the routers (no LSA database, no stub/NSSA areas, no virtual links, no ECMP: one
//        best next hop, ties go to the neighbor with the lower router ID), neighbors only inside
//        one area, DR/BDR chosen by router ID (priority is always 1), inter-area routes ("O IA")
//        are found by the same Dijkstra, whatever the areas on the way.
//  RIP   distance vector computed round by round, metric = hop count (16 = unreachable), split
//        horizon, automatic summarisation at the boundary of a classful network, no timers, no
//        triggered updates, no hold-down.
// Not simulated: redistribution, default-information originate, authentication, filters.

import type { Device } from "../../../core/model";
import type { OSPFConfig, RIPConfig } from "../../../core/protocols";
import { IPv4, IPv4Prefix } from "../../sim/ipv4";
import type { NetworkSimulator, SimInterface, SimRoute } from "../../sim/network-simulator";
import type { SimFeature } from "../../sim/packet";
import { classfulPrefix, isPassive, ospfCost, ospfNetworkMatches } from "./model";

export const ospfDistance = 110;
export const ripDistance = 120;
export const ripInfinity = 16;

// MARK: Views (the converged state, also read by the show commands)

export interface OSPFInterface {
  readonly iface: SimInterface;
  readonly area: number;
  readonly passive: boolean;
  readonly cost: number;
}

export interface OSPFNeighbor {
  readonly deviceID: string;
  readonly routerID: string;
  /** The neighbor's address on the shared network. */
  readonly address: IPv4;
  /** The local interface the neighbor is seen on. */
  readonly iface: SimInterface;
  /** "FULL/DR", "FULL/BDR", "FULL/DROTHER" or "2WAY/DROTHER". */
  readonly state: string;
}

export interface OSPFRouter {
  readonly deviceID: string;
  readonly config: OSPFConfig;
  readonly routerID: string;
  readonly interfaces: OSPFInterface[];
  neighbors: OSPFNeighbor[];
  /** Router IDs of all routers reached by the SPF (`show ip protocols`: routing information sources). */
  sources: string[];
}

export interface RIPInterface {
  readonly iface: SimInterface;
  readonly passive: boolean;
}

export interface RIPSource {
  readonly address: IPv4;
  readonly deviceID: string;
}

export interface RIPRouter {
  readonly deviceID: string;
  readonly config: RIPConfig;
  readonly interfaces: RIPInterface[];
  /** The routers learned from (`show ip protocols`: routing information sources). */
  sources: RIPSource[];
}

export interface RoutingView {
  readonly ospf: Map<string, OSPFRouter>;
  readonly rip: Map<string, RIPRouter>;
  /** Dynamic routes per device. */
  readonly routes: Map<string, SimRoute[]>;
}

const views = new WeakMap<NetworkSimulator, RoutingView>();

export function routingView(sim: NetworkSimulator): RoutingView {
  let view = views.get(sim);
  if (!view) {
    view = computeView(sim);
    views.set(sim, view);
  }
  return view;
}

export const routingSimFeature: SimFeature = {
  name: "routing",
  routes: (sim, deviceID) => routingView(sim).routes.get(deviceID) ?? [],
};

// MARK: Computation

function computeView(sim: NetworkSimulator): RoutingView {
  const view: RoutingView = { ospf: new Map(), rip: new Map(), routes: new Map() };
  const add = (deviceID: string, routes: SimRoute[]): void => {
    if (routes.length > 0) view.routes.set(deviceID, [...(view.routes.get(deviceID) ?? []), ...routes]);
  };
  computeOSPF(sim, view, add);
  computeRIP(sim, view, add);
  return view;
}

type Add = (deviceID: string, routes: SimRoute[]) => void;

function byAddress(a: SimRoute, b: SimRoute): number {
  return a.destination.network.value - b.destination.network.value || a.destination.length - b.destination.length;
}

// MARK: OSPF

function routerIDOf(config: OSPFConfig, interfaces: readonly SimInterface[]): string {
  if (config.routerID !== "") return config.routerID;
  let best: IPv4 | null = null;
  for (const iface of interfaces) {
    if (best === null || iface.prefix.address.value > best.value) best = iface.prefix.address;
  }
  return best === null ? "0.0.0.0" : best.description;
}

function ospfInterfaces(config: OSPFConfig, device: Device, own: readonly SimInterface[]): OSPFInterface[] {
  const result: OSPFInterface[] = [];
  for (const iface of own) {
    const fixed = config.interfaceAreas.find((entry) => entry.interface === iface.id);
    const network = config.networks.find((entry) => ospfNetworkMatches(entry, iface.prefix.address));
    const area = fixed?.area ?? network?.area;
    if (area === undefined) continue;
    result.push({ iface, area, passive: isPassive(config, iface.id), cost: ospfCost(config, device, iface.id) });
  }
  return result;
}

function computeOSPF(sim: NetworkSimulator, view: RoutingView, add: Add): void {
  const routers: OSPFRouter[] = [];
  for (const device of sim.project.devices) {
    const config = device.protocols?.ospf;
    if (!config || view.ospf.has(device.id)) continue;
    const own = sim.interfacesOf(device.id);
    const router: OSPFRouter = {
      deviceID: device.id,
      config,
      routerID: routerIDOf(config, own),
      interfaces: ospfInterfaces(config, device, own),
      neighbors: [],
      sources: [],
    };
    view.ospf.set(device.id, router);
    routers.push(router);
  }

  // Segments: active interfaces of one area, one layer-2 domain and one subnet. DR = highest
  // router ID, BDR = the second (all priorities are 1).
  interface Member {
    readonly router: OSPFRouter;
    readonly entry: OSPFInterface;
  }
  const segments = new Map<string, Member[]>();
  for (const router of routers) {
    for (const entry of router.interfaces) {
      if (entry.passive) continue;
      const key = `${entry.iface.domain}|${entry.area}|${entry.iface.prefix.networkPrefix.description}`;
      segments.set(key, [...(segments.get(key) ?? []), { router, entry }]);
    }
  }
  for (const members of segments.values()) {
    // Routers with the same ID never become neighbors.
    const unique = members.filter((m) => members.filter((o) => o.router.routerID === m.router.routerID).length === 1);
    const ordered = [...unique].sort((a, b) => (IPv4.parse(b.router.routerID)?.value ?? 0) - (IPv4.parse(a.router.routerID)?.value ?? 0));
    const role = (member: Member): string => {
      const index = ordered.indexOf(member);
      return index === 0 ? "DR" : index === 1 ? "BDR" : "DROTHER";
    };
    for (const self of unique) {
      for (const other of unique) {
        if (other.router === self.router) continue;
        const full = role(self) !== "DROTHER" || role(other) !== "DROTHER";
        self.router.neighbors.push({
          deviceID: other.router.deviceID,
          routerID: other.router.routerID,
          address: other.entry.iface.prefix.address,
          iface: self.entry.iface,
          state: `${full ? "FULL" : "2WAY"}/${role(other)}`,
        });
      }
    }
  }
  for (const router of routers) {
    router.neighbors.sort((a, b) => (IPv4.parse(a.routerID)?.value ?? 0) - (IPv4.parse(b.routerID)?.value ?? 0));
  }

  // Dijkstra from every router.
  const byDevice = new Map(routers.map((router) => [router.deviceID, router]));
  const costOf = (router: OSPFRouter, iface: SimInterface): number =>
    router.interfaces.find((entry) => entry.iface === iface)?.cost ?? 1;
  const ridValue = (router: OSPFRouter): number => IPv4.parse(router.routerID)?.value ?? 0;

  for (const source of routers) {
    interface Reach {
      distance: number;
      first: OSPFNeighbor | null;
    }
    const reach = new Map<string, Reach>([[source.deviceID, { distance: 0, first: null }]]);
    const done = new Set<string>();
    for (;;) {
      let current: OSPFRouter | null = null;
      for (const [id, info] of reach) {
        if (done.has(id)) continue;
        const candidate = byDevice.get(id);
        const best = current === null ? null : (reach.get(current.deviceID) as Reach);
        if (candidate && (best === null || info.distance < best.distance)) current = candidate;
      }
      if (current === null) break;
      done.add(current.deviceID);
      const here = reach.get(current.deviceID) as Reach;
      for (const neighbor of current.neighbors) {
        const next = byDevice.get(neighbor.deviceID);
        if (!next || done.has(next.deviceID)) continue;
        const distance = here.distance + costOf(current, neighbor.iface);
        const first = here.first ?? neighbor;
        const known = reach.get(next.deviceID);
        if (
          known === undefined ||
          distance < known.distance ||
          (distance === known.distance && known.first !== null && ridValue(byDevice.get(first.deviceID) as OSPFRouter) < ridValue(byDevice.get(known.first.deviceID) as OSPFRouter))
        ) {
          reach.set(next.deviceID, { distance, first });
        }
      }
    }

    source.sources = routers.filter((target) => target !== source && reach.has(target.deviceID)).map((target) => target.routerID);
    const mine = sim.interfacesOf(source.deviceID);
    const best = new Map<string, SimRoute>();
    for (const target of routers) {
      const info = reach.get(target.deviceID);
      if (target === source || !info || info.first === null) continue;
      for (const entry of target.interfaces) {
        const prefix = entry.iface.prefix.networkPrefix;
        if (mine.some((iface) => iface.prefix.networkPrefix.equals(prefix))) continue;
        const metric = info.distance + entry.cost;
        const known = best.get(prefix.description);
        if (known !== undefined && known.metric <= metric) continue;
        const inArea = source.interfaces.some((own) => own.area === entry.area);
        best.set(prefix.description, {
          destination: prefix,
          kind: "dynamic",
          nextHop: info.first.address,
          interface: info.first.iface,
          distance: ospfDistance,
          metric,
          protocol: "ospf",
          code: inArea ? "O" : "O IA",
        });
      }
    }
    add(source.deviceID, [...best.values()].sort(byAddress));
  }
}

// MARK: RIP

interface RIPEntry {
  prefix: IPv4Prefix;
  metric: number;
  /** null: connected network of an enabled interface. */
  nextHop: IPv4 | null;
  iface: SimInterface;
  learnedFrom: string | null;
}

/** Is this interface enabled for RIP (classful `network` statement or interface list)? */
function ripEnabled(config: RIPConfig, iface: SimInterface): boolean {
  if (config.interfaces.includes(iface.id)) return true;
  const own = classfulPrefix(iface.prefix.address);
  return config.networks.some((text) => {
    const parsed = IPv4.parse(text);
    return parsed !== null && classfulPrefix(parsed).equals(own);
  });
}

function computeRIP(sim: NetworkSimulator, view: RoutingView, add: Add): void {
  const routers: RIPRouter[] = [];
  const tables = new Map<string, Map<string, RIPEntry>>();
  for (const device of sim.project.devices) {
    const config = device.protocols?.rip;
    if (!config || view.rip.has(device.id)) continue;
    const interfaces = sim
      .interfacesOf(device.id)
      .filter((iface) => ripEnabled(config, iface))
      .map((iface) => ({ iface, passive: isPassive(config, iface.id) }));
    const router: RIPRouter = { deviceID: device.id, config, interfaces, sources: [] };
    view.rip.set(device.id, router);
    routers.push(router);
    const table = new Map<string, RIPEntry>();
    for (const entry of interfaces) {
      const prefix = entry.iface.prefix.networkPrefix;
      table.set(prefix.description, { prefix, metric: 0, nextHop: null, iface: entry.iface, learnedFrom: null });
    }
    tables.set(device.id, table);
  }

  /** What `sender` advertises out of `via`: split horizon and automatic summarisation applied. */
  const advertisement = (sender: RIPRouter, via: SimInterface): Map<string, { prefix: IPv4Prefix; metric: number }> => {
    const result = new Map<string, { prefix: IPv4Prefix; metric: number }>();
    const boundary = classfulPrefix(via.prefix.address);
    for (const entry of (tables.get(sender.deviceID) as Map<string, RIPEntry>).values()) {
      if (entry.learnedFrom !== null && entry.iface === via) continue;
      let prefix = entry.prefix;
      const classful = classfulPrefix(prefix.address);
      const summarize = (sender.config.autoSummary || sender.config.version === 1) && !classful.equals(boundary) && prefix.length > classful.length;
      if (summarize) prefix = classful;
      const known = result.get(prefix.description);
      if (known === undefined || entry.metric < known.metric) result.set(prefix.description, { prefix, metric: entry.metric });
    }
    return result;
  };

  const maxRounds = routers.length + ripInfinity;
  for (let round = 0; round < maxRounds; round++) {
    let changed = false;
    for (const sender of routers) {
      for (const out of sender.interfaces) {
        if (out.passive) continue;
        for (const receiver of routers) {
          if (receiver === sender) continue;
          // A RIPv1 receiver hears both versions; a RIPv2 one only version 2.
          if (sender.config.version === 1 && receiver.config.version === 2) continue;
          const incoming = receiver.interfaces.find(
            (entry) => entry.iface.domain === out.iface.domain && entry.iface.prefix.networkPrefix.equals(out.iface.prefix.networkPrefix),
          );
          if (!incoming) continue;
          const table = tables.get(receiver.deviceID) as Map<string, RIPEntry>;
          for (const { prefix, metric } of advertisement(sender, out.iface).values()) {
            const total = metric + 1;
            if (total >= ripInfinity) continue;
            if (sim.interfacesOf(receiver.deviceID).some((own) => own.prefix.networkPrefix.equals(prefix))) continue;
            const known = table.get(prefix.description);
            if (known !== undefined && known.metric <= total) continue;
            table.set(prefix.description, {
              prefix,
              metric: total,
              nextHop: out.iface.prefix.address,
              iface: incoming.iface,
              learnedFrom: sender.deviceID,
            });
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }

  for (const router of routers) {
    const routes: SimRoute[] = [];
    for (const entry of (tables.get(router.deviceID) as Map<string, RIPEntry>).values()) {
      if (entry.nextHop === null || entry.learnedFrom === null) continue;
      if (!router.sources.some((source) => source.address.equals(entry.nextHop))) {
        router.sources.push({ address: entry.nextHop, deviceID: entry.learnedFrom });
      }
      routes.push({
        destination: entry.prefix,
        kind: "dynamic",
        nextHop: entry.nextHop,
        interface: entry.iface,
        distance: ripDistance,
        metric: entry.metric,
        protocol: "rip",
        code: "R",
      });
    }
    add(router.deviceID, routes.sort(byAddress));
  }
}
