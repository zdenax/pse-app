// Handlers of the configuration commands. Port of IOSHandlers.swift (extension of IOSEngine).
// Each one maps a command onto ProjectStore operations (through DeviceAccess); one command is
// one undo step.

import type { VLANEntry } from "../core/model";
import { chars, ParsedCommand, trimWhitespaces } from "./command-tree";
import { dellVLANRows, DellMembership } from "./dell-show";
import { enterPortChannel, removePortChannel } from "./features/layer2/etherchannel-ios";
import type { IOSEngine } from "./ios-engine";
import { singleLine } from "./ios-show";
import type { PortSnapshot } from "./model-access";
import { Notices } from "./notices";
import { NetworkSimulator } from "./sim/network-simulator";
import { SwitchportConfig, SwitchportMode } from "./switchport";

// MARK: EXEC

export function enterPrivileged(engine: IOSEngine): string {
  if (engine.mode.kind === "userExec") engine.mode = { kind: "privilegedExec" };
  return "";
}

export function leavePrivileged(engine: IOSEngine): string {
  if (engine.mode.kind === "privilegedExec") engine.mode = { kind: "userExec" };
  return "";
}

export function enterGlobalConfig(engine: IOSEngine): string {
  engine.mode = { kind: "globalConfig" };
  return engine.isDell ? "" : "Enter configuration commands, one per line.  End with CNTL/Z.";
}

export function endConfig(engine: IOSEngine): string {
  engine.mode = { kind: "privilegedExec" };
  return "";
}

export function exitCommand(engine: IOSEngine): string {
  engine.exitOneLevel();
  return "";
}

// MARK: Global configuration

export function setHostname(engine: IOSEngine, command: ParsedCommand): string {
  const name = command.text("name");
  if (name === null) return "";
  engine.access.rename(name);
  return "";
}

export function resetHostname(engine: IOSEngine): string {
  let fallback: string;
  if (engine.isDell) {
    fallback = "Dell";
  } else {
    fallback = engine.access.category === "router" ? "Router" : "Switch";
  }
  engine.access.rename(fallback);
  return "";
}

export function enterInterface(engine: IOSEngine, command: ParsedCommand): string {
  const selection = command.interfaces("interface");
  if (selection === null) return "";
  const target = selection.target;
  switch (target.kind) {
    case "ports":
      engine.mode = { kind: "interface", selection };
      return "";
    case "vlan": {
      const id = target.number;
      if (!engine.isDell) {
        // IOS: the switch virtual interface of a switch; routers have none in the diagram.
        const category = engine.access.category;
        if (category === null || !NetworkSimulator.isSwitching(category)) return Notices.virtualInterface;
        engine.mode = { kind: "vlanInterface", vlan: id };
        return "";
      }
      if (id !== 1 && !engine.access.vlans.some((entry) => entry.id === id)) {
        engine.access.setVLANs([...engine.access.vlans, { id, name: "" }]);
      }
      engine.mode = { kind: "vlanInterface", vlan: id };
      return "";
    }
    case "portChannel":
      return engine.isDell ? Notices.lagIsDrawn : enterPortChannel(engine, target.number);
    case "loopback":
      return Notices.virtualInterface;
  }
}

/** `no interface X`: on Dell `no interface vlan N` deletes the VLAN. */
export function removeInterface(engine: IOSEngine, command: ParsedCommand): string {
  const selection = command.interfaces("interface");
  if (selection === null) return "";
  const target = selection.target;
  if (target.kind === "vlan" && engine.isDell) return dellDeleteVLAN(engine, target.number);
  switch (target.kind) {
    case "ports":
      return "NetSketch: fyzický port nelze z CLI odstranit, patří k modelu zařízení. Nic se nezměnilo.";
    case "portChannel":
      return engine.isDell ? Notices.lagIsDrawn : removePortChannel(engine, target.number);
    default:
      return Notices.virtualInterface;
  }
}

/** `default interface X`: back to an unconfigured port. */
export function defaultInterface(engine: IOSEngine, command: ParsedCommand): string {
  const selection = command.interfaces("interface");
  if (selection === null || selection.target.kind !== "ports") return Notices.virtualInterface;
  const ids = selection.target.ids;
  const ports = engine.access.interfaces.filter((port) => ids.includes(port.id));
  engine.access.transaction(() => {
    for (const port of ports) {
      engine.access.setDescription("", port.id);
      engine.access.setVLANText("", port.id);
      engine.access.setAdminDown(false, port.id);
    }
  });
  return ports.map((port) => `Interface ${engine.namer.longName(port.name)} set to default configuration`).join("\n");
}

export function enterLine(engine: IOSEngine, command: ParsedCommand): string {
  const rest = (command.text("rest") ?? "").toLowerCase();
  const kind = rest.startsWith("v") ? "vty" : rest.startsWith("a") ? "aux" : "console";
  engine.mode = { kind: "line", name: kind };
  return Notices.lineMode;
}

/** `banner motd #text#`: the text may continue on following lines until the delimiter. */
export function bannerCommand(engine: IOSEngine, command: ParsedCommand): string {
  const rest = command.text("rest") ?? "";
  // split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
  const words = splitOnce(rest);
  const kinds = ["motd", "login", "exec", "incoming"];
  let text = rest;
  const first = words[0];
  if (first !== undefined && kinds.some((kind) => kind.startsWith(first.toLowerCase()))) {
    text = words.length > 1 ? words[1] : "";
  }
  const trimmed = trimWhitespaces(text);
  const characters = chars(trimmed);
  const delimiter = characters[0];
  if (delimiter === undefined) return engine.isDell ? "% Error: Incomplete command." : "% Incomplete command.";
  if (characters.slice(1).includes(delimiter)) return Notices.bannerNotStored;
  engine.beginBanner(delimiter);
  return `Enter TEXT message.  End with the character '${delimiter}'.`;
}

/** Swift `split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)`. */
function splitOnce(text: string): string[] {
  let start = 0;
  while (start < text.length && text[start] === " ") start += 1;
  if (start >= text.length) return [];
  const space = text.indexOf(" ", start);
  if (space < 0) return [text.slice(start)];
  // After the first piece the rest is kept as it is, leading spaces included.
  const first = text.slice(start, space);
  const second = space + 1;
  return second >= text.length ? [first] : [first, text.slice(second)];
}

// MARK: VLAN database (IOS)

function isFixedVLAN(engine: IOSEngine, id: number): boolean {
  return id === 1 || (engine.dialect === "ios" && id >= 1002 && id <= 1005);
}

export function enterVLANConfig(engine: IOSEngine, command: ParsedCommand): string {
  const ids = command.intList("vlans");
  if (ids === null) return "";
  const existing = new Set(engine.access.vlans.map((entry) => entry.id));
  const missing = ids.filter((id) => !isFixedVLAN(engine, id) && !existing.has(id));
  if (missing.length > 0) {
    engine.access.setVLANs([...engine.access.vlans, ...missing.map((id): VLANEntry => ({ id, name: "" }))]);
  }
  engine.mode = { kind: "vlan", ids };
  return "";
}

export function deleteVLANs(engine: IOSEngine, command: ParsedCommand): string {
  const ids = command.intList("vlans");
  if (ids === null) return "";
  const messages: string[] = [];
  for (const id of ids) {
    if (isFixedVLAN(engine, id)) messages.push(`%Default VLAN ${id} may not be deleted.`);
  }
  const doomed = new Set(ids.filter((id) => !isFixedVLAN(engine, id)));
  const current = engine.access.vlans;
  const remaining = current.filter((entry) => !doomed.has(entry.id));
  if (remaining.length !== current.length) engine.access.setVLANs(remaining);
  return messages.join("\n");
}

export function setVLANName(engine: IOSEngine, command: ParsedCommand): string {
  return renameVLAN(engine, command.text("name") ?? "");
}

export function resetVLANName(engine: IOSEngine): string {
  return renameVLAN(engine, "");
}

function renameVLAN(engine: IOSEngine, name: string): string {
  let id: number;
  const mode = engine.mode;
  switch (mode.kind) {
    case "vlan":
      if (mode.ids.length !== 1) return Notices.singleVLANOnly;
      id = mode.ids[0];
      if (isFixedVLAN(engine, id)) return `%Default VLAN ${id} may not have its name changed.`;
      break;
    case "vlanInterface":
      id = mode.vlan;
      break;
    default:
      return "";
  }
  const table = engine.access.vlans;
  const index = table.findIndex((entry) => entry.id === id);
  if (index >= 0) {
    table[index] = { ...table[index], name };
  } else {
    // The VLAN was removed elsewhere while this mode was open (or is the Dell default VLAN).
    table.push({ id, name });
  }
  engine.access.setVLANs(table);
  return "";
}

// MARK: Interface configuration

/** Runs `body` for the ports of the current interface mode as one undo step. */
function withSelectedPorts(engine: IOSEngine, body: (ports: PortSnapshot[]) => string[]): string {
  const ports = engine.selectedPorts();
  if (ports.length === 0) {
    engine.mode = { kind: "globalConfig" };
    return Notices.interfaceGone;
  }
  let messages: string[] = [];
  engine.access.transaction(() => {
    messages = body(ports);
  });
  return messages.join("\n");
}

export function setDescription(engine: IOSEngine, command: ParsedCommand): string {
  const text = command.text("text") ?? "";
  return withSelectedPorts(engine, (ports) => {
    for (const port of ports) engine.access.setDescription(text, port.id);
    return [];
  });
}

export function clearDescription(engine: IOSEngine): string {
  return withSelectedPorts(engine, (ports) => {
    for (const port of ports) engine.access.setDescription("", port.id);
    return [];
  });
}

export function setShutdown(engine: IOSEngine, down: boolean): string {
  return withSelectedPorts(engine, (ports) => {
    for (const port of ports) engine.access.setAdminDown(down, port.id);
    return [];
  });
}

/** Applies a change to the switchport configuration of every selected port.
 * `ensuringVLAN` creates a missing access VLAN first, with the IOS message. */
export function updateSwitchport(
  engine: IOSEngine,
  ensuringVLAN: number | null,
  change: (config: SwitchportConfig) => void,
): string {
  return withSelectedPorts(engine, (ports) => {
    const messages: string[] = [];
    const access = engine.access;
    if (
      ensuringVLAN !== null &&
      ensuringVLAN !== 1 &&
      !access.vlans.some((entry) => entry.id === ensuringVLAN) &&
      ports.some((port) => port.isSwitchport)
    ) {
      messages.push(`% Access VLAN does not exist. Creating vlan ${ensuringVLAN}`);
      access.setVLANs([...access.vlans, { id: ensuringVLAN, name: "" }]);
    }
    let managementNoted = false;
    for (const port of ports) {
      if (!port.isSwitchport) {
        if (!managementNoted) messages.push(Notices.managementPort);
        managementNoted = true;
        continue;
      }
      let config = new SwitchportConfig();
      const parsed = port.switchport;
      if (parsed !== null) {
        config = parsed;
      } else {
        messages.push(Notices.replacedVLANText(engine.namer.shortName(port.name), singleLine(port.vlanText)));
      }
      change(config);
      access.setVLANText(config.canonicalText, port.id);
    }
    return messages;
  });
}

export function setSwitchportMode(engine: IOSEngine, mode: SwitchportMode): string {
  return updateSwitchport(engine, null, (config) => {
    config.mode = mode;
  });
}

export function setAccessVLAN(engine: IOSEngine, command: ParsedCommand): string {
  const vlan = command.int("vlan");
  if (vlan === null) return "";
  return updateSwitchport(engine, vlan, (config) => {
    config.accessVLAN = vlan;
  });
}

export function setNativeVLAN(engine: IOSEngine, command: ParsedCommand): string {
  const vlan = command.int("vlan");
  if (vlan === null) return "";
  return updateSwitchport(engine, null, (config) => {
    config.nativeVLAN = vlan;
  });
}

export type AllowedChange = "replace" | "add" | "remove" | "except" | "all" | "none";

export function setAllowedVLANs(engine: IOSEngine, kind: AllowedChange, command: ParsedCommand): string {
  const list = command.intList("vlans") ?? [];
  const everything = SwitchportConfig.allVLANList();
  return updateSwitchport(engine, null, (config) => {
    switch (kind) {
      case "replace":
        config.allowedVLANs = [...list];
        break;
      case "add":
        if (config.allowedVLANs !== null) {
          config.allowedVLANs = Array.from(new Set([...config.allowedVLANs, ...list])).sort((a, b) => a - b);
        }
        break;
      case "remove": {
        const doomed = new Set(list);
        config.allowedVLANs = (config.allowedVLANs ?? everything).filter((id) => !doomed.has(id));
        break;
      }
      case "except": {
        const doomed = new Set(list);
        config.allowedVLANs = everything.filter((id) => !doomed.has(id));
        break;
      }
      case "all":
        config.allowedVLANs = null;
        break;
      case "none":
        config.allowedVLANs = [];
        break;
    }
    if (config.allowedVLANs !== null && config.allowedVLANs.length === everything.length) config.allowedVLANs = null;
  });
}

// MARK: Dell OS9 VLAN interfaces

export function dellDeleteVLAN(engine: IOSEngine, id: number): string {
  if (id === 1) return "NetSketch: výchozí VLAN 1 nelze smazat. Nic se nezměnilo.";
  const access = engine.access;
  const defined = dellVLANRows(engine).map((row) => row.id);
  access.transaction(() => {
    for (const port of access.interfaces) {
      if (!port.isSwitchport) continue;
      const config = port.switchport;
      if (config === null) continue;
      const before = config.clone();
      DellMembership.removeUntagged(config, id);
      if (DellMembership.isTagged(config, id)) {
        DellMembership.removeTagged(config, id, defined);
      }
      if (!config.equals(before)) access.setVLANText(config.canonicalText, port.id);
    }
    access.setVLANs(access.vlans.filter((entry) => entry.id !== id));
  });
  const mode = engine.mode;
  if (mode.kind === "vlanInterface" && mode.vlan === id) engine.mode = { kind: "globalConfig" };
  return "";
}

export type DellMembershipChange = "tagged" | "untagged" | "noTagged" | "noUntagged";

/** `tagged X`, `untagged X` and their `no` forms inside `interface vlan N`. */
export function dellChangeMembership(engine: IOSEngine, change: DellMembershipChange, command: ParsedCommand): string {
  const mode = engine.mode;
  const selection = command.interfaces("interface");
  if (mode.kind !== "vlanInterface" || selection === null || selection.target.kind !== "ports") {
    return Notices.virtualInterface;
  }
  const vlan = mode.vlan;
  const ids = selection.target.ids;
  if (change === "tagged" && vlan === 1) {
    return "NetSketch: výchozí VLAN 1 nemá na Dell OS9 tagované členy. Nic se nezměnilo.";
  }
  const access = engine.access;
  const live = access.interfaces;
  const ports: PortSnapshot[] = [];
  for (const id of ids) {
    const port = live.find((candidate) => candidate.id === id);
    if (port) ports.push(port);
  }
  const defined = dellVLANRows(engine).map((row) => row.id);
  const messages: string[] = [];
  access.transaction(() => {
    for (const port of ports) {
      if (!port.isSwitchport) {
        messages.push(Notices.managementPort);
        continue;
      }
      let config = new SwitchportConfig();
      const parsed = port.switchport;
      if (parsed !== null) {
        config = parsed;
      } else {
        messages.push(Notices.replacedVLANText(engine.namer.shortName(port.name), singleLine(port.vlanText)));
      }
      switch (change) {
        case "tagged":
          DellMembership.addTagged(config, vlan);
          break;
        case "untagged":
          DellMembership.addUntagged(config, vlan);
          break;
        case "noTagged":
          DellMembership.removeTagged(config, vlan, defined);
          break;
        case "noUntagged":
          DellMembership.removeUntagged(config, vlan);
          break;
      }
      access.setVLANText(config.canonicalText, port.id);
    }
  });
  return messages.join("\n");
}
