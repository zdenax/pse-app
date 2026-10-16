// etherchannel: the Cisco IOS commands of link aggregation (see etherchannel.ts for the rules).
//
//   interface port-channel N        the logical interface; switchport, trunk, description, shutdown
//                                   and (routers) ip address are written through to the members
//   channel-group N mode active|passive|on|desirable|auto      (physical port or range)
//   no channel-group
//   show etherchannel summary | port-channel
//   show interfaces port-channel N [switchport | trunk | status | description]
//
// Only the Cisco dialects ("ios", "generic"); Dell OS9 keeps its notice. The configuration is
// Device.protocols.lacp (core/protocols/layer2.ts). Rule for feature modules (features/
// ios-commands.ts): values from ../../ios-engine, ../../ios-show etc. are used only inside
// functions, never at module top level.

import {
  closedRange,
  kw,
  num,
  padded,
  trimmingTrailingWhitespace,
  type CommandHandler,
  type CommandNode,
  type ParsedCommand,
} from "../../command-tree";
import type { IOSEngine } from "../../ios-engine";
import * as Show from "../../ios-show";
import { makePortSnapshot, parseL3Interface, type DeviceAccess, type PortSnapshot } from "../../model-access";
import { Notices } from "../../notices";
import type { ChannelMode } from "../../../core/protocols/layer2";
import type { IOSFeature, IOSFeatureCommands } from "../ios-commands";
import {
  channelLabel,
  channelsOfDevice,
  protocolOf,
  type ChannelInfo,
  type ChannelMember,
  type MemberState,
} from "./etherchannel";
import {
  channelPortID,
  channelRecord,
  createChannel,
  groupOfPort,
  joinChannel,
  lacpOf,
  leaveChannel,
  maxChannelGroup,
  removeChannel,
} from "./etherchannel-store";

// MARK: Messages

function creating(group: number): string {
  return `Creating a port-channel interface Port-channel ${group}`;
}

const notOnChannel = "NetSketch: příkaz channel-group patří na fyzický port, ne na port-channel. Nic se nezměnilo.";

function mixedProtocols(group: number, existing: ChannelMode, wanted: ChannelMode): string {
  return (
    `NetSketch: skupina ${group} už používá mód ${existing}; členové jedné skupiny musí mít stejný protokol ` +
    `(LACP, PAgP nebo on), ${wanted} nelze přidat. Nic se nezměnilo.`
  );
}

export const noChannelYet = (group: number): string =>
  `NetSketch: ${channelLabel(group)} neexistuje. Vytvoří ho „interface port-channel ${group}“ nebo „channel-group ${group} mode …“.`;

// MARK: The logical interface as a port

function shortName(group: number): string {
  return `Po${group}`;
}

/**
 * `interface port-channel N` as a PortSnapshot with the id "po:N", so the ordinary interface
 * commands and show commands work on it. It is up when at least one member is bundled; its
 * peer is the neighbour of the bundle.
 */
export function portChannelSnapshot(access: DeviceAccess, group: number): PortSnapshot | null {
  const device = access.device;
  const record = channelRecord(device, group);
  if (!device || !record) return null;
  const info = channelsOfDevice(access.store.project, device).find((candidate) => candidate.group === group);
  const bundled = info?.members.find((member) => member.state === "bundled");
  const peerDevice = bundled?.peerDeviceID
    ? access.store.project.devices.find((candidate) => candidate.id === bundled.peerDeviceID)
    : undefined;
  const peerPort = peerDevice?.ports.find((port) => port.id === bundled?.peerPortID);
  const first = info?.members[0] ? device.ports.find((port) => port.id === info.members[0].portID) : undefined;
  return makePortSnapshot({
    id: channelPortID(group),
    name: channelLabel(group),
    description: record.description,
    vlanText: record.vlan,
    adminDown: record.adminDown,
    speed: first?.speed ?? "",
    connector: "RJ45",
    peer:
      peerDevice && peerPort
        ? {
            hostname: peerDevice.hostname,
            vendor: peerDevice.vendor,
            model: peerDevice.model,
            category: peerDevice.category,
            portName: peerPort.name,
            adminDown: peerPort.adminDown,
          }
        : null,
  });
}

/** Every logical interface of the console's device, in group order. */
export function portChannelSnapshots(access: DeviceAccess): PortSnapshot[] {
  const channels = lacpOf(access.device).channels ?? [];
  return channels
    .map((channel) => portChannelSnapshot(access, channel.group))
    .filter((snapshot): snapshot is PortSnapshot => snapshot !== null);
}

// MARK: Entering, removing

/** `interface port-channel N` on Cisco: creates the logical interface and enters its mode. */
export function enterPortChannel(engine: IOSEngine, group: number): string {
  createChannel(engine.access.store, engine.access.deviceID, group);
  engine.mode = {
    kind: "interface",
    selection: { target: { kind: "portChannel", number: group }, isRange: false, promptLabel: `po-${group}` },
  };
  return "";
}

/** `no interface port-channel N`: the interface and the channel-group lines of its members. */
export function removePortChannel(engine: IOSEngine, group: number): string {
  if (!channelRecord(engine.access.device, group)) return noChannelYet(group);
  engine.access.transaction(() => removeChannel(engine.access.store, engine.access.deviceID, group));
  return "";
}

// MARK: channel-group

function channelGroupHandler(mode: ChannelMode): CommandHandler {
  return (engine, command) => {
    const group = command.int("group");
    if (group === null) return "";
    const selection = engine.mode.kind === "interface" ? engine.mode.selection : null;
    if (selection === null || selection.target.kind !== "ports") return notOnChannel;
    const ports = engine.selectedPorts();
    if (ports.length === 0) {
      engine.mode = { kind: "globalConfig" };
      return Notices.interfaceGone;
    }
    const access = engine.access;
    const messages: string[] = [];
    const joined: string[] = [];
    access.transaction(() => {
      for (const port of ports) {
        const device = access.device;
        if (!device) return;
        if (!port.isSwitchport) {
          messages.push(Notices.managementPort);
          continue;
        }
        const others = lacpOf(device).members.filter((member) => member.group === group && member.port !== port.id);
        if (others.length > 0 && protocolOf(others[0].mode) !== protocolOf(mode)) {
          messages.push(mixedProtocols(group, others[0].mode, mode));
          continue;
        }
        if (joinChannel(access.store, access.deviceID, port.id, group, mode) && messages.indexOf(creating(group)) < 0) {
          messages.unshift(creating(group));
        }
        joined.push(port.id);
      }
    });
    messages.push(...mismatchNotes(engine, group, joined));
    return messages.join("\n");
  };
}

/** The mismatches of the just configured ports with their neighbours (modes, groups). */
function mismatchNotes(engine: IOSEngine, group: number, portIDs: string[]): string[] {
  const device = engine.access.device;
  if (!device) return [];
  const info = channelsOfDevice(engine.access.store.project, device).find((candidate) => candidate.group === group);
  if (!info) return [];
  const notes: string[] = [];
  for (const member of info.members) {
    if (!portIDs.includes(member.portID) || member.reason === null || !isMismatch(member.reason)) continue;
    const port = device.ports.find((candidate) => candidate.id === member.portID);
    const name = port ? engine.namer.shortName(port.name) : "?";
    notes.push(
      `NetSketch: ${name} nevytvoří svazek: ${member.reason}. ` +
        (member.state === "suspended" ? "Port je pozastaven (s)." : "Port zůstává samostatný (I)."),
    );
  }
  return notes;
}

function isMismatch(reason: string): boolean {
  return reason.startsWith("nesoulad") || reason.startsWith("vede k jinému");
}

function noChannelGroup(engine: IOSEngine): string {
  const selection = engine.mode.kind === "interface" ? engine.mode.selection : null;
  if (selection === null || selection.target.kind !== "ports") return notOnChannel;
  const ports = engine.selectedPorts();
  if (ports.length === 0) {
    engine.mode = { kind: "globalConfig" };
    return Notices.interfaceGone;
  }
  const access = engine.access;
  access.transaction(() => {
    for (const port of ports) leaveChannel(access.store, access.deviceID, port.id);
  });
  return "";
}

function channelGroupNode(): CommandNode {
  return kw("channel-group", "Etherchannel/port bundling configuration", [
    num("group", closedRange(1, maxChannelGroup), "Channel group number", [
      kw("mode", "Etherchannel Mode of the interface", [
        kw("active", "Enable LACP unconditionally", [], channelGroupHandler("active")),
        kw("passive", "Enable LACP only if a LACP device is detected", [], channelGroupHandler("passive")),
        kw("on", "Enable Etherchannel only", [], channelGroupHandler("on")),
        kw("auto", "Enable PAgP only if a PAgP device is detected", [], channelGroupHandler("auto")),
        kw("desirable", "Enable PAgP unconditionally", [], channelGroupHandler("desirable")),
      ]),
    ]),
  ]);
}

function noChannelGroupNode(): CommandNode {
  return kw("channel-group", "Etherchannel/port bundling configuration", [], (engine) => noChannelGroup(engine));
}

// MARK: show etherchannel

const stateFlag: Record<MemberState, string> = { bundled: "P", down: "D", standalone: "I", suspended: "s" };

function protocolText(info: ChannelInfo): string {
  if (info.members.length === 0) return "-";
  return info.protocol === "lacp" ? "LACP" : info.protocol === "pagp" ? "PAgP" : "-";
}

function isRoutedDevice(engine: IOSEngine): boolean {
  const category = engine.access.category;
  return category === "router";
}

function channelFlags(engine: IOSEngine, info: ChannelInfo): string {
  return (isRoutedDevice(engine) ? "R" : "S") + (info.up && !info.config?.adminDown ? "U" : "D");
}

function memberNames(engine: IOSEngine, info: ChannelInfo): string {
  const device = engine.access.device;
  return info.members
    .map((member) => {
      const port = device?.ports.find((candidate) => candidate.id === member.portID);
      return `${engine.namer.shortName(port?.name ?? "?")}(${stateFlag[member.state]})`;
    })
    .join("  ");
}

const flagsLegend = [
  "Flags:  D - down        P - bundled in port-channel",
  "        I - stand-alone s - suspended",
  "        H - Hot-standby (LACP only)",
  "        R - Layer3      S - Layer2",
  "        U - in use      f - failed to allocate aggregator",
  "",
  "        M - not in use, minimum links not met",
  "        u - unsuitable for bundling",
  "        w - waiting to be aggregated",
  "        d - default port",
  "",
];

function channelsOf(engine: IOSEngine): ChannelInfo[] {
  const device = engine.access.device;
  return device ? channelsOfDevice(engine.access.store.project, device) : [];
}

/** `show etherchannel summary`. */
export function showEtherchannelSummary(engine: IOSEngine, command: ParsedCommand): string {
  const channels = channelsOf(engine);
  // Nothing configured, but bundles drawn in the diagram: the older listing of them.
  if (channels.length === 0 && engine.access.bundles.length > 0) return Show.showEtherchannelSummary(engine, command);
  const lines = [...flagsLegend, ""];
  lines.push(`Number of channel-groups in use: ${channels.length}`);
  lines.push(`Number of aggregators:           ${channels.length}`, "");
  lines.push("Group  Port-channel  Protocol    Ports");
  lines.push("------+-------------+-----------+-----------------------------------------------");
  for (const info of channels) {
    lines.push(
      padded(`${info.group}`, 7) +
        padded(`${shortName(info.group)}(${channelFlags(engine, info)})`, 14) +
        padded(protocolText(info), 12) +
        memberNames(engine, info),
    );
  }
  const problems = channels.flatMap((info) => info.problems.map((text) => `${shortName(info.group)}: ${text}`));
  if (problems.length > 0) {
    lines.push("");
    for (const text of problems) lines.push(`NetSketch: ${text}`);
  }
  return lines.map(trimmingTrailingWhitespace).join("\n");
}

/** `show etherchannel port-channel`: one block per channel. */
export function showEtherchannelPortChannel(engine: IOSEngine, _command: ParsedCommand): string {
  const channels = channelsOf(engine);
  if (channels.length === 0) return "";
  const lines: string[] = [];
  for (const info of channels) {
    lines.push(
      `                Port-channels in the group: ${info.group}`,
      "                ----------------------------------",
      "",
      `Port-channel: ${shortName(info.group)}    (Primary Aggregator)`,
      "",
      "------------",
      "",
      `Age of the Port-channel   = ${info.up ? "up" : "down"}`,
      `Logical slot/port   = 0/${info.group}          Number of ports = ${info.members.filter((m) => m.state === "bundled").length}`,
      `Port state          = Port-channel ${info.up ? "Ag-Inuse" : "Ag-Not-Inuse"}`,
      `Protocol            = ${protocolText(info)}`,
      "",
      `Ports in the Port-channel: ${memberNames(engine, info)}`,
      "",
    );
  }
  return lines.map(trimmingTrailingWhitespace).join("\n");
}

/** The lines `show interfaces port-channel N` adds to the common status line. */
export function channelInterfaceLines(engine: IOSEngine, group: number): string[] {
  const info = channelsOf(engine).find((candidate) => candidate.group === group);
  if (!info || info.members.length === 0) return ["  Members in this channel: (none)"];
  const lines = [
    `  Members in this channel: ${info.members
      .map((member) => engine.namer.shortName(memberPortName(engine, member)))
      .join(" ")}`,
  ];
  const bundled = info.members.filter((member) => member.state === "bundled").length;
  lines.push(`  Active members: ${bundled} of ${info.members.length}, protocol ${protocolText(info)}`);
  for (const problem of info.problems) lines.push(`  NetSketch: ${problem}`);
  return lines;
}

function memberPortName(engine: IOSEngine, member: ChannelMember): string {
  return engine.access.device?.ports.find((port) => port.id === member.portID)?.name ?? "?";
}

// MARK: running-config

function interfaceLines(engine: IOSEngine, interfaceID: string): string[] {
  const parsed = parseL3Interface(interfaceID);
  const device = engine.access.device;
  if (parsed?.kind !== "port" || !device) return [];
  const member = groupOfPort(device, parsed.id);
  return member ? [` channel-group ${member.group} mode ${member.mode}`] : [];
}

/** `interface Port-channelN` blocks (after the physical interfaces). */
function globalBlocks(engine: IOSEngine): string[][] {
  return portChannelSnapshots(engine.access).map((snapshot) => Show.interfaceConfigLines(engine, snapshot));
}

// MARK: The feature

export const etherchannelIOS: IOSFeature = (dialect): IOSFeatureCommands => {
  if (dialect !== "ios" && dialect !== "generic") return {};
  return {
    show: [
      kw("etherchannel", "EtherChannel information", [
        kw("summary", "One-line summary per channel-group", [], (engine, command) =>
          showEtherchannelSummary(engine, command),
        ),
        kw("port-channel", "Port-channel information", [], (engine, command) =>
          showEtherchannelPortChannel(engine, command),
        ),
      ]),
    ],
    interface: [channelGroupNode()],
    interfaceNo: [noChannelGroupNode()],
    config: { interfaceLines, globalBlocks },
  };
};
