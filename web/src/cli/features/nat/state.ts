// Run-time state of the address translation: the translation table of each router. Like on a
// real device it is lost when the page is reloaded and is not part of the project file.

import type { NATPool, NATRule } from "../../../core/protocols/nat";
import { IPv4 } from "../../sim/ipv4";
import type { PacketProtocol } from "../../sim/packet";
import { NetworkRuntime } from "../../sim/runtime";

/** One entry of the translation table (one flow, or one `---` mapping of a pool without overload). */
export interface Translation {
  id: number;
  /** "ios" for `ip nat ...`, "routeros" for `/ip firewall nat`. */
  style: "ios" | "routeros";
  kind: "static" | "dynamic" | "overload" | "masquerade" | "srcnat" | "dstnat";
  /** The rule that created it, in the words of the device, for explanations. */
  rule: string;
  /** Which side sent the first packet: "inside" (source translated) or "outside" (destination translated). */
  initiator: "inside" | "outside";
  protocol: PacketProtocol;
  /** Inside local address and port (the ICMP query id for ping). */
  local: string;
  localPort: number;
  /** Inside global address and port. */
  global: string;
  globalPort: number;
  /** The host on the outside (outside local = outside global; no outside translation). */
  remote: string;
  remotePort: number;
  /** Without overload one global address stands for one local address (the `---` row of IOS). */
  simple: boolean;
  /** Pool the global address came from and the access list of the rule (statistics). */
  pool?: string;
  list?: string;
  /** ICMP: requests that wait for their reply (the model has no query ids, see sim.ts). */
  pending: number;
  /** Logical time of the last use. */
  used: number;
}

export interface NATState {
  translations: Translation[];
  /** Logical clock, advanced at every use. */
  clock: number;
  icmpID: number;
  nextID: number;
  hits: number;
  misses: number;
  peak: number;
}

const stateKey = "nat";

export function natState(deviceID: string): NATState {
  return NetworkRuntime.state<NATState>(stateKey, deviceID, () => ({
    translations: [],
    clock: 0,
    icmpID: 0,
    nextID: 1,
    hits: 0,
    misses: 0,
    peak: 0,
  }));
}

/** `clear ip nat translation *`: the table is emptied, the counters stay. */
export function clearTranslations(deviceID: string): void {
  natState(deviceID).translations = [];
}

/** The range of addresses of a pool, or null when the pool is malformed. */
export function poolRange(pool: NATPool): { first: number; last: number } | null {
  const start = IPv4.parse(pool.start);
  const end = IPv4.parse(pool.end);
  if (start === null || end === null || end.value < start.value) return null;
  return { first: start.value, last: end.value };
}

export function poolSize(pool: NATPool): number {
  const range = poolRange(pool);
  return range === null ? 0 : range.last - range.first + 1;
}

/** Rules that are in force (MikroTik rules can be disabled). */
export function activeRules(rules: readonly NATRule[]): NATRule[] {
  return rules.filter((rule) => rule.disabled !== true);
}

/** The IOS command line of a dynamic rule: `ip nat inside source list 1 pool OUT overload`. */
export function dynamicRuleText(
  rule: Extract<NATRule, { kind: "dynamic" }>,
  interfaceName: string | null = null,
): string {
  const target = rule.pool !== undefined ? `pool ${rule.pool}` : `interface ${interfaceName ?? "?"}`;
  return `ip nat inside source list ${rule.list} ${target}${rule.overload ? " overload" : ""}`;
}
