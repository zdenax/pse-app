// Address translation of one device (owned by the NAT feature, see src/cli/features/nat).
// Cisco `ip nat ...` and MikroTik `/ip firewall nat` write this.
// Stored in Device.protocols.nat; plain JSON data.

import type { L3InterfaceID } from "../model";

export interface NATPool {
  name: string;
  start: string;
  end: string;
  /** Prefix length from `netmask`/`prefix-length`. */
  prefixLength: number;
}

/** Flags every rule can carry (MikroTik `disabled=`, `comment=`). */
export interface NATRuleOptions {
  /** A disabled rule stays in the configuration but is not applied. */
  disabled?: boolean;
  comment?: string;
}

export type NATRule = NATRuleOptions &
  (
    /** `ip nat inside source static LOCAL GLOBAL`: a fixed two-way mapping. */
    | { kind: "static"; local: string; global: string }
    /** `ip nat inside source list ACL (interface IF | pool NAME) [overload]`. */
    | { kind: "dynamic"; list: string; pool?: string; interface?: L3InterfaceID; overload: boolean }
    /** MikroTik `chain=srcnat action=masquerade [out-interface=] [src-address=]` ("" = any source). */
    | { kind: "masquerade"; outInterface?: L3InterfaceID; srcAddress: string }
    /** MikroTik `chain=srcnat action=src-nat to-addresses=A [src-address=] [out-interface=]`. */
    | { kind: "srcnat"; srcAddress: string; toAddress: string; outInterface?: L3InterfaceID }
    /**
     * MikroTik `chain=dstnat action=dst-nat dst-address= to-addresses= [in-interface=]
     * [protocol= dst-port= to-ports=]` ("" or missing = any).
     */
    | {
        kind: "dstnat";
        dstAddress: string;
        toAddress: string;
        inInterface?: L3InterfaceID;
        protocol?: string;
        dstPort?: string;
        toPort?: string;
      }
  );

export interface NATConfig {
  /** Cisco `ip nat inside` interfaces. */
  inside: L3InterfaceID[];
  /** Cisco `ip nat outside` interfaces. */
  outside: L3InterfaceID[];
  pools: NATPool[];
  rules: NATRule[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readPool(raw: unknown): NATPool | null {
  if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.start !== "string" || typeof raw.end !== "string") {
    return null;
  }
  const length = typeof raw.prefixLength === "number" && raw.prefixLength >= 0 && raw.prefixLength <= 32 ? raw.prefixLength : 24;
  return { name: raw.name, start: raw.start, end: raw.end, prefixLength: Math.trunc(length) };
}

function readRule(raw: unknown): NATRule | null {
  if (!isRecord(raw)) return null;
  const options: NATRuleOptions = {};
  if (raw.disabled === true) options.disabled = true;
  const comment = optionalText(raw.comment);
  if (comment !== undefined) options.comment = comment;
  switch (raw.kind) {
    case "static":
      if (typeof raw.local !== "string" || typeof raw.global !== "string") return null;
      return { ...options, kind: "static", local: raw.local, global: raw.global };
    case "dynamic": {
      if (typeof raw.list !== "string") return null;
      const rule: NATRule = { ...options, kind: "dynamic", list: raw.list, overload: raw.overload === true };
      const pool = optionalText(raw.pool);
      const iface = optionalText(raw.interface);
      if (pool !== undefined) rule.pool = pool;
      if (iface !== undefined) rule.interface = iface;
      return rule;
    }
    case "masquerade": {
      const rule: NATRule = { ...options, kind: "masquerade", srcAddress: text(raw.srcAddress) };
      const out = optionalText(raw.outInterface);
      if (out !== undefined) rule.outInterface = out;
      return rule;
    }
    case "srcnat": {
      if (typeof raw.toAddress !== "string") return null;
      const rule: NATRule = { ...options, kind: "srcnat", srcAddress: text(raw.srcAddress), toAddress: raw.toAddress };
      const out = optionalText(raw.outInterface);
      if (out !== undefined) rule.outInterface = out;
      return rule;
    }
    case "dstnat": {
      if (typeof raw.toAddress !== "string") return null;
      const rule: NATRule = { ...options, kind: "dstnat", dstAddress: text(raw.dstAddress), toAddress: raw.toAddress };
      const into = optionalText(raw.inInterface);
      const protocol = optionalText(raw.protocol);
      const dstPort = optionalText(raw.dstPort);
      const toPort = optionalText(raw.toPort);
      if (into !== undefined) rule.inInterface = into;
      if (protocol !== undefined) rule.protocol = protocol;
      if (dstPort !== undefined) rule.dstPort = dstPort;
      if (toPort !== undefined) rule.toPort = toPort;
      return rule;
    }
    default:
      return null;
  }
}

function readList<T>(raw: unknown, read: (item: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  const result: T[] = [];
  for (const item of raw) {
    const value = read(item);
    if (value !== null) result.push(value);
  }
  return result;
}

export function readNATConfig(raw: unknown): NATConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const interfaces = (value: unknown): L3InterfaceID[] =>
    readList(value, (item) => (typeof item === "string" && item !== "" ? item : null));
  return {
    inside: interfaces(raw.inside),
    outside: interfaces(raw.outside),
    pools: readList(raw.pools, readPool),
    rules: readList(raw.rules, readRule),
  };
}

/** True when nothing is configured (the key is then removed from the device). */
export function isEmptyNATConfig(config: NATConfig): boolean {
  return (
    config.inside.length === 0 && config.outside.length === 0 && config.pools.length === 0 && config.rules.length === 0
  );
}
