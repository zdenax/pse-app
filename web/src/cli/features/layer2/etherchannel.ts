// EtherChannel (Cisco port-channel, LACP, PAgP and static "on") in the network simulation:
// which member ports form a bundle with the neighbour and which do not. A pure function of the
// project, like the spanning tree (stp.ts), so the console, the simulation and the tree agree.
//
// Configuration (Device.protocols.lacp, core/protocols/layer2.ts):
//  - `members`: `channel-group N mode M` of a physical port;
//  - `channels`: the logical interface `interface port-channel N` (switchport text, description,
//    shutdown). The simulation does not read it directly: the console writes the settings of the
//    channel through to its members (etherchannel-config.ts), so a member behaves like the channel.
//
// Rules of a bundle (one local group against one neighbour group):
//  - a member counts only when its cable is up (cabled, neither end shut down);
//  - the neighbour port must be a member of a group on the neighbour too, and the two modes must
//    be compatible: active-active, active-passive, desirable-desirable, desirable-auto, on-on.
//    passive-passive, auto-auto and LACP against PAgP never negotiate; "on" talks only to "on";
//  - all members of a group must lead to the same neighbour device and neighbour group.
// A bundle that does not form: dynamic members (LACP, PAgP) work as individual ports ("I",
// stand-alone), static members ("on") are suspended ("s", EtherChannel misconfig guard) and carry
// nothing. Each such member gets a reason and the channel a problem text (Czech) for the console.

import type { Device, Port, Project } from "../../../core/model";
import type { ChannelMode, LACPConfig, PortChannelConfig } from "../../../core/protocols/layer2";
import { readLACPConfig } from "../../../core/protocols/layer2";

export type ChannelProtocol = "lacp" | "pagp" | "static";

export function protocolOf(mode: ChannelMode): ChannelProtocol {
  if (mode === "active" || mode === "passive") return "lacp";
  if (mode === "desirable" || mode === "auto") return "pagp";
  return "static";
}

/**
 * Whether two ends negotiate a bundle. LACP: at least one end active. PAgP: at least one end
 * desirable. Static: both "on". Different protocols never.
 */
export function modesCompatible(a: ChannelMode, b: ChannelMode): boolean {
  const protocol = protocolOf(a);
  if (protocol !== protocolOf(b)) return false;
  switch (protocol) {
    case "lacp":
      return a === "active" || b === "active";
    case "pagp":
      return a === "desirable" || b === "desirable";
    case "static":
      return true;
  }
}

/**
 * bundled: carries traffic as a part of the port-channel (P); down: no cable, or one end shut
 * down (D); standalone: works as an ordinary port because the bundle did not form (I);
 * suspended: carries nothing (s).
 */
export type MemberState = "bundled" | "down" | "standalone" | "suspended";

export interface ChannelMember {
  portID: string;
  mode: ChannelMode;
  state: MemberState;
  /** Why the member is not bundled (Czech sentence without final period), or null. */
  reason: string | null;
  /** The cabled port at the other end and its device, when there is a cable. */
  peerDeviceID: string | null;
  peerPortID: string | null;
}

export interface ChannelInfo {
  deviceID: string;
  group: number;
  protocol: ChannelProtocol;
  /** In order of the device's ports. */
  members: ChannelMember[];
  /** The neighbour device and its group of the bundled members, or null when nothing bundles. */
  peerDeviceID: string | null;
  peerGroup: number | null;
  /** At least one member is bundled: the port-channel is up. */
  up: boolean;
  /** Everything that keeps members out of the bundle, one sentence each. */
  problems: string[];
  /** The `interface port-channel N` record, when it exists. */
  config: PortChannelConfig | undefined;
}

function lacpOf(device: Device | undefined): LACPConfig | undefined {
  const raw = device?.protocols?.lacp;
  return raw === undefined ? undefined : (readLACPConfig(raw) ?? undefined);
}

/** Cheap check for the simulation: does the port belong to a channel-group? */
export function isChannelMember(device: Device, portID: string): boolean {
  return device.protocols?.lacp?.members?.some((member) => member.port === portID) === true;
}

function findPort(device: Device | undefined, id: string): Port | undefined {
  return device?.ports.find((port) => port.id === id);
}

export function channelLabel(group: number): string {
  return `Port-channel${group}`;
}

/**
 * The channel-groups of one device. `lookup` resolves devices of the project; the neighbour's
 * configuration is read only for the ports cabled to members.
 */
export function channelsOfDevice(project: Project, device: Device): ChannelInfo[] {
  const config = lacpOf(device);
  if (!config) return [];
  const devices = new Map<string, Device>();
  for (const candidate of project.devices) if (!devices.has(candidate.id)) devices.set(candidate.id, candidate);
  const farEnd = (portID: string): { device: Device; port: Port } | null => {
    for (const link of project.links) {
      let other = null;
      if (link.a.deviceID === device.id && link.a.portID === portID) other = link.b;
      else if (link.b.deviceID === device.id && link.b.portID === portID) other = link.a;
      if (!other) continue;
      const owner = devices.get(other.deviceID);
      const port = findPort(owner, other.portID);
      return owner && port ? { device: owner, port } : null;
    }
    return null;
  };

  const groups = new Set<number>([...config.members.map((member) => member.group), ...(config.channels ?? []).map((c) => c.group)]);
  const result: ChannelInfo[] = [];
  for (const group of [...groups].sort((a, b) => a - b)) {
    const entries = device.ports
      .map((port) => ({ port, member: config.members.find((candidate) => candidate.port === port.id && candidate.group === group) }))
      .filter((entry): entry is { port: Port; member: LACPConfig["members"][number] } => entry.member !== undefined);
    const members: ChannelMember[] = entries.map(({ port, member }) => {
      const far = farEnd(port.id);
      return {
        portID: port.id,
        mode: member.mode,
        state: "down",
        reason: null,
        peerDeviceID: far?.device.id ?? null,
        peerPortID: far?.port.id ?? null,
      };
    });
    const info: ChannelInfo = {
      deviceID: device.id,
      group,
      protocol: members.length > 0 ? protocolOf(members[0].mode) : "lacp",
      members,
      peerDeviceID: null,
      peerGroup: null,
      up: false,
      problems: [],
      config: config.channels?.find((candidate) => candidate.group === group),
    };

    // Cable state, and which neighbour group each cabled member leads to.
    interface Candidate {
      member: ChannelMember;
      key: string;
      peerGroup: number | null;
      peerMode: ChannelMode | null;
    }
    const candidates: Candidate[] = [];
    entries.forEach(({ port }, index) => {
      const member = members[index];
      const far = farEnd(port.id);
      if (!far) {
        member.reason = "bez kabelu";
        return;
      }
      if (port.adminDown || far.port.adminDown) {
        member.reason = port.adminDown ? "port je vypnutý (shutdown)" : "druhý konec je vypnutý (shutdown)";
        return;
      }
      const peerMember = lacpOf(far.device)?.members.find((candidate) => candidate.port === far.port.id);
      candidates.push({
        member,
        key: `${far.device.id}|${peerMember?.group ?? "-"}`,
        peerGroup: peerMember?.group ?? null,
        peerMode: peerMember?.mode ?? null,
      });
    });

    // The first cabled member decides which neighbour group the bundle leads to.
    const lead = candidates[0];
    const names = (member: ChannelMember): string => findPort(device, member.portID)?.name ?? "?";
    for (const candidate of candidates) {
      const { member } = candidate;
      let reason: string | null = null;
      if (candidate.peerGroup === null || candidate.peerMode === null) {
        reason = "druhý konec nemá channel-group";
      } else if (!modesCompatible(member.mode, candidate.peerMode)) {
        reason = `nesoulad módů: zde ${member.mode}, na druhém konci ${candidate.peerMode}`;
      } else if (candidate.key !== lead.key) {
        reason = "vede k jinému sousedovi nebo jiné skupině než ostatní členové";
      }
      if (reason === null) {
        member.state = "bundled";
        info.peerDeviceID = member.peerDeviceID;
        info.peerGroup = candidate.peerGroup;
      } else {
        member.reason = reason;
        member.state = protocolOf(member.mode) === "static" ? "suspended" : "standalone";
        info.problems.push(`${names(member)}: ${reason}`);
      }
    }
    info.up = members.some((member) => member.state === "bundled");
    result.push(info);
  }
  return result;
}

/** The channel-groups of every device of the project, in device order. */
export function computeChannels(project: Project): ChannelInfo[] {
  return project.devices.flatMap((device) => channelsOfDevice(project, device));
}

/** The state of one member port in the project, or undefined for a port without channel-group. */
export function memberStateOf(project: Project, device: Device, portID: string): ChannelMember | undefined {
  if (!isChannelMember(device, portID)) return undefined;
  for (const info of channelsOfDevice(project, device)) {
    const found = info.members.find((member) => member.portID === portID);
    if (found) return found;
  }
  return undefined;
}

/** Why a port carries nothing because of EtherChannel (a suspended static member), or null. */
export function channelPortDown(project: Project, device: Device, port: Port): string | null {
  if (!isChannelMember(device, port.id)) return null;
  const member = memberStateOf(project, device, port.id);
  if (!member || member.state !== "suspended") return null;
  return `EtherChannel: port je pozastaven (${member.reason ?? "svazek nevznikl"}).`;
}
