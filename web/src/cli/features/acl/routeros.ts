// MikroTik `/ip firewall filter`: add, print, set, remove, enable, disable, comment and the
// part of `/export`. Rules are stored in Device.protocols.acl.firewall in the order of `print`.

import type { L3InterfaceID } from "../../../core/model";
import type { ACLConfig, FirewallRule } from "../../../core/protocols";
import { leftPadded, trimmingTrailingWhitespace } from "../../command-tree";
import type { RouterOSContext, RouterOSFeature, RouterOSWord } from "../routeros-menus";
import {
  checkAddress,
  checkPorts,
  checkProtocol,
  checkStates,
  chains,
  ruleProperties,
  splitNot,
} from "./firewall";

const keys = [
  "chain",
  "action",
  "protocol",
  "src-address",
  "dst-address",
  "src-port",
  "dst-port",
  "in-interface",
  "out-interface",
  "connection-state",
  "comment",
  "disabled",
  "place-before",
  "log",
  "log-prefix",
];

const printWords = ["detail", "terse", "without-paging", "brief"];

function invalid(key: string): string {
  return `invalid value for argument ${key}`;
}

function readRules(context: RouterOSContext): FirewallRule[] {
  return context.access.protocols.acl?.firewall ?? [];
}

/** Writes the rule list (an empty configuration removes the key). */
function writeRules(context: RouterOSContext, change: (rules: FirewallRule[]) => FirewallRule[]): void {
  context.access.updateProtocols((protocols) => {
    const config: ACLConfig = protocols.acl ?? { lists: [], bindings: [], firewall: [] };
    config.firewall = change(config.firewall);
    const empty = config.lists.length === 0 && config.bindings.length === 0 && config.firewall.length === 0;
    protocols.acl = empty ? undefined : config;
  });
}

function yesNo(value: string): boolean | null {
  switch (value.toLowerCase()) {
    case "yes":
    case "true":
      return true;
    case "no":
    case "false":
      return false;
    default:
      return null;
  }
}

/** Applies the typed properties to `rule`; returns an error text or null. */
function apply(context: RouterOSContext, rule: FirewallRule, values: Map<string, string>, notes: string[]): string | null {
  for (const [key, value] of values) {
    switch (key) {
      case "chain": {
        const chain = chains.find((candidate) => candidate === value);
        if (!chain) {
          return `${invalid("chain")}\nNetSketch: simuluje se jen input, forward a output (vlastní řetězce ne).`;
        }
        rule.chain = chain;
        break;
      }
      case "action": {
        const action = (["accept", "drop", "reject"] as const).find((candidate) => candidate === value);
        if (!action) {
          return `${invalid("action")}\nNetSketch: simuluje se jen accept, drop a reject.`;
        }
        rule.action = action;
        break;
      }
      case "protocol": {
        const protocol = value === "" ? "" : checkProtocol(value);
        if (protocol === null) return invalid("protocol");
        rule.protocol = protocol;
        break;
      }
      case "src-address":
      case "dst-address": {
        if (value !== "" && checkAddress(value) === null) return invalid(key);
        if (key === "src-address") rule.srcAddress = value;
        else rule.dstAddress = value;
        break;
      }
      case "src-port":
      case "dst-port": {
        if (value !== "" && checkPorts(value) === null) return invalid(key);
        if (key === "src-port") rule.srcPort = value === "" ? undefined : value;
        else rule.dstPort = value;
        break;
      }
      case "connection-state": {
        if (value !== "" && checkStates(value) === null) return invalid(key);
        rule.connectionState = value === "" ? undefined : value;
        break;
      }
      case "in-interface":
      case "out-interface": {
        const { not, body } = splitNot(value);
        let id: L3InterfaceID | undefined;
        if (value !== "") {
          const found = context.l3Interface(body);
          if (found.kind === "failure") return found.message;
          id = found.id;
        }
        if (key === "in-interface") {
          rule.inInterface = id;
          rule.inInterfaceNot = id !== undefined && not ? true : undefined;
        } else {
          rule.outInterface = id;
          rule.outInterfaceNot = id !== undefined && not ? true : undefined;
        }
        break;
      }
      case "comment":
        rule.comment = value;
        break;
      case "disabled": {
        const flag = yesNo(value);
        if (flag === null) return invalid("disabled");
        rule.disabled = flag;
        break;
      }
      case "log":
      case "log-prefix":
        notes.push("NetSketch: logování se nesimuluje, volba je přijata a ignorována.");
        break;
    }
  }
  const protocol = splitNot(rule.protocol).body;
  const withPorts = protocol === "tcp" || protocol === "udp";
  if ((rule.dstPort !== "" || (rule.srcPort ?? "") !== "") && !withPorts) {
    return "failure: ports can be used only with protocol tcp or udp";
  }
  return null;
}

function cleaned(rule: FirewallRule): FirewallRule {
  const copy: FirewallRule = { ...rule };
  for (const key of ["srcPort", "connectionState", "inInterface", "outInterface", "inInterfaceNot", "outInterfaceNot"] as const) {
    if (copy[key] === undefined || copy[key] === "") delete copy[key];
  }
  return copy;
}

function add(context: RouterOSContext, args: RouterOSWord[]): string {
  const named = context.named(args, keys);
  if (named.kind === "failure") return named.message;
  if (!named.values.has("chain")) return "missing value(s) of argument(s) chain";
  const rule: FirewallRule = {
    chain: "forward",
    action: "accept",
    protocol: "",
    srcAddress: "",
    dstAddress: "",
    dstPort: "",
    disabled: false,
    comment: "",
  };
  const notes: string[] = [];
  const values = new Map(named.values);
  const before = values.get("place-before");
  values.delete("place-before");
  const error = apply(context, rule, values, notes);
  if (error !== null) return error;
  const rules = readRules(context);
  let position = rules.length;
  if (before !== undefined) {
    const list = context.itemNumbers([{ text: before, column: 1 }], rules.length);
    if (list.kind === "failure") return list.message;
    position = list.items[0];
  }
  writeRules(context, (current) => {
    const copy = [...current];
    copy.splice(position, 0, cleaned(rule));
    return copy;
  });
  return notes.join("\n");
}

function set(context: RouterOSContext, args: RouterOSWord[]): string {
  const named = context.named(args, ["numbers", ...keys], "numbers");
  if (named.kind === "failure") return named.message;
  const spec = named.values.get("numbers");
  if (spec === undefined) return "missing value(s) of argument(s) numbers";
  const rules = readRules(context);
  const selected = context.itemNumbers([{ text: spec, column: 1 }], rules.length);
  if (selected.kind === "failure") return selected.message;
  const values = new Map(named.values);
  values.delete("numbers");
  values.delete("place-before");
  const notes: string[] = [];
  const updated = rules.map((rule) => ({ ...rule }));
  for (const index of selected.items) {
    const error = apply(context, updated[index], values, notes);
    if (error !== null) return error;
    updated[index] = cleaned(updated[index]);
  }
  writeRules(context, () => updated);
  return [...new Set(notes)].join("\n");
}

function remove(context: RouterOSContext, args: RouterOSWord[]): string {
  const rules = readRules(context);
  const selected = context.itemNumbers(args, rules.length);
  if (selected.kind === "failure") return selected.message;
  const gone = new Set(selected.items);
  writeRules(context, (current) => current.filter((_, index) => !gone.has(index)));
  return "";
}

function setDisabled(context: RouterOSContext, args: RouterOSWord[], disabled: boolean): string {
  const rules = readRules(context);
  const selected = context.itemNumbers(args, rules.length);
  if (selected.kind === "failure") return selected.message;
  const chosen = new Set(selected.items);
  writeRules(context, (current) => current.map((rule, index) => (chosen.has(index) ? { ...rule, disabled } : rule)));
  return "";
}

function comment(context: RouterOSContext, args: RouterOSWord[]): string {
  const named = context.named(args, ["numbers", "comment"], "numbers");
  if (named.kind === "failure") return named.message;
  const spec = named.values.get("numbers");
  if (spec === undefined) return "missing value(s) of argument(s) numbers";
  const text = named.values.get("comment");
  if (text === undefined) return "missing value(s) of argument(s) comment";
  const rules = readRules(context);
  const selected = context.itemNumbers([{ text: spec, column: 1 }], rules.length);
  if (selected.kind === "failure") return selected.message;
  const chosen = new Set(selected.items);
  writeRules(context, (current) => current.map((rule, index) => (chosen.has(index) ? { ...rule, comment: text } : rule)));
  return "";
}

function print(context: RouterOSContext, args: RouterOSWord[]): string {
  const stray = args.find((word) => !printWords.includes(word.text.toLowerCase()));
  if (stray) return context.endOfCommand(stray);
  const name = (id: L3InterfaceID): string => context.interfaceName(id) ?? "unknown";
  const lines = ["Flags: X - disabled, I - invalid; D - dynamic"];
  readRules(context).forEach((rule, index) => {
    const head = leftPadded(`${index}`, 2) + " " + (rule.disabled ? "X" : " ") + "  ";
    const properties = ruleProperties(rule, name)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    if (rule.comment !== "") {
      lines.push(head + ";;; " + rule.comment);
      lines.push(" ".repeat(head.length) + properties);
    } else {
      lines.push(head + properties);
    }
  });
  return lines.map(trimmingTrailingWhitespace).join("\n");
}

function exportRows(context: RouterOSContext): string[] {
  const name = (id: L3InterfaceID): string => context.interfaceName(id) ?? "unknown";
  const plain = /^[A-Za-z0-9\-_./:@,!]+$/;
  return readRules(context).map((rule) => {
    const properties = ruleProperties(rule, name);
    if (rule.comment !== "") properties.push(["comment", rule.comment]);
    if (rule.disabled) properties.push(["disabled", "yes"]);
    properties.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return (
      "add " +
      properties.map(([key, value]) => `${key}=${plain.test(value) ? value : context.exportValue(value)}`).join(" ")
    );
  });
}

export const aclRouterOS: RouterOSFeature = () => [
  {
    path: ["ip", "firewall", "filter"],
    help: "Firewall filter rules",
    commands: [
      { name: "add", help: "Create a new item", run: add },
      { name: "print", help: "Print values of item properties", run: print },
      { name: "set", help: "Change item properties", run: set },
      { name: "remove", help: "Remove item", run: remove },
      { name: "enable", help: "Enable items", run: (context, args) => setDisabled(context, args, false) },
      { name: "disable", help: "Disable items", run: (context, args) => setDisabled(context, args, true) },
      { name: "comment", help: "Set comment for items", run: comment },
    ],
    export: exportRows,
  },
];
