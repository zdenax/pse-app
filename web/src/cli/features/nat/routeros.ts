// nat: the MikroTik RouterOS menu `/ip firewall nat` (add, print, remove, enable, disable and
// the rows of `/export`). The rules are Device.protocols.nat.rules of kind masquerade, srcnat
// and dstnat; the translations are made in ./sim.ts.
//
// Supported: chain=srcnat action=masquerade|src-nat, chain=dstnat action=dst-nat, with
// out-interface, in-interface, src-address, dst-address, to-addresses, protocol, dst-port,
// to-ports, comment and disabled. Other actions (redirect, netmap, ...) are refused with a note.

import type { NATConfig, NATRule } from "../../../core/protocols/nat";
import { isEmptyNATConfig } from "../../../core/protocols/nat";
import { IPv4, IPv4Prefix } from "../../sim/ipv4";
import type { RouterOSContext, RouterOSFeature, RouterOSFeatureCommand, RouterOSWord } from "../routeros-menus";

type OwnRule = Extract<NATRule, { kind: "masquerade" | "srcnat" | "dstnat" }>;

const addKeys = [
  "chain",
  "action",
  "out-interface",
  "in-interface",
  "src-address",
  "dst-address",
  "to-addresses",
  "protocol",
  "dst-port",
  "to-ports",
  "comment",
  "disabled",
];

const unsupportedActions = new Set([
  "accept",
  "passthrough",
  "log",
  "jump",
  "return",
  "netmap",
  "redirect",
  "same",
  "add-dst-to-address-list",
  "add-src-to-address-list",
  "endpoint-independent-nat",
]);

function isOwn(rule: NATRule): rule is OwnRule {
  return rule.kind === "masquerade" || rule.kind === "srcnat" || rule.kind === "dstnat";
}

/** The rules of this menu with their positions in `config.rules`, in the order `print` numbers them. */
function ownRules(config: NATConfig | undefined): { rule: OwnRule; index: number }[] {
  const result: { rule: OwnRule; index: number }[] = [];
  (config?.rules ?? []).forEach((rule, index) => {
    if (isOwn(rule)) result.push({ rule, index });
  });
  return result;
}

// MARK: Validation

function isAddressOrNetwork(text: string): boolean {
  return IPv4.parse(text) !== null || IPv4Prefix.fromCIDR(text) !== null;
}

/** "A.B.C.D" or "A.B.C.D-E.F.G.H". */
function isAddressRange(text: string): boolean {
  const parts = text.split("-");
  return (parts.length === 1 || parts.length === 2) && parts.every((part) => IPv4.parse(part) !== null);
}

/** "80", "80-90", "80,443,8000-8080". */
function isPortList(text: string): boolean {
  return text.split(",").every((part) => {
    const bounds = part.split("-");
    return (
      (bounds.length === 1 || bounds.length === 2) &&
      bounds.every((bound) => /^[0-9]{1,5}$/.test(bound) && Number(bound) >= 1 && Number(bound) <= 65535)
    );
  });
}

// MARK: add

function buildRule(context: RouterOSContext, values: Map<string, string>): OwnRule | string {
  const chain = values.get("chain");
  if (chain === undefined) return "missing value(s) of argument(s) chain";
  if (chain !== "srcnat" && chain !== "dstnat") return "invalid value for argument chain";
  const action = values.get("action");
  if (action === undefined) return "missing value(s) of argument(s) action";
  if (unsupportedActions.has(action)) {
    return `NetSketch: akce ${action} se v simulaci NAT nepodporuje (jen masquerade, src-nat a dst-nat), pravidlo nebylo přidáno.`;
  }
  const allowed = chain === "srcnat" ? ["masquerade", "src-nat"] : ["dst-nat"];
  if (!["masquerade", "src-nat", "dst-nat"].includes(action)) return "invalid value for argument action";
  if (!allowed.includes(action)) {
    return `NetSketch: akce ${action} patří do řetězce ${action === "dst-nat" ? "dstnat" : "srcnat"}, pravidlo nebylo přidáno.`;
  }

  const srcAddress = values.get("src-address") ?? "";
  if (srcAddress !== "" && !isAddressOrNetwork(srcAddress)) return "invalid value for argument src-address";
  const dstAddress = values.get("dst-address") ?? "";
  if (dstAddress !== "" && !isAddressOrNetwork(dstAddress)) return "invalid value for argument dst-address";
  const toAddress = values.get("to-addresses") ?? "";
  if (toAddress !== "" && !isAddressRange(toAddress)) return "invalid value for argument to-addresses";
  const protocol = values.get("protocol") ?? "";
  if (protocol !== "" && !["tcp", "udp", "icmp"].includes(protocol)) return "invalid value for argument protocol";
  const dstPort = values.get("dst-port") ?? "";
  if (dstPort !== "" && !isPortList(dstPort)) return "invalid value for argument dst-port";
  const toPort = values.get("to-ports") ?? "";
  if (toPort !== "" && !isPortList(toPort)) return "invalid value for argument to-ports";
  if ((dstPort !== "" || toPort !== "") && protocol !== "tcp" && protocol !== "udp") {
    return "failure: ports can be used only with protocol tcp or udp";
  }

  const options: { disabled?: boolean; comment?: string } = {};
  const disabled = values.get("disabled");
  if (disabled !== undefined) {
    if (!["yes", "no", "true", "false"].includes(disabled)) return "invalid value for argument disabled";
    if (disabled === "yes" || disabled === "true") options.disabled = true;
  }
  const comment = values.get("comment");
  if (comment !== undefined && comment !== "") options.comment = comment;

  const lookup = (name: string): { id: string } | string => {
    const found = context.l3Interface(name);
    return found.kind === "found" ? { id: found.id } : found.message;
  };

  if (chain === "srcnat") {
    if (values.has("in-interface") || dstAddress !== "" || protocol !== "") {
      return "NetSketch: v řetězci srcnat se in-interface, dst-address ani protocol v simulaci nepoužívají, pravidlo nebylo přidáno.";
    }
    let outInterface: string | undefined;
    const outName = values.get("out-interface");
    if (outName !== undefined) {
      const found = lookup(outName);
      if (typeof found === "string") return found;
      outInterface = found.id;
    }
    if (action === "masquerade") {
      const rule: OwnRule = { ...options, kind: "masquerade", srcAddress };
      if (outInterface !== undefined) rule.outInterface = outInterface;
      return rule;
    }
    if (toAddress === "") return "missing value(s) of argument(s) to-addresses";
    const rule: OwnRule = { ...options, kind: "srcnat", srcAddress, toAddress };
    if (outInterface !== undefined) rule.outInterface = outInterface;
    return rule;
  }

  if (values.has("out-interface") || srcAddress !== "") {
    return "NetSketch: v řetězci dstnat se out-interface ani src-address v simulaci nepoužívají, pravidlo nebylo přidáno.";
  }
  if (toAddress === "") return "missing value(s) of argument(s) to-addresses";
  const rule: OwnRule = { ...options, kind: "dstnat", dstAddress, toAddress };
  const inName = values.get("in-interface");
  if (inName !== undefined) {
    const found = lookup(inName);
    if (typeof found === "string") return found;
    rule.inInterface = found.id;
  }
  if (protocol !== "") rule.protocol = protocol;
  if (dstPort !== "") rule.dstPort = dstPort;
  if (toPort !== "") rule.toPort = toPort;
  return rule;
}

function add(context: RouterOSContext, args: RouterOSWord[]): string {
  const named = context.named(args, addKeys);
  if (named.kind === "failure") return named.message;
  const rule = buildRule(context, named.values);
  if (typeof rule === "string") return rule;
  context.access.updateProtocols((protocols) => {
    const config = protocols.nat ?? { inside: [], outside: [], pools: [], rules: [] };
    config.rules.push(rule);
    protocols.nat = config;
  });
  return "";
}

// MARK: print and export

/** The `key=value` pairs of a rule in the order RouterOS prints them. */
function properties(context: RouterOSContext, rule: OwnRule): [string, string][] {
  const name = (id: string | undefined): string | null => (id === undefined ? null : (context.interfaceName(id) ?? "unknown"));
  const pairs: [string, string | null | undefined][] = [];
  switch (rule.kind) {
    case "masquerade":
      pairs.push(["chain", "srcnat"], ["action", "masquerade"], ["src-address", rule.srcAddress], ["out-interface", name(rule.outInterface)]);
      break;
    case "srcnat":
      pairs.push(
        ["chain", "srcnat"],
        ["action", "src-nat"],
        ["to-addresses", rule.toAddress],
        ["src-address", rule.srcAddress],
        ["out-interface", name(rule.outInterface)],
      );
      break;
    case "dstnat":
      pairs.push(
        ["chain", "dstnat"],
        ["action", "dst-nat"],
        ["to-addresses", rule.toAddress],
        ["to-ports", rule.toPort],
        ["protocol", rule.protocol],
        ["dst-address", rule.dstAddress],
        ["in-interface", name(rule.inInterface)],
        ["dst-port", rule.dstPort],
      );
      break;
  }
  return pairs.filter((pair): pair is [string, string] => pair[1] !== null && pair[1] !== undefined && pair[1] !== "");
}

/** A value as `print` and `/export` write it; port lists keep their commas. */
function shown(context: RouterOSContext, value: string): string {
  return /^[A-Za-z0-9\-_./:@,]+$/.test(value) ? value : context.exportValue(value);
}

function isInvalid(context: RouterOSContext, rule: OwnRule): boolean {
  const id = rule.kind === "dstnat" ? rule.inInterface : rule.outInterface;
  return id !== undefined && context.interfaceName(id) === null;
}

function print(context: RouterOSContext, args: RouterOSWord[]): string {
  if (args.length > 0) return context.endOfCommand(args[0]);
  const lines = ["Flags: X - disabled, I - invalid; D - dynamic"];
  ownRules(context.access.protocols.nat).forEach(({ rule }, position) => {
    const flag = rule.disabled === true ? "X" : isInvalid(context, rule) ? "I" : " ";
    if (rule.comment !== undefined) lines.push(`;;; ${rule.comment.replace(/\n/g, " ")}`);
    const text = properties(context, rule)
      .map(([key, value]) => `${key}=${shown(context, value)}`)
      .join(" ");
    lines.push(`${String(position).padStart(2)} ${flag}  ${text} log=no log-prefix=""`);
    lines.push("");
  });
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

function exportRows(context: RouterOSContext): string[] {
  return ownRules(context.access.protocols.nat).map(({ rule }) => {
    const pairs = properties(context, rule);
    if (rule.comment !== undefined) pairs.push(["comment", rule.comment]);
    if (rule.disabled === true) pairs.push(["disabled", "yes"]);
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return "add " + pairs.map(([key, value]) => `${key}=${shown(context, value)}`).join(" ");
  });
}

// MARK: remove, enable, disable

function changeItems(
  context: RouterOSContext,
  args: RouterOSWord[],
  change: (config: NATConfig, indexes: number[]) => void,
): string {
  const own = ownRules(context.access.protocols.nat);
  const selected = context.itemNumbers(args, own.length);
  if (selected.kind === "failure") return selected.message;
  const indexes = selected.items.map((item) => own[item].index);
  context.access.updateProtocols((protocols) => {
    if (!protocols.nat) return;
    change(protocols.nat, indexes);
    if (isEmptyNATConfig(protocols.nat)) protocols.nat = undefined;
  });
  return "";
}

function remove(context: RouterOSContext, args: RouterOSWord[]): string {
  return changeItems(context, args, (config, indexes) => {
    config.rules = config.rules.filter((_, index) => !indexes.includes(index));
  });
}

function setDisabled(disabled: boolean): (context: RouterOSContext, args: RouterOSWord[]) => string {
  return (context, args) =>
    changeItems(context, args, (config, indexes) => {
      for (const index of indexes) {
        const rule = config.rules[index];
        if (disabled) rule.disabled = true;
        else delete rule.disabled;
      }
    });
}

const commands: RouterOSFeatureCommand[] = [
  { name: "add", help: "Create a new item", run: add },
  { name: "print", help: "Print values of item properties", run: print },
  { name: "remove", help: "Remove item", run: remove },
  { name: "enable", help: "Enable items", run: setDisabled(false) },
  { name: "disable", help: "Disable items", run: setDisabled(true) },
];

export const natRouterOS: RouterOSFeature = () => [
  {
    path: ["ip", "firewall", "nat"],
    help: "NAT rules (masquerade, src-nat, dst-nat)",
    commands,
    export: exportRows,
  },
];
