// Dell OS9 VLAN membership and `show` output. Port of DellShow.swift (extension of IOSEngine).

import {
  chars,
  column,
  isNumber,
  padded,
  swiftInt,
  trimmingTrailingWhitespace,
  trimWhitespaces,
  VLANListParser,
} from "./command-tree";
import type { IOSEngine } from "./ios-engine";
import { InterfaceNameParts } from "./interface-naming";
import { addressLine, globalIPLines } from "./ios-network";
import { singleLine, VLANRow } from "./ios-show";
import { l3Port, l3VLAN, parseL3Interface, PeerSnapshot, PortSnapshot } from "./model-access";
import { Notices } from "./notices";
import { SwitchportConfig } from "./switchport";

/** How Dell OS9 VLAN membership maps onto the canonical switchport text.
 *
 * OS9 has no access/trunk modes: a VLAN interface lists its `untagged` and `tagged` ports.
 * NetSketch stores the same facts in the one canonical `Port.vlan` format:
 *
 *     untagged in VLAN N only            -> "access N"   (the default VLAN 1: "")
 *     tagged in VLANs A,B                -> "trunk A,B"
 *     tagged in A,B + untagged in N      -> "trunk A,B native N"   (OS9 hybrid port)
 *
 * The mutating functions change `config` in place (Swift `inout`). */
export class DellMembership {
  /** The VLAN the port is an untagged member of; null for a port that is only tagged. */
  static untaggedVLAN(config: SwitchportConfig): number | null {
    if (config.mode !== "trunk") return config.accessVLAN;
    return config.nativeVLAN === 1 ? null : config.nativeVLAN;
  }

  /** The default VLAN never has tagged members on OS9. */
  static isTagged(config: SwitchportConfig, vlan: number): boolean {
    if (config.mode !== "trunk" || vlan === 1 || vlan === config.nativeVLAN) return false;
    return config.allows(vlan);
  }

  static addUntagged(config: SwitchportConfig, vlan: number): void {
    if (config.mode === "trunk") {
      config.nativeVLAN = vlan;
      if (config.allowedVLANs !== null) config.allowedVLANs = config.allowedVLANs.filter((id) => id !== vlan);
    } else if (vlan === 1) {
      config.assign(new SwitchportConfig());
    } else {
      config.mode = "access";
      config.accessVLAN = vlan;
    }
  }

  static addTagged(config: SwitchportConfig, vlan: number): void {
    if (config.mode === "trunk") {
      const allowed = config.allowedVLANs;
      if (allowed !== null && !allowed.includes(vlan)) {
        config.allowedVLANs = [...allowed, vlan].sort((a, b) => a - b);
      }
      if (config.nativeVLAN === vlan) config.nativeVLAN = 1;
    } else {
      const untagged = config.accessVLAN;
      const fresh = new SwitchportConfig();
      fresh.mode = "trunk";
      fresh.allowedVLANs = [vlan];
      if (untagged !== 1 && untagged !== vlan) fresh.nativeVLAN = untagged;
      config.assign(fresh);
    }
  }

  static removeUntagged(config: SwitchportConfig, vlan: number): void {
    if (config.mode === "trunk") {
      if (config.nativeVLAN === vlan) config.nativeVLAN = 1;
    } else if (config.accessVLAN === vlan) {
      config.assign(new SwitchportConfig());
    }
  }

  /** `definedVLANs` spells out "all VLANs" when the trunk was unrestricted. */
  static removeTagged(config: SwitchportConfig, vlan: number, definedVLANs: number[]): void {
    if (config.mode !== "trunk") return;
    const current = config.allowedVLANs ?? definedVLANs.filter((id) => id !== 1 && id !== config.nativeVLAN);
    const remaining = current.filter((id) => id !== vlan);
    if (remaining.length === 0) {
      // No tagged membership is left: the port falls back to a plain untagged port.
      const native = config.nativeVLAN;
      const fresh = new SwitchportConfig();
      if (native !== 1) {
        fresh.mode = "access";
        fresh.accessVLAN = native;
      }
      config.assign(fresh);
    } else {
      config.allowedVLANs = remaining;
    }
  }
}

function dellJoined(lines: string[]): string {
  return lines.map((text) => trimmingTrailingWhitespace(text)).join("\n");
}

/** The VLAN table as OS9 sees it: VLAN 1 always exists, names are never invented. */
export function dellVLANRows(engine: IOSEngine): VLANRow[] {
  const rows: VLANRow[] = engine.access.vlans
    .filter((entry) => entry.id >= 1 && entry.id <= 4094)
    .map((entry) => ({ id: entry.id, name: trimWhitespaces(entry.name) }));
  if (!rows.some((row) => row.id === 1)) rows.push({ id: 1, name: "" });
  return rows.sort((a, b) => a.id - b.id);
}

/** Compact OS9 port lists, one string per interface type:
 * ["GigabitEthernet 1/1-1/3,1/7", "TenGigabitEthernet 1/49"]. */
export function dellPortLists(engine: IOSEngine, ports: PortSnapshot[], short: boolean): string[] {
  const order: string[] = [];
  const groups = new Map<string, InterfaceNameParts[]>();
  for (const port of ports) {
    const name = short ? engine.namer.shortName(port.name) : engine.namer.longName(port.name);
    const characters = chars(name);
    const firstNumber = characters.findIndex((character) => isNumber(character));
    const typeWord = trimWhitespaces((firstNumber < 0 ? characters : characters.slice(0, firstNumber)).join(""));
    if (!groups.has(typeWord)) order.push(typeWord);
    const members = groups.get(typeWord) ?? [];
    members.push(new InterfaceNameParts(port.name));
    groups.set(typeWord, members);
  }
  return order.map((typeWord) => {
    const members = groups.get(typeWord) ?? [];
    const parts: string[] = [];
    let index = 0;
    while (index < members.length) {
      let end = index;
      while (end + 1 < members.length && follows(members[end + 1], members[end])) end += 1;
      parts.push(end === index ? members[index].number : `${members[index].number}-${members[end].number}`);
      index = end + 1;
    }
    const list = parts.join(",");
    return typeWord === "" ? list : `${typeWord} ${list}`;
  });
}

/** True when `next` is the port right behind `previous` in the same slot. */
function follows(next: InterfaceNameParts, previous: InterfaceNameParts): boolean {
  const a = previous.components;
  const b = next.components;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length - 1; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  const last = a.length > 0 ? swiftInt(a[a.length - 1]) : null;
  const following = b.length > 0 ? swiftInt(b[b.length - 1]) : null;
  if (last === null || following === null) return false;
  return following === last + 1;
}

function dellMembers(engine: IOSEngine, vlan: number): { untagged: PortSnapshot[]; tagged: PortSnapshot[] } {
  const untagged: PortSnapshot[] = [];
  const tagged: PortSnapshot[] = [];
  for (const port of engine.access.interfaces) {
    if (!port.isSwitchport) continue;
    const config = port.switchport;
    if (config === null) continue;
    if (DellMembership.untaggedVLAN(config) === vlan) untagged.push(port);
    if (DellMembership.isTagged(config, vlan)) tagged.push(port);
  }
  return { untagged, tagged };
}

// MARK: show running-config

export function dellInterfaceConfigLines(engine: IOSEngine, port: PortSnapshot): string[] {
  const lines = [`interface ${engine.namer.longName(port.name)}`];
  if (port.description !== "") lines.push(` description ${singleLine(port.description)}`);
  if (port.isSwitchport) lines.push(" switchport");
  const address = addressLine(engine, l3Port(port.id));
  if (address !== null) lines.push(address);
  if (port.switchport === null) lines.push(` ! ${Notices.customVLANText(singleLine(port.vlanText))}`);
  lines.push(port.adminDown ? " shutdown" : " no shutdown");
  return lines;
}

export function dellRunningConfig(engine: IOSEngine): string {
  const lines = ["Current Configuration ...", "!", `hostname ${engine.hostname}`, "!"];
  for (const port of engine.access.interfaces) {
    lines.push(...dellInterfaceConfigLines(engine, port));
    lines.push("!");
  }
  const rows = dellVLANRows(engine);
  for (const row of rows) {
    lines.push(`interface Vlan ${row.id}`);
    if (row.name !== "") lines.push(` name ${row.name}`);
    const address = addressLine(engine, l3VLAN(row.id));
    if (address !== null) lines.push(address);
    const members = dellMembers(engine, row.id);
    for (const list of dellPortLists(engine, members.tagged, false)) lines.push(` tagged ${list}`);
    for (const list of dellPortLists(engine, members.untagged, false)) {
      // OS9 lists the members of the default VLAN as comments.
      lines.push(row.id === 1 ? `!untagged ${list}` : ` untagged ${list}`);
    }
    lines.push("!");
  }
  // An address on a VLAN that is not in the table (the table was edited elsewhere).
  for (const entry of engine.access.addresses) {
    const parsed = parseL3Interface(entry.interface);
    if (parsed === null || parsed.kind !== "vlan") continue;
    const number = parsed.number;
    if (dellVLANRows(engine).some((row) => row.id === number)) continue;
    const address = addressLine(engine, entry.interface);
    if (address === null) continue;
    lines.push(`interface Vlan ${number}`, address, "!");
  }
  const global = globalIPLines(engine);
  if (global.length > 0) lines.push(...global, "!");
  lines.push("end");
  return dellJoined(lines);
}

// MARK: show interfaces ...

export function dellInterfacesStatus(engine: IOSEngine, ports: PortSnapshot[]): string {
  const lines = ["Port                 Description  Status Speed        Duplex Vlan"];
  const defined = dellVLANRows(engine).map((row) => row.id);
  for (const port of ports) {
    let vlan: string;
    const config = port.switchport;
    if (!port.isSwitchport) {
      vlan = "--";
    } else if (config !== null) {
      const ids = defined.filter((id) => DellMembership.isTagged(config, id));
      const untagged = DellMembership.untaggedVLAN(config);
      if (untagged !== null) ids.push(untagged);
      vlan = ids.length === 0 ? "--" : VLANListParser.format(ids);
    } else {
      vlan = singleLine(port.vlanText);
    }
    lines.push(
      padded(engine.namer.shortName(port.name), 20) +
        " " +
        column(singleLine(port.description), 12) +
        " " +
        padded(port.linkState === "up" ? "Up" : "Down", 6) +
        " " +
        padded("Auto", 12) +
        " " +
        padded("Auto", 6) +
        " " +
        vlan,
    );
  }
  return dellJoined(lines);
}

export function dellInterfacesDescription(engine: IOSEngine, ports: PortSnapshot[]): string {
  const lines = ["Interface                   OK  Status     Protocol Description"];
  for (const port of ports) {
    let status: string;
    switch (port.linkState) {
      case "adminDown":
        status = "admin down";
        break;
      case "up":
        status = "up";
        break;
      case "down":
        status = "down";
        break;
    }
    lines.push(
      padded(engine.namer.longName(port.name), 27) +
        " " +
        padded(port.linkState === "up" ? "YES" : "NO", 3) +
        " " +
        padded(status, 10) +
        " " +
        padded(port.linkState === "up" ? "up" : "down", 8) +
        " " +
        singleLine(port.description),
    );
  }
  return dellJoined(lines);
}

// MARK: show vlan

export function dellShowVLAN(engine: IOSEngine, only: number | null): string {
  const rows = dellVLANRows(engine);
  if (only !== null && !rows.some((row) => row.id === only)) {
    return `NetSketch: VLAN ${only} v tabulce VLAN zařízení není.`;
  }
  const lines = [
    "",
    "Codes: * - Default VLAN",
    "Q: U - Untagged, T - Tagged",
    "",
    "    NUM    Status    Description                     Q Ports",
  ];
  const remarks: string[] = [];
  for (const row of rows) {
    if (only !== null && only !== row.id) continue;
    const members = dellMembers(engine, row.id);
    const anyUp = [...members.untagged, ...members.tagged].some((port) => port.linkState === "up");
    const portLines = dellPortLists(engine, members.untagged, true).map((list) => `U ${list}`);
    portLines.push(...dellPortLists(engine, members.tagged, true).map((list) => `T ${list}`));
    const head =
      (row.id === 1 ? "*   " : "    ") +
      padded(`${row.id}`, 6) +
      " " +
      padded(anyUp ? "Active" : "Inactive", 9) +
      " " +
      column(row.name, 31) +
      " ";
    lines.push(head + (portLines[0] ?? ""));
    for (const extra of portLines.slice(1)) lines.push(" ".repeat(53) + extra);
  }
  if (only === null) {
    for (const port of engine.access.interfaces) {
      if (!port.isSwitchport) continue;
      const short = engine.namer.shortName(port.name);
      const config = port.switchport;
      if (config === null) {
        remarks.push(Notices.unreadableVLANText(short, singleLine(port.vlanText)));
        continue;
      }
      const untagged = DellMembership.untaggedVLAN(config);
      if (untagged !== null && !rows.some((row) => row.id === untagged)) {
        remarks.push(Notices.missingVLAN(short, untagged));
      }
    }
    lines.push("");
    lines.push(
      "NetSketch: Status (Active/Inactive) plyne z kabeláže v diagramu; sloupec Description ukazuje název VLAN.",
    );
    lines.push(...remarks);
  }
  return dellJoined(lines);
}

// MARK: show lldp neighbors

export function dellLLDPNeighbors(engine: IOSEngine, neighbors: { port: PortSnapshot; peer: PeerSnapshot }[]): string {
  const nameWidth = Math.max(17, ...neighbors.map((neighbor) => chars(neighbor.peer.hostname).length));
  const lines = [
    Notices.neighborsFromDiagram,
    " " + padded("Loc PortID", 13) + " " + padded("Rem Host Name", nameWidth) + " Rem Port Id",
    " " + "-".repeat(13 + 1 + nameWidth + 1 + 24),
  ];
  for (const { port, peer } of neighbors) {
    lines.push(
      " " + padded(engine.namer.shortName(port.name), 13) + " " + padded(peer.hostname, nameWidth) + " " + peer.portName,
    );
  }
  return dellJoined(lines);
}
