// Packet filters of one device (owned by the ACL feature, see src/cli/features/acl):
// Cisco/Dell access lists bound to interfaces, and MikroTik firewall filter rules.
// Stored in Device.protocols.acl; plain JSON data.

import type { L3InterfaceID } from "../model";

export type ACLAction = "permit" | "deny";

export interface ACLEntry {
  /** Sequence number (10, 20, ...). */
  sequence: number;
  /** "remark" entries carry only `remark`. */
  action: ACLAction | "remark";
  /** "ip" | "icmp" | "tcp" | "udp" (extended lists); standard lists use "ip". */
  protocol: string;
  /** Normalised source: "any", "host A.B.C.D" or "A.B.C.D W.W.W.W" (wildcard mask). */
  source: string;
  /** Extended lists only; "" in standard lists. Same format as `source`. */
  destination: string;
  /** Port condition on the destination, numeric IOS text ("eq 80", "eq 80 443", "range 20 21"); "" none. */
  destinationPort: string;
  /** Port condition on the source; "" none. */
  sourcePort: string;
  /** ICMP type for protocol icmp ("echo", "echo-reply"); "" any. */
  icmpType: string;
  remark: string;
  /** TCP `established`: matches the packets of a connection that is already open (replies). */
  established?: boolean;
  /** `log` keyword; kept for the configuration listing, it has no effect. */
  log?: boolean;
}

export interface AccessList {
  /** "1", "101" or a name ("BLOCK_WEB"). */
  name: string;
  type: "standard" | "extended";
  entries: ACLEntry[];
}

export interface ACLBinding {
  interface: L3InterfaceID;
  direction: "in" | "out";
  list: string;
}

/** MikroTik `/ip firewall filter` rule, evaluated in order within its chain. */
export interface FirewallRule {
  chain: "input" | "forward" | "output";
  action: "accept" | "drop" | "reject";
  /** "" any, else "icmp" | "tcp" | "udp"; a leading "!" negates. */
  protocol: string;
  /** CIDR or address; "" any; a leading "!" negates. */
  srcAddress: string;
  dstAddress: string;
  /** Destination port ("80", "20-21", "80,443"); "" any. */
  dstPort: string;
  /** Source port, same format; "" or absent any. */
  srcPort?: string;
  /** Comma separated states ("established,related"); "" or absent any. */
  connectionState?: string;
  inInterface?: L3InterfaceID;
  outInterface?: L3InterfaceID;
  /** `in-interface=!ether1` / `out-interface=!ether1`. */
  inInterfaceNot?: boolean;
  outInterfaceNot?: boolean;
  disabled: boolean;
  comment: string;
}

export interface ACLConfig {
  lists: AccessList[];
  bindings: ACLBinding[];
  firewall: FirewallRule[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readEntry(raw: unknown): ACLEntry | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const action = value.action;
  if (action !== "permit" && action !== "deny" && action !== "remark") return null;
  const sequence = typeof value.sequence === "number" && Number.isFinite(value.sequence) ? Math.trunc(value.sequence) : 0;
  if (sequence < 1) return null;
  const entry: ACLEntry = {
    sequence,
    action,
    protocol: text(value.protocol) || "ip",
    source: text(value.source) || "any",
    destination: text(value.destination),
    destinationPort: text(value.destinationPort),
    sourcePort: text(value.sourcePort),
    icmpType: text(value.icmpType),
    remark: text(value.remark),
  };
  if (value.established === true) entry.established = true;
  if (value.log === true) entry.log = true;
  return entry;
}

function readList(raw: unknown): AccessList | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const name = text(value.name);
  if (name === "" || (value.type !== "standard" && value.type !== "extended")) return null;
  const entries = Array.isArray(value.entries)
    ? value.entries.map(readEntry).filter((entry): entry is ACLEntry => entry !== null)
    : [];
  return { name, type: value.type, entries };
}

function readBinding(raw: unknown): ACLBinding | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.direction !== "in" && value.direction !== "out") return null;
  const list = text(value.list);
  const iface = text(value.interface);
  if (list === "" || iface === "") return null;
  return { interface: iface, direction: value.direction, list };
}

function readRule(raw: unknown): FirewallRule | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.chain !== "input" && value.chain !== "forward" && value.chain !== "output") return null;
  if (value.action !== "accept" && value.action !== "drop" && value.action !== "reject") return null;
  const rule: FirewallRule = {
    chain: value.chain,
    action: value.action,
    protocol: text(value.protocol),
    srcAddress: text(value.srcAddress),
    dstAddress: text(value.dstAddress),
    dstPort: text(value.dstPort),
    disabled: value.disabled === true,
    comment: text(value.comment),
  };
  if (text(value.srcPort) !== "") rule.srcPort = text(value.srcPort);
  if (text(value.connectionState) !== "") rule.connectionState = text(value.connectionState);
  if (text(value.inInterface) !== "") rule.inInterface = text(value.inInterface);
  if (text(value.outInterface) !== "") rule.outInterface = text(value.outInterface);
  if (value.inInterfaceNot === true) rule.inInterfaceNot = true;
  if (value.outInterfaceNot === true) rule.outInterfaceNot = true;
  return rule;
}

export function readACLConfig(raw: unknown): ACLConfig | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  return {
    lists: Array.isArray(value.lists) ? value.lists.map(readList).filter((item): item is AccessList => item !== null) : [],
    bindings: Array.isArray(value.bindings)
      ? value.bindings.map(readBinding).filter((item): item is ACLBinding => item !== null)
      : [],
    firewall: Array.isArray(value.firewall)
      ? value.firewall.map(readRule).filter((item): item is FirewallRule => item !== null)
      : [],
  };
}
