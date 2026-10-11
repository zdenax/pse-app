// DHCP data helpers shared by the consoles and the simulation: the effective pools of a server
// (Cisco/Dell pools and the three RouterOS tables look the same to the simulation), address
// ranges, exclusions, the deterministic choice of a free address and the binding table.
// Pure functions over the project data; nothing here touches a console or the store.

import type { Device, L3InterfaceID, Project } from "../../../core/model";
import type { DHCPConfig, DHCPLease } from "../../../core/protocols";
import type { DeviceAccess } from "../../model-access";
import { IPv4, IPv4Prefix } from "../../sim/ipv4";

export function emptyDHCPConfig(): DHCPConfig {
  return { pools: [], excluded: [], relays: [], clients: [] };
}

export function dhcpOf(device: Device | null | undefined): DHCPConfig | undefined {
  return device?.protocols?.dhcp;
}

export function isEmptyDHCPConfig(config: DHCPConfig): boolean {
  const ros = config.routerOS;
  return (
    config.pools.length === 0 &&
    config.excluded.length === 0 &&
    config.relays.length === 0 &&
    config.clients.length === 0 &&
    (config.leases?.length ?? 0) === 0 &&
    (ros === undefined || ros.pools.length + ros.servers.length + ros.networks.length === 0)
  );
}

/**
 * Edits the DHCP configuration of the console's device in one store write; the key is removed
 * when nothing is left, so projects without DHCP stay untouched.
 */
export function updateDHCP(access: DeviceAccess, change: (config: DHCPConfig) => void): boolean {
  return access.updateProtocols((protocols) => {
    const config = protocols.dhcp ?? emptyDHCPConfig();
    change(config);
    if (config.leases?.length === 0) delete config.leases;
    const ros = config.routerOS;
    if (ros && ros.pools.length + ros.servers.length + ros.networks.length === 0) delete config.routerOS;
    protocols.dhcp = isEmptyDHCPConfig(config) ? undefined : config;
  });
}

// MARK: Address ranges

/** An inclusive range of addresses as unsigned numbers. */
export interface Span {
  readonly lo: number;
  readonly hi: number;
}

/** "A", "A-B" or a comma separated list of them; null when anything is malformed. */
export function parseSpans(text: string): Span[] | null {
  const spans: Span[] = [];
  for (const part of text.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const bounds = trimmed.split("-").map((piece) => IPv4.parse(piece.trim()));
    if (bounds.length > 2 || bounds.some((bound) => bound === null)) return null;
    const low = bounds[0] as IPv4;
    const high = (bounds[1] ?? low) as IPv4;
    if (low.value > high.value) return null;
    spans.push({ lo: low.value, hi: high.value });
  }
  return spans.length > 0 ? spans : null;
}

export function inSpans(spans: readonly Span[], value: number): boolean {
  return spans.some((span) => value >= span.lo && value <= span.hi);
}

export function spanSize(spans: readonly Span[]): number {
  return spans.reduce((sum, span) => sum + (span.hi - span.lo + 1), 0);
}

/** The usable host addresses of a network (without the network and broadcast address). */
export function hostSpan(network: IPv4Prefix): Span {
  const first = network.network.value;
  const last = network.broadcast.value;
  if (network.length >= 31) return { lo: first, hi: last };
  return { lo: first + 1, hi: last - 1 };
}

function clip(spans: readonly Span[], within: Span): Span[] {
  const result: Span[] = [];
  for (const span of spans) {
    const lo = Math.max(span.lo, within.lo);
    const hi = Math.min(span.hi, within.hi);
    if (lo <= hi) result.push({ lo, hi });
  }
  return result.sort((a, b) => a.lo - b.lo);
}

export function spansText(spans: readonly Span[]): string {
  return spans
    .map((span) => (span.lo === span.hi ? new IPv4(span.lo).description : `${new IPv4(span.lo).description}-${new IPv4(span.hi).description}`))
    .join(",");
}

// MARK: Lease time

/**
 * Seconds of a lease text: Cisco "7" / "0 8" / "0 0 30" (days, hours, minutes), RouterOS "10m",
 * "1d", "1h30m"; null for "infinite". Anything unreadable counts as the default of one day.
 */
export function leaseSeconds(text: string | undefined): number | null {
  const value = (text ?? "").trim().toLowerCase();
  if (value === "") return 86400;
  if (value === "infinite") return null;
  const words = value.split(/\s+/);
  if (words.every((word) => /^[0-9]+$/.test(word)) && words.length <= 3) {
    const [days, hours, minutes] = words.map(Number);
    return (days ?? 0) * 86400 + (hours ?? 0) * 3600 + (minutes ?? 0) * 60;
  }
  const units: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  let seconds = 0;
  let matched = 0;
  for (const part of value.matchAll(/([0-9]+)([wdhms])/g)) {
    seconds += Number(part[1]) * units[part[2]];
    matched += part[0].length;
  }
  return matched === value.length && seconds > 0 ? seconds : 86400;
}

const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Lease expiration as IOS prints it. The simulation has no clock, so every lease starts at the
 * same fixed moment and the date only follows from the lease time.
 */
export function leaseExpiry(text: string | undefined): string {
  const seconds = leaseSeconds(text);
  if (seconds === null) return "Infinite";
  const moment = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + seconds * 1000);
  const hours = moment.getUTCHours();
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  const two = (value: number): string => String(value).padStart(2, "0");
  return (
    `${monthNames[moment.getUTCMonth()]} ${two(moment.getUTCDate())} ${moment.getUTCFullYear()} ` +
    `${two(twelve)}:${two(moment.getUTCMinutes())} ${hours < 12 ? "AM" : "PM"}`
  );
}

// MARK: Effective pools

/** One thing a server hands addresses out of, whichever vendor syntax created it. */
export interface EffectivePool {
  readonly name: string;
  /** The network served; null until it is configured. */
  readonly network: IPv4Prefix | null;
  /** The addresses the pool may hand out, ascending (before the exclusions). */
  readonly spans: readonly Span[];
  /** Default gateway(s) and DNS server(s) handed out. */
  readonly defaultRouters: readonly string[];
  readonly dnsServers: readonly string[];
  readonly domainName: string;
  readonly lease: string;
  /** Serves only on this interface. */
  readonly interface?: L3InterfaceID;
  readonly source: "pool" | "routerOS";
  /** Czech sentence why the pool cannot serve at all (no network, server disabled, ...), or null. */
  readonly problem: string | null;
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((word) => word !== "");
}

/** The pools of a device as the simulation sees them. */
export function effectivePools(config: DHCPConfig): EffectivePool[] {
  const result: EffectivePool[] = [];
  for (const pool of config.pools) {
    const network = IPv4Prefix.fromCIDR(pool.network)?.networkPrefix ?? null;
    let spans: Span[] = [];
    if (network) {
      const hosts = hostSpan(network);
      spans = pool.range === "" ? [hosts] : clip(parseSpans(pool.range) ?? [], hosts);
    }
    result.push({
      name: pool.name,
      network,
      spans,
      defaultRouters: words(pool.defaultRouter),
      dnsServers: words(pool.dnsServer),
      domainName: pool.domainName ?? "",
      lease: pool.lease ?? "",
      interface: pool.interface,
      source: "pool",
      problem: network ? null : `pool ${pool.name} nemá příkaz network.`,
    });
  }
  const ros = config.routerOS;
  for (const server of ros?.servers ?? []) {
    const addressPool = ros?.pools.find((pool) => pool.name === server.addressPool);
    const ranges = addressPool ? parseSpans(addressPool.ranges) : null;
    const first = ranges?.[0];
    const entry = first === undefined ? undefined : ros?.networks.find((net) => IPv4Prefix.fromCIDR(net.address)?.contains(new IPv4(first.lo)));
    const network = entry ? (IPv4Prefix.fromCIDR(entry.address)?.networkPrefix ?? null) : null;
    let problem: string | null = null;
    if (server.disabled) {
      problem = `DHCP server ${server.name} je vypnutý (disabled=yes), zapněte ho příkazem „/ip dhcp-server enable ${server.name}“.`;
    } else if (!addressPool || !ranges) {
      problem = `DHCP server ${server.name} nemá platný address-pool (${server.addressPool}).`;
    } else if (!entry || !network) {
      problem = `pro rozsah poolu ${addressPool.name} chybí záznam v /ip dhcp-server network.`;
    }
    result.push({
      name: server.name,
      network,
      spans: network && ranges ? clip(ranges, hostSpan(network)) : [],
      defaultRouters: words(entry?.gateway ?? ""),
      dnsServers: words(entry?.dnsServer ?? ""),
      domainName: entry?.domain ?? "",
      lease: server.leaseTime,
      interface: server.interface,
      source: "routerOS",
      problem,
    });
  }
  return result;
}

// MARK: Used addresses and the choice of a free one

export function parseAddressValue(text: string): number | null {
  return IPv4.parse(text.split("/")[0] ?? "")?.value ?? null;
}

/** Every address configured on any device of the project, except one interface (the client's own). */
export function usedAddresses(project: Project, except: { deviceID: string; interfaceID: L3InterfaceID } | null): Set<number> {
  const used = new Set<number>();
  for (const device of project.devices) {
    for (const entry of device.addresses) {
      if (except && device.id === except.deviceID && entry.interface === except.interfaceID) continue;
      const value = parseAddressValue(entry.address);
      if (value !== null) used.add(value);
    }
  }
  return used;
}

export function excludedSpans(config: DHCPConfig): Span[] {
  const spans: Span[] = [];
  for (const entry of config.excluded) spans.push(...(parseSpans(entry) ?? []));
  return spans;
}

/**
 * The address a client gets from a pool: the one it already holds when that is still valid,
 * otherwise the lowest address of the range that is not excluded, not the network or broadcast
 * address, not the pool's gateway and not configured on any other device of the project.
 * Deterministic. Null when the pool is exhausted.
 */
export function allocateAddress(
  project: Project,
  server: DHCPConfig,
  pool: EffectivePool,
  client: { deviceID: string; interfaceID: L3InterfaceID },
): IPv4 | null {
  const network = pool.network;
  if (!network) return null;
  const excluded = excludedSpans(server);
  const used = usedAddresses(project, client);
  for (const router of pool.defaultRouters) {
    const value = parseAddressValue(router);
    if (value !== null) used.add(value);
  }
  const isFree = (value: number): boolean => {
    if (used.has(value) || inSpans(excluded, value)) return false;
    if (network.length < 31 && (value === network.network.value || value === network.broadcast.value)) return false;
    return true;
  };
  const device = project.devices.find((candidate) => candidate.id === client.deviceID);
  const held = device?.addresses.find((entry) => entry.interface === client.interfaceID);
  const current = held ? parseAddressValue(held.address) : null;
  if (current !== null && inSpans(pool.spans, current) && isFree(current)) return new IPv4(current);
  for (const span of pool.spans) {
    let value = span.lo;
    while (value <= span.hi) {
      const skip = excluded.find((entry) => value >= entry.lo && value <= entry.hi);
      if (skip) {
        value = skip.hi + 1;
        continue;
      }
      if (isFree(value)) return new IPv4(value);
      value += 1;
    }
  }
  return null;
}

// MARK: Bindings

/** One lease as the server lists it. */
export interface Binding {
  readonly pool: EffectivePool;
  readonly client: Device;
  readonly interfaceID: L3InterfaceID;
  readonly address: IPv4;
  readonly lease: DHCPLease | undefined;
  /** The id the client's MAC address derives from (see sim/mac.ts). */
  readonly macSource: string;
}

/** The id the MAC address of a client interface derives from: its port, or the bridge of an SVI. */
export function macSourceOf(device: Device, interfaceID: L3InterfaceID): string {
  if (interfaceID.startsWith("port:")) return interfaceID.slice(5);
  return device.ports[0]?.id ?? device.id;
}

/** The addresses configured on a device (text without the prefix length). */
export function addressTexts(device: Device): Set<string> {
  const result = new Set<string>();
  for (const entry of device.addresses) result.add(entry.address.split("/")[0] ?? "");
  return result;
}

/**
 * The clients of the project whose DHCP address lies in a pool of the server (and whose lease
 * names this server, when the client recorded one), ascending by address.
 */
export function bindingsOf(project: Project, server: Device): Binding[] {
  const config = dhcpOf(server);
  if (!config) return [];
  const pools = effectivePools(config).filter((pool) => pool.network !== null);
  const serverAddresses = addressTexts(server);
  const result: Binding[] = [];
  for (const client of project.devices) {
    if (client.id === server.id) continue;
    const clientConfig = dhcpOf(client);
    if (!clientConfig) continue;
    for (const interfaceID of clientConfig.clients) {
      const entry = client.addresses.find((candidate) => candidate.interface === interfaceID);
      const address = entry ? IPv4.parse(entry.address.split("/")[0] ?? "") : null;
      if (!address) continue;
      const lease = clientConfig.leases?.find((candidate) => candidate.interface === interfaceID);
      if (lease && lease.server !== "" && !serverAddresses.has(lease.server)) continue;
      const pool = pools.find((candidate) => candidate.network?.contains(address) && inSpans(candidate.spans, address.value));
      if (!pool) continue;
      result.push({ pool, client, interfaceID, address, lease, macSource: macSourceOf(client, interfaceID) });
    }
  }
  return result.sort((a, b) => a.address.value - b.address.value);
}
