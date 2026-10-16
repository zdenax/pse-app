// The console of Dell Networking N-series switches (DNOS 6.x, "Dell OS6"): N1100, N2000, N3000.
//
// Not the OS9 console: OS6 is a Broadcom/FASTPATH style CLI with Cisco-like modes (`enable`,
// `configure`, `interface gi1/0/1`, `interface range`, `switchport mode access|trunk|general`,
// `vlan 10` + `name`, `interface vlan 10` + `ip address A.B.C.D M.M.M.M`). The commands are a
// flat pattern table (below); a word is a keyword (abbreviations allowed), `<name>` takes one
// word and `<name...>` the rest of the line. The configuration itself lives in the project
// (DeviceAccess), the switchport text is the canonical one of cli/switchport.ts, so ping and the
// layer-2 simulation behave like on the other dialects.

import {
  chars,
  charCount,
  isNewline,
  splitCharacters,
  swiftInt,
  trimWhitespaces,
  VLANListParser,
} from "./command-tree";
import {
  definedVLANs,
  showIPInterfaceVLAN,
  showIPRoute,
  showInterfacesStatus,
  showInterfacesSwitchport,
  showRunningConfig,
  showSpanningTree,
  showVLAN,
  showVersion,
  vlanIsUp,
} from "./dell-os6-show";
import {
  announcePing,
  announceTraceroute,
  planPing,
  planTraceroute,
  lossNotice,
  tracerouteLossNotice,
  wholeMilliseconds,
} from "./features/realism/timing";
import { readSTPConfig, type STPConfig } from "../core/protocols/layer2";
import type { StaticRoute } from "../core/model";
import { type DeviceAccess, l3VLAN, type PortSnapshot } from "./model-access";
import { CLILimits, Notices } from "./notices";
import type { ConsoleEngine } from "./session";
import { IPv4, IPv4Prefix } from "./sim/ipv4";
import { SwitchportConfig } from "./switchport";

// MARK: Modes

type Mode =
  | { kind: "user" }
  | { kind: "priv" }
  | { kind: "config" }
  | { kind: "vlanDatabase" }
  | { kind: "vlan"; ids: number[] }
  | { kind: "interface"; ids: string[]; label: string }
  | { kind: "svi"; vlan: number };

/** Mode letters of a pattern: u user, p privileged, c global config, d vlan database, v vlan, i interface, s VLAN interface. */
type ModeLetters = string;
const exec: ModeLetters = "upcdvis";
const privileged: ModeLetters = "pcdvis";

type Args = Record<string, string>;
type Handler = (engine: DellOS6Engine, args: Args) => string;

interface Pattern {
  words: string[];
  modes: ModeLetters;
  help: string;
  run: Handler;
}

const invalidMarker = "% Invalid input detected at '^' marker.";

// MARK: Command table

/** Help of keywords that are not the last word of a pattern. */
const wordHelp: Record<string, string> = {
  show: "Display information",
  interface: "Configure an interface",
  interfaces: "Display interface information",
  ip: "IP configuration",
  switchport: "Configure switchport parameters",
  trunk: "Trunk mode parameters",
  access: "Access mode parameters",
  general: "General mode parameters",
  allowed: "Allowed VLANs",
  native: "Native VLAN",
  "spanning-tree": "Spanning tree commands",
  no: "Negate a command or set its defaults",
  copy: "Copy a file",
  write: "Write the running configuration",
  clear: "Clear information",
  vlan: "VLAN configuration",
  address: "IP address",
  route: "Static route",
  mac: "MAC address",
};

function build(): Pattern[] {
  const table: Pattern[] = [];
  const add = (modes: ModeLetters, words: string, help: string, run: Handler) =>
    table.push({ words: words.split(" "), modes, help, run });

  // Mode changes
  add("u", "enable", "Enter privileged EXEC mode", (e) => e.goto({ kind: "priv" }));
  add("p", "disable", "Return to user EXEC mode", (e) => e.goto({ kind: "user" }));
  add("p", "configure", "Enter global configuration mode", (e) => e.goto({ kind: "config" }));
  add("p", "configure terminal", "Configure from the terminal", (e) => e.goto({ kind: "config" }));
  add("upcdvis", "exit", "Exit from the current mode", (e) => e.exitMode());
  add("upcdvis", "logout", "Close the console", (e) => e.close());
  add("upcdvis", "quit", "Close the console", (e) => e.close());
  add("cdvis", "end", "Return to privileged EXEC mode", (e) => e.goto({ kind: "priv" }));
  add("cdvis", "do <command...>", "Run a privileged EXEC command", (e, a) => e.runExec(a.command));

  // Exec commands
  add("upcdvis", "show running-config", "Current operating configuration", (e) => showRunningConfig(e.access));
  add("upcdvis", "show vlan", "Display VLAN information", (e) => showVLAN(e.access, null));
  add("upcdvis", "show vlan id <id>", "VLAN ID", (e, a) => {
    const id = parseVLAN(a.id);
    return id === null ? "VLAN ID must be between 1 and 4094." : showVLAN(e.access, id);
  });
  add("upcdvis", "show interfaces status", "Interface status", (e) => showInterfacesStatus(e.access.interfaces));
  add("upcdvis", "show interfaces status <port...>", "Interface", (e, a) => {
    const ports = e.resolvePorts(a.port, false);
    return typeof ports === "string" ? ports : showInterfacesStatus(ports);
  });
  add("upcdvis", "show interfaces switchport <port...>", "Switchport settings", (e, a) => {
    const ports = e.resolvePorts(a.port, false);
    if (typeof ports === "string") return ports;
    return ports.map((port) => showInterfacesSwitchport(e.access, port)).join("\n\n");
  });
  add("upcdvis", "show ip interface vlan <id>", "VLAN interface", (e, a) => {
    const id = parseVLAN(a.id);
    if (id === null || !definedVLANs(e.access).includes(id)) return "VLAN ID not found.";
    return showIPInterfaceVLAN(e.access, id);
  });
  add("upcdvis", "show ip route", "IP routing table", (e) => showIPRoute(e.access));
  add("upcdvis", "show spanning-tree", "Spanning tree information", (e) => showSpanningTree(e.access));
  add("upcdvis", "show mac-address-table", "MAC address table", () => Notices.needsSimulation);
  add("upcdvis", "show arp", "ARP table", () => Notices.needsSimulation);
  add("upcdvis", "show version", "System hardware and software versions", (e) => showVersion(e.access));
  add("upcdvis", "ping <target...>", "Send ICMP echo messages", (e, a) => e.ping(a.target));
  add("upcdvis", "traceroute <target...>", "Trace the route to a destination", (e, a) => e.traceroute(a.target));
  add("p", "write", "Save the running configuration", (e) => e.askToSave());
  add("p", "write memory", "Save the running configuration", (e) => e.askToSave());
  add("p", "copy running-config startup-config", "Save the running configuration", (e) => e.askToSave());
  add("p", "clear config", "Reset the configuration to defaults", (e) => e.ask("clear", "Are you sure you want to clear the configuration? (y/n)"));
  add("p", "reload", "Reload the switch", (e) => e.ask("reload", "Are you sure you want to reload the stack? (y/n)"));

  // Global configuration
  add("c", "hostname <name...>", "Set the system name", (e, a) => {
    const name = trimWhitespaces(a.name).replace(/^"(.*)"$/, "$1");
    if (name === "" || /\s/.test(name)) return invalidMarker;
    return e.access.rename(name) ? "" : "% Invalid hostname.";
  });
  add("c", "no hostname", "Reset the system name", (e) => (e.access.rename("console") ? "" : ""));
  add("c", "vlan database", "Enter VLAN database mode", (e) => e.goto({ kind: "vlanDatabase" }));
  add("c", "vlan <list>", "VLAN ID or range", (e, a) => e.enterVLAN(a.list));
  add("d", "vlan <list>", "Create VLANs", (e, a) => e.createVLANs(a.list));
  add("c", "no vlan <list>", "Delete VLANs", (e, a) => e.deleteVLANs(a.list));
  add("d", "no vlan <list>", "Delete VLANs", (e, a) => e.deleteVLANs(a.list));
  add("c", "interface vlan <id>", "VLAN interface", (e, a) => e.enterSVI(a.id));
  add("c", "interface range <ports...>", "Interface range", (e, a) => e.enterPorts(a.ports, true));
  add("c", "interface <ports...>", "Interface", (e, a) => e.enterPorts(a.ports, false));
  add("c", "ip default-gateway <address>", "Default gateway of the switch", (e, a) => e.setGateway(a.address));
  add("c", "no ip default-gateway", "Remove the default gateway", (e) => {
    e.access.setDefaultGateway(null);
    return "";
  });
  add("c", "ip route <network> <mask> <hop>", "Static route", (e, a) => e.addRoute(a));
  add("c", "no ip route <network> <mask> <hop>", "Remove a static route", (e, a) => e.removeRoute(a));
  add("c", "ip routing", "Enable IP routing", () => "");
  add("c", "spanning-tree mode <mode>", "Spanning tree mode (stp, rstp, mstp, pvst, rapid-pvst)", (e, a) => e.setSTPMode(a.mode));
  add("c", "spanning-tree priority <value>", "Bridge priority (multiple of 4096)", (e, a) => e.setBridgePriority(a.value));
  add("c", "no spanning-tree priority", "Default bridge priority", (e) => e.setBridgePriority(null));
  add("c", "no spanning-tree", "Disable spanning tree", (e) => e.disableSTP());

  // VLAN mode
  add("v", "name <name...>", "VLAN name", (e, a) => e.nameVLAN(a.name));
  add("v", "no name", "Default VLAN name", (e) => e.nameVLAN(""));

  // VLAN interface mode
  add("s", "ip address <address> <mask>", "IP address and subnet mask", (e, a) => e.setSVIAddress(a.address, a.mask));
  add("s", "ip address dhcp", "Obtain the address by DHCP", () => Notices.dhcpNotSimulated);
  add("s", "no ip address", "Remove the IP address", (e) => e.clearSVIAddress());

  // Interface mode
  add("i", "shutdown", "Disable the interface", (e) => e.shutdown(true));
  add("i", "no shutdown", "Enable the interface", (e) => e.shutdown(false));
  add("i", "description <text...>", "Interface description", (e, a) => e.describe(a.text));
  add("i", "no description", "Remove the description", (e) => e.describe(""));
  add("i", "switchport mode access", "Access port", (e) => e.updatePorts(null, (c) => void (c.mode = "access")));
  add("i", "switchport mode trunk", "Trunk port", (e) => e.updatePorts(null, (c) => void (c.mode = "trunk")));
  add("i", "switchport mode general", "General port (stored as trunk)", (e) =>
    e.updatePorts(null, (c) => void (c.mode = "trunk"), GENERAL_NOTE),
  );
  add("i", "no switchport mode", "Default switchport mode", (e) => e.updatePorts(null, (c) => void (c.mode = "unset")));
  add("i", "switchport access vlan <id>", "Access VLAN", (e, a) => {
    const id = parseVLAN(a.id);
    return id === null ? invalidMarker : e.updatePorts(id, (c) => void (c.accessVLAN = id));
  });
  add("i", "no switchport access vlan", "Default access VLAN", (e) => e.updatePorts(null, (c) => void (c.accessVLAN = 1)));
  add("i", "switchport trunk native vlan <id>", "Native VLAN", (e, a) => {
    const id = parseVLAN(a.id);
    return id === null ? invalidMarker : e.updatePorts(null, (c) => void (c.nativeVLAN = id));
  });
  add("i", "no switchport trunk native vlan", "Default native VLAN", (e) => e.updatePorts(null, (c) => void (c.nativeVLAN = 1)));
  add("i", "switchport general pvid <id>", "PVID (stored as the native VLAN)", (e, a) => {
    const id = parseVLAN(a.id);
    return id === null ? invalidMarker : e.updatePorts(null, (c) => void (c.nativeVLAN = id), GENERAL_NOTE);
  });
  add("i", "switchport trunk allowed vlan all", "All VLANs", (e) => e.updatePorts(null, (c) => void (c.allowedVLANs = null)));
  add("i", "switchport trunk allowed vlan none", "No VLANs", (e) => e.updatePorts(null, (c) => void (c.allowedVLANs = [])));
  add("i", "no switchport trunk allowed vlan", "All VLANs", (e) => e.updatePorts(null, (c) => void (c.allowedVLANs = null)));
  add("i", "switchport trunk allowed vlan add <list>", "Add VLANs", (e, a) => e.allowedVLANs("add", a.list));
  add("i", "switchport trunk allowed vlan remove <list>", "Remove VLANs", (e, a) => e.allowedVLANs("remove", a.list));
  add("i", "switchport trunk allowed vlan <list>", "Replace the allowed VLANs", (e, a) => e.allowedVLANs("replace", a.list));
  add("i", "switchport general allowed vlan add <list>", "Add VLANs (stored as trunk)", (e, a) => e.allowedVLANs("add", a.list, GENERAL_NOTE));
  add("i", "switchport general allowed vlan add <list> <tagging>", "Tagging", (e, a) => e.allowedVLANs("add", a.list, GENERAL_NOTE));
  add("i", "switchport general allowed vlan remove <list>", "Remove VLANs", (e, a) => e.allowedVLANs("remove", a.list, GENERAL_NOTE));
  add("i", "spanning-tree portfast", "Enable PortFast (edge port)", (e) => e.portfast(true));
  add("i", "no spanning-tree portfast", "Disable PortFast", (e) => e.portfast(false));
  add("i", "spanning-tree cost <value>", "Port path cost", (e, a) => e.portCost(a.value));
  add("i", "no spanning-tree cost", "Default port path cost", (e) => e.portCost(null));
  add("i", "spanning-tree port-priority <value>", "Port priority (multiple of 16)", (e, a) => e.portPriority(a.value));
  add("i", "no spanning-tree port-priority", "Default port priority", (e) => e.portPriority(null));
  return table;
}

const GENERAL_NOTE = "NetSketch: režim general se ukládá jako trunk (PVID jako nativní VLAN).";

const patterns: readonly Pattern[] = build();

function parseVLAN(text: string): number | null {
  if (!/^[0-9]{1,4}$/.test(text)) return null;
  const value = Number(text);
  return value >= 1 && value <= 4094 ? value : null;
}

// MARK: Parsing

interface Word {
  text: string;
  lower: string;
  column: number;
}

function wordsOf(line: string): Word[] {
  const result: Word[] = [];
  const pattern = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    result.push({ text: match[0], lower: match[0].toLowerCase(), column: match.index });
  }
  return result;
}

const isArg = (word: string) => word.startsWith("<");
const isRest = (word: string) => word.startsWith("<") && word.endsWith("...>");
const argName = (word: string) => word.slice(1, isRest(word) ? -4 : -1);

type Parsed =
  | { kind: "run"; pattern: Pattern; args: Args }
  | { kind: "incomplete" }
  | { kind: "ambiguous" }
  | { kind: "invalid"; column: number };

function forMode(letter: string): Pattern[] {
  return patterns.filter((pattern) => pattern.modes.includes(letter));
}

/** Narrows the candidate patterns word by word. */
function narrow(candidates: Pattern[], words: Word[]): { rest: Pattern[]; failedAt: number | null; ambiguous: boolean } {
  let current = candidates;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const matching = current.filter((pattern) => {
      const expected = pattern.words[index] ?? (isRest(pattern.words[pattern.words.length - 1]) ? "<...>" : undefined);
      if (expected === undefined) return false;
      if (isArg(expected)) return true;
      return expected.startsWith(word.lower);
    });
    const literals = matching.filter((pattern) => {
      const expected = pattern.words[index];
      return expected !== undefined && !isArg(expected);
    });
    let kept = matching;
    if (literals.length > 0) {
      const exact = literals.filter((pattern) => pattern.words[index] === word.lower);
      kept = exact.length > 0 ? exact : literals;
      const distinct = new Set(kept.map((pattern) => pattern.words[index]));
      if (distinct.size > 1 && exact.length === 0) return { rest: kept, failedAt: null, ambiguous: true };
    }
    if (kept.length === 0) return { rest: [], failedAt: index, ambiguous: false };
    // A rest argument earlier in a pattern swallows every later word.
    current = kept;
  }
  return { rest: current, failedAt: null, ambiguous: false };
}

function parse(tree: Pattern[], words: Word[]): Parsed {
  const narrowed = narrow(tree, words);
  if (narrowed.failedAt !== null) return { kind: "invalid", column: words[narrowed.failedAt].column };
  if (narrowed.ambiguous) return { kind: "ambiguous" };
  const complete = narrowed.rest.find((pattern) => {
    const last = pattern.words[pattern.words.length - 1];
    if (isRest(last)) return words.length >= pattern.words.length;
    return pattern.words.length === words.length;
  });
  if (!complete) return { kind: "incomplete" };
  const args: Args = {};
  complete.words.forEach((expected, index) => {
    if (!isArg(expected)) return;
    args[argName(expected)] = isRest(expected) ? words.slice(index).map((word) => word.text).join(" ") : words[index].text;
  });
  return { kind: "run", pattern: complete, args };
}

// MARK: Engine

type Pending = { kind: "save" | "clear" | "reload" } | null;

export class DellOS6Engine implements ConsoleEngine {
  mode: Mode = { kind: "user" };
  private closedFlag = false;
  private lastHostname: string;
  private pending: Pending = null;
  private readonly lines: string[] = [];

  constructor(readonly access: DeviceAccess) {
    this.lastHostname = access.hostname;
  }

  get isClosed(): boolean {
    return this.closedFlag;
  }

  get hostname(): string {
    const device = this.access.device;
    if (device) this.lastHostname = device.hostname;
    return this.lastHostname;
  }

  get banner(): string {
    const model = [this.access.vendor, this.access.model].filter((part) => part !== "").join(" ");
    return Notices.banner(this.hostname, model, "Dell OS6", false);
  }

  get prompt(): string {
    const host = this.hostname;
    const mode = this.mode;
    switch (mode.kind) {
      case "user":
        return host + ">";
      case "priv":
        return host + "#";
      case "config":
        return host + "(config)#";
      case "vlanDatabase":
        return host + "(Config-vlan)#";
      case "vlan":
        return host + `(config-vlan${mode.ids.join(",")})#`;
      case "interface":
        return host + `(config-if${mode.label === "" ? "" : "-" + mode.label})#`;
      case "svi":
        return host + `(config-if-vlan${mode.vlan})#`;
    }
  }

  private get letter(): string {
    switch (this.mode.kind) {
      case "user":
        return "u";
      case "priv":
        return "p";
      case "config":
        return "c";
      case "vlanDatabase":
        return "d";
      case "vlan":
        return "v";
      case "interface":
        return "i";
      case "svi":
        return "s";
    }
  }

  // Mode helpers used by the handlers

  goto(mode: Mode): string {
    this.mode = mode;
    return "";
  }

  close(): string {
    this.closedFlag = true;
    return "";
  }

  exitMode(): string {
    switch (this.mode.kind) {
      case "user":
      case "priv":
        this.closedFlag = true;
        break;
      case "config":
        this.mode = { kind: "priv" };
        break;
      default:
        this.mode = { kind: "config" };
    }
    return "";
  }

  // MARK: Execution

  execute(line: string): string {
    const characters = chars(line);
    if (characters.some(isNewline)) {
      const outputs = splitCharacters(line, isNewline).map((piece) => this.execute(piece));
      return outputs.filter((output) => output !== "").join("\n");
    }
    if (this.closedFlag) return "";
    if (!this.access.exists) {
      this.closedFlag = true;
      return Notices.deviceGone;
    }
    if (characters.length > CLILimits.maxLineLength) return Notices.lineTooLong;

    if (this.pending !== null) return this.answer(line);

    if (line.includes("\u001A")) {
      if (this.mode.kind !== "user" && this.mode.kind !== "priv") this.mode = { kind: "priv" };
      return "";
    }
    const trimmed = trimWhitespaces(line);
    if (trimmed === "" || trimmed.startsWith("!")) return "";
    if (trimmed.endsWith("?")) {
      const mark = line.lastIndexOf("?");
      return this.help(mark >= 0 ? line.slice(0, mark) : line);
    }
    this.lines.push(trimmed);
    if (this.lines.length > CLILimits.historySize) this.lines.shift();
    return this.run(line, charCount(this.prompt));
  }

  private run(line: string, promptWidth: number): string {
    const words = wordsOf(line);
    const result = this.parseInMode(words);
    switch (result.kind) {
      case "run":
        return result.pattern.run(this, result.args);
      case "incomplete":
        return "% Incomplete command.";
      case "ambiguous":
        return "% Ambiguous command.";
      case "invalid":
        return " ".repeat(promptWidth + result.column) + "^\n" + invalidMarker;
    }
  }

  /** The command in the current mode; a global command typed in a sub-mode leaves it. */
  private parseInMode(words: Word[]): Parsed {
    const first = parse(forMode(this.letter), words);
    const sub = this.letter === "v" || this.letter === "i" || this.letter === "s" || this.letter === "d";
    if (first.kind !== "run" && sub) {
      const global = parse(forMode("c"), words);
      if (global.kind === "run") {
        this.mode = { kind: "config" };
        return global;
      }
    }
    return first;
  }

  /** `do <command>`: an exec command from configuration mode. */
  runExec(command: string): string {
    const words = wordsOf(command);
    const result = parse(forMode("p"), words);
    if (result.kind !== "run") return result.kind === "invalid" ? invalidMarker : "% Incomplete command.";
    return result.pattern.run(this, result.args);
  }

  // MARK: Confirmations (write memory, clear config, reload)

  ask(kind: "clear" | "reload", question: string): string {
    this.pending = { kind };
    return question;
  }

  askToSave(): string {
    this.pending = { kind: "save" };
    return [
      "This operation may take a few minutes.",
      "Management interfaces will not be available during this time.",
      "",
      "Are you sure you want to save? (y/n)",
    ].join("\n");
  }

  private answer(line: string): string {
    const pending = this.pending;
    this.pending = null;
    if (pending === null) return "";
    const yes = /^\s*y(es)?\s*$/i.test(line);
    if (!yes) return pending.kind === "save" ? "\nConfiguration Not Saved!" : "";
    switch (pending.kind) {
      case "save":
        return "\nConfiguration Saved!\n" + Notices.savedInProject;
      case "clear":
        this.clearConfiguration();
        return "\nConfiguration Cleared!";
      case "reload":
        return "NetSketch: restart se nesimuluje, konfigurace v diagramu zůstává beze změny.";
    }
  }

  private clearConfiguration(): void {
    const access = this.access;
    access.transaction(() => {
      access.setVLANs([]);
      for (const port of access.interfaces) {
        access.setVLANText("", port.id);
        access.setAdminDown(false, port.id);
        access.setDescription("", port.id);
      }
      for (const entry of access.addresses) access.setAddress(null, entry.interface);
      access.setDefaultGateway(null);
      access.setStaticRoutes([]);
      access.updateProtocols((protocols) => {
        protocols.stp = undefined;
      });
    });
    this.mode = { kind: "priv" };
  }

  // MARK: Help and completion

  help(partial: string): string {
    if (!this.access.exists || this.closedFlag || charCount(partial) > CLILimits.maxLineLength) return "";
    const tree = forMode(this.letter);
    const words = wordsOf(partial);
    const endsNew = words.length === 0 || /\s$/.test(partial);
    const done = endsNew ? words : words.slice(0, -1);
    const narrowed = narrow(tree, done);
    if (narrowed.failedAt !== null) return "% Unrecognized command";
    if (narrowed.ambiguous) return "% Ambiguous command.";
    const position = done.length;
    const rows = new Map<string, string>();
    for (const pattern of narrowed.rest) {
      const expected = pattern.words[position];
      if (expected === undefined) {
        if (endsNew) rows.set("<cr>", "");
        continue;
      }
      if (!endsNew && !isArg(expected) && !expected.startsWith(words[words.length - 1].lower)) continue;
      if (!endsNew && isArg(expected)) continue;
      const isLast = position === pattern.words.length - 1;
      const text = isLast ? pattern.help : (wordHelp[expected] ?? "");
      const shown = isRest(expected) ? `<${argName(expected)}>` : expected;
      const existing = rows.get(shown);
      if (existing === undefined || (existing === "" && text !== "")) rows.set(shown, text);
    }
    if (rows.size === 0) return "% Unrecognized command";
    if (!endsNew) return [...rows.keys()].sort().join("  ");
    const names = [...rows.keys()].sort((a, b) => (a === "<cr>" ? 1 : b === "<cr>" ? -1 : a.localeCompare(b)));
    return names.map((name) => `  ${name.padEnd(22)}${rows.get(name) ?? ""}`.trimEnd()).join("\n");
  }

  complete(partial: string): string[] {
    if (!this.access.exists || this.closedFlag || charCount(partial) > CLILimits.maxLineLength) return [];
    const words = wordsOf(partial);
    const endsNew = words.length === 0 || /\s$/.test(partial);
    const done = endsNew ? words : words.slice(0, -1);
    const narrowed = narrow(forMode(this.letter), done);
    if (narrowed.failedAt !== null) return [];
    const prefix = endsNew ? "" : words[words.length - 1].lower;
    const result = new Set<string>();
    for (const pattern of narrowed.rest) {
      const expected = pattern.words[done.length];
      if (expected !== undefined && !isArg(expected) && expected.startsWith(prefix)) result.add(expected);
    }
    return [...result].sort();
  }

  // MARK: Interfaces

  /** Ports named by an interface expression, or an error text. */
  resolvePorts(text: string, allowRange: boolean): PortSnapshot[] | string {
    const all = this.access.interfaces;
    const normalize = (value: string) =>
      value
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/^tengigabitethernet/, "te")
        .replace(/^tengigabit/, "te")
        .replace(/^gigabitethernet/, "gi")
        .replace(/^gigabit/, "gi");
    const byName = new Map(all.map((port) => [port.name.toLowerCase(), port]));
    const found: PortSnapshot[] = [];
    const segments = text.split(",");
    if (!allowRange && segments.length !== 1) return "% Invalid interface specified.";
    for (const segment of segments) {
      const spec = normalize(segment);
      const range = /^([a-z]+)((?:\d+\/)+)(\d+)(?:-(?:(?:\d+\/)*)(\d+))?$/.exec(spec);
      if (range === null) return "% Invalid interface specified.";
      const [, type, prefix, from, to] = range;
      if (to !== undefined && !allowRange) return "% Invalid interface specified.";
      const low = Number(from);
      const high = to === undefined ? low : Number(to);
      if (low > high) return "% Invalid interface specified.";
      for (let number = low; number <= high; number += 1) {
        const port = byName.get(`${type}${prefix}${number}`);
        if (!port) return "% Invalid interface specified.";
        if (!found.includes(port)) found.push(port);
      }
    }
    return found;
  }

  enterPorts(text: string, range: boolean): string {
    const vlan = /^vlan\s*(\d+)$/i.exec(text.trim());
    if (vlan) return this.enterSVI(vlan[1]);
    const ports = this.resolvePorts(text, range);
    if (typeof ports === "string") return ports;
    const single = ports.length === 1 && !range;
    this.mode = { kind: "interface", ids: ports.map((port) => port.id), label: single ? ports[0].name : "" };
    return "";
  }

  enterSVI(idText: string): string {
    const id = parseVLAN(idText);
    if (id === null) return invalidMarker;
    if (!definedVLANs(this.access).includes(id)) return "VLAN ID not found.";
    this.mode = { kind: "svi", vlan: id };
    return "";
  }

  /** The live ports of the interface mode; leaves the mode when they are gone. */
  private selected(): PortSnapshot[] {
    if (this.mode.kind !== "interface") return [];
    const ids = this.mode.ids;
    const live = this.access.interfaces.filter((port) => ids.includes(port.id));
    if (live.length === 0) {
      this.mode = { kind: "config" };
    }
    return live;
  }

  shutdown(down: boolean): string {
    const ports = this.selected();
    if (ports.length === 0) return Notices.interfaceGone;
    for (const port of ports) this.access.setAdminDown(down, port.id);
    return "";
  }

  describe(text: string): string {
    const ports = this.selected();
    if (ports.length === 0) return Notices.interfaceGone;
    const clean = trimWhitespaces(text).replace(/^"(.*)"$/, "$1");
    for (const port of ports) this.access.setDescription(clean, port.id);
    return "";
  }

  /** Changes the switchport configuration of every selected port. */
  updatePorts(ensuringVLAN: number | null, change: (config: SwitchportConfig) => void, note = ""): string {
    const ports = this.selected();
    if (ports.length === 0) return Notices.interfaceGone;
    const access = this.access;
    if (ensuringVLAN !== null && !definedVLANs(access).includes(ensuringVLAN)) {
      return `VLAN ${ensuringVLAN} does not exist. Create it first with "vlan ${ensuringVLAN}".`;
    }
    const messages: string[] = [];
    if (note !== "") messages.push(note);
    access.transaction(() => {
      for (const port of ports) {
        if (!port.isSwitchport) {
          messages.push(Notices.managementPort);
          continue;
        }
        const config = port.switchport ?? new SwitchportConfig();
        change(config);
        access.setVLANText(config.canonicalText, port.id);
      }
    });
    return [...new Set(messages)].join("\n");
  }

  allowedVLANs(kind: "add" | "remove" | "replace", text: string, note = ""): string {
    const list = VLANListParser.parse(text);
    if (list === null) return invalidMarker;
    return this.updatePorts(
      null,
      (config) => {
        const current = config.allowedVLANs;
        switch (kind) {
          case "replace":
            config.allowedVLANs = list;
            break;
          case "add":
            if (current !== null) config.allowedVLANs = [...new Set([...current, ...list])].sort((a, b) => a - b);
            break;
          case "remove": {
            const base = current ?? SwitchportConfig.allVLANList();
            config.allowedVLANs = base.filter((id) => !list.includes(id));
          }
        }
      },
      note,
    );
  }

  // MARK: VLANs

  createVLANs(text: string): string {
    const ids = VLANListParser.parse(text);
    if (ids === null) return invalidMarker;
    const existing = new Set(this.access.vlans.map((entry) => entry.id));
    const missing = ids.filter((id) => id !== 1 && !existing.has(id));
    if (missing.length > 0) {
      this.access.setVLANs([...this.access.vlans, ...missing.map((id) => ({ id, name: "" }))]);
    }
    return "";
  }

  enterVLAN(text: string): string {
    const ids = VLANListParser.parse(text);
    if (ids === null) return invalidMarker;
    this.createVLANs(text);
    this.mode = { kind: "vlan", ids };
    return "";
  }

  deleteVLANs(text: string): string {
    const ids = VLANListParser.parse(text);
    if (ids === null) return invalidMarker;
    const messages: string[] = [];
    if (ids.includes(1)) messages.push("The default VLAN 1 cannot be deleted.");
    const doomed = new Set(ids.filter((id) => id !== 1));
    const current = this.access.vlans;
    const remaining = current.filter((entry) => !doomed.has(entry.id));
    if (remaining.length !== current.length) this.access.setVLANs(remaining);
    return messages.join("\n");
  }

  nameVLAN(name: string): string {
    if (this.mode.kind !== "vlan") return "";
    if (this.mode.ids.length !== 1) return Notices.singleVLANOnly;
    const id = this.mode.ids[0];
    const clean = trimWhitespaces(name).replace(/^"(.*)"$/, "$1");
    if (id === 1) return "The default VLAN name cannot be changed.";
    const vlans = this.access.vlans;
    const entry = vlans.find((candidate) => candidate.id === id);
    if (entry) entry.name = clean;
    else vlans.push({ id, name: clean });
    this.access.setVLANs(vlans);
    return "";
  }

  // MARK: IP

  setSVIAddress(addressText: string, maskText: string): string {
    if (this.mode.kind !== "svi") return "";
    const prefix = IPv4Prefix.fromAddressMask(addressText, maskText);
    if (prefix === null || !prefix.isHostAddress) return "% Invalid IP address.";
    const interfaceID = l3VLAN(this.mode.vlan);
    const overlap = this.access.addresses.find((entry) => {
      if (entry.interface === interfaceID) return false;
      const other = IPv4Prefix.fromCIDR(entry.address);
      return other !== null && (other.contains(prefix.address) || prefix.contains(other.address));
    });
    if (overlap) return "The specified IP address overlaps with another routing interface.";
    this.access.setAddress(prefix, interfaceID);
    const owner = this.access.addressConflict(prefix.address, interfaceID);
    return owner !== null ? Notices.duplicateAddress(prefix.address.description, owner) : "";
  }

  clearSVIAddress(): string {
    if (this.mode.kind !== "svi") return "";
    this.access.setAddress(null, l3VLAN(this.mode.vlan));
    return "";
  }

  setGateway(text: string): string {
    const gateway = IPv4.parse(text);
    if (gateway === null) return "% Invalid IP address.";
    this.access.setDefaultGateway(gateway);
    // The gateway is used only while the VLAN interface of its subnet is up.
    for (const entry of this.access.addresses) {
      const prefix = IPv4Prefix.fromCIDR(entry.address);
      const match = /^vlan:(\d+)$/.exec(entry.interface);
      if (prefix === null || match === null || !prefix.contains(gateway)) continue;
      const vlan = Number(match[1]);
      if (!vlanIsUp(this.access, vlan)) {
        return `Warning: the default gateway ${gateway.description} becomes active once interface Vlan${vlan} is up.`;
      }
    }
    return "";
  }

  private parseRoute(args: Args): StaticRoute | null {
    const network = IPv4Prefix.fromAddressMask(args.network, args.mask);
    const hop = IPv4.parse(args.hop);
    if (network === null || hop === null) return null;
    return { destination: network.networkPrefix.description, nextHop: hop.description };
  }

  addRoute(args: Args): string {
    const route = this.parseRoute(args);
    if (route === null) return "% Invalid IP address.";
    const routes = this.access.staticRoutes;
    if (!routes.some((stored) => stored.destination === route.destination && stored.nextHop === route.nextHop)) {
      this.access.setStaticRoutes([...routes, route]);
    }
    return "";
  }

  removeRoute(args: Args): string {
    const route = this.parseRoute(args);
    if (route === null) return "% Invalid IP address.";
    const routes = this.access.staticRoutes;
    const remaining = routes.filter((stored) => !(stored.destination === route.destination && stored.nextHop === route.nextHop));
    if (remaining.length === routes.length) return "% Route not found.";
    this.access.setStaticRoutes(remaining);
    return "";
  }

  // MARK: Spanning tree

  private updateSTP(change: (config: STPConfig) => void): string {
    this.access.updateProtocols((protocols) => {
      const config =
        readSTPConfig(protocols.stp) ??
        ({ mode: "rstp", disabledVLANs: [], priorities: [], portfast: [], bpduGuard: [], costs: [], portPriorities: [] } as STPConfig);
      change(config);
      protocols.stp = config;
    });
    return "";
  }

  setSTPMode(word: string): string {
    const modes: Record<string, STPConfig["mode"]> = {
      stp: "stp",
      rstp: "rstp",
      mstp: "mst",
      pvst: "pvst",
      "rapid-pvst": "rapid-pvst",
    };
    const typed = word.toLowerCase();
    const matches = Object.keys(modes).filter((name) => name.startsWith(typed));
    const chosen = matches.includes(typed) ? typed : matches.length === 1 ? matches[0] : null;
    if (chosen === null) return invalidMarker;
    return this.updateSTP((config) => {
      config.mode = modes[chosen];
    });
  }

  disableSTP(): string {
    return this.updateSTP((config) => {
      config.mode = "none";
    });
  }

  setBridgePriority(text: string | null): string {
    if (text === null) {
      return this.updateSTP((config) => {
        config.priorities = config.priorities.filter((entry) => entry.vlan !== 0);
      });
    }
    const value = swiftInt(text);
    if (value === null || value < 0 || value > 61440) return "Value is out of range. The valid range is 0 to 61440.";
    if (value % 4096 !== 0) return "The bridge priority must be a multiple of 4096.";
    return this.updateSTP((config) => {
      config.priorities = config.priorities.filter((entry) => entry.vlan !== 0);
      config.priorities.push({ vlan: 0, priority: value });
    });
  }

  portfast(on: boolean): string {
    const ports = this.selected();
    if (ports.length === 0) return Notices.interfaceGone;
    return this.updateSTP((config) => {
      for (const port of ports) {
        const rest = config.portfast.filter((id) => id !== port.id);
        config.portfast = on ? [...rest, port.id] : rest;
      }
    });
  }

  portCost(text: string | null): string {
    const ports = this.selected();
    if (ports.length === 0) return Notices.interfaceGone;
    const value = text === null ? null : swiftInt(text);
    if (text !== null && (value === null || value < 0 || value > 200000000)) return "Value is out of range. The valid range is 0 to 200000000.";
    return this.updateSTP((config) => {
      for (const port of ports) {
        config.costs = config.costs.filter((entry) => !(entry.port === port.id && entry.vlan === 0));
        if (value !== null && value > 0) config.costs.push({ port: port.id, vlan: 0, cost: value });
      }
    });
  }

  portPriority(text: string | null): string {
    const ports = this.selected();
    if (ports.length === 0) return Notices.interfaceGone;
    const value = text === null ? null : swiftInt(text);
    if (text !== null && (value === null || value < 0 || value > 240)) return "Value is out of range. The valid range is 0 to 240.";
    if (value !== null && value % 16 !== 0) return "The port priority must be a multiple of 16.";
    return this.updateSTP((config) => {
      for (const port of ports) {
        config.portPriorities = config.portPriorities.filter((entry) => !(entry.port === port.id && entry.vlan === 0));
        if (value !== null) config.portPriorities.push({ port: port.id, vlan: 0, priority: value });
      }
    });
  }

  // MARK: ping and traceroute

  ping(text: string): string {
    const words = text.split(/\s+/).filter((word) => word !== "");
    const destination = IPv4.parse(words[0] ?? "");
    if (destination === null) return "% Invalid host address.";
    let count = 5;
    const index = words.findIndex((word) => word.toLowerCase() === "count");
    if (index >= 0 && index + 1 < words.length) {
      const value = swiftInt(words[index + 1]);
      if (value !== null && value >= 1 && value <= 100) count = value;
    }
    const access = this.access;
    const simulator = access.simulator;
    const result = simulator.ping(access.deviceID, destination);
    const plan = planPing(simulator, access.deviceID, destination, result, count);
    announcePing(access.deviceID, result, plan);
    const lines = [`Pinging ${destination.description} with 0 bytes of data:`, ""];
    let received = 0;
    for (let echo = 0; echo < count; echo += 1) {
      const sample = plan.active ? plan.samples[echo] : undefined;
      const answered = plan.active ? sample !== undefined && !sample.lost : result.success;
      if (answered) {
        received += 1;
        const time = sample !== undefined && sample.rtt >= 10 ? `${wholeMilliseconds(sample.rtt)} msec` : "<10 msec";
        lines.push(`Reply From ${destination.description}: icmp_seq = ${echo}. time${time.startsWith("<") ? "" : " = "}${time}.`);
      } else {
        lines.push(`Request timed out for icmp_seq ${echo}`);
      }
    }
    const percent = Math.round(((count - received) * 100) / count);
    lines.push(
      "",
      `----${destination.description} PING statistics----`,
      `${count} packets transmitted, ${received} packets received, ${percent}% packet loss`,
    );
    if (received === 0) {
      const reason = simulator.explain(result);
      if (reason !== "") lines.push(reason);
    }
    const lost = lossNotice(plan);
    if (lost !== "") lines.push(lost);
    return lines.join("\n");
  }

  traceroute(text: string): string {
    const words = text.split(/\s+/).filter((word) => word !== "");
    const destination = IPv4.parse(words[0] ?? "");
    if (destination === null) return "% Invalid host address.";
    const access = this.access;
    const simulator = access.simulator;
    const delivery = simulator.deliver(access.deviceID, destination);
    const plan = planTraceroute(simulator, access.deviceID, destination, delivery);
    announceTraceroute(access.deviceID, delivery);
    const lines = [`Tracing route to ${destination.description} over a maximum of 20 hops`, ""];
    delivery.hops.forEach((hop, index) => {
      const probes = plan.active ? (plan.hops[index] ?? []) : [];
      const times = plan.active
        ? probes.map((probe) => (probe.rtt === null ? "*" : `${wholeMilliseconds(probe.rtt)} ms`)).join("  ")
        : "<10 ms  <10 ms  <10 ms";
      lines.push(`${index + 1}  ${hop.description}  ${times}`);
    });
    if (!delivery.delivered) {
      lines.push(`${delivery.hops.length + 1}  *  *  *`);
      const reason = simulator.explain(simulator.ping(access.deviceID, destination));
      if (reason !== "") lines.push(reason);
    }
    const notice = tracerouteLossNotice(plan);
    if (notice !== "") lines.push(notice);
    return lines.join("\n");
  }
}
