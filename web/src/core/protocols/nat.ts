// Address translation of one device (owned by the NAT feature, see src/cli/features/nat).
// Cisco `ip nat ...`, MikroTik `/ip firewall nat` and EdgeOS `service nat` write this.
// Stored in Device.protocols.nat; plain JSON data.

import type { L3InterfaceID } from "../model";

export interface NATPool {
  name: string;
  start: string;
  end: string;
  /** Prefix length from `netmask`/`prefix-length`. */
  prefixLength: number;
}

export type NATRule =
  /** `ip nat inside source static LOCAL GLOBAL` (also MikroTik dst-nat + src-nat pairs). */
  | { kind: "static"; local: string; global: string }
  /** `ip nat inside source list ACL (interface IF | pool NAME) [overload]`. */
  | { kind: "dynamic"; list: string; pool?: string; interface?: L3InterfaceID; overload: boolean }
  /** MikroTik `chain=srcnat action=masquerade [out-interface=] [src-address=]`, EdgeOS masquerade. */
  | { kind: "masquerade"; outInterface?: L3InterfaceID; srcAddress: string }
  /** MikroTik `chain=dstnat action=dst-nat dst-address= to-addresses=`. */
  | { kind: "dstnat"; dstAddress: string; toAddress: string; inInterface?: L3InterfaceID };

export interface NATConfig {
  inside: L3InterfaceID[];
  outside: L3InterfaceID[];
  pools: NATPool[];
  rules: NATRule[];
}

export function readNATConfig(raw: unknown): NATConfig | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Partial<NATConfig>;
  return {
    inside: Array.isArray(value.inside) ? value.inside : [],
    outside: Array.isArray(value.outside) ? value.outside : [],
    pools: Array.isArray(value.pools) ? value.pools : [],
    rules: Array.isArray(value.rules) ? value.rules : [],
  };
}
