// Writes of the EtherChannel configuration (Device.protocols.lacp) and of the logical interface
// `interface port-channel N`. The channel keeps its own settings (switchport text, description,
// shutdown) and writes them through to its member ports, so the simulation, which reads only
// physical ports, sees the members behave like the channel. Core types only: model-access.ts
// uses this module, so it must not import the CLI.

import type { Device, Port, PortRef } from "../../../core/model";
import { cloneProtocols } from "../../../core/protocols";
import type { ChannelMode, LACPConfig, PortChannelConfig } from "../../../core/protocols/layer2";
import { readLACPConfig } from "../../../core/protocols/layer2";
import type { ProjectStoreAPI } from "../../../core/store-api";

/** The id the console gives the pseudo-port of `interface port-channel N` ("po:<N>"). */
const prefix = "po:";

export function channelPortID(group: number): string {
  return prefix + group;
}

/** The group number of a pseudo-port id, or null for a real port id. */
export function groupOfPortID(id: string): number | null {
  if (!id.startsWith(prefix)) return null;
  const group = Number(id.slice(prefix.length));
  return Number.isInteger(group) && group >= 1 ? group : null;
}

export const maxChannelGroup = 4096;

export function lacpOf(device: Device | null | undefined): LACPConfig {
  return readLACPConfig(device?.protocols?.lacp ?? {}) ?? { members: [] };
}

export function channelRecord(device: Device | null | undefined, group: number): PortChannelConfig | undefined {
  return lacpOf(device).channels?.find((channel) => channel.group === group);
}

/** The ports of the device that are members of the group, in panel order. */
export function memberPorts(device: Device, group: number): Port[] {
  const members = lacpOf(device).members.filter((member) => member.group === group);
  return device.ports.filter((port) => members.some((member) => member.port === port.id));
}

export function groupOfPort(device: Device, portID: string): { group: number; mode: ChannelMode } | undefined {
  const member = lacpOf(device).members.find((candidate) => candidate.port === portID);
  return member ? { group: member.group, mode: member.mode } : undefined;
}

function deviceOf(store: ProjectStoreAPI, deviceID: string): Device | undefined {
  return store.project.devices.find((device) => device.id === deviceID);
}

/** Reads, changes and writes back the LACP configuration; an empty one is removed. */
function updateLACP(store: ProjectStoreAPI, deviceID: string, change: (config: LACPConfig) => void): void {
  const device = deviceOf(store, deviceID);
  if (!device) return;
  const protocols = cloneProtocols(device.protocols);
  const config = lacpOf(device);
  change(config);
  if (config.channels !== undefined && config.channels.length === 0) delete config.channels;
  protocols.lacp = config.members.length === 0 && config.channels === undefined ? undefined : config;
  store.setProtocols(deviceID, protocols);
}

function ref(deviceID: string, port: Port): PortRef {
  return { deviceID, portID: port.id };
}

function ensure(config: LACPConfig, group: number): { record: PortChannelConfig; created: boolean } {
  const channels = (config.channels ??= []);
  const found = channels.find((channel) => channel.group === group);
  if (found) return { record: found, created: false };
  const record: PortChannelConfig = { group, vlan: "", description: "", adminDown: false };
  channels.push(record);
  channels.sort((a, b) => a.group - b.group);
  return { record, created: true };
}

/** `interface port-channel N`: creates the logical interface; true when it did not exist. */
export function createChannel(store: ProjectStoreAPI, deviceID: string, group: number): boolean {
  let created = false;
  updateLACP(store, deviceID, (config) => {
    created = ensure(config, group).created;
  });
  return created;
}

/** `no interface port-channel N`: the channel and the channel-group lines of its members go. */
export function removeChannel(store: ProjectStoreAPI, deviceID: string, group: number): void {
  updateLACP(store, deviceID, (config) => {
    config.channels = (config.channels ?? []).filter((channel) => channel.group !== group);
    config.members = config.members.filter((member) => member.group !== group);
  });
}

/**
 * `channel-group N mode M` on a port. The port leaves its former group; the channel is created
 * when missing and the port takes over its switchport text (the first member defines the text of a
 * channel that has none yet). Returns whether the channel was created.
 */
export function joinChannel(
  store: ProjectStoreAPI,
  deviceID: string,
  portID: string,
  group: number,
  mode: ChannelMode,
): boolean {
  let created = false;
  let text = "";
  let down = false;
  updateLACP(store, deviceID, (config) => {
    config.members = config.members.filter((member) => member.port !== portID);
    config.members.push({ port: portID, group, mode });
    const ensured = ensure(config, group);
    created = ensured.created;
    if (ensured.record.vlan === "") {
      ensured.record.vlan = deviceOf(store, deviceID)?.ports.find((port) => port.id === portID)?.vlan ?? "";
    }
    text = ensured.record.vlan;
    down = ensured.record.adminDown;
  });
  const port = deviceOf(store, deviceID)?.ports.find((candidate) => candidate.id === portID);
  if (port) {
    if (port.vlan !== text) store.setPortVLAN(ref(deviceID, port), text);
    if (down && !port.adminDown) store.setPortAdminDown(ref(deviceID, port), true);
  }
  return created;
}

/** `no channel-group` on a port; true when it was a member. */
export function leaveChannel(store: ProjectStoreAPI, deviceID: string, portID: string): boolean {
  const device = deviceOf(store, deviceID);
  if (!device || !groupOfPort(device, portID)) return false;
  updateLACP(store, deviceID, (config) => {
    config.members = config.members.filter((member) => member.port !== portID);
  });
  return true;
}

/** Settings of the logical interface; they are written through to the member ports. */
export function setChannelVLAN(store: ProjectStoreAPI, deviceID: string, group: number, text: string): void {
  updateLACP(store, deviceID, (config) => {
    ensure(config, group).record.vlan = text;
  });
  const device = deviceOf(store, deviceID);
  if (!device) return;
  for (const port of memberPorts(device, group)) {
    if (port.vlan !== text) store.setPortVLAN(ref(deviceID, port), text);
  }
}

export function setChannelDescription(store: ProjectStoreAPI, deviceID: string, group: number, text: string): void {
  updateLACP(store, deviceID, (config) => {
    ensure(config, group).record.description = text;
  });
}

export function setChannelAdminDown(store: ProjectStoreAPI, deviceID: string, group: number, down: boolean): void {
  updateLACP(store, deviceID, (config) => {
    ensure(config, group).record.adminDown = down;
  });
  const device = deviceOf(store, deviceID);
  if (!device) return;
  for (const port of memberPorts(device, group)) {
    if (port.adminDown !== down) store.setPortAdminDown(ref(deviceID, port), down);
  }
}

/** The member whose address stands for the channel's (routers): the first in panel order. */
export function leadPort(device: Device, group: number): Port | undefined {
  return memberPorts(device, group)[0];
}
