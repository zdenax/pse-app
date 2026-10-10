// Packet filters of one device (owned by the ACL feature, see src/cli/features/acl):
// Cisco/Dell access lists bound to interfaces, and MikroTik/EdgeOS firewall filter rules.
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
  /** IOS text of the source: "any", "host A.B.C.D" or "A.B.C.D W.W.W.W". */
  source: string;
  /** Extended lists only; "" in standard lists. */
  destination: string;
  /** Port condition on the destination, IOS text ("eq 80", "range 20 21"); "" none. */
  destinationPort: string;
  /** Port condition on the source; "" none. */
  sourcePort: string;
  /** ICMP type for protocol icmp ("echo", "echo-reply"); "" any. */
  icmpType: string;
  remark: string;
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

/** MikroTik `/ip firewall filter` (and EdgeOS firewall) rule, evaluated in order. */
export interface FirewallRule {
  chain: "input" | "forward" | "output";
  action: "accept" | "drop" | "reject";
  /** "" any, else "icmp" | "tcp" | "udp". */
  protocol: string;
  /** CIDR or address; "" any. */
  srcAddress: string;
  dstAddress: string;
  /** Destination port ("80", "20-21"); "" any. */
  dstPort: string;
  inInterface?: L3InterfaceID;
  outInterface?: L3InterfaceID;
  disabled: boolean;
  comment: string;
}

export interface ACLConfig {
  lists: AccessList[];
  bindings: ACLBinding[];
  firewall: FirewallRule[];
}

export function readACLConfig(raw: unknown): ACLConfig | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Partial<ACLConfig>;
  return {
    lists: Array.isArray(value.lists) ? value.lists : [],
    bindings: Array.isArray(value.bindings) ? value.bindings : [],
    firewall: Array.isArray(value.firewall) ? value.firewall : [],
  };
}
