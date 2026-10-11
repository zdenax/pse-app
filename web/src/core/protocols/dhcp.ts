// DHCP configuration of one device (owned by the DHCP feature, see src/cli/features/dhcp).
// Vendor-neutral: Cisco/Dell `ip dhcp pool` write `pools`, MikroTik `/ip pool`, `/ip dhcp-server`
// and `/ip dhcp-server network` write `routerOS` (the three tables RouterOS keeps apart), relay
// agents write `relays`; consoles mark an interface as a DHCP client in `clients` and keep what
// the server told them in `leases`. Stored in Device.protocols.dhcp; plain JSON data.

import type { L3InterfaceID } from "../model";

export interface DHCPPool {
  /** Pool name ("LAN10"). */
  name: string;
  /** Network served, CIDR ("192.168.10.0/24"); "" until `network` is given. */
  network: string;
  /** Default gateway(s) handed out, space separated; "" none. */
  defaultRouter: string;
  /** DNS server(s) handed out, space separated; "" none. */
  dnsServer: string;
  /** Explicit address range "A.B.C.D-A.B.C.E[,...]"; "" = the whole network. */
  range: string;
  /** Serve only on this interface; absent = any interface in the network. */
  interface?: L3InterfaceID;
  /** Domain name handed out (Cisco `domain-name`). */
  domainName?: string;
  /** Cisco `lease`: "7" (days), "0 8" (days hours), "0 0 30" or "infinite"; absent = 1 day. */
  lease?: string;
}

export interface DHCPRelay {
  /** The interface with `ip helper-address` (MikroTik `/ip dhcp-relay interface=`). */
  interface: L3InterfaceID;
  /** Address of the DHCP server. */
  server: string;
  /** MikroTik relay name ("relay1"). */
  name?: string;
  /** MikroTik relays are created disabled; a disabled relay forwards nothing. */
  disabled?: boolean;
}

/** What a DHCP client interface was told by its server. */
export interface DHCPLease {
  interface: L3InterfaceID;
  /** Address of the server (the DHCP server identifier). */
  server: string;
  /** Default gateway of the lease; "" none. */
  gateway: string;
  /** DNS server(s) of the lease, space separated; "" none. */
  dnsServer: string;
  domainName?: string;
  /** The lease time as the server's pool states it (see DHCPPool.lease); absent = 1 day. */
  lease?: string;
}

/** MikroTik `/ip pool`. */
export interface RouterOSPool {
  name: string;
  /** "A.B.C.D-A.B.C.E[,...]". */
  ranges: string;
}

/** MikroTik `/ip dhcp-server`. */
export interface RouterOSServer {
  name: string;
  interface: L3InterfaceID;
  /** Name of a RouterOS pool; "static-only" for none. */
  addressPool: string;
  /** "10m", "1d", ... */
  leaseTime: string;
  disabled: boolean;
}

/** MikroTik `/ip dhcp-server network`. */
export interface RouterOSNetwork {
  /** CIDR ("192.168.88.0/24"). */
  address: string;
  gateway: string;
  dnsServer: string;
  domain?: string;
}

export interface RouterOSDHCP {
  pools: RouterOSPool[];
  servers: RouterOSServer[];
  networks: RouterOSNetwork[];
}

export interface DHCPConfig {
  pools: DHCPPool[];
  /** Excluded addresses: "A.B.C.D" or "A.B.C.D-A.B.C.E". */
  excluded: string[];
  relays: DHCPRelay[];
  /** Interfaces of THIS device whose address is obtained by DHCP (client side). */
  clients: L3InterfaceID[];
  /** What the servers told the interfaces in `clients`; written only when not empty. */
  leases?: DHCPLease[];
  /** MikroTik tables; written only when not empty. */
  routerOS?: RouterOSDHCP;
}

function isObject(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

function text(raw: unknown): string | undefined {
  return typeof raw === "string" ? raw : undefined;
}

function list<T>(raw: unknown, read: (item: unknown) => T | undefined): T[] {
  if (!Array.isArray(raw)) return [];
  const result: T[] = [];
  for (const item of raw) {
    const value = read(item);
    if (value !== undefined) result.push(value);
  }
  return result;
}

function optional<T>(value: T, extra: Record<string, string | boolean | undefined>): T {
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [key, entry] of Object.entries(extra)) if (entry !== undefined && entry !== "") copy[key] = entry;
  return copy as T;
}

function readPool(raw: unknown): DHCPPool | undefined {
  if (!isObject(raw)) return undefined;
  const name = text(raw.name);
  if (name === undefined || name === "") return undefined;
  return optional(
    {
      name,
      network: text(raw.network) ?? "",
      defaultRouter: text(raw.defaultRouter) ?? "",
      dnsServer: text(raw.dnsServer) ?? "",
      range: text(raw.range) ?? "",
    },
    { interface: text(raw.interface), domainName: text(raw.domainName), lease: text(raw.lease) },
  );
}

function readRelay(raw: unknown): DHCPRelay | undefined {
  if (!isObject(raw)) return undefined;
  const iface = text(raw.interface);
  const server = text(raw.server);
  if (iface === undefined || server === undefined) return undefined;
  return optional(
    { interface: iface, server },
    { name: text(raw.name), disabled: raw.disabled === true ? true : undefined },
  );
}

function readLease(raw: unknown): DHCPLease | undefined {
  if (!isObject(raw)) return undefined;
  const iface = text(raw.interface);
  if (iface === undefined) return undefined;
  return optional(
    { interface: iface, server: text(raw.server) ?? "", gateway: text(raw.gateway) ?? "", dnsServer: text(raw.dnsServer) ?? "" },
    { domainName: text(raw.domainName), lease: text(raw.lease) },
  );
}

function readRouterOS(raw: unknown): RouterOSDHCP | undefined {
  if (!isObject(raw)) return undefined;
  const result: RouterOSDHCP = {
    pools: list(raw.pools, (item): RouterOSPool | undefined => {
      if (!isObject(item) || text(item.name) === undefined || text(item.ranges) === undefined) return undefined;
      return { name: item.name as string, ranges: item.ranges as string };
    }),
    servers: list(raw.servers, (item): RouterOSServer | undefined => {
      if (!isObject(item) || text(item.name) === undefined || text(item.interface) === undefined) return undefined;
      return {
        name: item.name as string,
        interface: item.interface as string,
        addressPool: text(item.addressPool) ?? "static-only",
        leaseTime: text(item.leaseTime) ?? "10m",
        disabled: item.disabled !== false,
      };
    }),
    networks: list(raw.networks, (item): RouterOSNetwork | undefined => {
      if (!isObject(item) || text(item.address) === undefined) return undefined;
      return optional(
        { address: item.address as string, gateway: text(item.gateway) ?? "", dnsServer: text(item.dnsServer) ?? "" },
        { domain: text(item.domain) },
      );
    }),
  };
  return result.pools.length + result.servers.length + result.networks.length > 0 ? result : undefined;
}

/** Lenient reader: anything that is not an object is dropped, malformed entries are skipped. */
export function readDHCPConfig(raw: unknown): DHCPConfig | undefined {
  if (!isObject(raw)) return undefined;
  const config: DHCPConfig = {
    pools: list(raw.pools, readPool),
    excluded: list(raw.excluded, text),
    relays: list(raw.relays, readRelay),
    clients: list(raw.clients, text),
  };
  const leases = list(raw.leases, readLease);
  if (leases.length > 0) config.leases = leases;
  const routerOS = readRouterOS(raw.routerOS);
  if (routerOS) config.routerOS = routerOS;
  return config;
}
