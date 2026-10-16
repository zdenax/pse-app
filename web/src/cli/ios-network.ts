// IPv4 configuration and the network commands (ping, traceroute, show ip route) of the
// IOS-style dialects. Port of IOSNetwork.swift (extension of IOSEngine).
//
// Addresses, routes and the default gateway are stored in the project; ping and traceroute ask
// NetworkSimulator, which follows the drawn cabling.

import { enableDHCPClient } from "./features/dhcp/ios";
import { featureInterfaceLines } from "./features/ios-commands";
import { groupOfPortID, leadPort } from "./features/layer2/etherchannel-store";
import {
  announcePing,
  announceTraceroute,
  ciscoRoundTrip,
  lossNotice,
  planPing,
  planTraceroute,
  tracerouteLossNotice,
  wholeMilliseconds,
} from "./features/realism/timing";
import type { L3InterfaceID, StaticRoute } from "../core/model";
import { leftPadded, padded, ParsedCommand, splitSpaces, splitWords, swiftInt, trimmingTrailingWhitespace } from "./command-tree";
import type { IOSEngine } from "./ios-engine";
import { devicePort, l3Port, l3VLAN, parseL3Interface } from "./model-access";
import { Notices } from "./notices";
import { IPv4, IPv4Prefix } from "./sim/ipv4";
import { NetworkSimulator } from "./sim/network-simulator";

// MARK: Parsing

/** "A.B.C.D M.M.M.M" (IOS) or "A.B.C.D/NN" (Dell OS9, accepted everywhere). */
export function parseAddress(text: string): IPv4Prefix | null {
  return IPv4Prefix.fromWords(splitWords(text));
}

function badAddress(engine: IOSEngine): string {
  return engine.isDell ? "% Error: Invalid IP address." : "% Invalid input detected: bad IP address or mask.";
}

function incomplete(engine: IOSEngine): string {
  return engine.isDell ? "% Error: Incomplete command." : "% Incomplete command.";
}

function samePrefix(a: IPv4Prefix, b: IPv4Prefix): boolean {
  return a.address.value === b.address.value && a.length === b.length;
}

export type L3Result = { kind: "success"; interface: L3InterfaceID } | { kind: "failure"; message: string };

/** The layer-3 interface of the current mode, or a message why there is none. */
export function currentL3Interface(engine: IOSEngine): L3Result {
  const mode = engine.mode;
  switch (mode.kind) {
    case "vlanInterface":
      return { kind: "success", interface: l3VLAN(mode.vlan) };
    case "interface": {
      const ports = engine.selectedPorts();
      if (ports.length === 0) {
        engine.mode = { kind: "globalConfig" };
        return { kind: "failure", message: Notices.interfaceGone };
      }
      if (ports.length !== 1) {
        return { kind: "failure", message: "NetSketch: IP adresu lze nastavit jen jednomu rozhraní, ne rozsahu." };
      }
      const port = ports[0];
      const category = engine.access.category;
      if (category !== null && NetworkSimulator.isSwitching(category) && port.isSwitchport) {
        return { kind: "failure", message: Notices.switchPortHasNoAddress };
      }
      // The address of a port-channel (routers) is kept on its first member.
      const channel = groupOfPortID(port.id);
      if (channel !== null) {
        const device = engine.access.device;
        const lead = device ? leadPort(device, channel) : undefined;
        if (!lead) return { kind: "failure", message: Notices.channelNeedsMember };
        return { kind: "success", interface: l3Port(lead.id) };
      }
      return { kind: "success", interface: l3Port(port.id) };
    }
    default:
      return { kind: "failure", message: "" };
  }
}

// MARK: Interface addresses

export function setIPAddress(engine: IOSEngine, command: ParsedCommand): string {
  const text = command.text("address") ?? "";
  if (text.toLowerCase().startsWith("dhcp")) return enableDHCPClient(engine);
  const prefix = parseAddress(text);
  if (prefix === null) return badAddress(engine);
  if (!prefix.isHostAddress) {
    return engine.isDell ? "% Error: Invalid IP address." : `Bad mask /${prefix.length} for address ${prefix.address.description}`;
  }
  const result = currentL3Interface(engine);
  if (result.kind === "failure") return result.message;
  const interfaceID = result.interface;
  // IOS refuses a second interface in a network that is already connected.
  const overlap = engine.access.addresses.find((entry) => {
    if (entry.interface === interfaceID) return false;
    const other = IPv4Prefix.fromCIDR(entry.address);
    if (other === null) return false;
    return other.contains(prefix.address) || prefix.contains(other.address);
  });
  const other = overlap ? IPv4Prefix.fromCIDR(overlap.address) : null;
  if (overlap && other !== null) {
    return engine.isDell
      ? `% Error: ${other.networkPrefix.description} overlaps with ${l3Name(engine, overlap.interface)}.`
      : `% ${other.network.description} overlaps with ${l3Name(engine, overlap.interface)}`;
  }
  engine.access.setAddress(prefix, interfaceID);
  const owner = engine.access.addressConflict(prefix.address, interfaceID);
  if (owner !== null) return Notices.duplicateAddress(prefix.address.description, owner);
  return "";
}

export function clearIPAddress(engine: IOSEngine): string {
  const result = currentL3Interface(engine);
  if (result.kind === "failure") return result.message;
  engine.access.setAddress(null, result.interface);
  return "";
}

/** The interface name used in messages and listings: "GigabitEthernet0/0/0", "Vlan10". */
export function l3Name(engine: IOSEngine, interfaceID: L3InterfaceID): string {
  const parsed = parseL3Interface(interfaceID);
  if (parsed === null) return "?";
  switch (parsed.kind) {
    case "vlan":
      return engine.isDell ? `Vlan ${parsed.number}` : `Vlan${parsed.number}`;
    case "port": {
      const device = engine.access.device;
      const port = device ? devicePort(device, parsed.id) : null;
      if (port === null) return "?";
      return engine.namer.longName(port.name);
    }
  }
}

// MARK: Routes and gateway

/** `ip route NET MASK NEXTHOP` (IOS) or `ip route NET/NN NEXTHOP` (Dell OS9). */
function parseRoute(text: string): [IPv4Prefix, IPv4] | null {
  const words = splitWords(text);
  if (words.length >= 2) {
    const network = IPv4Prefix.fromCIDR(words[0]);
    const hop = IPv4.parse(words[1]);
    if (network !== null && hop !== null) return [network.networkPrefix, hop];
  }
  if (words.length >= 3) {
    const network = IPv4Prefix.fromAddressMask(words[0], words[1]);
    const hop = IPv4.parse(words[2]);
    if (network !== null && hop !== null) return [network.networkPrefix, hop];
  }
  return null;
}

export function addStaticRoute(engine: IOSEngine, command: ParsedCommand): string {
  const text = command.text("route") ?? "";
  const parsed = parseRoute(text);
  if (parsed === null) {
    if (splitSpaces(text).length < 2) return incomplete(engine);
    return engine.isDell ? "% Error: Invalid route." : "%Inconsistent address and mask";
  }
  const [network, hop] = parsed;
  const route: StaticRoute = { destination: network.description, nextHop: hop.description };
  const routes = engine.access.staticRoutes;
  if (!routes.some((stored) => stored.destination === route.destination && stored.nextHop === route.nextHop)) {
    engine.access.setStaticRoutes([...routes, route]);
  }
  return "";
}

export function removeStaticRoute(engine: IOSEngine, command: ParsedCommand): string {
  const words = splitWords(command.text("route") ?? "");
  let network: IPv4Prefix | null = null;
  let rest: string[] = [];
  const cidr = words.length > 0 ? IPv4Prefix.fromCIDR(words[0]) : null;
  if (cidr !== null) {
    network = cidr.networkPrefix;
    rest = words.slice(1);
  } else if (words.length >= 2) {
    const prefix = IPv4Prefix.fromAddressMask(words[0], words[1]);
    if (prefix !== null) {
      network = prefix.networkPrefix;
      rest = words.slice(2);
    }
  }
  if (network === null) return engine.isDell ? "% Error: Invalid route." : "%Inconsistent address and mask";
  const hop = rest.length > 0 ? IPv4.parse(rest[0]) : null;
  const routes = engine.access.staticRoutes;
  const remaining = routes.filter((route) => {
    const destination = IPv4Prefix.fromCIDR(route.destination);
    if (destination === null || !samePrefix(destination, network!)) return true;
    if (hop !== null) return route.nextHop !== hop.description;
    return false;
  });
  if (remaining.length === routes.length) {
    return engine.isDell ? "% Error: Route not found." : "%No matching route to delete";
  }
  engine.access.setStaticRoutes(remaining);
  return "";
}

export function setDefaultGateway(engine: IOSEngine, command: ParsedCommand): string {
  const gateway = IPv4.parse(command.text("gateway") ?? "");
  if (gateway === null) return badAddress(engine);
  engine.access.setDefaultGateway(gateway);
  return "";
}

export function clearDefaultGateway(engine: IOSEngine): string {
  engine.access.setDefaultGateway(null);
  return "";
}

// MARK: ping and traceroute

export function ping(engine: IOSEngine, command: ParsedCommand): string {
  const dell = engine.isDell;
  const words = splitWords(command.text("target") ?? "");
  const first = words[0];
  if (first === undefined) return incomplete(engine);
  const destination = IPv4.parse(first);
  if (destination === null) {
    return dell ? "% Error: Invalid host address." : "% Unrecognized host or address, or protocol not running.";
  }
  let count = 5;
  const index = words.findIndex((text) => text.toLowerCase() === "repeat" || text.toLowerCase() === "count");
  if (index >= 0 && index + 1 < words.length) {
    const value = swiftInt(words[index + 1]);
    if (value !== null && value >= 1 && value <= 100) count = value;
  }
  const access = engine.access;
  const simulator = access.simulator;
  const result = simulator.ping(access.deviceID, destination);
  const plan = planPing(simulator, access.deviceID, destination, result, count);
  announcePing(access.deviceID, result, plan);
  const failure = result.forward.failure;
  let marks: string;
  if (plan.active) {
    marks = plan.samples.map((sample) => (sample.lost ? "." : "!")).join("");
  } else if (result.success) {
    marks = "!".repeat(count);
  } else if (failure != null && failure.kind === "noRoute" && failure.deviceID !== access.deviceID && !result.noSource) {
    // A router on the way answers "destination unreachable".
    marks = Array.from({ length: count }, (_, position) => (position % 2 === 0 ? "U" : ".")).join("");
  } else {
    marks = ".".repeat(count);
  }
  const received = plan.active ? plan.received : result.success ? count : 0;
  const lines = [
    dell ? "Type Ctrl-C to abort." : "Type escape sequence to abort.",
    `Sending ${count}, 100-byte ICMP Echos to ${destination.description}, timeout is 2 seconds:`,
    marks,
  ];
  const percent = dell ? ((received * 100) / count).toFixed(1) : `${Math.trunc((received * 100) / count)}`;
  if (received > 0) {
    const times = plan.active ? ciscoRoundTrip(plan) : "1/1/1";
    lines.push(`Success rate is ${percent} percent (${received}/${count}), round-trip min/avg/max = ${times} ms`);
  } else {
    lines.push(`Success rate is ${percent} percent (${received}/${count})`);
    const reason = simulator.explain(result);
    if (reason !== "") lines.push(reason);
  }
  const lost = lossNotice(plan);
  if (lost !== "") lines.push(lost);
  return lines.join("\n");
}

export function traceroute(engine: IOSEngine, command: ParsedCommand): string {
  const dell = engine.isDell;
  const words = splitWords(command.text("target") ?? "");
  const first = words[0];
  if (first === undefined) return incomplete(engine);
  const destination = IPv4.parse(first);
  if (destination === null) {
    return dell ? "% Error: Invalid host address." : "% Unrecognized host or address, or protocol not running.";
  }
  const access = engine.access;
  const simulator = access.simulator;
  const delivery = simulator.deliver(access.deviceID, destination);
  const plan = planTraceroute(simulator, access.deviceID, destination, delivery);
  announceTraceroute(access.deviceID, delivery);
  const lines = [
    dell ? "Type Ctrl-C to abort." : "Type escape sequence to abort.",
    `Tracing the route to ${destination.description}`,
    "",
  ];
  delivery.hops.forEach((hop, index) => {
    const probes = plan.active ? plan.hops[index] ?? [] : [];
    if (!plan.active) {
      lines.push(leftPadded(`${index + 1}`, 3) + ` ${hop.description} 0 msec 0 msec 0 msec`);
    } else if (probes.every((probe) => probe.rtt === null)) {
      lines.push(leftPadded(`${index + 1}`, 3) + "  *  *  *");
    } else {
      const times = probes.map((probe) => (probe.rtt === null ? "*" : `${wholeMilliseconds(probe.rtt)} msec`));
      lines.push(leftPadded(`${index + 1}`, 3) + ` ${hop.description} ${times.join(" ")}`);
    }
  });
  if (!delivery.delivered) {
    const next = delivery.hops.length + 1;
    lines.push(leftPadded(`${next}`, 3) + "  *  *  *");
    const result = simulator.ping(access.deviceID, destination);
    const reason = simulator.explain(result);
    if (reason !== "") lines.push(reason);
  }
  const lostNotice = tracerouteLossNotice(plan);
  if (lostNotice !== "") lines.push(lostNotice);
  return lines.join("\n");
}

// MARK: show

export function showIPRoute(engine: IOSEngine, _command: ParsedCommand): string {
  const access = engine.access;
  const routes = access.simulator.routes(access.deviceID);
  const lines: string[] = [];
  if (engine.isDell) {
    lines.push("Codes: C - connected, S - static");
    lines.push("");
    lines.push("  Destination        Gateway                      Dist/Metric Last Change");
    lines.push("  -----------        -------                      ----------- -----------");
    for (const route of routes) {
      if (route.kind === "local") continue;
      const code = route.kind === "connected" ? "C" : "S";
      const gateway =
        route.nextHop != null
          ? `via ${route.nextHop.description}, ${l3Name(engine, route.interface.id)}`
          : `Direct, ${l3Name(engine, route.interface.id)}`;
      const distance = route.kind === "connected" ? "0/0" : "1/0";
      lines.push(
        `${code} ` +
          padded(route.destination.description, 18) +
          " " +
          padded(gateway, 28) +
          " " +
          padded(distance, 11) +
          " 00:00:00",
      );
    }
  } else {
    lines.push("Codes: L - local, C - connected, S - static");
    lines.push("");
    const gateway = routes.find((route) => route.destination.length === 0)?.nextHop ?? null;
    lines.push(
      gateway !== null
        ? `Gateway of last resort is ${gateway.description} to network 0.0.0.0`
        : "Gateway of last resort is not set",
    );
    lines.push("");
    for (const route of routes) {
      switch (route.kind) {
        case "connected":
          lines.push(`C        ${route.destination.description} is directly connected, ${l3Name(engine, route.interface.id)}`);
          break;
        case "local":
          lines.push(`L        ${route.destination.description} is directly connected, ${l3Name(engine, route.interface.id)}`);
          break;
        case "staticRoute": {
          const code = route.destination.length === 0 ? "S*" : "S ";
          lines.push(`${code}       ${route.destination.description} [1/0] via ${route.nextHop?.description ?? "?"}`);
          break;
        }
      }
    }
  }
  const inactive = access.staticRoutes.filter(
    (stored) =>
      !routes.some(
        (route) =>
          route.kind === "staticRoute" &&
          route.destination.description === stored.destination &&
          route.nextHop?.description === stored.nextHop,
      ),
  );
  if (inactive.length > 0) {
    lines.push("");
    lines.push(Notices.inactiveRoutes(inactive.map((route) => `${route.destination} via ${route.nextHop}`)));
  }
  return lines.map((text) => trimmingTrailingWhitespace(text)).join("\n");
}

export interface IPInterfaceRow {
  name: string;
  address: string;
  status: string;
  proto: string;
}

/** Rows of `show ip interface brief`: every physical port and every VLAN interface with an address. */
export function ipInterfaceRows(engine: IOSEngine): IPInterfaceRow[] {
  const access = engine.access;
  const simulator = access.simulator;
  const working = new Set(simulator.interfacesOf(access.deviceID).map((entry) => entry.id));
  const rows: IPInterfaceRow[] = [];
  for (const port of access.interfaces) {
    const address = access.address(l3Port(port.id))?.address.description ?? "unassigned";
    let status: string;
    switch (port.linkState) {
      case "adminDown":
        status = "administratively down";
        break;
      case "up":
        status = "up";
        break;
      case "down":
        status = "down";
        break;
    }
    rows.push({
      name: engine.namer.longName(port.name),
      address,
      status,
      proto: port.linkState === "up" ? "up" : "down",
    });
  }
  for (const entry of access.addresses) {
    const parsed = parseL3Interface(entry.interface);
    if (parsed === null || parsed.kind !== "vlan") continue;
    const up = working.has(entry.interface);
    rows.push({
      name: l3Name(engine, entry.interface),
      address: IPv4Prefix.fromCIDR(entry.address)?.address.description ?? "unassigned",
      status: up ? "up" : "down",
      proto: up ? "up" : "down",
    });
  }
  return rows;
}

// MARK: running-config

/** " ip address A.B.C.D M.M.M.M" (IOS) or " ip address A.B.C.D/NN" (Dell) for an interface. */
export function addressLine(engine: IOSEngine, interfaceID: L3InterfaceID): string | null {
  // An interface that takes its address from DHCP is configured as such, whatever it was leased.
  if (engine.access.device?.protocols?.dhcp?.clients.includes(interfaceID)) return " ip address dhcp";
  const prefix = engine.access.address(interfaceID);
  if (prefix === null) return null;
  return engine.isDell
    ? ` ip address ${prefix.description}`
    : ` ip address ${prefix.address.description} ${prefix.mask.description}`;
}

/** The global IP lines: default gateway and static routes. */
export function globalIPLines(engine: IOSEngine): string[] {
  const lines: string[] = [];
  const gateway = IPv4.parse(engine.access.defaultGateway);
  if (gateway !== null) lines.push(`ip default-gateway ${gateway.description}`);
  for (const route of engine.access.staticRoutes) {
    const network = IPv4Prefix.fromCIDR(route.destination);
    if (network === null) continue;
    lines.push(
      engine.isDell
        ? `ip route ${network.description} ${route.nextHop}`
        : `ip route ${network.address.description} ${network.mask.description} ${route.nextHop}`,
    );
  }
  return lines;
}

/** VLAN interfaces with an address, as configuration blocks. */
export function sviConfigBlocks(engine: IOSEngine): string[][] {
  const blocks: string[][] = [];
  for (const entry of engine.access.addresses) {
    const parsed = parseL3Interface(entry.interface);
    if (parsed === null || parsed.kind !== "vlan") continue;
    const text = addressLine(engine, entry.interface);
    if (text === null) continue;
    blocks.push([
      engine.isDell ? `interface Vlan ${parsed.number}` : `interface Vlan${parsed.number}`,
      text,
      ...featureInterfaceLines(engine, entry.interface),
    ]);
  }
  return blocks;
}
