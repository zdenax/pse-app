// Dynamic routing of one device (owned by the routing feature, see src/cli/features/routing):
// OSPF and RIP. Cisco `router ospf/rip`, Dell OS9, MikroTik `/routing ospf|rip` and EdgeOS
// `protocols ospf|rip` write this. Stored in Device.protocols.ospf / .rip; plain JSON data.

import type { L3InterfaceID } from "../model";

export interface OSPFNetwork {
  /** Network address of the statement ("10.0.0.0"). */
  address: string;
  /** Wildcard mask ("0.0.0.255"); Dell/MikroTik/EdgeOS CIDR forms are converted. */
  wildcard: string;
  /** Area number (0 = backbone; dotted areas are converted to a number). */
  area: number;
}

export interface OSPFConfig {
  /** Cisco process id; 1 elsewhere. */
  process: number;
  /** "" = chosen automatically (highest interface address). */
  routerID: string;
  networks: OSPFNetwork[];
  /** `ip ospf <process> area <n>` on an interface / MikroTik interface-template. */
  interfaceAreas: { interface: L3InterfaceID; area: number }[];
  passive: L3InterfaceID[];
  /** `passive-interface default`. */
  passiveDefault: boolean;
  costs: { interface: L3InterfaceID; cost: number }[];
  /** `default-information originate`. */
  defaultOriginate: boolean;
  redistributeStatic: boolean;
  redistributeConnected: boolean;
  /** `auto-cost reference-bandwidth` in Mbit/s (default 100). */
  referenceBandwidth: number;
}

export interface RIPConfig {
  version: 1 | 2;
  /** Classful network statements ("10.0.0.0"). */
  networks: string[];
  /** Interfaces enabled directly (MikroTik/EdgeOS interface lists). */
  interfaces: L3InterfaceID[];
  passive: L3InterfaceID[];
  autoSummary: boolean;
  defaultOriginate: boolean;
  redistributeStatic: boolean;
  redistributeConnected: boolean;
}

function isObject(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

export function readOSPFConfig(raw: unknown): OSPFConfig | undefined {
  if (!isObject(raw)) return undefined;
  const value = raw as Partial<OSPFConfig>;
  return {
    process: typeof value.process === "number" ? value.process : 1,
    routerID: typeof value.routerID === "string" ? value.routerID : "",
    networks: Array.isArray(value.networks) ? value.networks : [],
    interfaceAreas: Array.isArray(value.interfaceAreas) ? value.interfaceAreas : [],
    passive: Array.isArray(value.passive) ? value.passive : [],
    passiveDefault: value.passiveDefault === true,
    costs: Array.isArray(value.costs) ? value.costs : [],
    defaultOriginate: value.defaultOriginate === true,
    redistributeStatic: value.redistributeStatic === true,
    redistributeConnected: value.redistributeConnected === true,
    referenceBandwidth: typeof value.referenceBandwidth === "number" ? value.referenceBandwidth : 100,
  };
}

export function readRIPConfig(raw: unknown): RIPConfig | undefined {
  if (!isObject(raw)) return undefined;
  const value = raw as Partial<RIPConfig>;
  return {
    version: value.version === 2 ? 2 : 1,
    networks: Array.isArray(value.networks) ? value.networks : [],
    interfaces: Array.isArray(value.interfaces) ? value.interfaces : [],
    passive: Array.isArray(value.passive) ? value.passive : [],
    autoSummary: value.autoSummary !== false,
    defaultOriginate: value.defaultOriginate === true,
    redistributeStatic: value.redistributeStatic === true,
    redistributeConnected: value.redistributeConnected === true,
  };
}
