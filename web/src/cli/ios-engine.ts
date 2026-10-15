// The IOS-style engine. It also drives the Dell OS9 dialect (same parser, other command
// tables, prompts and output layouts) and the generic dialect. Port of IOSEngine.swift.
//
// The engine holds no copy of the configuration: every command reads the current project and
// writes through the ProjectStore, so the canvas, the inspector and undo stay in step.

import {
  chars,
  charCount,
  CLIToken,
  CommandNode,
  CommandParser,
  commonPrefixLength,
  compareStrings,
  CustomArgument,
  CustomMatch,
  HelpEntry,
  HelpFormatter,
  isNewline,
  isNumber,
  isWhitespace,
  ParseInput,
  ParseResult,
  prefixLength,
  splitCharacters,
  splitWords,
  swiftInt,
  trimWhitespaces,
} from "./command-tree";
import { CommandTables } from "./command-tables";
import { InterfaceNameParts, InterfaceNamer, InterfaceResolver } from "./interface-naming";
import type { DeviceAccess, PortSnapshot } from "./model-access";
import { CLILimits, Notices } from "./notices";
import type { ConsoleEngine } from "./session";
import type { CLIDialect } from "./session-api";

/** The interfaces a command refers to. */
export type InterfaceTarget =
  /** Physical ports of the device, by id. */
  | { kind: "ports"; ids: string[] }
  | { kind: "vlan"; number: number }
  | { kind: "portChannel"; number: number }
  | { kind: "loopback"; number: number };

export interface InterfaceSelection {
  target: InterfaceTarget;
  isRange: boolean;
  /** The part of a Dell prompt that names the selection, e.g. "gi-1/1" or "range-gi-1/1-4". */
  promptLabel: string;
}

export type Mode =
  | { kind: "userExec" }
  | { kind: "privilegedExec" }
  | { kind: "globalConfig" }
  /** Interface configuration of one or more physical ports. */
  | { kind: "interface"; selection: InterfaceSelection }
  /** IOS `vlan N` configuration. */
  | { kind: "vlan"; ids: number[] }
  /** `interface vlan N`: Dell OS9 VLAN membership and address, IOS switch virtual interface. */
  | { kind: "vlanInterface"; vlan: number }
  /** Line configuration; accepted formally, nothing is stored. */
  | { kind: "line"; name: string }
  /**
   * A configuration mode of a protocol feature (features/ios-commands.ts): `router ospf 1`,
   * `ip dhcp pool LAN`, `ip access-list extended WEB`. `prompt` is the text in parentheses
   * ("config-router", "dhcp-config"); `context` what the mode edits (process, pool, list name).
   */
  | { kind: "feature"; name: string; prompt: string; context: Record<string, string | number> };

interface VirtualType {
  name: string;
  word: string;
  help: string;
  lowerBound: number;
  upperBound: number;
}

const virtualTypes: readonly VirtualType[] = [
  { name: "vlan", word: "Vlan", help: "Catalyst Vlans", lowerBound: 1, upperBound: 4094 },
  { name: "port-channel", word: "Port-channel", help: "Ethernet Channel of interfaces", lowerBound: 1, upperBound: 4096 },
  { name: "loopback", word: "Loopback", help: "Loopback interface", lowerBound: 0, upperBound: 2_147_483_647 },
];

export class IOSEngine implements ConsoleEngine {
  readonly namer: InterfaceNamer;
  mode: Mode = { kind: "userExec" };
  private _isClosed = false;
  private _history: string[] = [];
  /** Set while a multi-line `banner` text is being typed; lines are swallowed until it shows up. */
  private bannerDelimiter: string | null = null;
  private lastHostname: string;
  private _tables: CommandTables | null = null;

  constructor(
    readonly access: DeviceAccess,
    readonly dialect: CLIDialect,
  ) {
    this.namer = new InterfaceNamer(dialect === "dellOS9" ? "dell" : "ios");
    this.lastHostname = access.hostname;
  }

  get isClosed(): boolean {
    return this._isClosed;
  }

  get history(): string[] {
    return this._history;
  }

  private get tables(): CommandTables {
    if (this._tables === null) this._tables = new CommandTables(this.dialect);
    return this._tables;
  }

  get isDell(): boolean {
    return this.dialect === "dellOS9";
  }

  // MARK: Banner and prompt

  get banner(): string {
    let name: string;
    switch (this.dialect) {
      case "ios":
        name = "Cisco IOS";
        break;
      case "dellOS9":
        name = "Dell OS9";
        break;
      case "dellOS6":
        name = "Dell OS6";
        break;
      case "routerOS":
        name = "RouterOS";
        break;
      case "generic":
        name = "obecný (styl IOS)";
        break;
      case "host":
        name = "příkazový řádek";
        break;
      case "edgeOS":
        name = "Ubiquiti EdgeOS";
        break;
      case "unifiSwitch":
        name = "UniFi Switch";
        break;
    }
    const model = [this.access.vendor, this.access.model].filter((part) => part !== "").join(" ");
    return Notices.banner(this.hostname, model, name, this.dialect === "generic");
  }

  /** The current hostname; the last known one once the device has been deleted. */
  get hostname(): string {
    const device = this.access.device;
    if (device) this.lastHostname = device.hostname;
    return this.lastHostname;
  }

  get prompt(): string {
    if (this.bannerDelimiter !== null) return "";
    const host = this.hostname;
    const mode = this.mode;
    switch (mode.kind) {
      case "userExec":
        return host + ">";
      case "privilegedExec":
        return host + "#";
      case "globalConfig":
        return host + (this.isDell ? "(conf)#" : "(config)#");
      case "interface":
        if (this.isDell) return host + `(conf-if-${mode.selection.promptLabel})#`;
        return host + (mode.selection.isRange ? "(config-if-range)#" : "(config-if)#");
      case "vlan":
        return host + "(config-vlan)#";
      case "vlanInterface":
        return host + (this.isDell ? `(conf-if-vl-${mode.vlan})#` : "(config-if)#");
      case "line":
        return host + (this.isDell ? `(config-line-${mode.name})#` : "(config-line)#");
      case "feature":
        return host + `(${mode.prompt})#`;
    }
  }

  get isConfigMode(): boolean {
    return this.mode.kind !== "userExec" && this.mode.kind !== "privilegedExec";
  }

  private get isSubConfigMode(): boolean {
    return this.mode.kind !== "userExec" && this.mode.kind !== "privilegedExec" && this.mode.kind !== "globalConfig";
  }

  private get currentTree(): CommandNode {
    const tables = this.tables;
    switch (this.mode.kind) {
      case "userExec":
        return tables.userExec;
      case "privilegedExec":
        return tables.privilegedExec;
      case "globalConfig":
        return tables.globalConfig;
      case "interface":
        return tables.interfaceConfig;
      case "vlan":
        return tables.vlanConfig;
      case "vlanInterface":
        return this.isDell ? tables.vlanInterfaceConfig : tables.sviConfig;
      case "line":
        return tables.lineConfig;
      case "feature":
        return tables.featureModes.get(this.mode.name) ?? tables.globalConfig;
    }
  }

  // MARK: Mode changes used by handlers

  close(): void {
    this._isClosed = true;
  }

  leaveToPrivileged(): void {
    this.mode = { kind: "privilegedExec" };
  }

  /** `exit`: one level up; at the top level the session ends. */
  exitOneLevel(): void {
    switch (this.mode.kind) {
      case "userExec":
      case "privilegedExec":
        this._isClosed = true;
        break;
      case "globalConfig":
        this.mode = { kind: "privilegedExec" };
        break;
      default:
        this.mode = { kind: "globalConfig" };
    }
  }

  beginBanner(delimiter: string): void {
    this.bannerDelimiter = delimiter;
  }

  // MARK: Execution

  execute(line: string): string {
    // A pasted block: run it line by line.
    const characters = chars(line);
    if (characters.some(isNewline)) {
      const outputs = splitCharacters(line, isNewline).map((piece) => this.execute(piece));
      return outputs.filter((output) => output !== "").join("\n");
    }
    if (this._isClosed) return "";
    if (!this.access.exists) {
      this._isClosed = true;
      return Notices.deviceGone;
    }
    if (characters.length > CLILimits.maxLineLength) return Notices.lineTooLong;

    if (this.bannerDelimiter !== null) {
      if (!characters.includes(this.bannerDelimiter)) return "";
      this.bannerDelimiter = null;
      return Notices.bannerNotStored;
    }

    // Ctrl-Z typed as a character ends configuration, like on a real console.
    if (line.includes("\u001A")) {
      if (this.isConfigMode) this.mode = { kind: "privilegedExec" };
      return "";
    }

    const trimmed = trimWhitespaces(line);
    if (trimmed === "") return "";
    if (trimmed.endsWith("?")) {
      // "?" never reaches the parser on a real device: it asks for help right away.
      const mark = line.lastIndexOf("?");
      return this.help(mark >= 0 ? line.slice(0, mark) : line);
    }
    this.remember(trimmed);
    if (trimmed.startsWith("!")) return "";

    const promptWidth = charCount(this.prompt);
    const input = new ParseInput(line);
    return this.run(input, promptWidth);
  }

  private remember(command: string): void {
    this._history.push(command);
    if (this._history.length > CLILimits.historySize) {
      this._history.splice(0, this._history.length - CLILimits.historySize);
    }
  }

  private run(input: ParseInput, promptWidth: number): string {
    const parser = new CommandParser(this);
    let result: ParseResult = parser.parse(input, this.currentTree);

    // Like IOS, a sub-mode accepts global configuration commands and leaves the sub-mode
    // ("no vlan 20" inside "interface fa0/1" too). When both fail, the error of the parse
    // that got further is reported.
    const first = input.tokens[0];
    if (this.isSubConfigMode && result.kind === "invalid" && first !== undefined) {
      const failedColumn = result.column;
      const firstWordFailed = failedColumn < first.column + charCount(first.text);
      const global = parser.parse(input, this.tables.globalConfig);
      switch (global.kind) {
        case "run":
          this.mode = { kind: "globalConfig" };
          result = global;
          break;
        case "incomplete":
        case "ambiguous":
          if (firstWordFailed) result = global;
          break;
        case "invalid":
          if (global.column > failedColumn) result = global;
          break;
      }
    }

    switch (result.kind) {
      case "run":
        return result.node.handler ? result.node.handler(this, result.command) : "";
      case "incomplete":
        return this.isDell ? "% Error: Incomplete command." : "% Incomplete command.";
      case "ambiguous":
        return this.ambiguousMessage(input.source);
      case "invalid": {
        const caret = " ".repeat(promptWidth + result.column) + "^";
        const message = this.isDell
          ? '% Error: Invalid input at "^" marker.'
          : "% Invalid input detected at '^' marker.";
        return caret + "\n" + message;
      }
    }
  }

  private ambiguousMessage(line: string): string {
    if (this.isDell) return "% Error: Ambiguous command.";
    return `% Ambiguous command:  "${trimWhitespaces(line)}"`;
  }

  // MARK: Help and completion

  help(partial: string): string {
    if (!this.access.exists || this._isClosed || charCount(partial) > CLILimits.maxLineLength) return "";
    const parser = new CommandParser(this);
    const input = new ParseInput(partial);
    const tree = this.currentTree;

    if (input.tokens.length === 0 || input.endsWithSeparator) {
      const position = parser.position(input.tokens, input, tree);
      switch (position.kind) {
        case "at": {
          const entries = parser.helpEntries(position.node);
          return entries.length === 0 ? "% Unrecognized command" : HelpFormatter.table(entries);
        }
        case "insideArgument":
          return HelpFormatter.table(position.argument.continuationHelp(this, position.pending));
        case "ambiguous":
          return this.ambiguousMessage(partial);
        case "invalid":
          return "% Unrecognized command";
      }
    }

    // The last word is still being typed: list what it may become.
    const complete = input.tokens.slice(0, -1);
    const last = input.tokens[input.tokens.length - 1];
    const position = parser.position(complete, input, tree);
    switch (position.kind) {
      case "at": {
        const node = position.node;
        if (node.kind.kind === "line") return HelpFormatter.table(parser.helpEntries(node));
        const lastLower = last.lower;
        const words = parser
          .completionWords(node)
          .filter((candidate) => candidate.toLowerCase().startsWith(lastLower))
          .sort((a, b) => compareStrings(a.toLowerCase(), b.toLowerCase()));
        if (words.length > 0) return HelpFormatter.words(words);
        // Not a keyword: the word may be an argument (a number, a name, free text).
        const argumentEntries = parser
          .helpEntries(node)
          .filter((entry) => !node.children.some((child) => child.keyword === entry.name) && entry.name !== "<cr>");
        return argumentEntries.length === 0 ? "% Unrecognized command" : HelpFormatter.table(argumentEntries);
      }
      case "insideArgument":
        return HelpFormatter.table(position.argument.continuationHelp(this, position.pending));
      case "ambiguous":
        return this.ambiguousMessage(partial);
      case "invalid":
        return "% Unrecognized command";
    }
  }

  complete(partial: string): string[] {
    if (!this.access.exists || this._isClosed || charCount(partial) > CLILimits.maxLineLength) return [];
    const parser = new CommandParser(this);
    const input = new ParseInput(partial);
    const startsNewWord = input.tokens.length === 0 || input.endsWithSeparator;
    const complete = startsNewWord ? input.tokens : input.tokens.slice(0, -1);
    const position = parser.position(complete, input, this.currentTree);
    if (position.kind !== "at") return [];
    let words = parser.completionWords(position.node);
    if (!startsNewWord) {
      const prefix = input.tokens[input.tokens.length - 1].lower;
      words = words.filter((candidate) => candidate.toLowerCase().startsWith(prefix));
    }
    const seen = new Set<string>();
    return words
      .filter((candidate) => {
        const key = candidate.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => compareStrings(a.toLowerCase(), b.toLowerCase()));
  }

  // MARK: Ports of the current mode

  /** The live ports of the interface mode. When they are gone the mode is left. */
  selectedPorts(): PortSnapshot[] {
    const mode = this.mode;
    if (mode.kind !== "interface" || mode.selection.target.kind !== "ports") return [];
    const live = this.access.interfaces;
    const result: PortSnapshot[] = [];
    for (const id of mode.selection.target.ids) {
      const port = live.find((candidate) => candidate.id === id);
      if (port) result.push(port);
    }
    return result;
  }

  // MARK: - Interface arguments

  /** One interface: "fa0/1", "Fa 0/1", "GigabitEthernet 1/1", "vlan 10". */
  static readonly interfaceArgument: CustomArgument = {
    name: "interface",
    match: (engine, input, index) => engine.matchInterface(input, index),
    helpEntries: (engine) => engine.interfaceTypeHelp(),
    continuationHelp: (engine, pending) => engine.interfaceNumberHelp(pending),
    completions: (engine) => engine.interfaceTypeHelp().map((entry) => entry.name),
  };

  /** One or more interfaces: "fa0/1 - 4", "fa0/1-4 , gi0/1", "gigabitethernet 1/1 - 1/4". */
  static readonly interfaceRangeArgument: CustomArgument = {
    name: "interface",
    match: (engine, input, index) => engine.matchInterfaceRange(input, index),
    helpEntries: (engine) => engine.interfaceTypeHelp(false),
    continuationHelp: (engine, pending) => engine.interfaceNumberHelp(pending),
    completions: (engine) => engine.interfaceTypeHelp(false).map((entry) => entry.name),
  };

  /** The interface type words `interface ?` lists for this device. */
  interfaceTypeHelp(includingVirtual = true): HelpEntry[] {
    const entries: HelpEntry[] = [];
    const seen = new Set<string>();
    for (const port of this.access.interfaces) {
      const typeWord = this.namer.typeWord(port.name);
      if (typeWord === "" || typeWord.includes(" ") || seen.has(typeWord.toLowerCase())) continue;
      seen.add(typeWord.toLowerCase());
      entries.push({ name: typeWord, text: this.namer.knownType(port.name)?.help ?? "Interface" });
    }
    if (includingVirtual) {
      entries.push({ name: "Vlan", text: this.isDell ? "VLAN interface" : "Catalyst Vlans" });
    }
    return entries;
  }

  /** Help after an interface type without a number ("interface fastethernet ?"). */
  interfaceNumberHelp(pending: CLIToken[]): HelpEntry[] {
    if (pending.length === 0) return [];
    const typed = new InterfaceNameParts(pending[0].text).type;
    const ports = this.access.interfaces.filter((port) =>
      InterfaceResolver.typeMatches(typed, new InterfaceNameParts(port.name).type),
    );
    const first = ports[0];
    const last = ports[ports.length - 1];
    if (first === undefined || last === undefined) {
      const virtual = virtualTypes.find((candidate) => candidate.name.startsWith(typed));
      if (virtual) {
        return [{ name: `<${virtual.lowerBound}-${virtual.upperBound}>`, text: `${virtual.word} interface number` }];
      }
      return [];
    }
    const range = `<${new InterfaceNameParts(first.name).number}-${new InterfaceNameParts(last.name).number}>`;
    return [{ name: range, text: `${this.namer.typeWord(first.name)} interface number` }];
  }

  private typeIsPlausible(type: string): boolean {
    if (type === "") return false;
    if (virtualTypes.some((candidate) => candidate.name.startsWith(type))) return true;
    return this.access.interfaces.some((port) =>
      InterfaceResolver.typeMatches(type, new InterfaceNameParts(port.name).type),
    );
  }

  /** Number of leading characters of a typed type that still fit some type of this device. */
  private typePrefixLength(type: string): number {
    const words = virtualTypes.map((candidate) => candidate.name);
    for (const port of this.access.interfaces) {
      words.push(new InterfaceNameParts(port.name).type);
      const known = this.namer.knownType(port.name);
      if (known) words.push(known.full.toLowerCase());
    }
    let best = 0;
    for (const candidate of words) best = Math.max(best, commonPrefixLength(type, candidate));
    return Math.min(best, Math.max(0, charCount(type) - 1));
  }

  private virtualInterface(parts: InterfaceNameParts): InterfaceSelection | null {
    if (parts.type === "" || !/^[0-9]{1,10}$/.test(parts.number)) return null;
    const number = Number(parts.number);
    const virtual = virtualTypes.find((candidate) => candidate.name.startsWith(parts.type));
    if (!virtual || number < virtual.lowerBound || number > virtual.upperBound) return null;
    switch (virtual.name) {
      case "vlan":
        return { target: { kind: "vlan", number }, isRange: false, promptLabel: `vl-${number}` };
      case "port-channel":
        return { target: { kind: "portChannel", number }, isRange: false, promptLabel: `po-${number}` };
      default:
        return { target: { kind: "loopback", number }, isRange: false, promptLabel: `lo-${number}` };
    }
  }

  private selection(port: PortSnapshot): InterfaceSelection {
    const label = `${this.namer.promptTag(port.name)}-${new InterfaceNameParts(port.name).number}`;
    return { target: { kind: "ports", ids: [port.id] }, isRange: false, promptLabel: label };
  }

  matchInterface(input: ParseInput, index: number): CustomMatch {
    const tokens = input.tokens;
    const ports = this.access.interfaces;

    // Names made of several words first ("LAN 3", "WAN SFP+"): they must match word by word.
    for (let count = Math.min(3, tokens.length - index); count >= 2; count -= 1) {
      const typed = tokens.slice(index, index + count).map((token) => token.lower);
      const match = ports.find((port) => {
        const words = splitWords(port.name.toLowerCase());
        return words.length === typed.length && words.every((piece, position) => piece === typed[position]);
      });
      if (match) return { kind: "matched", value: { kind: "interfaces", value: this.selection(match) }, consumed: count };
    }
    const exact = ports.find((port) => new InterfaceNameParts(port.name).normalized === tokens[index].lower);
    if (exact) return { kind: "matched", value: { kind: "interfaces", value: this.selection(exact) }, consumed: 1 };

    const first = tokens[index];
    let parts = new InterfaceNameParts(first.text);
    let consumed = 1;
    let numberColumn = first.column + prefixLength(first.text, (character) => !isNumber(character));

    if (parts.number === "") {
      // "fa 0/1": the number is the next word.
      if (index + 1 >= tokens.length) {
        return this.typeIsPlausible(parts.type)
          ? { kind: "incomplete" }
          : { kind: "invalid", column: first.column + this.typePrefixLength(parts.type) };
      }
      const next = tokens[index + 1];
      if (!this.typeIsPlausible(parts.type)) {
        return { kind: "invalid", column: first.column + this.typePrefixLength(parts.type) };
      }
      const digit = chars(next.text)[0];
      if (digit === undefined || !isNumber(digit)) return { kind: "invalid", column: next.column };
      parts = new InterfaceNameParts(first.text + next.text);
      consumed = 2;
      numberColumn = next.column;
    }

    const lookup = InterfaceResolver.lookup(parts.normalized, ports);
    switch (lookup.kind) {
      case "found":
        return { kind: "matched", value: { kind: "interfaces", value: this.selection(lookup.port) }, consumed };
      case "ambiguous":
        return { kind: "invalid", column: first.column };
      case "unknownNumber":
        return { kind: "invalid", column: numberColumn + lookup.offset };
      case "unknownType": {
        const virtual = this.virtualInterface(parts);
        if (virtual) return { kind: "matched", value: { kind: "interfaces", value: virtual }, consumed };
        if (virtualTypes.some((candidate) => parts.type !== "" && candidate.name.startsWith(parts.type))) {
          return { kind: "invalid", column: numberColumn };
        }
        return { kind: "invalid", column: first.column + this.typePrefixLength(parts.type) };
      }
    }
  }

  matchInterfaceRange(input: ParseInput, index: number): CustomMatch {
    const tokens = input.tokens;
    const raw = input.rest(index);
    const base = tokens[index].column;
    const ports = this.access.interfaces;
    const ids: string[] = [];
    const labels: string[] = [];
    let offset = 0;

    const segments = raw.split(",");
    for (let position = 0; position < segments.length; position += 1) {
      const segment = segments[position];
      const segmentColumn = base + offset + prefixLength(segment, isWhitespace);
      offset += charCount(segment) + 1;
      const text = trimWhitespaces(segment);
      if (text === "") {
        return position === segments.length - 1 ? { kind: "incomplete" } : { kind: "invalid", column: segmentColumn };
      }

      let startSpec = text;
      let endText: string | null = null;
      const dash = text.lastIndexOf("-");
      if (dash >= 0) {
        const left = trimWhitespaces(text.slice(0, dash));
        const right = trimWhitespaces(text.slice(dash + 1));
        if (chars(left).some(isNumber)) {
          if (right === "") return { kind: "incomplete" };
          if (/^[0-9/]*$/.test(right)) {
            startSpec = left;
            endText = right;
          }
        }
      }

      const startParts = new InterfaceNameParts(startSpec);
      if (startParts.number === "") {
        // Only a type so far ("interface range fa").
        const plausible =
          this.typeIsPlausible(startParts.type) &&
          !ports.some((port) => new InterfaceNameParts(port.name).normalized === startParts.normalized);
        if (plausible) {
          return position === segments.length - 1 ? { kind: "incomplete" } : { kind: "invalid", column: segmentColumn };
        }
      }
      const lookup = InterfaceResolver.lookup(startSpec, ports);
      if (lookup.kind !== "found") return { kind: "invalid", column: segmentColumn };
      const startPort = lookup.port;
      const actual = new InterfaceNameParts(startPort.name);
      const tag = this.namer.promptTag(startPort.name);

      if (endText === null) {
        ids.push(startPort.id);
        labels.push(`${tag}-${actual.number}`);
        continue;
      }

      // "fa0/1 - 4" repeats the leading numbers of the start; "1/1 - 1/4" spells them out.
      const startComponents = actual.components;
      const endComponents = endText.split("/");
      const startLastText = startComponents[startComponents.length - 1];
      const endLastText = endComponents[endComponents.length - 1];
      const startLast = startLastText === undefined ? null : swiftInt(startLastText);
      const endLast = endLastText === undefined || charCount(endLastText) > 6 ? null : swiftInt(endLastText);
      const leading = startComponents.slice(0, -1);
      const sameLeading =
        endComponents.length === 1 ||
        (endComponents.length - 1 === leading.length &&
          endComponents.slice(0, -1).every((component, position) => component === leading[position]));
      if (startLast === null || endLast === null || !sameLeading || startLast > endLast || endLast - startLast >= 1024) {
        return { kind: "invalid", column: segmentColumn };
      }

      const siblings = ports.filter((port) => new InterfaceNameParts(port.name).type === actual.type);
      for (let number = startLast; number <= endLast; number += 1) {
        const wanted = [...leading, String(number)].join("/");
        const port = siblings.find((candidate) => new InterfaceNameParts(candidate.name).number === wanted);
        if (!port) return { kind: "invalid", column: segmentColumn };
        ids.push(port.id);
      }
      labels.push(`${tag}-${actual.number}-${endText}`);
    }

    const seen = new Set<string>();
    const unique = ids.filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const selection: InterfaceSelection = {
      target: { kind: "ports", ids: unique },
      isRange: true,
      promptLabel: "range-" + labels.join(","),
    };
    return { kind: "matched", value: { kind: "interfaces", value: selection }, consumed: tokens.length - index };
  }
}
