// Access lists on the IOS-style consoles: numbered lists (`access-list 101 permit ...`), named
// lists with sequence numbers (`ip access-list extended NAME`, config-ext-nacl), binding to
// interfaces (`ip access-group NAME in`), `show access-lists`, the running-config and
// `telnet` for testing ports. Cisco IOS and Dell OS9 (`seq N permit ...`, CIDR networks).
//
// Values from ../../ios-network are used only inside functions (circular imports).

import type { ACLBinding, ACLConfig, AccessList } from "../../../core/protocols";
import {
  closedRange,
  custom,
  kw,
  line,
  num,
  splitSpaces,
  word,
  type CommandHandler,
  type CommandNode,
  type CustomArgument,
  type ParsedCommand,
} from "../../command-tree";
import type { IOSEngine } from "../../ios-engine";
import * as Network from "../../ios-network";
import { Notices } from "../../notices";
import { IPv4 } from "../../sim/ipv4";
import type { IOSFeature, IOSFeatureCommands } from "../ios-commands";
import {
  entryFromRule,
  formatEntry,
  insertEntry,
  isNumbered,
  nextSequence,
  parseRule,
  ruleHelp,
  ruleStart,
  sameRule,
  typeOfNumber,
  type FormatStyle,
  type ListType,
  type ParsedRule,
  type RuleOptions,
} from "./rules";
import { tcpProbe } from "./tcp";

const standardMode = "acl-std";
const extendedMode = "acl-ext";

// MARK: Reading and writing the configuration

function emptyConfig(): ACLConfig {
  return { lists: [], bindings: [], firewall: [] };
}

function readConfig(engine: IOSEngine): ACLConfig {
  return engine.access.protocols.acl ?? emptyConfig();
}

/**
 * Changes the configuration in one undo step. `change` returns a message; one starting with "%"
 * is an error and nothing is written.
 */
function edit(engine: IOSEngine, change: (config: ACLConfig) => string): string {
  const protocols = engine.access.protocols;
  const config = protocols.acl ?? emptyConfig();
  const message = change(config);
  if (message.startsWith("%")) return message;
  const empty = config.lists.length === 0 && config.bindings.length === 0 && config.firewall.length === 0;
  protocols.acl = empty ? undefined : config;
  engine.access.setProtocols(protocols);
  return message;
}

function step(engine: IOSEngine): number {
  return engine.isDell ? 5 : 10;
}

function duplicateSequence(engine: IOSEngine): string {
  return engine.isDell ? "% Error: Duplicate sequence number." : "% Duplicate sequence number";
}

function listStyle(engine: IOSEngine, type: ListType, show: boolean): FormatStyle {
  return { dell: engine.isDell, standard: type === "standard", show };
}

// MARK: Rule argument (the part of a line after permit/deny)

function ruleArgument(type: ListType, dell: boolean): CustomArgument {
  const options: RuleOptions = { kind: type, dell };
  return {
    name: "rule",
    match(_engine, input, index) {
      const tokens = input.tokens.slice(index);
      const parsed = parseRule(
        tokens.map((token) => token.text),
        options,
      );
      switch (parsed.kind) {
        case "ok":
          return { kind: "matched", value: { kind: "text", value: input.rest(index) }, consumed: tokens.length };
        case "invalid":
          return { kind: "invalid", column: tokens[parsed.at].column };
        case "incomplete":
          return { kind: "incomplete" };
      }
    },
    helpEntries: () => ruleStart(options),
    continuationHelp: (_engine, pending) =>
      ruleHelp(
        pending.map((token) => token.text),
        options,
      ),
    completions: () => ruleStart(options).map((entry) => entry.name).filter((name) => /^[a-z]/.test(name)),
  };
}

/** The rule typed after permit/deny (already checked by the parser). */
function typedRule(command: ParsedCommand, type: ListType, dell: boolean): ParsedRule | null {
  const parsed = parseRule(splitSpaces(command.text("rule") ?? ""), { kind: type, dell });
  return parsed.kind === "ok" ? parsed.rule : null;
}

function actionOf(command: ParsedCommand): "permit" | "deny" {
  return command.has("permit") ? "permit" : "deny";
}

/** The `log` hint behind a complete rule: `?` after it lists `log` and `<cr>`. */
function logHint(): CommandNode[] {
  return [kw("log", "Log matches against this entry")];
}

// MARK: Numbered lists

function addNumbered(engine: IOSEngine, command: ParsedCommand, remark: boolean): string {
  const number = command.int("number") ?? 0;
  const type = typeOfNumber(number);
  if (type === null) return "% Invalid input detected";
  const name = `${number}`;
  const parsed = remark ? null : typedRule(command, type, engine.isDell);
  if (!remark && parsed === null) return "% Invalid input detected";
  return edit(engine, (config) => {
    let list = config.lists.find((item) => item.name === name);
    if (!list) {
      list = { name, type, entries: [] };
      config.lists.push(list);
    }
    const sequence = nextSequence(list, step(engine));
    if (remark) {
      list.entries.push({
        sequence,
        action: "remark",
        protocol: "ip",
        source: "any",
        destination: "",
        destinationPort: "",
        sourcePort: "",
        icmpType: "",
        remark: (command.text("text") ?? "").trim(),
      });
    } else if (parsed) {
      list.entries.push(entryFromRule(sequence, actionOf(command), parsed));
    }
    return "";
  });
}

function removeList(engine: IOSEngine, name: string): string {
  return edit(engine, (config) => {
    config.lists = config.lists.filter((list) => list.name !== name);
    return "";
  });
}

function accessListCommand(): CommandNode {
  const ranges: [number, number, string, ListType][] = [
    [1, 99, "IP standard access list", "standard"],
    [100, 199, "IP extended access list", "extended"],
    [1300, 1999, "IP standard access list (expanded range)", "standard"],
    [2000, 2699, "IP extended access list (expanded range)", "extended"],
  ];
  const lineHandler =
    (): CommandHandler =>
    (engine, command) =>
      addNumbered(engine, command, false);
  const nodes = ranges.map(([low, high, help, type]) =>
    num("number", closedRange(low, high), help, [
      kw("deny", "Specify packets to reject", [custom(ruleArgument(type, false), lineHandler(), "", logHint())]),
      kw("permit", "Specify packets to forward", [custom(ruleArgument(type, false), lineHandler(), "", logHint())]),
      kw("remark", "Access list entry comment", [
        line("text", "Comment up to 100 characters", (engine, command) => addNumbered(engine, command, true)),
      ]),
    ]),
  );
  return kw("access-list", "Add an access list entry", nodes);
}

function noAccessListCommand(): CommandNode {
  return kw("access-list", "Add an access list entry", [
    num("number", closedRange(1, 2699), "IP access list number", [], (engine, command) =>
      removeList(engine, `${command.int("number") ?? 0}`),
    ),
  ]);
}

// MARK: Named lists

function enterNamed(engine: IOSEngine, command: ParsedCommand, type: ListType): string {
  const name = command.text("name") ?? "";
  const existing = readConfig(engine).lists.find((list) => list.name === name);
  if (existing && existing.type !== type) {
    return engine.isDell ? `% Error: Access-list ${name} is of another type.` : "% Access-list type mismatch";
  }
  if (!existing) {
    edit(engine, (config) => {
      config.lists.push({ name, type, entries: [] });
      return "";
    });
  }
  engine.mode = {
    kind: "feature",
    name: type === "standard" ? standardMode : extendedMode,
    prompt: type === "standard" ? "config-std-nacl" : "config-ext-nacl",
    context: { list: name },
  };
  return "";
}

function removeNamed(engine: IOSEngine, command: ParsedCommand): string {
  return removeList(engine, command.text("name") ?? "");
}

function resequence(engine: IOSEngine, command: ParsedCommand): string {
  const name = command.text("name") ?? "";
  const start = command.int("start") ?? 10;
  const increment = command.int("increment") ?? 10;
  if (!readConfig(engine).lists.some((list) => list.name === name)) return `% Access list ${name} not found`;
  return edit(engine, (config) => {
    const list = config.lists.find((item) => item.name === name);
    list?.entries.forEach((entry, index) => {
      entry.sequence = start + index * increment;
    });
    return "";
  });
}

/** The list of the current access list mode and its kind. */
function modeList(engine: IOSEngine): { name: string; type: ListType } | null {
  const mode = engine.mode;
  if (mode.kind !== "feature" || (mode.name !== standardMode && mode.name !== extendedMode)) return null;
  return { name: String(mode.context.list ?? ""), type: mode.name === standardMode ? "standard" : "extended" };
}

/** Changes the list being edited (created again if it was deleted meanwhile). */
function editList(engine: IOSEngine, change: (list: AccessList) => string): string {
  const current = modeList(engine);
  if (!current) return "";
  return edit(engine, (config) => {
    let list = config.lists.find((item) => item.name === current.name);
    if (!list) {
      list = { name: current.name, type: current.type, entries: [] };
      config.lists.push(list);
    }
    return change(list);
  });
}

function addToMode(engine: IOSEngine, command: ParsedCommand): string {
  const current = modeList(engine);
  if (!current) return "";
  const remark = command.has("remark");
  const parsed = remark ? null : typedRule(command, current.type, engine.isDell);
  if (!remark && parsed === null) return "% Invalid input detected";
  const given = command.int("sequence");
  return editList(engine, (list) => {
    const sequence = given ?? nextSequence(list, step(engine));
    if (list.entries.some((entry) => entry.sequence === sequence)) return duplicateSequence(engine);
    if (remark) {
      insertEntry(list, {
        sequence,
        action: "remark",
        protocol: "ip",
        source: "any",
        destination: "",
        destinationPort: "",
        sourcePort: "",
        icmpType: "",
        remark: (command.text("text") ?? "").trim(),
      });
    } else if (parsed) {
      insertEntry(list, entryFromRule(sequence, actionOf(command), parsed));
    }
    return "";
  });
}

function removeFromMode(engine: IOSEngine, command: ParsedCommand): string {
  const current = modeList(engine);
  if (!current) return "";
  const sequence = command.int("sequence");
  const known = readConfig(engine)
    .lists.find((list) => list.name === current.name)
    ?.entries.some((entry) => entry.sequence === sequence);
  if (!known) return engine.isDell ? "% Error: Invalid sequence number." : "% Invalid sequence number";
  return editList(engine, (list) => {
    list.entries = list.entries.filter((entry) => entry.sequence !== sequence);
    return "";
  });
}

function removeByRule(engine: IOSEngine, command: ParsedCommand): string {
  const current = modeList(engine);
  if (!current) return "";
  const rule = typedRule(command, current.type, engine.isDell);
  if (rule === null) return "% Invalid input detected";
  const wanted = entryFromRule(0, actionOf(command), rule);
  const found = readConfig(engine)
    .lists.find((list) => list.name === current.name)
    ?.entries.some((entry) => sameRule(entry, wanted));
  if (!found) return engine.isDell ? "% Error: Entry not found." : "% Invalid input detected";
  return editList(engine, (list) => {
    const index = list.entries.findIndex((entry) => sameRule(entry, wanted));
    if (index >= 0) list.entries.splice(index, 1);
    return "";
  });
}

function removeRemark(engine: IOSEngine, command: ParsedCommand): string {
  const text = (command.text("text") ?? "").trim();
  return editList(engine, (list) => {
    const index = list.entries.findIndex((entry) => entry.action === "remark" && entry.remark === text);
    if (index >= 0) list.entries.splice(index, 1);
    return "";
  });
}

function modeCommands(type: ListType, dell: boolean): CommandNode[] {
  const withRule = (): CommandNode[] => [
    kw("deny", "Specify packets to reject", [custom(ruleArgument(type, dell), addToMode, "", logHint())]),
    kw("permit", "Specify packets to forward", [custom(ruleArgument(type, dell), addToMode, "", logHint())]),
    kw("remark", "Access list entry comment", [line("text", "Comment up to 100 characters", addToMode)]),
  ];
  const sequence = dell
    ? kw("seq", "Sequence number", [
        num("sequence", closedRange(0, 4294967290), "Sequence number", withRule()),
      ])
    : num("sequence", closedRange(1, 2147483647), "Sequence Number", withRule());
  const removal = dell
    ? kw("seq", "Sequence number", [
        num("sequence", closedRange(0, 4294967290), "Sequence number", [], removeFromMode),
      ])
    : num("sequence", closedRange(1, 2147483647), "Sequence Number", [], removeFromMode);
  return [
    ...withRule(),
    sequence,
    kw("no", "Negate a command or set its defaults", [
      removal,
      kw("deny", "Specify packets to reject", [custom(ruleArgument(type, dell), removeByRule, "", logHint())]),
      kw("permit", "Specify packets to forward", [custom(ruleArgument(type, dell), removeByRule, "", logHint())]),
      kw("remark", "Access list entry comment", [line("text", "Comment up to 100 characters", removeRemark)]),
    ]),
  ];
}

// MARK: Binding to interfaces

function accessGroupFailure(message: string): string {
  if (message === Notices.switchPortHasNoAddress) {
    return (
      "NetSketch: seznam lze navázat jen na směrované rozhraní (port routeru, rozhraní VLAN); " +
      "filtrování na přepínaném (L2) portu se nesimuluje. Nic se nezměnilo."
    );
  }
  return message;
}

function bind(engine: IOSEngine, command: ParsedCommand): string {
  const where = Network.currentL3Interface(engine);
  if (where.kind === "failure") return accessGroupFailure(where.message);
  const list = command.text("list") ?? "";
  const direction = command.has("out") ? "out" : "in";
  const interfaceID = where.interface;
  const exists = readConfig(engine).lists.some((item) => item.name === list);
  const message = edit(engine, (config) => {
    config.bindings = config.bindings.filter((item) => !(item.interface === interfaceID && item.direction === direction));
    config.bindings.push({ interface: interfaceID, direction, list });
    return "";
  });
  if (message !== "") return message;
  return exists
    ? ""
    : `NetSketch: seznam ${list} zatím neexistuje; dokud nevznikne, propouští rozhraní vše (jako IOS).`;
}

function unbind(engine: IOSEngine, command: ParsedCommand): string {
  const where = Network.currentL3Interface(engine);
  if (where.kind === "failure") return accessGroupFailure(where.message);
  const list = command.text("list");
  const direction = command.has("in") ? "in" : command.has("out") ? "out" : null;
  const interfaceID = where.interface;
  const matches = (item: ACLBinding): boolean =>
    item.interface === interfaceID && (direction === null || item.direction === direction) && (list === null || item.list === list);
  if (!readConfig(engine).bindings.some(matches)) return "";
  return edit(engine, (config) => {
    config.bindings = config.bindings.filter((item) => !matches(item));
    return "";
  });
}

function accessGroupNode(): CommandNode {
  const direction = (): CommandNode[] => [
    kw("in", "inbound packets", [], bind),
    kw("out", "outbound packets", [], bind),
  ];
  return kw("access-group", "Specify access control for packets", [
    word("list", "Access-list name or number", null, "WORD", direction()),
  ]);
}

function noAccessGroupNode(): CommandNode {
  const direction = (): CommandNode[] => [
    kw("in", "inbound packets", [], unbind),
    kw("out", "outbound packets", [], unbind),
  ];
  return kw(
    "access-group",
    "Specify access control for packets",
    [...direction(), word("list", "Access-list name or number", unbind, "WORD", direction())],
    unbind,
  );
}

// MARK: show

function listHeader(list: AccessList): string {
  return `${list.type === "standard" ? "Standard" : "Extended"} IP access list ${list.name}`;
}

function showLists(engine: IOSEngine, command: ParsedCommand): string {
  const wanted = command.text("name");
  const lists = readConfig(engine).lists.filter((list) => wanted === null || list.name === wanted);
  if (wanted !== null && lists.length === 0) return `NetSketch: seznam ${wanted} neexistuje.`;
  const dell = engine.isDell;
  const lines: string[] = [];
  for (const list of lists) {
    lines.push(listHeader(list));
    const style = listStyle(engine, list.type, true);
    for (const entry of list.entries) {
      const text = formatEntry(entry, list.type, style, list.type === "standard");
      lines.push(dell ? ` seq ${entry.sequence} ${text}` : `    ${entry.sequence} ${text}`);
    }
  }
  return lines.join("\n");
}

function showNode(): CommandNode {
  return kw(
    "access-lists",
    "List access lists",
    [word("name", "Access list name or number", showLists, "WORD")],
    showLists,
  );
}

// MARK: Configuration lines

function entryLines(engine: IOSEngine, list: AccessList): string[] {
  const style = listStyle(engine, list.type, false);
  return list.entries.map((entry) => {
    const text = formatEntry(entry, list.type, style, true);
    return engine.isDell ? ` seq ${entry.sequence} ${text}` : ` ${text}`;
  });
}

function globalBlocks(engine: IOSEngine): string[][] {
  const config = readConfig(engine);
  const blocks: string[][] = [];
  const numbered = engine.isDell ? [] : config.lists.filter(isNumbered);
  const numberedLines = numbered.flatMap((list) =>
    entryLines(engine, list).map((text) => `access-list ${list.name}${text}`),
  );
  if (numberedLines.length > 0) blocks.push(numberedLines);
  for (const list of config.lists) {
    if (numbered.includes(list)) continue;
    blocks.push([`ip access-list ${list.type} ${list.name}`, ...entryLines(engine, list)]);
  }
  return blocks;
}

function interfaceLines(engine: IOSEngine, interfaceID: string): string[] {
  const bindings = readConfig(engine).bindings.filter((item) => item.interface === interfaceID);
  return ["in", "out"].flatMap((direction) =>
    bindings.filter((item) => item.direction === direction).map((item) => ` ip access-group ${item.list} ${direction}`),
  );
}

// MARK: telnet

function telnet(engine: IOSEngine, command: ParsedCommand): string {
  const address = IPv4.parse(command.text("host") ?? "");
  if (!address) return "% Unknown command or computer name, or unable to find computer address";
  const port = command.int("port") ?? 23;
  const dell = engine.isDell;
  const access = engine.access;
  const probe = tcpProbe(access.simulator, access.deviceID, address, port);
  const target = port === 23 ? address.description : `${address.description}, ${port}`;
  const lines: string[] = [];
  switch (probe.outcome) {
    case "open":
      if (dell) {
        lines.push(`Trying ${address.description}...`, `Connected to ${address.description}.`, "Escape character is '^\\'.");
      } else {
        lines.push(`Trying ${target} ... Open`);
      }
      lines.push("NetSketch: spojení se navázalo; obsah relace se nesimuluje, spojení se hned zavírá.");
      lines.push(
        dell ? "Connection closed by foreign host." : `[Connection to ${address.description} closed by foreign host]`,
      );
      return lines.join("\n");
    case "refused":
      lines.push(dell ? `Trying ${address.description}...` : `Trying ${target} ...`);
      lines.push(dell ? "telnet: Unable to connect to remote host: Connection refused" : "% Connection refused by remote host");
      break;
    case "unreachable":
      lines.push(dell ? `Trying ${address.description}...` : `Trying ${target} ...`);
      lines.push(
        dell ? "telnet: Unable to connect to remote host: No route to host" : "% Destination unreachable; gateway or host down",
      );
      break;
    case "timeout":
      lines.push(dell ? `Trying ${address.description}...` : `Trying ${target} ...`);
      lines.push(
        dell
          ? "telnet: Unable to connect to remote host: Connection timed out"
          : "% Connection timed out; remote host not responding",
      );
      break;
  }
  if (probe.explanation !== "") lines.push(probe.explanation);
  return lines.join("\n");
}

function telnetNode(): CommandNode {
  return kw("telnet", "Open a telnet connection", [
    word("host", "IP address of remote host", telnet, "WORD", [
      num("port", closedRange(0, 65535), "Port number", [], telnet),
    ]),
  ]);
}

// MARK: The feature

export const aclIOS: IOSFeature = (dialect): IOSFeatureCommands => {
  if (dialect !== "ios" && dialect !== "dellOS9" && dialect !== "generic") return {};
  const dell = dialect === "dellOS9";

  const named = (type: ListType): CommandNode =>
    kw(
      type,
      type === "standard" ? "Standard Access List" : "Extended Access List",
      [word("name", "Access-list name", (engine, command) => enterNamed(engine, command, type), "WORD")],
    );
  const namedRemoval = (type: ListType): CommandNode =>
    kw(type, type === "standard" ? "Standard Access List" : "Extended Access List", [
      word("name", "Access-list name", removeNamed, "WORD"),
    ]);
  const ipAccessList = kw("access-list", "Named access list", [
    named("standard"),
    named("extended"),
    ...(dell
      ? []
      : [
          kw("resequence", "Resequence Access List", [
            word("name", "Access-list name", null, "WORD", [
              num("start", closedRange(1, 2147483647), "Starting Sequence Number", [
                num("increment", closedRange(1, 2147483647), "Step to increment the sequence number", [], resequence),
              ]),
            ]),
          ]),
        ]),
  ]);

  const showAccessLists = showNode();
  return {
    show: dell ? [] : [showAccessLists],
    showIP: [showNode()],
    exec: [telnetNode()],
    global: dell ? [] : [accessListCommand()],
    globalNo: dell ? [] : [noAccessListCommand()],
    globalIP: [ipAccessList],
    globalNoIP: [kw("access-list", "Named access list", [namedRemoval("standard"), namedRemoval("extended")])],
    interfaceIP: [accessGroupNode()],
    interfaceNoIP: [noAccessGroupNode()],
    modes: {
      [standardMode]: modeCommands("standard", dell),
      [extendedMode]: modeCommands("extended", dell),
    },
    config: { interfaceLines, globalBlocks },
  };
};
