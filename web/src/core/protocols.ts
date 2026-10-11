// Configuration of the network protocols beyond addresses and static routes: DHCP, ACL and
// firewall, NAT, OSPF, RIP, spanning tree and link aggregation (web version only; the Swift app
// reads files with this field and ignores it).
//
// Stored in Device.protocols as plain JSON data, one optional key per protocol; the key is
// written only when present, so projects without protocols stay byte-identical to the Swift
// app's files. Each protocol's structure lives in src/core/protocols/<name>.ts next to its
// lenient reader; the meaning is implemented by src/cli/features/<name>.

import { readACLConfig, type ACLConfig } from "./protocols/acl";
import { readDHCPConfig, type DHCPConfig } from "./protocols/dhcp";
import { readLACPConfig, readSTPConfig, type LACPConfig, type STPConfig } from "./protocols/layer2";
import { readNATConfig, type NATConfig } from "./protocols/nat";
import { readOSPFConfig, readRIPConfig, type OSPFConfig, type RIPConfig } from "./protocols/routing";

export type * from "./protocols/acl";
export type * from "./protocols/dhcp";
export type * from "./protocols/layer2";
export type * from "./protocols/nat";
export type * from "./protocols/routing";

export interface DeviceProtocols {
  dhcp?: DHCPConfig;
  acl?: ACLConfig;
  nat?: NATConfig;
  ospf?: OSPFConfig;
  rip?: RIPConfig;
  stp?: STPConfig;
  lacp?: LACPConfig;
}

export type ProtocolKey = keyof DeviceProtocols;

const readers: { [K in ProtocolKey]: (raw: unknown) => DeviceProtocols[K] | undefined } = {
  dhcp: readDHCPConfig,
  acl: readACLConfig,
  nat: readNATConfig,
  ospf: readOSPFConfig,
  rip: readRIPConfig,
  stp: readSTPConfig,
  lacp: readLACPConfig,
};

export const protocolKeys = Object.keys(readers) as ProtocolKey[];

/** Reads `protocols` of a device leniently: unknown keys and malformed values are dropped. */
export function readProtocols(raw: unknown): DeviceProtocols {
  const result: DeviceProtocols = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return result;
  const source = raw as Record<string, unknown>;
  for (const key of protocolKeys) {
    if (source[key] === undefined || source[key] === null) continue;
    const value = readers[key](source[key]);
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

/** True when no protocol is configured (the field is then not written). */
export function isEmptyProtocols(protocols: DeviceProtocols | undefined): boolean {
  if (!protocols) return true;
  return protocolKeys.every((key) => protocols[key] === undefined);
}

/** A deep copy through JSON (the values are plain data). */
export function cloneProtocols(protocols: DeviceProtocols | undefined): DeviceProtocols {
  if (!protocols) return {};
  return JSON.parse(JSON.stringify(protocols)) as DeviceProtocols;
}
