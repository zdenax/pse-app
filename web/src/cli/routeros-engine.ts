// A small, accurate subset of the MikroTik RouterOS console (port of
// NetSketchCLI/RouterOSEngine.swift).
//
// Menus: `/interface`, `/interface ethernet`, `/ip address`, `/ip route`, `/system identity`.
// Commands: `print`, `set`, `enable`, `disable`, `comment`, `add`, `remove`, `export`, `/ping`,
// `/quit`, `..` and `/`. Words and argument names may be abbreviated to any unique prefix, as
// on RouterOS. Like the IOS engine it keeps no state of its own: reads come from the project,
// writes go through the store; `/ping` asks the network simulation.

import type { L3InterfaceID, StaticRoute } from "../core/model";
import {
  charCount,
  chars,
  isASCIIDigit,
  isNewline,
  isWhitespace,
  leftPadded,
  padded,
  splitCharacters,
  splitWords,
  swiftInt,
  trimWhitespaces,
  trimmingTrailingWhitespace,
} from "./command-tree";
import type { DeviceAccess, PortSnapshot } from "./model-access";
import { CLILimits, Notices } from "./notices";
import type { ConsoleEngine } from "./session";
import { IPv4, IPv4Prefix } from "./sim/ipv4";
import { collectRouterOSMenus, type RouterOSContext, type RouterOSFeatureMenu } from "./features/routeros-menus";
import { announcePing, lossNotice, planPing, routerOSTime, wholeMilliseconds } from "./features/realism/timing";
import { NetworkSimulator } from "./sim/network-simulator";

// MARK: Menu tree (the single definition used by execution, help and completion)

type Action =
  | "print"
  | "set"
  | "enable"
  | "disable"
  | "comment"
  | "add"
  | "remove"
  | "export"
  | "ping"
  | "quit"
  | "feature";

interface Command {
  readonly name: string;
  readonly help: string;
  readonly action: Action;
  /** A command of a protocol feature (features/routeros-menus.ts). */
  readonly run?: (context: RouterOSContext, args: Word[]) => string;
}

interface Menu {
  readonly name: string;
  readonly help: string;
  readonly submenus: readonly Menu[];
  readonly commands: readonly Command[];
}

const exportCommand: Command = {
  name: "export",
  help: "Print or save an export script that can be used to restore configuration",
  action: "export",
};

const itemCommands: readonly Command[] = [
  { name: "print", help: "Print values of item properties", action: "print" },
  { name: "set", help: "Change item properties", action: "set" },
  { name: "enable", help: "Enable items", action: "enable" },
  { name: "disable", help: "Disable items", action: "disable" },
  { name: "comment", help: "Set comment for items", action: "comment" },
  exportCommand,
];

/** Commands of the list menus `/ip address` and `/ip route`. */
const listCommands: readonly Command[] = [
  { name: "add", help: "Create a new item", action: "add" },
  { name: "print", help: "Print values of item properties", action: "print" },
  { name: "remove", help: "Remove item", action: "remove" },
  exportCommand,
];

const addressMenu = ["ip", "address"];
const routeMenu = ["ip", "route"];
const identityMenu = ["system", "identity"];

const rootMenu: Menu = {
  name: "",
  help: "",
  submenus: [
    {
      name: "interface",
      help: "Interface configuration",
      submenus: [{ name: "ethernet", help: "Ethernet interface configuration", submenus: [], commands: itemCommands }],
      commands: itemCommands,
    },
    {
      name: "ip",
      help: "IP options",
      submenus: [
        { name: "address", help: "Address management", submenus: [], commands: listCommands },
        { name: "route", help: "Route management", submenus: [], commands: listCommands },
      ],
      commands: [exportCommand],
    },
    {
      name: "system",
      help: "System information and utilities",
      submenus: [
        {
          name: "identity",
          help: "System identity (the name of the router)",
          submenus: [],
          commands: [
            { name: "print", help: "Print values of item properties", action: "print" },
            { name: "set", help: "Change item properties", action: "set" },
            exportCommand,
          ],
        },
      ],
      commands: [],
    },
  ],
  commands: [
    exportCommand,
    { name: "ping", help: "Send ICMP Echo packets", action: "ping" },
    { name: "quit", help: "Quit console", action: "quit" },
  ],
};

function sameMenu(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/** Exact name first, otherwise a unique prefix. */
function resolve<T>(word: string, items: readonly T[], name: (item: T) => string): T | null {
  const lower = word.toLowerCase();
  const exact = items.find((item) => name(item) === lower);
  if (exact !== undefined) return exact;
  const matches = items.filter((item) => name(item).startsWith(lower));
  return matches.length === 1 ? matches[0] : null;
}

// MARK: Tokens

interface Word {
  readonly text: string;
  /** One-based column, as RouterOS reports it. */
  readonly column: number;
}

/**
 * Splits a line into words. Quotes and `[ ... ]` keep their spaces; slashes separate menu
 * names ("/interface/ethernet/print") until the first `key=value` word.
 */
function wordsOf(line: string): { words: Word[]; absolute: boolean } {
  const result: Word[] = [];
  let current = "";
  let start = 1;
  let column = 0;
  let inQuotes = false;
  let depth = 0;
  let absolute = false;
  let seenContent = false;

  const flush = (): void => {
    if (current !== "") result.push({ text: current, column: start });
    current = "";
  };
  for (const character of chars(line)) {
    column += 1;
    if (inQuotes) {
      current += character;
      if (character === '"') inQuotes = false;
      continue;
    }
    if (depth > 0) {
      current += character;
      if (character === "[") depth += 1;
      if (character === "]") depth -= 1;
      continue;
    }
    if (isWhitespace(character)) {
      flush();
      continue;
    }
    if (character === "/" && !current.includes("=")) {
      if (!seenContent) absolute = true;
      flush();
      seenContent = true;
      continue;
    }
    if (current === "") start = column;
    seenContent = true;
    if (character === '"') inQuotes = true;
    if (character === "[") depth = 1;
    current += character;
  }
  flush();
  return { words: result, absolute };
}

/** Drops the first `count` Characters. */
function dropFirst(text: string, count: number): string {
  return chars(text).slice(count).join("");
}

function unquoted(text: string): string {
  let value = text;
  if (charCount(value) >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const characters = chars(value);
    value = characters.slice(1, characters.length - 1).join("");
  } else if (value.startsWith('"')) {
    value = dropFirst(value, 1);
  }
  return value.split('\\"').join('"');
}

/** The text after the first "=" of a word. */
function afterEquals(text: string, equals: number): string {
  return text.slice(equals + 1);
}

/** `[ ... ]` without the brackets (the closing one may be missing). */
function bracketInner(text: string): string {
  const characters = chars(text).slice(1);
  if (text.endsWith("]") && characters.length > 0) characters.pop();
  return characters.join("");
}

/** Swift `split(separator:maxSplits:)` with empty pieces omitted. */
function splitOnce(text: string, separator: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] === separator) {
      const appended = start !== index;
      if (appended) pieces.push(text.slice(start, index));
      index += 1;
      start = index;
      if (appended && pieces.length === 1) break;
      continue;
    }
    index += 1;
  }
  if (start !== text.length) pieces.push(text.slice(start));
  return pieces;
}

/** A short ASCII number ("0".."999999") as RouterOS item numbers are written. */
function itemNumber(text: string): number | null {
  if (text === "" || charCount(text) > 6 || !chars(text).every(isASCIIDigit)) return null;
  return swiftInt(text);
}

/** Description texts are shown on one line. */
/** The menu tree with the menus of the protocol features merged in. */
function withFeatureMenus(base: Menu, features: RouterOSFeatureMenu[]): Menu {
  const copy = (menu: Menu): Menu => ({ ...menu, submenus: menu.submenus.map(copy), commands: [...menu.commands] });
  const result = copy(base);
  for (const feature of features) {
    let menu = result;
    for (const [index, name] of feature.path.entries()) {
      let next = menu.submenus.find((submenu) => submenu.name === name);
      if (!next) {
        const last = index === feature.path.length - 1;
        next = { name, help: last ? feature.help : "", submenus: [], commands: last ? [] : [exportCommand] };
        (menu.submenus as Menu[]).push(next);
      }
      menu = next;
    }
    const commands = menu.commands as Command[];
    for (const command of feature.commands) {
      const existing = commands.findIndex((candidate) => candidate.name === command.name);
      const entry: Command = {
        name: command.name,
        help: command.help,
        action: "feature",
        run: (context, args) => command.run(context, args),
      };
      if (existing >= 0) commands[existing] = entry;
      else commands.push(entry);
    }
    if (!commands.some((command) => command.name === "export")) commands.push(exportCommand);
  }
  return result;
}

function oneLine(text: string): string {
  return splitCharacters(text, isNewline).join(" ");
}

type Selection = { kind: "ports"; ports: PortSnapshot[] } | { kind: "failure"; message: string };
type NamedArguments = { kind: "values"; values: Map<string, string> } | { kind: "failure"; message: string };
type ItemNumbers = { kind: "items"; items: number[] } | { kind: "failure"; message: string };
type InterfaceLookup = { kind: "found"; id: L3InterfaceID; name: string } | { kind: "failure"; message: string };

interface Property {
  readonly key: string;
  readonly value: string;
  readonly word: Word;
}

/** Where a row of `/ip route print` comes from. */
type RouteSource =
  /** A connected network (dynamic): goes away with its address. */
  | { kind: "connected" }
  /** `staticRoutes[index]` of the device. */
  | { kind: "stored"; index: number }
  /** The device's default gateway (set outside RouterOS), shown as a static default route. */
  | { kind: "defaultGateway" };

/** One row of `/ip route print`. */
interface RouteRow {
  /** "ADC", "A S" or "  S" (inactive static route). */
  readonly flags: string;
  readonly destination: string;
  readonly preferredSource: string;
  readonly gateway: string;
  readonly distance: number;
  readonly source: RouteSource;
}

/** Ethernet properties RouterOS knows but the diagram has no field for. */
const unstoredProperties = new Set([
  "mtu",
  "l2mtu",
  "arp",
  "speed",
  "auto-negotiation",
  "full-duplex",
  "mac-address",
  "advertise",
  "poe-out",
  "rx-flow-control",
  "tx-flow-control",
  "bandwidth",
  "mdix-enable",
  "loop-protect",
]);

const maxPingCount = 20;

function exportValue(value: string): string {
  const plain = /^[A-Za-z0-9\-_./:@]*$/.test(value);
  if (plain && value !== "") return value;
  const escaped = value.split("\\").join("\\\\").split('"').join('\\"').split("$").join("\\$");
  return `"${escaped}"`;
}

export class RouterOSEngine implements ConsoleEngine {
  private readonly access: DeviceAccess;
  private closed = false;
  /** The current menu, e.g. ["interface", "ethernet"]; empty at the top level. */
  private path: string[] = [];
  private lastHostname: string;

  /** The menus of the protocol features. */
  private readonly featureMenus: RouterOSFeatureMenu[];
  private readonly rootMenu: Menu;

  constructor(access: DeviceAccess) {
    this.access = access;
    this.lastHostname = access.hostname;
    this.featureMenus = collectRouterOSMenus();
    this.rootMenu = withFeatureMenus(rootMenu, this.featureMenus);
  }

  /** What feature commands may use (features/routeros-menus.ts). */
  private get featureContext(): RouterOSContext {
    return {
      access: this.access,
      hostname: this.hostname,
      named: (args, keys, positional = null) => this.namedArguments(args, keys, positional),
      itemNumbers: (args, count) => this.itemNumbers(args, count),
      l3Interface: (name) => this.l3Interface(name),
      interfaceName: (id) => this.interfaceName(id),
      endOfCommand: (word) => this.endOfCommand(word),
      exportValue,
    };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private menu(at: readonly string[]): Menu {
    let menu = this.rootMenu;
    for (const name of at) {
      const next = menu.submenus.find((submenu) => submenu.name === name);
      if (!next) break;
      menu = next;
    }
    return menu;
  }

  // MARK: Banner and prompt

  get hostname(): string {
    const device = this.access.device;
    if (device) this.lastHostname = device.hostname;
    return this.lastHostname;
  }

  private get modelText(): string {
    return [this.access.vendor, this.access.model].filter((part) => part !== "").join(" ");
  }

  get banner(): string {
    return Notices.banner(this.hostname, this.modelText, "MikroTik RouterOS", false);
  }

  /**
   * "[admin@R1] > " at the top level, "[admin@R1] /interface> " inside a menu. The trailing
   * space is part of the real prompt.
   */
  get prompt(): string {
    const location = this.path.length === 0 ? "" : "/" + this.path.join(" ");
    return `[admin@${this.hostname}] ${location}> `;
  }

  // MARK: Execution

  execute(line: string): string {
    if (chars(line).some(isNewline)) {
      const outputs = splitCharacters(line, isNewline).map((part) => this.execute(part));
      return outputs.filter((output) => output !== "").join("\n");
    }
    if (this.closed) return "";
    if (!this.access.exists) {
      this.closed = true;
      return Notices.deviceGone;
    }
    if (charCount(line) > CLILimits.maxLineLength) return Notices.lineTooLong;
    // Ctrl-Z has no meaning on RouterOS; ignore it instead of reporting a bad command.
    if (line.includes("\u001a")) return "";

    const trimmed = trimWhitespaces(line);
    if (trimmed === "" || trimmed.startsWith("#")) return "";
    if (trimmed.endsWith("?")) {
      return this.help(line.slice(0, line.lastIndexOf("?")));
    }

    const { words, absolute } = wordsOf(line);
    const location = absolute ? [] : [...this.path];
    let index = 0;
    while (index < words.length) {
      const word = words[index];
      if (word.text === "..") {
        if (location.length > 0) location.pop();
        index += 1;
        continue;
      }
      const current = this.menu(location);
      const submenu = resolve(word.text, current.submenus, (item) => item.name);
      if (submenu) {
        location.push(submenu.name);
        index += 1;
        continue;
      }
      const command = resolve(word.text, current.commands, (item) => item.name);
      if (command) {
        if (command.run) return command.run(this.featureContext, words.slice(index + 1));
        return this.run(command.action, location, words.slice(index + 1));
      }
      return `bad command name ${word.text} (line 1 column ${word.column})`;
    }
    // Only menu names: that is navigation.
    this.path = location;
    return "";
  }

  private run(action: Action, location: string[], args: Word[]): string {
    if (action === "quit") {
      if (args.length > 0) return this.endOfCommand(args[0]);
      this.closed = true;
      return "";
    }
    if (action === "export") {
      if (args.length > 0) return this.endOfCommand(args[0]);
      return this.export(location);
    }
    if (action === "ping") return this.ping(args);
    if (sameMenu(location, identityMenu)) {
      return action === "print" ? this.printIdentity(args) : this.setIdentity(args);
    }
    if (sameMenu(location, addressMenu)) {
      switch (action) {
        case "add":
          return this.addAddress(args);
        case "remove":
          return this.removeAddresses(args);
        default:
          return this.printAddresses(args);
      }
    }
    if (sameMenu(location, routeMenu)) {
      switch (action) {
        case "add":
          return this.addRoute(args);
        case "remove":
          return this.removeRoutes(args);
        default:
          return this.printRoutes(args);
      }
    }
    const ports = this.items(location);
    switch (action) {
      case "print":
        return this.printInterfaces(ports, location[location.length - 1] === "ethernet", args);
      case "set":
        return this.setItems(ports, args);
      case "enable":
        return this.setDisabled(false, ports, args);
      case "disable":
        return this.setDisabled(true, ports, args);
      case "comment":
        return this.setComment(ports, args);
      default:
        return "";
    }
  }

  private endOfCommand(word: Word): string {
    return `expected end of command (line 1 column ${word.column})`;
  }

  /** The interfaces a menu lists: all of them in `/interface`, the wired ones in `/interface ethernet`. */
  private items(location: readonly string[]): PortSnapshot[] {
    const all = this.access.interfaces;
    return location[location.length - 1] === "ethernet" ? all.filter((port) => port.connector !== "wireless") : all;
  }

  // MARK: /system identity

  private printIdentity(args: Word[]): string {
    if (args.length > 0) return this.endOfCommand(args[0]);
    return `  name: ${this.hostname}`;
  }

  private setIdentity(args: Word[]): string {
    for (const word of args) {
      const equals = word.text.indexOf("=");
      if (equals < 0 || word.text.slice(0, equals).toLowerCase() !== "name") return this.endOfCommand(word);
      const name = unquoted(afterEquals(word.text, equals));
      if (trimWhitespaces(name) === "") {
        return "NetSketch: název zařízení nesmí být prázdný, nic se nezměnilo.";
      }
      this.access.rename(name);
    }
    return "";
  }

  // MARK: /interface

  private typeName(port: PortSnapshot): string {
    return port.connector === "wireless" ? "wlan" : "ether";
  }

  private printInterfaces(ports: PortSnapshot[], ethernetMenu: boolean, args: Word[]): string {
    if (args.length > 0) return this.endOfCommand(args[0]);
    const lines = ["Flags: X - disabled, R - running"];
    lines.push(ethernetMenu ? " #    NAME" : " #    NAME                                TYPE");
    ports.forEach((port, index) => {
      const flags = (port.adminDown ? "X" : port.linkState === "up" ? "R" : " ") + " ";
      const head = leftPadded(`${index}`, 2) + " " + flags + " ";
      const name = ethernetMenu ? port.name : padded(port.name, 35) + " " + this.typeName(port);
      if (port.description === "") {
        lines.push(head + name);
      } else {
        lines.push(head + ";;; " + oneLine(port.description));
        lines.push(" ".repeat(charCount(head)) + name);
      }
    });
    lines.push("NetSketch: příznak R (running) plyne jen z kabeláže v diagramu a z příznaku disabled.");
    return lines.map(trimmingTrailingWhitespace).join("\n");
  }

  /**
   * Resolves an item specification: "ether1", "0", "0,2", "ether1,ether2", "[find]",
   * "[ find default-name=ether1 ]".
   */
  private select(spec: string, ports: PortSnapshot[]): Selection {
    const text = unquoted(spec);
    if (text.startsWith("[")) {
      const parts = splitWords(bracketInner(text));
      if (parts.length === 0 || parts[0].toLowerCase() !== "find") {
        return { kind: "failure", message: "NetSketch: v hranatých závorkách je podporováno jen [find ...]." };
      }
      let matches = ports;
      for (const condition of parts.slice(1)) {
        const pieces = splitOnce(condition, "=");
        if (pieces.length !== 2 || !["name", "default-name"].includes(pieces[0].toLowerCase())) {
          return { kind: "failure", message: "NetSketch: find podporuje jen podmínky name=... a default-name=...." };
        }
        const wanted = unquoted(pieces[1]).toLowerCase();
        matches = matches.filter((port) => port.name.toLowerCase() === wanted);
      }
      return { kind: "ports", ports: matches };
    }
    const selected: PortSnapshot[] = [];
    for (const piece of text.split(",").filter((part) => part !== "")) {
      const name = trimWhitespaces(piece);
      const number = itemNumber(name);
      if (number !== null) {
        if (number >= ports.length) return { kind: "failure", message: "no such item" };
        selected.push(ports[number]);
        continue;
      }
      const port = ports.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
      if (!port) return { kind: "failure", message: "input does not match any value of numbers" };
      selected.push(port);
    }
    return selected.length === 0
      ? { kind: "failure", message: "missing value(s) of argument(s) numbers" }
      : { kind: "ports", ports: selected };
  }

  /** Splits arguments into the item specification and `key=value` properties. */
  private parse(args: Word[]): { spec: string | null; properties: Property[]; stray: Word | null } {
    let spec: string | null = null;
    const properties: Property[] = [];
    for (const word of args) {
      const equals = word.text.indexOf("=");
      if (!word.text.startsWith("[") && !word.text.startsWith('"') && equals >= 0) {
        const key = word.text.slice(0, equals).toLowerCase();
        const value = unquoted(afterEquals(word.text, equals));
        if (key === "numbers") spec = value;
        else properties.push({ key, value, word });
      } else if (spec === null && properties.length === 0) {
        spec = word.text;
      } else {
        return { spec, properties, stray: word };
      }
    }
    return { spec, properties, stray: null };
  }

  private setItems(ports: PortSnapshot[], args: Word[]): string {
    const parsed = this.parse(args);
    if (parsed.stray) return this.endOfCommand(parsed.stray);
    if (parsed.spec === null) return "missing value(s) of argument(s) numbers";
    const selection = this.select(parsed.spec, ports);
    if (selection.kind === "failure") return selection.message;
    const selected = selection.ports;

    let comment: string | null = null;
    let disabled: boolean | null = null;
    const notes: string[] = [];
    for (const property of parsed.properties) {
      if (property.key === "comment") {
        comment = property.value;
      } else if (property.key === "disabled") {
        switch (property.value.toLowerCase()) {
          case "yes":
          case "true":
            disabled = true;
            break;
          case "no":
          case "false":
            disabled = false;
            break;
          default:
            return "invalid value for argument disabled";
        }
      } else if (property.key === "name") {
        notes.push("NetSketch: přejmenování portu z CLI není podporováno (název patří k modelu zařízení).");
      } else if (unstoredProperties.has(property.key)) {
        notes.push(Notices.notStored(property.key));
      } else {
        return this.endOfCommand(property.word);
      }
    }
    this.access.transaction(() => {
      for (const port of selected) {
        if (comment !== null) this.access.setDescription(comment, port.id);
        if (disabled !== null) this.access.setAdminDown(disabled, port.id);
      }
    });
    return notes.join("\n");
  }

  private setDisabled(disabled: boolean, ports: PortSnapshot[], args: Word[]): string {
    const parsed = this.parse(args);
    if (parsed.stray) return this.endOfCommand(parsed.stray);
    if (parsed.properties.length > 0) return this.endOfCommand(parsed.properties[0].word);
    if (parsed.spec === null) return "missing value(s) of argument(s) numbers";
    const selection = this.select(parsed.spec, ports);
    if (selection.kind === "failure") return selection.message;
    this.access.transaction(() => {
      for (const port of selection.ports) this.access.setAdminDown(disabled, port.id);
    });
    return "";
  }

  /** `comment ether1 comment="text"` or `comment ether1 "text"`. */
  private setComment(ports: PortSnapshot[], args: Word[]): string {
    if (args.length === 0) return "missing value(s) of argument(s) numbers";
    let spec = args[0].text;
    let text: string | null = null;
    for (const word of args.slice(1)) {
      if (text !== null) return this.endOfCommand(word);
      if (word.text.toLowerCase().startsWith("comment=")) {
        text = unquoted(dropFirst(word.text, "comment=".length));
      } else {
        text = unquoted(word.text);
      }
    }
    if (spec.toLowerCase().startsWith("numbers=")) spec = dropFirst(spec, "numbers=".length);
    if (text === null) return "missing value(s) of argument(s) comment";
    const selection = this.select(spec, ports);
    if (selection.kind === "failure") return selection.message;
    const comment = text;
    this.access.transaction(() => {
      for (const port of selection.ports) this.access.setDescription(comment, port.id);
    });
    return "";
  }

  // MARK: Arguments of add, remove and ping

  /**
   * `key=value` arguments; keys may be abbreviated to a unique prefix, as on RouterOS. A bare
   * word is the value of `positional` (`/ping 10.0.0.1`) when the command has one.
   */
  private namedArguments(args: Word[], keys: string[], positional: string | null = null): NamedArguments {
    const values = new Map<string, string>();
    for (const word of args) {
      const equals = word.text.indexOf("=");
      if (!word.text.startsWith('"') && equals >= 0) {
        const key = word.text.slice(0, equals);
        const name = key === "" ? null : resolve(key, keys, (item) => item);
        if (name === null) return { kind: "failure", message: this.endOfCommand(word) };
        values.set(name, unquoted(afterEquals(word.text, equals)));
      } else if (positional !== null && !values.has(positional)) {
        values.set(positional, unquoted(word.text));
      } else {
        return { kind: "failure", message: this.endOfCommand(word) };
      }
    }
    return { kind: "values", values };
  }

  /**
   * The items of `remove` in a list of `count` rows: "0", "0,2", "numbers=1" or "[find]"
   * (all), numbered as `print` shows them.
   */
  private itemNumbers(args: Word[], count: number): ItemNumbers {
    const parsed = this.parse(args);
    if (parsed.stray) return { kind: "failure", message: this.endOfCommand(parsed.stray) };
    if (parsed.properties.length > 0) return { kind: "failure", message: this.endOfCommand(parsed.properties[0].word) };
    if (parsed.spec === null) return { kind: "failure", message: "missing value(s) of argument(s) numbers" };
    const text = unquoted(parsed.spec);
    if (text.startsWith("[")) {
      const parts = splitWords(bracketInner(text)).map((part) => part.toLowerCase());
      if (parts.length !== 1 || parts[0] !== "find") {
        return {
          kind: "failure",
          message: "NetSketch: zde je podporováno jen [find] bez podmínek; použijte čísla z příkazu print.",
        };
      }
      return { kind: "items", items: Array.from({ length: count }, (_, index) => index) };
    }
    const selected: number[] = [];
    for (const piece of text.split(",").filter((part) => part !== "")) {
      const number = itemNumber(trimWhitespaces(piece));
      if (number === null) return { kind: "failure", message: "input does not match any value of numbers" };
      if (number >= count) return { kind: "failure", message: "no such item" };
      if (!selected.includes(number)) selected.push(number);
    }
    return selected.length === 0
      ? { kind: "failure", message: "missing value(s) of argument(s) numbers" }
      : { kind: "items", items: selected };
  }

  // MARK: /ip address

  /** True on a switch (CRS): its ports are bridged, so the address belongs to the bridge. */
  private get isSwitch(): boolean {
    const category = this.access.category;
    return category != null ? NetworkSimulator.isSwitching(category) : false;
  }

  /** The RouterOS name of a layer-3 interface ("ether2", "bridge"); null when it is gone. */
  private interfaceName(id: L3InterfaceID): string | null {
    if (id.startsWith("port:")) {
      const portID = id.slice(5);
      return this.access.device?.ports.find((port) => port.id === portID)?.name ?? null;
    }
    if (id.startsWith("vlan:")) {
      const number = swiftInt(id.slice(5));
      if (number === null) return null;
      return this.isSwitch ? (number === 1 ? "bridge" : `vlan${number}`) : null;
    }
    return null;
  }

  /** The names `interface=` accepts: the bridge (and management ports) of a switch, every port of a router. */
  private get addressInterfaceNames(): string[] {
    const ports = this.access.interfaces;
    if (!this.isSwitch) return ports.map((port) => port.name);
    return ["bridge", ...ports.filter((port) => port.connector === "mgmt").map((port) => port.name)];
  }

  /**
   * Resolves `interface=`: a port name (any case), or `bridge`/`bridge1` on a switch, where the
   * bridge stands for VLAN 1 of the simulation.
   */
  private l3Interface(text: string): InterfaceLookup {
    const lower = text.toLowerCase();
    const noSuchInterface = "input does not match any value of interface";
    if (lower === "bridge" || lower === "bridge1") {
      if (!this.isSwitch) {
        return {
          kind: "failure",
          message:
            noSuchInterface +
            "\nNetSketch: router v NetSketch nemá bridge, adresu nastavte přímo na port (např. interface=ether2).",
        };
      }
      return { kind: "found", id: "vlan:1", name: "bridge" };
    }
    const port = this.access.interfaces.find((candidate) => candidate.name.toLowerCase() === lower);
    if (!port) return { kind: "failure", message: noSuchInterface };
    if (this.isSwitch && port.connector !== "mgmt") {
      return { kind: "failure", message: "NetSketch: na přepínači nastavte adresu na interface=bridge." };
    }
    return { kind: "found", id: `port:${port.id}`, name: port.name };
  }

  /**
   * `add address=A.B.C.D/NN interface=NAME`.
   *
   * Simplification: NetSketch keeps one address per interface, so a second `add` on the same
   * interface replaces the first one (RouterOS would keep both); a notice says so.
   */
  private addAddress(args: Word[]): string {
    const named = this.namedArguments(args, ["address", "interface"]);
    if (named.kind === "failure") return named.message;
    const values = named.values;
    const text = values.get("address");
    if (text === undefined) return "missing value(s) of argument(s) address";
    const interfaceText = values.get("interface");
    if (interfaceText === undefined) return "missing value(s) of argument(s) interface";

    const notes: string[] = [];
    let prefix: IPv4Prefix;
    const parsed = IPv4Prefix.fromCIDR(text);
    const host = parsed ? null : IPv4.parse(text);
    if (parsed) {
      prefix = parsed;
    } else if (host) {
      // RouterOS takes an address without a prefix length as /32.
      prefix = new IPv4Prefix(host, 32);
      notes.push(
        `NetSketch: adresa bez délky prefixu se uloží jako /32 (jako na RouterOS); síť zadejte např. jako ${host.description}/24.`,
      );
    } else {
      return "invalid value for argument address";
    }
    if (!prefix.isHostAddress) {
      return (
        `invalid value for argument address\nNetSketch: ${prefix.address.description} je adresa sítě nebo broadcast ` +
        `sítě ${prefix.networkPrefix.description}, zadejte adresu hostitele.`
      );
    }

    const lookup = this.l3Interface(interfaceText);
    if (lookup.kind === "failure") return lookup.message;
    const { id, name } = lookup;
    const previous = this.access.addresses.find((entry) => entry.interface === id);
    if (previous) {
      if (previous.address === prefix.description) return "failure: already have such address";
      notes.push(`NetSketch: rozhraní ${name} má v NetSketch jen jednu adresu, původní ${previous.address} byla nahrazena.`);
    }
    const other = this.access.addressConflict(prefix.address, id);
    if (other != null) {
      notes.push(`NetSketch: pozor, adresa ${prefix.address.description} je už nastavena na zařízení ${other}.`);
    }
    this.access.setAddress(prefix, id);
    return notes.join("\n");
  }

  /** Rows in the order of the device's addresses; that order also numbers `remove`. */
  private printAddresses(args: Word[]): string {
    if (args.length > 0) return this.endOfCommand(args[0]);
    const lines = ["Flags: X - disabled, I - invalid, D - dynamic", " #   ADDRESS            NETWORK         INTERFACE"];
    this.access.addresses.forEach((entry, index) => {
      const name = this.interfaceName(entry.interface);
      const network = IPv4Prefix.fromCIDR(entry.address)?.network.description ?? null;
      // I (invalid): the interface no longer exists or the stored text is not an address.
      const flag = name === null || network === null ? "I" : " ";
      const columns = [
        leftPadded(`${index}`, 2),
        flag,
        padded(entry.address, 18),
        padded(network ?? "", 15),
        name ?? "unknown",
      ];
      lines.push(columns.join(" "));
    });
    return lines.map(trimmingTrailingWhitespace).join("\n");
  }

  private removeAddresses(args: Word[]): string {
    const entries = this.access.addresses;
    const numbers = this.itemNumbers(args, entries.length);
    if (numbers.kind === "failure") return numbers.message;
    this.access.transaction(() => {
      for (const index of numbers.items) this.access.setAddress(null, entries[index].interface);
    });
    return "";
  }

  // MARK: /ip route

  /**
   * The routing table of the simulation without the local /32 routes, then the stored static
   * routes that are not active (their gateway is not on a connected network).
   */
  private routeRows(): RouteRow[] {
    const stored = this.access.staticRoutes;
    const used = new Set<number>();
    const rows: RouteRow[] = [];
    for (const route of this.access.simulator.routes(this.access.deviceID)) {
      switch (route.kind) {
        case "local":
          continue;
        case "connected":
          rows.push({
            flags: "ADC",
            destination: route.destination.description,
            preferredSource: route.interface.prefix.address.description,
            gateway: this.interfaceName(route.interface.id) ?? route.interface.name,
            distance: 0,
            source: { kind: "connected" },
          });
          break;
        case "staticRoute": {
          const hop = route.nextHop;
          if (!hop) continue;
          const index = stored.findIndex(
            (candidate, position) =>
              !used.has(position) &&
              hop.equals(IPv4.parse(candidate.nextHop)) &&
              route.destination.equals(IPv4Prefix.fromCIDR(candidate.destination)?.networkPrefix),
          );
          let source: RouteSource;
          if (index >= 0) {
            used.add(index);
            source = { kind: "stored", index };
          } else {
            source = { kind: "defaultGateway" };
          }
          rows.push({
            flags: "A S",
            destination: route.destination.description,
            preferredSource: "",
            gateway: hop.description,
            distance: 1,
            source,
          });
          break;
        }
      }
    }
    stored.forEach((route, index) => {
      if (used.has(index)) return;
      rows.push({
        flags: "  S",
        destination: route.destination,
        preferredSource: "",
        gateway: route.nextHop,
        distance: 1,
        source: { kind: "stored", index },
      });
    });
    return rows;
  }

  /**
   * `add [dst-address=A.B.C.D/NN] gateway=A.B.C.D`; the destination defaults to 0.0.0.0/0.
   * A route whose gateway is not on a connected network yet is stored all the same (the
   * addresses may come later), with a notice.
   */
  private addRoute(args: Word[]): string {
    const named = this.namedArguments(args, ["dst-address", "gateway"]);
    if (named.kind === "failure") return named.message;
    const values = named.values;
    const gatewayText = values.get("gateway");
    if (gatewayText === undefined) return "missing value(s) of argument(s) gateway";
    const destinationText = values.get("dst-address") ?? "0.0.0.0/0";
    let destination = IPv4Prefix.fromCIDR(destinationText);
    if (!destination) {
      const host = IPv4.parse(destinationText);
      destination = host ? new IPv4Prefix(host, 32) : null;
    }
    if (!destination) return "invalid value for argument dst-address";
    const gateway = IPv4.parse(gatewayText);
    if (!gateway) {
      const lower = gatewayText.toLowerCase();
      if (!lower.startsWith("bridge") && !this.access.interfaces.some((port) => port.name.toLowerCase() === lower)) {
        return "invalid value for argument gateway";
      }
      return (
        "invalid value for argument gateway\n" +
        "NetSketch: bránu zadejte jako IP adresu sousedního routeru (rozhraní jako brána se nemodeluje)."
      );
    }
    const route: StaticRoute = { destination: destination.networkPrefix.description, nextHop: gateway.description };
    const routes = this.access.staticRoutes;
    if (routes.some((entry) => entry.destination === route.destination && entry.nextHop === route.nextHop)) {
      return "failure: already have such route";
    }
    this.access.setStaticRoutes([...routes, route]);
    const connected = this.access.simulator
      .interfacesOf(this.access.deviceID)
      .some((iface) => iface.prefix.contains(gateway));
    return connected
      ? ""
      : `NetSketch: trasa je uložena, ale zatím není aktivní – brána ${gateway.description} neleží v žádné připojené síti ` +
          "(adresa na zapojeném rozhraní).";
  }

  private printRoutes(args: Word[]): string {
    if (args.length > 0) return this.endOfCommand(args[0]);
    const rows = this.routeRows();
    const lines = [
      "Flags: X - disabled, A - active, D - dynamic, C - connect, S - static",
      " #      DST-ADDRESS        PREF-SRC        GATEWAY            DISTANCE",
    ];
    rows.forEach((row, index) => {
      // The flags column is three wide and followed by two spaces.
      const columns = [
        leftPadded(`${index}`, 2),
        padded(row.flags, 3) + " ",
        padded(row.destination, 18),
        padded(row.preferredSource, 15),
        padded(row.gateway, 18),
        leftPadded(`${row.distance}`, 8),
      ];
      lines.push(columns.join(" "));
    });
    if (rows.some((row) => !row.flags.startsWith("A"))) {
      lines.push("NetSketch: trasa bez příznaku A není aktivní – její brána neleží v žádné připojené síti.");
    }
    return lines.map(trimmingTrailingWhitespace).join("\n");
  }

  /**
   * Removes static routes by their number in `print`. Connected routes are refused (as
   * dynamic routes on RouterOS); nothing is removed then.
   */
  private removeRoutes(args: Word[]): string {
    const rows = this.routeRows();
    const numbers = this.itemNumbers(args, rows.length);
    if (numbers.kind === "failure") return numbers.message;
    const sources = numbers.items.map((index) => rows[index].source);
    if (sources.some((source) => source.kind === "connected")) {
      return (
        "failure: cannot remove dynamic route\n" +
        "NetSketch: připojená síť (příznak C) zmizí odebráním adresy v /ip address."
      );
    }
    const removed = new Set<number>();
    for (const source of sources) if (source.kind === "stored") removed.add(source.index);
    const remaining = this.access.staticRoutes.filter((_, index) => !removed.has(index));
    this.access.transaction(() => {
      if (removed.size > 0) this.access.setStaticRoutes(remaining);
      if (sources.some((source) => source.kind === "defaultGateway")) this.access.setDefaultGateway(null);
    });
    return "";
  }

  // MARK: /ping

  /**
   * `/ping A.B.C.D [count=N]` or `/ping address=A.B.C.D`: echo requests through the network
   * simulation. Only reachability is simulated, so every reply takes 0ms.
   */
  private ping(args: Word[]): string {
    const named = this.namedArguments(args, ["address", "count"], "address");
    if (named.kind === "failure") return named.message;
    const values = named.values;
    const text = values.get("address");
    if (text === undefined) return "missing value(s) of argument(s) address";
    const destination = IPv4.parse(text);
    if (!destination) return "invalid value for argument address";
    let count = 4;
    const notes: string[] = [];
    const countText = values.get("count");
    if (countText !== undefined) {
      const value = itemNumber(countText);
      if (value === null || value <= 0) return "invalid value for argument count";
      count = Math.min(value, maxPingCount);
      if (value > count) notes.push(`NetSketch: odesláno jen ${count} paketů (víc NetSketch neposílá).`);
    }

    const simulator = this.access.simulator;
    const result = simulator.ping(this.access.deviceID, destination);
    const plan = planPing(simulator, this.access.deviceID, destination, result, count);
    announcePing(this.access.deviceID, result, plan);
    // Every router on the way back lowers the TTL of the reply by one.
    const ttl = Math.max(1, 64 - (plan.active ? plan.routersOnReturn : Math.max(0, result.hopCount - 1)));
    const host = padded(destination.description, 40);
    const lines = ["  SEQ HOST                                     SIZE TTL TIME       STATUS"];
    for (let sequence = 0; sequence < count; sequence++) {
      const head = leftPadded(`${sequence}`, 5) + " " + host;
      const sample = plan.active ? plan.samples[sequence] : undefined;
      if (result.success && !sample?.lost) {
        const time = sample === undefined ? "0ms" : routerOSTime(sample.rtt);
        lines.push([head, leftPadded("56", 4), leftPadded(`${ttl}`, 3), time].join(" "));
      } else {
        lines.push(head + " ".repeat(19) + "timeout");
      }
    }
    const received = plan.active ? plan.received : result.success ? count : 0;
    if (received > 0) {
      const loss = Math.trunc(((count - received) * 100) / count);
      const times = plan.active
        ? `${wholeMilliseconds(plan.minimum)}ms avg-rtt=${wholeMilliseconds(plan.average)}ms max-rtt=${wholeMilliseconds(plan.maximum)}ms`
        : "0ms avg-rtt=0ms max-rtt=0ms";
      lines.push(`    sent=${count} received=${received} packet-loss=${loss}% min-rtt=${times}`);
    } else {
      lines.push(`    sent=${count} received=0 packet-loss=100%`);
      const reason = simulator.explain(result);
      if (reason !== "") lines.push(reason);
    }
    const lostNotice = lossNotice(plan);
    if (lostNotice !== "") lines.push(lostNotice);
    lines.push(...notes);
    return lines.join("\n");
  }

  // MARK: /export

  private export(location: string[]): string {
    const lines = [`# NetSketch: export z dat diagramu (${this.modelText}); nic se nesimuluje`];
    const first = location.length > 0 ? location[0] : null;
    const last = location.length > 0 ? location[location.length - 1] : null;
    const wantsInterfaces = location.length === 0 || first === "interface";
    const wantsIdentity = location.length === 0 || first === "system";

    if (wantsInterfaces) {
      const section = (title: string, ports: PortSnapshot[]): void => {
        const rows: string[] = [];
        for (const port of ports) {
          const properties: string[] = [];
          if (port.description !== "") {
            properties.push(`comment=${exportValue(oneLine(port.description))}`);
          }
          if (port.adminDown) properties.push("disabled=yes");
          if (properties.length > 0) {
            rows.push(`set [ find default-name=${port.name} ] ` + properties.join(" "));
          }
          const vlan = oneLine(port.vlanText);
          if (trimWhitespaces(vlan) !== "") {
            rows.push(
              `# ${port.name}: text VLAN z diagramu „${vlan}“ (VLAN se z konzole RouterOS v NetSketch nenastavují)`,
            );
          }
        }
        if (rows.length > 0) {
          lines.push(title);
          lines.push(...rows);
        }
      };
      const all = this.access.interfaces;
      section(
        "/interface ethernet",
        all.filter((port) => port.connector !== "wireless"),
      );
      if (last !== "ethernet") {
        section(
          "/interface wireless",
          all.filter((port) => port.connector === "wireless"),
        );
      }
    }
    // `/ip export` writes both sections, `/ip address export` and `/ip route export` one each.
    const wantsIP = location.length === 0 || first === "ip";
    const addresses = this.access.addresses;
    if (wantsIP && last !== "route" && addresses.length > 0) {
      lines.push("/ip address");
      for (const entry of addresses) {
        const name = this.interfaceName(entry.interface) ?? "unknown";
        lines.push(`add address=${exportValue(entry.address)} interface=${exportValue(name)}`);
      }
    }
    if (wantsIP && last !== "address") {
      const staticRoutes = this.access.staticRoutes;
      const rows = staticRoutes.map(
        (route) => `add dst-address=${exportValue(route.destination)} gateway=${exportValue(route.nextHop)}`,
      );
      // A default gateway set outside RouterOS is shown by `print` as a static default route.
      const gateway = this.access.defaultGateway;
      if (gateway !== "" && !staticRoutes.some((route) => route.destination === "0.0.0.0/0")) {
        rows.push(`add dst-address=0.0.0.0/0 gateway=${exportValue(gateway)}`);
      }
      if (rows.length > 0) {
        lines.push("/ip route");
        lines.push(...rows);
      }
    }
    for (const menu of this.featureMenus) {
      const covered = location.every((name, index) => menu.path[index] === name);
      if (!covered || !menu.export) continue;
      const rows = menu.export(this.featureContext);
      if (rows.length === 0) continue;
      lines.push("/" + menu.path.join(" "));
      lines.push(...rows);
    }
    if (wantsIdentity) {
      lines.push("/system identity");
      lines.push(`set name=${exportValue(this.hostname)}`);
    }
    return lines.join("\n");
  }

  // MARK: Help and completion

  /** The menu a partial line has reached, and the command if one was already typed. */
  private context(
    partial: string,
  ): { menu: Menu; command: Command | null; location: string[]; lastWord: string } | null {
    const { words: allWords, absolute } = wordsOf(partial);
    const characters = chars(partial);
    const lastCharacter = characters.length > 0 ? characters[characters.length - 1] : null;
    const endsWithSeparator = lastCharacter === null ? true : isWhitespace(lastCharacter) || lastCharacter === "/";
    const complete = endsWithSeparator ? allWords : allWords.slice(0, Math.max(0, allWords.length - 1));
    const lastWord = endsWithSeparator ? "" : allWords.length > 0 ? allWords[allWords.length - 1].text : "";
    const location = absolute ? [] : [...this.path];
    let command: Command | null = null;
    for (const word of complete) {
      if (command !== null) continue;
      if (word.text === "..") {
        if (location.length > 0) location.pop();
        continue;
      }
      const current = this.menu(location);
      const submenu = resolve(word.text, current.submenus, (item) => item.name);
      if (submenu) {
        location.push(submenu.name);
        continue;
      }
      const found = resolve(word.text, current.commands, (item) => item.name);
      if (!found) return null;
      command = found;
    }
    return { menu: this.menu(location), command, location, lastWord };
  }

  /** Words that may follow: [word, description]. */
  private candidates(partial: string): [string, string][] | null {
    const context = this.context(partial);
    if (!context) return null;
    const entries: [string, string][] = [];
    const command = context.command;
    if (command) {
      const identity = sameMenu(context.location, identityMenu);
      const isAddressMenu = sameMenu(context.location, addressMenu);
      switch (command.action) {
        case "set":
        case "comment":
          if (command.action === "set" && identity) {
            entries.push(["name=", "Name of the router"]);
            break;
          }
          for (const port of this.items(context.location)) entries.push([port.name, "Interface"]);
          entries.push(["comment=", "Short description of the item"]);
          if (command.action === "set") entries.push(["disabled=", "Defines whether item is ignored or used (yes | no)"]);
          break;
        case "enable":
        case "disable":
          for (const port of this.items(context.location)) entries.push([port.name, "Interface"]);
          break;
        case "add":
          if (isAddressMenu) {
            // While a value of interface= is typed, the interface names complete the word.
            if (context.lastWord.toLowerCase().startsWith("interface=")) {
              for (const name of this.addressInterfaceNames) entries.push(["interface=" + name, "Interface"]);
            } else {
              entries.push(["address=", "Local IP address with prefix length (A.B.C.D/NN)"]);
              entries.push(["interface=", "Interface name"]);
            }
          } else {
            entries.push(["dst-address=", "Destination network (A.B.C.D/NN, default 0.0.0.0/0)"]);
            entries.push(["gateway=", "IP address of the next router"]);
          }
          break;
        case "remove":
          if (isAddressMenu) {
            this.access.addresses.forEach((entry, index) => {
              const name = this.interfaceName(entry.interface) ?? "unknown";
              entries.push([`${index}`, entry.address + " " + name]);
            });
          } else {
            this.routeRows().forEach((row, index) => {
              entries.push([`${index}`, row.destination + " " + row.gateway]);
            });
          }
          break;
        case "ping":
          entries.push(["address=", "Destination IP address"]);
          entries.push(["count=", `How many packets to send (1-${maxPingCount})`]);
          break;
        case "print":
        case "export":
        case "quit":
          break;
      }
    } else {
      if (context.location.length > 0) entries.push(["..", "Go up to the parent menu"]);
      for (const submenu of context.menu.submenus) entries.push([submenu.name, submenu.help]);
      for (const item of context.menu.commands) entries.push([item.name, item.help]);
    }
    const prefix = context.lastWord.toLowerCase();
    return entries.filter((entry) => prefix === "" || entry[0].toLowerCase().startsWith(prefix));
  }

  help(partial: string): string {
    if (!this.access.exists || this.closed || charCount(partial) > CLILimits.maxLineLength) return "";
    const entries = this.candidates(partial);
    if (!entries) return "NetSketch: k tomuto vstupu není nápověda (neznámý příkaz).";
    return entries.map((entry) => (entry[1] === "" ? entry[0] : `${entry[0]} -- ${entry[1]}`)).join("\n");
  }

  complete(partial: string): string[] {
    if (!this.access.exists || this.closed || charCount(partial) > CLILimits.maxLineLength) return [];
    return (this.candidates(partial) ?? []).map((entry) => entry[0]).filter((word) => word !== "..");
  }
}
