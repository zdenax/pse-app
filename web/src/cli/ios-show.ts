// `show` output of the IOS dialect. Port of IOSShow.swift (extension of IOSEngine).
//
// Everything printed here follows from static data of the diagram (ports, their texts, the
// shutdown flag, drawn cables and bundles, the VLAN table). Columns copy the real IOS layout;
// fields a real switch would learn from a running protocol are either left out or replaced by
// the configured value, and a NetSketch line says so.

import { featureGlobalBlocks, featureInterfaceLines } from "./features/ios-commands";
import type { DeviceCategory } from "../core/model";
import {
  charCount,
  column,
  isNewline,
  leftPadded,
  padded,
  ParsedCommand,
  splitCharacters,
  trimmingTrailingWhitespace,
  trimWhitespaces,
  VLANListParser,
} from "./command-tree";
import { dellInterfaceConfigLines, dellInterfacesDescription, dellInterfacesStatus, dellLLDPNeighbors, dellRunningConfig, dellShowVLAN } from "./dell-show";
import type { IOSEngine } from "./ios-engine";
import { InterfaceNamer } from "./interface-naming";
import { addressLine, globalIPLines, ipInterfaceRows, sviConfigBlocks } from "./ios-network";
import { l3Port, PeerSnapshot, PortSnapshot } from "./model-access";
import { Notices } from "./notices";
import { NetworkSimulator } from "./sim/network-simulator";
import type { SwitchportConfig } from "./switchport";

export interface VLANRow {
  readonly id: number;
  readonly name: string;
}

// MARK: Shared lookups

export function defaultVLANName(id: number): string {
  return id === 1 ? "default" : "VLAN" + "0".repeat(Math.max(0, 4 - String(id).length)) + String(id);
}

/** The VLAN table with the implicit VLAN 1 and default names filled in, sorted by number. */
export function vlanRows(engine: IOSEngine): VLANRow[] {
  const rows: VLANRow[] = [];
  let hasDefault = false;
  for (const entry of engine.access.vlans) {
    if (entry.id < 1 || entry.id > 4094) continue;
    if (entry.id === 1) hasDefault = true;
    const name = trimWhitespaces(entry.name);
    rows.push({ id: entry.id, name: name === "" ? defaultVLANName(entry.id) : name });
  }
  if (!hasDefault) rows.push({ id: 1, name: "default" });
  return rows.sort((a, b) => a.id - b.id);
}

export function vlanName(engine: IOSEngine, id: number): string | null {
  return vlanRows(engine).find((row) => row.id === id)?.name ?? null;
}

/** One-line form of a free text (inspector texts may contain line breaks). */
export function singleLine(text: string): string {
  return splitCharacters(text, isNewline).join(" ");
}

function statusWord(port: PortSnapshot): string {
  switch (port.linkState) {
    case "adminDown":
      return "disabled";
    case "up":
      return "connected";
    case "down":
      return "notconnect";
  }
}

function mediaType(port: PortSnapshot): string {
  switch (port.connector) {
    case "RJ45":
    case "mgmt":
      switch (port.speed.toUpperCase()) {
        case "10M":
          return "10BaseT";
        case "100M":
          return "10/100BaseTX";
        case "1G":
          return "10/100/1000BaseTX";
        default:
          return port.speed === "" ? "RJ45" : `RJ45 ${port.speed}`;
      }
    case "SFP":
    case "SFP+":
    case "QSFP+":
      return port.connector;
    case "wireless":
      return "wireless";
    case "console":
      return "";
  }
}

function vlanColumn(port: PortSnapshot): string {
  if (!port.isSwitchport) return "routed";
  const config = port.switchport;
  if (config === null) return singleLine(port.vlanText);
  return config.mode === "trunk" ? "trunk" : `${config.accessVLAN}`;
}

function joined(lines: string[]): string {
  return lines.map((text) => trimmingTrailingWhitespace(text)).join("\n");
}

/** The physical ports a show command was asked about; null when the argument names a
 * virtual interface, which the diagram does not store. */
function portsOf(engine: IOSEngine, command: ParsedCommand): PortSnapshot[] | null {
  const selection = command.interfaces("interface");
  if (selection === null) return engine.access.interfaces;
  if (selection.target.kind !== "ports") return null;
  const live = engine.access.interfaces;
  const result: PortSnapshot[] = [];
  for (const id of selection.target.ids) {
    const port = live.find((candidate) => candidate.id === id);
    if (port) result.push(port);
  }
  return result;
}

function isRouting(category: DeviceCategory | null): boolean {
  return category !== null && !NetworkSimulator.isSwitching(category);
}

// MARK: show running-config

export function interfaceConfigLines(engine: IOSEngine, port: PortSnapshot): string[] {
  const lines = [`interface ${engine.namer.longName(port.name)}`];
  if (port.description !== "") lines.push(` description ${singleLine(port.description)}`);
  const address = addressLine(engine, l3Port(port.id));
  if (address !== null) {
    lines.push(address);
  } else if (isRouting(engine.access.category)) {
    lines.push(" no ip address");
  }
  const routed = isRouting(engine.access.category);
  const config = port.switchport;
  if (routed) {
    // Router ports are not switchports; their VLAN text is not configuration.
  } else if (config !== null) {
    if (config.accessVLAN !== 1) lines.push(` switchport access vlan ${config.accessVLAN}`);
    if (config.nativeVLAN !== 1) lines.push(` switchport trunk native vlan ${config.nativeVLAN}`);
    if (config.allowedVLANs !== null) {
      const allowed = config.allowedVLANs;
      lines.push(` switchport trunk allowed vlan ${allowed.length === 0 ? "none" : VLANListParser.format(allowed)}`);
    }
    switch (config.mode) {
      case "access":
        lines.push(" switchport mode access");
        break;
      case "trunk":
        lines.push(" switchport mode trunk");
        break;
      case "unset":
        break;
    }
  } else {
    lines.push(` ! ${Notices.customVLANText(singleLine(port.vlanText))}`);
  }
  lines.push(...featureInterfaceLines(engine, l3Port(port.id)));
  if (port.adminDown) lines.push(" shutdown");
  return lines;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function withConfigHeader(body: string[]): string {
  const text = body.join("\n");
  return joined(["Building configuration...", "", `Current configuration : ${utf8Length(text)} bytes`, ...body]);
}

export function showRunningConfig(engine: IOSEngine, _command: ParsedCommand): string {
  if (engine.isDell) return dellRunningConfig(engine);
  const body = ["!", `hostname ${engine.hostname}`, "!"];
  for (const row of vlanRows(engine)) {
    if (row.id === 1) continue;
    body.push(`vlan ${row.id}`);
    if (row.name !== defaultVLANName(row.id)) body.push(` name ${row.name}`);
    body.push("!");
  }
  for (const port of engine.access.interfaces) {
    body.push(...interfaceConfigLines(engine, port));
    body.push("!");
  }
  for (const block of sviConfigBlocks(engine)) {
    body.push(...block);
    body.push("!");
  }
  const global = globalIPLines(engine);
  if (global.length > 0) body.push(...global, "!");
  for (const block of featureGlobalBlocks(engine)) body.push(...block, "!");
  body.push("end");
  return withConfigHeader(body);
}

export function showRunningConfigInterface(engine: IOSEngine, command: ParsedCommand): string {
  const ports = portsOf(engine, command);
  if (ports === null) return Notices.virtualInterface;
  if (engine.isDell) return joined(ports.flatMap((port) => ["!", ...dellInterfaceConfigLines(engine, port)]));
  const body: string[] = [];
  for (const port of ports) {
    body.push("!");
    body.push(...interfaceConfigLines(engine, port));
  }
  body.push("end");
  return withConfigHeader(body);
}

// MARK: show interfaces ...

export function showInterfacesStatus(engine: IOSEngine, command: ParsedCommand): string {
  const ports = portsOf(engine, command);
  if (ports === null) return Notices.virtualInterface;
  if (engine.isDell) return dellInterfacesStatus(engine, ports);
  const lines = ["Port      Name               Status       Vlan       Duplex  Speed Type"];
  for (const port of ports) {
    lines.push(
      padded(engine.namer.shortName(port.name), 9) +
        " " +
        column(singleLine(port.description), 18) +
        " " +
        padded(statusWord(port), 12) +
        " " +
        column(vlanColumn(port), 10) +
        " " +
        leftPadded("auto", 6) +
        " " +
        leftPadded("auto", 6) +
        " " +
        mediaType(port),
    );
  }
  return joined(lines);
}

function descriptionStatus(port: PortSnapshot): string {
  switch (port.linkState) {
    case "adminDown":
      return "admin down";
    case "up":
      return "up";
    case "down":
      return "down";
  }
}

export function showInterfacesDescription(engine: IOSEngine, command: ParsedCommand): string {
  const ports = portsOf(engine, command);
  if (ports === null) return Notices.virtualInterface;
  if (engine.isDell) return dellInterfacesDescription(engine, ports);
  const lines = ["Interface                      Status         Protocol Description"];
  for (const port of ports) {
    lines.push(
      padded(engine.namer.shortName(port.name), 30) +
        " " +
        padded(descriptionStatus(port), 14) +
        " " +
        padded(port.linkState === "up" ? "up" : "down", 8) +
        " " +
        singleLine(port.description),
    );
  }
  return joined(lines);
}

/** `show interfaces [X]`: only the lines that follow from the diagram. */
export function showInterfaces(engine: IOSEngine, command: ParsedCommand): string {
  const ports = portsOf(engine, command);
  if (ports === null) return Notices.virtualInterface;
  const dell = engine.isDell;
  const lines: string[] = [];
  for (const port of ports) {
    const name = engine.namer.longName(port.name);
    switch (port.linkState) {
      case "adminDown":
        lines.push(`${name} is administratively down, line protocol is down` + (dell ? "" : " (disabled)"));
        break;
      case "up":
        lines.push(`${name} is up, line protocol is up` + (dell ? "" : " (connected)"));
        break;
      case "down":
        lines.push(`${name} is down, line protocol is down` + (dell ? "" : " (notconnect)"));
        break;
    }
    if (port.description !== "") lines.push(`  Description: ${singleLine(port.description)}`);
  }
  lines.push(Notices.interfaceStatic);
  return joined(lines);
}

export function showInterfacesTrunk(engine: IOSEngine, command: ParsedCommand): string {
  const ports = portsOf(engine, command);
  if (ports === null) return Notices.virtualInterface;
  const trunks: [PortSnapshot, SwitchportConfig][] = [];
  for (const port of ports) {
    if (!port.isSwitchport) continue;
    const config = port.switchport;
    if (config === null || config.mode !== "trunk") continue;
    trunks.push([port, config]);
  }
  if (trunks.length === 0) return "";
  const existing = vlanRows(engine).map((row) => row.id);
  const namer = engine.namer;

  const lines = ["Port        Mode             Encapsulation  Status        Native vlan"];
  for (const [port, config] of trunks) {
    lines.push(
      padded(namer.shortName(port.name), 11) +
        " " +
        padded("on", 16) +
        " " +
        padded("802.1q", 14) +
        " " +
        padded(port.linkState === "up" ? "trunking" : "not-trunking", 13) +
        " " +
        `${config.nativeVLAN}`,
    );
  }
  lines.push("");
  lines.push("Port        Vlans allowed on trunk");
  for (const [port, config] of trunks) {
    let allowed: string;
    if (config.allowedVLANs !== null) {
      allowed = config.allowedVLANs.length === 0 ? "none" : VLANListParser.format(config.allowedVLANs);
    } else {
      allowed = "1-4094";
    }
    lines.push(padded(namer.shortName(port.name), 11) + " " + allowed);
  }
  lines.push("");
  lines.push("Port        Vlans allowed and active in management domain");
  for (const [port, config] of trunks) {
    const active = existing.filter((id) => config.allows(id));
    lines.push(padded(namer.shortName(port.name), 11) + " " + (active.length === 0 ? "none" : VLANListParser.format(active)));
  }
  lines.push("");
  lines.push(Notices.trunkStatic);
  return joined(lines);
}

/** `show interfaces [X] switchport`: the administrative (configured) fields only. */
export function showInterfacesSwitchport(engine: IOSEngine, command: ParsedCommand): string {
  const ports = portsOf(engine, command);
  if (ports === null) return Notices.virtualInterface;
  const lines: string[] = [];
  for (const port of ports) {
    if (lines.length > 0) lines.push("");
    lines.push(`Name: ${engine.namer.shortName(port.name)}`);
    if (!port.isSwitchport) {
      lines.push("Switchport: Disabled");
      continue;
    }
    lines.push("Switchport: Enabled");
    const config = port.switchport;
    if (config === null) {
      lines.push(`! ${Notices.customVLANText(singleLine(port.vlanText))}`);
      continue;
    }
    switch (config.mode) {
      case "access":
        lines.push("Administrative Mode: static access");
        break;
      case "trunk":
        lines.push("Administrative Mode: trunk");
        break;
      case "unset":
        lines.push("Administrative Mode: dynamic auto");
        break;
    }
    lines.push("Administrative Trunking Encapsulation: dot1q");
    lines.push(`Access Mode VLAN: ${config.accessVLAN} (${vlanName(engine, config.accessVLAN) ?? "Inactive"})`);
    lines.push(`Trunking Native Mode VLAN: ${config.nativeVLAN} (${vlanName(engine, config.nativeVLAN) ?? "Inactive"})`);
    if (config.allowedVLANs !== null) {
      const allowed = config.allowedVLANs;
      lines.push(`Trunking VLANs Enabled: ${allowed.length === 0 ? "NONE" : VLANListParser.format(allowed)}`);
    } else {
      lines.push("Trunking VLANs Enabled: ALL");
    }
  }
  return joined(lines);
}

export function showIPInterfaceBrief(engine: IOSEngine, _command: ParsedCommand): string {
  const lines = ["Interface              IP-Address      OK? Method Status                Protocol"];
  for (const row of ipInterfaceRows(engine)) {
    lines.push(
      padded(row.name, 22) +
        " " +
        padded(row.address, 15) +
        " " +
        (row.address === "unassigned" ? "YES unset  " : "YES manual ") +
        padded(row.status, 21) +
        " " +
        row.proto,
    );
  }
  lines.push(Notices.statusFromDiagram);
  return joined(lines);
}

// MARK: show vlan

export function showVLAN(engine: IOSEngine, command: ParsedCommand): string {
  if (engine.isDell) return dellShowVLAN(engine, command.int("vlan"));
  const only = command.int("vlan");
  const rows = vlanRows(engine);
  if (only !== null && !rows.some((row) => row.id === only)) {
    return `VLAN id ${only} not found in current VLAN database`;
  }

  const members = new Map<number, string[]>();
  const remarks: string[] = [];
  for (const port of engine.access.interfaces) {
    if (!port.isSwitchport) continue;
    const short = engine.namer.shortName(port.name);
    const config = port.switchport;
    if (config === null) {
      remarks.push(Notices.unreadableVLANText(short, singleLine(port.vlanText)));
      continue;
    }
    if (config.mode === "trunk") continue;
    if (rows.some((row) => row.id === config.accessVLAN)) {
      const list = members.get(config.accessVLAN) ?? [];
      list.push(short);
      members.set(config.accessVLAN, list);
    } else {
      remarks.push(Notices.missingVLAN(short, config.accessVLAN));
    }
  }

  const lines = [
    "",
    "VLAN Name                             Status    Ports",
    "---- -------------------------------- --------- -------------------------------",
  ];
  const append = (id: number, name: string, status: string, ports: string[]): void => {
    const wrapped = wrap(ports, 31);
    const head = padded(`${id}`, 4) + " " + column(name, 32) + " " + padded(status, 9) + " ";
    lines.push(head + (wrapped[0] ?? ""));
    for (const extra of wrapped.slice(1)) lines.push(" ".repeat(48) + extra);
  };
  for (const row of rows) {
    if (only === null || only === row.id) append(row.id, row.name, "active", members.get(row.id) ?? []);
  }
  if (engine.dialect === "ios" && only === null) {
    // The four fixed legacy VLANs every Catalyst lists.
    const legacy: [number, string][] = [
      [1002, "fddi-default"],
      [1003, "token-ring-default"],
      [1004, "fddinet-default"],
      [1005, "trnet-default"],
    ];
    for (const [id, name] of legacy) {
      if (!rows.some((row) => row.id === id)) append(id, name, "act/unsup", []);
    }
  }
  if (only === null) lines.push(...remarks);
  return joined(lines);
}

/** Breaks a comma-separated port list into lines of at most `width` characters. */
export function wrap(items: string[], width: number): string[] {
  const lines: string[] = [];
  let current = "";
  items.forEach((item, index) => {
    const piece = index === items.length - 1 ? item : item + ",";
    if (current === "") {
      current = piece;
    } else if (charCount(current) + 1 + charCount(piece) <= width) {
      current += " " + piece;
    } else {
      lines.push(current);
      current = piece;
    }
  });
  if (current !== "") lines.push(current);
  return lines.map((text) => (text.endsWith(",") ? text.slice(0, -1) : text));
}

// MARK: Neighbors (from the drawn cabling)

export interface CabledNeighbor {
  port: PortSnapshot;
  peer: PeerSnapshot;
}

function cabledNeighbors(engine: IOSEngine): CabledNeighbor[] {
  const result: CabledNeighbor[] = [];
  for (const port of engine.access.interfaces) {
    if (port.linkState !== "up" || port.peer === null) continue;
    result.push({ port, peer: port.peer });
  }
  return result;
}

/** True when the peer's console speaks IOS (CLI.dialect(vendor:model:category:) == .ios). */
function peerUsesIOSNames(peer: PeerSnapshot): boolean {
  if (peer.category === "PC" || peer.category === "server") return false;
  return peer.vendor.toLowerCase().includes("cisco");
}

function cdpCapability(category: DeviceCategory): string {
  switch (category) {
    case "router":
      return "R";
    case "switch":
      return "S";
    case "L3 switch":
      return "R S";
    case "AP":
      return "T";
    case "PC":
    case "server":
      return "H";
  }
}

export function showCDPNeighbors(engine: IOSEngine, command: ParsedCommand): string {
  const neighbors = cabledNeighbors(engine);
  const iosNamer = new InterfaceNamer("ios");
  const namer = engine.namer;
  if (command.has("detail")) {
    const lines = [Notices.neighborsFromDiagram];
    for (const { port, peer } of neighbors) {
      let capability: string;
      switch (peer.category) {
        case "router":
          capability = "Router";
          break;
        case "switch":
          capability = "Switch";
          break;
        case "L3 switch":
          capability = "Router Switch";
          break;
        case "AP":
          capability = "Trans-Bridge";
          break;
        case "PC":
        case "server":
          capability = "Host";
          break;
      }
      const remote = peerUsesIOSNames(peer) ? iosNamer.longName(peer.portName) : peer.portName;
      lines.push("-------------------------");
      lines.push(`Device ID: ${peer.hostname}`);
      lines.push(`Platform: ${platform(peer)},  Capabilities: ${capability}`);
      lines.push(`Interface: ${namer.longName(port.name)},  Port ID (outgoing port): ${remote}`);
    }
    lines.push("");
    lines.push(`Total cdp entries displayed : ${neighbors.length}`);
    return joined(lines);
  }

  const platforms = neighbors.map((neighbor) => platform(neighbor.peer));
  const platformWidth = Math.max(8, ...platforms.map((text) => charCount(text)));
  const nameWidth = Math.max(16, ...neighbors.map((neighbor) => charCount(neighbor.peer.hostname)));
  const lines = [
    Notices.neighborsFromDiagram,
    "Capability Codes: R - Router, T - Trans Bridge, S - Switch, H - Host",
    "",
    padded("Device ID", nameWidth) +
      " " +
      padded("Local Intrfce", 17) +
      " " +
      padded("Capability", 11) +
      " " +
      padded("Platform", platformWidth) +
      "  Port ID",
  ];
  neighbors.forEach((neighbor, index) => {
    const remote = peerUsesIOSNames(neighbor.peer) ? iosNamer.cdpName(neighbor.peer.portName) : neighbor.peer.portName;
    lines.push(
      padded(neighbor.peer.hostname, nameWidth) +
        " " +
        padded(namer.cdpName(neighbor.port.name), 17) +
        " " +
        padded(cdpCapability(neighbor.peer.category), 11) +
        " " +
        padded(platforms[index], platformWidth) +
        "  " +
        remote,
    );
  });
  lines.push("");
  lines.push(`Total cdp entries displayed : ${neighbors.length}`);
  return joined(lines);
}

function platform(peer: PeerSnapshot): string {
  const text = [peer.vendor, peer.model].filter((part) => part !== "").join(" ");
  return text === "" ? "-" : text;
}

export function showLLDPNeighbors(engine: IOSEngine, _command: ParsedCommand): string {
  const neighbors = cabledNeighbors(engine);
  if (engine.isDell) return dellLLDPNeighbors(engine, neighbors);
  const iosNamer = new InterfaceNamer("ios");
  const nameWidth = Math.max(19, ...neighbors.map((neighbor) => charCount(neighbor.peer.hostname)));
  const lines = [
    Notices.neighborsFromDiagram,
    "Capability codes:",
    "    (R) Router, (B) Bridge, (W) WLAN Access Point, (S) Station",
    "",
    padded("Device ID", nameWidth) + " " + padded("Local Intf", 14) + " " + padded("Capability", 15) + " Port ID",
  ];
  for (const { port, peer } of neighbors) {
    let capability: string;
    switch (peer.category) {
      case "router":
        capability = "R";
        break;
      case "switch":
        capability = "B";
        break;
      case "L3 switch":
        capability = "B,R";
        break;
      case "AP":
        capability = "W";
        break;
      case "PC":
      case "server":
        capability = "S";
        break;
    }
    const remote = peerUsesIOSNames(peer) ? iosNamer.shortName(peer.portName) : peer.portName;
    lines.push(
      padded(peer.hostname, nameWidth) +
        " " +
        padded(engine.namer.shortName(port.name), 14) +
        " " +
        padded(capability, 15) +
        " " +
        remote,
    );
  }
  lines.push("");
  lines.push(`Total entries displayed: ${neighbors.length}`);
  return joined(lines);
}

// MARK: Bundles, version, inventory, history

export function showEtherchannelSummary(engine: IOSEngine, _command: ParsedCommand): string {
  const bundles = engine.access.bundles;
  const lines = [Notices.bundlesFromDiagram, `Number of channel-groups in use: ${bundles.length}`, ""];
  const labelWidth = Math.max(12, ...bundles.map((bundle) => charCount(bundle.label)));
  lines.push("Group  " + padded("Port-channel", labelWidth) + "  Ports");
  lines.push("------+" + "-".repeat(labelWidth + 1) + "+" + "-".repeat(46));
  bundles.forEach((bundle, index) => {
    const local = bundle.localPorts.map((name) => engine.namer.shortName(name)).join(" ");
    const remote = bundle.peerPorts.join(" ");
    lines.push(
      padded(`${index + 1}`, 6) + " " + padded(bundle.label, labelWidth) + "  " + local + `  -> ${bundle.peerHostname}: ${remote}`,
    );
  });
  return joined(lines);
}

export function showVersion(engine: IOSEngine, _command: ParsedCommand): string {
  const lines: string[] = [];
  const access = engine.access;
  const vendor = access.vendor === "" ? "-" : access.vendor;
  const model = access.model === "" ? "-" : access.model;
  if (engine.isDell) {
    lines.push(`System Name: ${engine.hostname}`);
    lines.push(`System Type: ${model}`);
    lines.push(`Vendor: ${vendor}`);
  } else {
    lines.push(`${vendor} ${model}`);
    lines.push(`Hostname: ${engine.hostname}`);
  }
  lines.push("");
  for (const [typeWord, count] of interfaceCounts(engine)) {
    if (engine.isDell) {
      const label = typeWord.split("TenGigabitEthernet").join("Ten GigabitEthernet");
      lines.push(leftPadded(`${count}`, 4) + ` ${label}/IEEE 802.3 interface(s)`);
    } else {
      let label: string;
      switch (typeWord) {
        case "GigabitEthernet":
          label = "Gigabit Ethernet";
          break;
        case "TenGigabitEthernet":
          label = "Ten Gigabit Ethernet";
          break;
        case "FortyGigabitEthernet":
          label = "Forty Gigabit Ethernet";
          break;
        default:
          label = typeWord;
      }
      lines.push(`${count} ${label} interface` + (count === 1 ? "" : "s"));
    }
  }
  lines.push("");
  lines.push(Notices.versionStatic);
  return joined(lines);
}

/** Interface type words with the number of ports of each, in panel order. */
function interfaceCounts(engine: IOSEngine): [string, number][] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const port of engine.access.interfaces) {
    const typeWord = engine.namer.typeWord(port.name);
    if (!counts.has(typeWord)) order.push(typeWord);
    counts.set(typeWord, (counts.get(typeWord) ?? 0) + 1);
  }
  return order.map((typeWord) => [typeWord, counts.get(typeWord) ?? 0]);
}

export function showInventory(engine: IOSEngine, _command: ParsedCommand): string {
  const access = engine.access;
  const description = [access.vendor, access.model].filter((part) => part !== "").join(" ");
  return joined([
    `NAME: "${engine.hostname}", DESCR: "${description}"`,
    `PID: ${access.model === "" ? "-" : access.model}`,
    "",
    Notices.versionStatic,
  ]);
}

export function showHistory(engine: IOSEngine, _command: ParsedCommand): string {
  return engine.history.map((entry) => "  " + entry).join("\n");
}
