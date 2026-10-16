// The data model behind the UniFi Switch 48 console (FASTPATH CLI): port numbering, the
// per-VLAN membership of a port and the management interface.
//
// Port mapping. The switch CLI calls ports 0/1 ... 0/52, the catalog Port 1-48 (RJ45), SFP 1-2
// and SFP+ 1-2. `0/N` is the N-th port of the device in catalog order (groups in order, console
// jacks left out), so 0/1-0/48 = Port 1-48, 0/49 = SFP 1, 0/50 = SFP 2, 0/51 = SFP+ 1,
// 0/52 = SFP+ 2.
//
// VLANs. The diagram stores one `switchport` text per port (cli/switchport.ts: access / trunk +
// native), FASTPATH has a membership (include / exclude, tagged / untagged) per VLAN and port plus
// a PVID. The membership is kept here as a shadow per port; after every change it is projected
// onto the switchport text, which is what the simulation reads (see `project`). When the text is
// changed from elsewhere (inspector, another console) the shadow is rebuilt from it.
//
// Management interface. It is the SVI `vlan:<N>` of the diagram with the address of the switch;
// N is the management VLAN: the VLAN with a stored address or DHCP client mark (default 1).

import type { Device } from "../core/model";
import { dhcpOf } from "./features/dhcp/model";
import type { DeviceAccess, PortSnapshot } from "./model-access";
import { SwitchportConfig } from "./switchport";

export const unifiTemplateID = "ubiquiti-us-48-g1";
export const unifiFirmware = "7.2.123";

// MARK: Ports

/** The ports of the device with their CLI names, in panel order. */
export function cliPorts(access: DeviceAccess): { name: string; port: PortSnapshot }[] {
  return access.interfaces.map((port, index) => ({ name: `0/${index + 1}`, port }));
}

export function findCliPort(access: DeviceAccess, name: string): { name: string; port: PortSnapshot } | null {
  return cliPorts(access).find((entry) => entry.name === name) ?? null;
}

// MARK: Membership shadow

export type Tagging = "untagged" | "tagged";

export interface PortMembership {
  /** Included VLANs (VLAN id -> tagging); a VLAN that is absent is excluded. */
  members: Map<number, Tagging>;
  pvid: number;
  /** The switchport text this state was projected to. */
  projected: string;
}

const shadows = new Map<string, Map<string, PortMembership>>();

function knownVLANs(device: Device): number[] {
  return [...new Set([1, ...device.vlans.map((entry) => entry.id)])].sort((a, b) => a - b);
}

function seed(device: Device, text: string): PortMembership {
  const config = SwitchportConfig.parse(text) ?? new SwitchportConfig();
  const members = new Map<number, Tagging>();
  if (config.mode === "trunk") {
    for (const vlan of config.allowedVLANs ?? knownVLANs(device)) {
      members.set(vlan, vlan === config.nativeVLAN ? "untagged" : "tagged");
    }
    return { members, pvid: config.nativeVLAN, projected: text };
  }
  members.set(config.accessVLAN, "untagged");
  return { members, pvid: config.accessVLAN, projected: text };
}

/** The membership of a port (rebuilt from the diagram when its text changed behind our back). */
export function membershipOf(device: Device, portID: string): PortMembership {
  let perDevice = shadows.get(device.id);
  if (!perDevice) {
    perDevice = new Map();
    shadows.set(device.id, perDevice);
  }
  const text = device.ports.find((port) => port.id === portID)?.vlan ?? "";
  let state = perDevice.get(portID);
  if (!state || state.projected !== text) {
    state = seed(device, text);
    perDevice.set(portID, state);
  }
  return state;
}

/** The switchport text of a membership: access when nothing is tagged, otherwise a trunk. */
export function projectText(state: PortMembership): string {
  const config = new SwitchportConfig();
  const tagged = [...state.members].filter(([, tagging]) => tagging === "tagged").map(([vlan]) => vlan);
  const untagged = [...state.members].filter(([, tagging]) => tagging === "untagged").map(([vlan]) => vlan);
  if (tagged.length === 0 && untagged.length > 0) {
    config.mode = "access";
    config.accessVLAN = untagged.includes(state.pvid) ? state.pvid : Math.min(...untagged);
  } else if (tagged.length === 0) {
    config.mode = "trunk";
    config.allowedVLANs = [];
    config.nativeVLAN = state.pvid;
  } else {
    config.mode = "trunk";
    config.allowedVLANs = [...new Set([...tagged, ...untagged])].sort((a, b) => a - b);
    config.nativeVLAN = state.pvid;
  }
  return config.canonicalText;
}

/** Writes the membership of one port to the diagram (the switchport text). */
export function project(access: DeviceAccess, portID: string, state: PortMembership): boolean {
  const text = projectText(state);
  const ok = access.setVLANText(text, portID);
  if (ok) {
    state.projected = text;
    let perDevice = shadows.get(access.deviceID);
    if (!perDevice) {
      perDevice = new Map();
      shadows.set(access.deviceID, perDevice);
    }
    perDevice.set(portID, state);
  }
  return ok;
}

/** A VLAN was deleted: every port forgets it. */
export function forgetVLAN(access: DeviceAccess, vlan: number): void {
  const device = access.device;
  if (!device) return;
  for (const { port } of cliPorts(access)) {
    const state = membershipOf(device, port.id);
    if (!state.members.has(vlan) && state.pvid !== vlan) continue;
    state.members.delete(vlan);
    if (state.pvid === vlan) state.pvid = 1;
    project(access, port.id, state);
  }
}

// MARK: Management interface

export function mgmtInterface(vlan: number): string {
  return `vlan:${vlan}`;
}

/** The management VLAN: the one with an address or a DHCP client mark, default 1. */
export function mgmtVLAN(access: DeviceAccess): number {
  for (const entry of access.addresses) {
    const match = /^vlan:(\d+)$/.exec(entry.interface);
    if (match) return Number(match[1]);
  }
  for (const client of dhcpOf(access.device)?.clients ?? []) {
    const match = /^vlan:(\d+)$/.exec(client);
    if (match) return Number(match[1]);
  }
  return 1;
}
