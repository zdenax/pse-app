// DHCP configuration of one device (owned by the DHCP feature, see src/cli/features/dhcp).
// Vendor-neutral: Cisco `ip dhcp pool`, MikroTik `/ip dhcp-server` and EdgeOS
// `service dhcp-server` all write this structure; the PC command prompt marks its adapter as a
// DHCP client. Stored in Device.protocols.dhcp; plain JSON data.

import type { L3InterfaceID } from "../model";

export interface DHCPPool {
  /** Pool name ("LAN10", MikroTik "dhcp1"). */
  name: string;
  /** Network served, CIDR ("192.168.10.0/24"); "" until `network` is given. */
  network: string;
  /** Default gateway handed out; "" none. */
  defaultRouter: string;
  /** DNS server handed out; "" none. */
  dnsServer: string;
  /** Explicit address range "A.B.C.D-A.B.C.E" (MikroTik /ip pool); "" = the whole network. */
  range: string;
  /** Serve only on this interface (MikroTik dhcp-server interface=); absent = any interface in the network. */
  interface?: L3InterfaceID;
}

export interface DHCPRelay {
  /** The interface with `ip helper-address`. */
  interface: L3InterfaceID;
  /** Address of the DHCP server. */
  server: string;
}

export interface DHCPConfig {
  pools: DHCPPool[];
  /** Excluded addresses: "A.B.C.D" or "A.B.C.D-A.B.C.E". */
  excluded: string[];
  relays: DHCPRelay[];
  /** Interfaces of THIS device whose address was obtained by DHCP (client side). */
  clients: L3InterfaceID[];
}

/** Lenient reader: anything that is not an object is dropped. The DHCP feature may harden it. */
export function readDHCPConfig(raw: unknown): DHCPConfig | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Partial<DHCPConfig>;
  return {
    pools: Array.isArray(value.pools) ? value.pools : [],
    excluded: Array.isArray(value.excluded) ? value.excluded : [],
    relays: Array.isArray(value.relays) ? value.relays : [],
    clients: Array.isArray(value.clients) ? value.clients : [],
  };
}
