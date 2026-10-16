// Spanning tree and link aggregation of one device (owned by the layer-2 feature, see
// src/cli/features/layer2). Cisco `spanning-tree ...` / `channel-group`, Dell OS9 `protocol
// spanning-tree` / `port-channel-protocol lacp`, MikroTik bridge `protocol-mode` / `bonding`.
// Stored in Device.protocols.stp / .lacp; plain JSON data. Ports are referenced by port UUID.

export type STPMode = "pvst" | "rapid-pvst" | "mst" | "stp" | "rstp" | "none";

export interface STPConfig {
  mode: STPMode;
  /** VLANs with spanning tree switched off (`no spanning-tree vlan N`). */
  disabledVLANs: number[];
  /** Bridge priority per VLAN; vlan 0 = all VLANs / the MikroTik bridge. Default 32768. */
  priorities: { vlan: number; priority: number }[];
  /** Ports with PortFast / edge-port. */
  portfast: string[];
  /** Ports with BPDU guard. */
  bpduGuard: string[];
  /** Port cost overrides; vlan 0 = all VLANs. */
  costs: { port: string; vlan: number; cost: number }[];
  /** Port priority overrides (default 128); vlan 0 = all VLANs. */
  portPriorities: { port: string; vlan: number; priority: number }[];
}

export type ChannelMode = "active" | "passive" | "on" | "desirable" | "auto";

/** The logical interface `interface port-channel N` (Cisco; see cli/features/layer2/etherchannel*.ts). */
export interface PortChannelConfig {
  group: number;
  /** Canonical switchport text of the channel (like Port.vlan, see cli/switchport.ts); "" = none. */
  vlan: string;
  description: string;
  /** `shutdown` on the port-channel: the members are shut down with it. */
  adminDown: boolean;
}

export interface LACPConfig {
  /** Port-channel membership: `channel-group N mode M`, MikroTik bonding slaves. */
  members: { port: string; group: number; mode: ChannelMode }[];
  /** The port-channel interfaces that exist on the device (created by `interface port-channel N`). */
  channels?: PortChannelConfig[];
}

function isObject(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

export function readSTPConfig(raw: unknown): STPConfig | undefined {
  if (!isObject(raw)) return undefined;
  const value = raw as Partial<STPConfig>;
  return {
    mode: typeof value.mode === "string" ? value.mode : "pvst",
    disabledVLANs: Array.isArray(value.disabledVLANs) ? value.disabledVLANs : [],
    priorities: Array.isArray(value.priorities) ? value.priorities : [],
    portfast: Array.isArray(value.portfast) ? value.portfast : [],
    bpduGuard: Array.isArray(value.bpduGuard) ? value.bpduGuard : [],
    costs: Array.isArray(value.costs) ? value.costs : [],
    portPriorities: Array.isArray(value.portPriorities) ? value.portPriorities : [],
  };
}

export function readLACPConfig(raw: unknown): LACPConfig | undefined {
  if (!isObject(raw)) return undefined;
  const value = raw as Partial<LACPConfig>;
  const config: LACPConfig = { members: Array.isArray(value.members) ? value.members : [] };
  if (Array.isArray(value.channels)) config.channels = value.channels;
  return config;
}
