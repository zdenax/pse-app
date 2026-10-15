// layer2: menus of the MikroTik RouterOS console.
//
//   /interface bridge         set [find] protocol-mode=none|stp|rstp|mstp priority=0x1000, print,
//                             monitor (state and root of the bridge)
//   /interface bridge port    set <port> edge=yes|no|auto path-cost=N priority=0x80, print (with role
//                             and status of the port in the spanning tree)
//
// The bridge of a switch is the one item "bridge"; a router has none. The priority is written
// as hexadecimal like RouterOS does (decimal is accepted).

import type { STPMode } from "../../../core/protocols";
import { leftPadded, padded, trimmingTrailingWhitespace } from "../../command-tree";
import { NetworkSimulator } from "../../sim/network-simulator";
import type { RouterOSContext, RouterOSFeature, RouterOSFeatureCommand, RouterOSFeatureMenu, RouterOSWord } from "../routeros-menus";
import { parseNumber, setCost, setMember, setPortPriority, setPriority, stpOf, updateSTP, validBridgePriority } from "./model";
import { computeSpanningTree, defaultBridgePriority, type STPBridgeInfo } from "./stp";

const missing = (key: string): string => `missing value(s) of argument(s) ${key}`;
const invalid = (key: string): string => `invalid value for argument ${key}`;
const noMatch = (key: string): string => `input does not match any value of ${key}`;

function command(name: string, help: string, run: RouterOSFeatureCommand["run"]): RouterOSFeatureCommand {
  return { name, help, run };
}

function table(flags: string, headers: [string, number][], rows: string[][]): string {
  const lines = [" #   " + headers.map(([title, width]) => padded(title, width)).join(" ")];
  if (flags !== "") lines.unshift(flags);
  rows.forEach((row, index) => {
    lines.push(
      leftPadded(`${index}`, 2) + " " + row[0] + " " + headers.map(([, width], column) => padded(row[column + 1] ?? "", width)).join(" "),
    );
  });
  return lines.map(trimmingTrailingWhitespace).join("\n");
}

function hex(value: number): string {
  return "0x" + value.toString(16);
}

/** "0001.4324.7b5d" as RouterOS writes a MAC. */
function colonMAC(mac: string): string {
  const digits = mac.replace(/[^0-9a-f]/gi, "").toUpperCase();
  return (digits.match(/.{2}/g) ?? []).join(":");
}

// MARK: What the bridge is

function isSwitch(context: RouterOSContext): boolean {
  const category = context.access.category;
  return category !== null && NetworkSimulator.isSwitching(category);
}

/** "rstp" for an unconfigured bridge (the RouterOS default) and for the Cisco-style names. */
function protocolMode(mode: STPMode | undefined): string {
  switch (mode) {
    case undefined:
    case "pvst":
    case "rapid-pvst":
    case "rstp":
      return "rstp";
    case "mst":
      return "mstp";
    default:
      return mode;
  }
}

function infoOf(context: RouterOSContext): STPBridgeInfo | undefined {
  return computeSpanningTree(context.access.store.project).get(context.access.deviceID);
}

const modes: Record<string, STPMode> = { none: "none", stp: "stp", rstp: "rstp", mstp: "mst" };

/** "bridge", "0" or "[find]": the indices of the chosen rows; `names` are the rows' names. */
function chosenItems(
  context: RouterOSContext,
  word: RouterOSWord | undefined,
  names: string[],
): { items: number[] } | { message: string } {
  if (word === undefined) return { message: missing("numbers") };
  const named = names.indexOf(word.text);
  if (named >= 0) return { items: [named] };
  const listed = word.text.split(",").map((part) => names.indexOf(part));
  if (word.text.includes(",") && listed.every((index) => index >= 0)) return { items: listed };
  const result = context.itemNumbers([word], names.length);
  return result.kind === "items" ? { items: result.items } : { message: result.message };
}

// MARK: /interface bridge

function bridgeNames(context: RouterOSContext): string[] {
  return isSwitch(context) ? ["bridge"] : [];
}

function bridgeMenu(): RouterOSFeatureMenu {
  return {
    path: ["interface", "bridge"],
    help: "Bridge interfaces",
    commands: [
      command("set", "Change item properties", (context, args) => {
        const chosen = chosenItems(context, args[0], bridgeNames(context));
        if ("message" in chosen) return chosen.message;
        const named = context.named(args.slice(1), ["protocol-mode", "priority", "name", "comment"]);
        if (named.kind === "failure") return named.message;
        const modeText = named.values.get("protocol-mode");
        const mode = modeText === undefined ? undefined : modes[modeText.toLowerCase()];
        if (modeText !== undefined && mode === undefined) return noMatch("protocol-mode");
        const priorityText = named.values.get("priority");
        const priority = priorityText === undefined ? undefined : parseNumber(priorityText);
        if (priorityText !== undefined && (priority === null || priority === undefined || !validBridgePriority(priority))) {
          return invalid("priority");
        }
        updateSTP(context.access, (config) => {
          if (mode !== undefined) config.mode = mode;
          if (priority !== undefined && priority !== null) setPriority(config, 0, priority);
        });
        return "";
      }),
      command("print", "Print values of item properties", (context, args) =>
        args.length > 0
          ? context.endOfCommand(args[0])
          : table(
              "Flags: X - disabled, R - running",
              [
                ["NAME", 12],
                ["PROTOCOL-MODE", 14],
                ["PRIORITY", 10],
              ],
              bridgeNames(context).map((name) => {
                const config = stpOf(context.access.device);
                return [
                  "R",
                  name,
                  protocolMode(config?.mode),
                  hex(config?.priorities.find((entry) => entry.vlan === 0)?.priority ?? defaultBridgePriority),
                ];
              }),
            ),
      ),
      command("monitor", "Monitor the state of the bridge", (context, args) => {
        const words = args.filter((word) => word.text !== "once");
        const chosen = chosenItems(context, words[0], bridgeNames(context));
        if ("message" in chosen) return chosen.message;
        const info = infoOf(context);
        const mode = protocolMode(stpOf(context.access.device)?.mode);
        const rows: [string, string][] = [["state", "enabled"]];
        if (info === undefined || mode === "none") {
          rows.push(["root-bridge", "no"]);
        } else {
          const live = info.ports.filter((port) => port.role !== "disabled");
          const rootPort = info.ports.find((port) => port.portID === info.rootPortID);
          const rootPortName = context.access.interface(rootPort?.portID ?? "")?.name ?? "none";
          const [priority, ...macParts] = info.rootBridgeID.split(".");
          rows.push(
            ["current-mac-address", colonMAC(info.mac)],
            ["root-bridge", info.isRoot ? "yes" : "no"],
            ["root-bridge-id", `${hex(Number(priority))}.${colonMAC(macParts.join("."))}`],
            ["root-path-cost", `${info.rootCost}`],
            ["root-port", info.isRoot ? "none" : rootPortName],
            ["port-count", `${info.ports.length}`],
            ["designated-port-count", `${live.filter((port) => port.role === "designated").length}`],
          );
        }
        return rows.map(([key, value]) => `${leftPadded(key, 22)}: ${value}`).join("\n");
      }),
    ],
    export: (context) => {
      const config = stpOf(context.access.device);
      if (!config || !isSwitch(context)) return [];
      const parts = [`protocol-mode=${protocolMode(config.mode)}`];
      const priority = config.priorities.find((entry) => entry.vlan === 0);
      if (priority) parts.push(`priority=${hex(priority.priority)}`);
      return [`set bridge ${parts.join(" ")}`];
    },
  };
}

// MARK: /interface bridge port

function portMenu(): RouterOSFeatureMenu {
  const portNames = (context: RouterOSContext): string[] =>
    isSwitch(context) ? context.access.interfaces.filter((port) => port.isSwitchport).map((port) => port.name) : [];
  const yesNoAuto = new Set(["yes", "no", "auto"]);
  return {
    path: ["interface", "bridge", "port"],
    help: "Bridge port settings",
    commands: [
      command("set", "Change item properties", (context, args) => {
        const names = portNames(context);
        const chosen = chosenItems(context, args[0], names);
        if ("message" in chosen) return chosen.message;
        const named = context.named(args.slice(1), ["edge", "path-cost", "priority", "comment"]);
        if (named.kind === "failure") return named.message;
        const edge = named.values.get("edge")?.toLowerCase();
        if (edge !== undefined && !yesNoAuto.has(edge)) return noMatch("edge");
        const costText = named.values.get("path-cost");
        const cost = costText === undefined ? undefined : parseNumber(costText);
        if (costText !== undefined && (cost === null || cost === undefined || cost < 1 || cost > 200000000)) return invalid("path-cost");
        const priorityText = named.values.get("priority");
        const priority = priorityText === undefined ? undefined : parseNumber(priorityText);
        if (priorityText !== undefined && (priority === null || priority === undefined || priority > 240 || priority % 16 !== 0)) {
          return invalid("priority");
        }
        const ports = context.access.interfaces.filter((port) => port.isSwitchport);
        const ids = chosen.items.map((index) => ports.find((port) => port.name === names[index])?.id ?? "");
        context.access.transaction(() => {
          updateSTP(context.access, (config) => {
            for (const id of ids) {
              if (edge !== undefined) config.portfast = setMember(config.portfast, id, edge === "yes");
              if (cost !== undefined && cost !== null) setCost(config, id, 0, cost);
              if (priority !== undefined && priority !== null) setPortPriority(config, id, 0, priority);
            }
          });
        });
        return "";
      }),
      command("print", "Print values of item properties", (context, args) => {
        if (args.length > 0) return context.endOfCommand(args[0]);
        const info = infoOf(context);
        const config = stpOf(context.access.device);
        const rows = context.access.interfaces
          .filter((port) => isSwitch(context) && port.isSwitchport)
          .map((port) => {
            const live = info?.ports.find((entry) => entry.portID === port.id);
            const cost = config?.costs.find((entry) => entry.port === port.id && entry.vlan === 0)?.cost ?? live?.cost;
            const priority = config?.portPriorities.find((entry) => entry.port === port.id && entry.vlan === 0)?.priority ?? live?.priority ?? 128;
            const status = live === undefined || live.role === "disabled" ? "disabled-port" : live.state === "blocking" ? "discarding" : "forwarding";
            return [
              " ",
              port.name,
              "bridge",
              config?.portfast.includes(port.id) ? "yes" : "auto",
              hex(priority),
              cost === undefined ? "auto" : `${cost}`,
              live === undefined || live.role === "disabled" ? "" : live.role === "root" ? "root-port" : live.role === "designated" ? "designated-port" : live.role === "alternate" ? "alternate-port" : "backup-port",
              status,
            ];
          });
        return table(
          "Flags: X - disabled, I - inactive, D - dynamic",
          [
            ["INTERFACE", 12],
            ["BRIDGE", 8],
            ["EDGE", 5],
            ["PRIORITY", 9],
            ["PATH-COST", 10],
            ["ROLE", 16],
            ["STATUS", 13],
          ],
          rows,
        );
      }),
    ],
    export: (context) => {
      const config = stpOf(context.access.device);
      if (!config || !isSwitch(context)) return [];
      const rows: string[] = [];
      for (const port of context.access.interfaces.filter((entry) => entry.isSwitchport)) {
        const parts: string[] = [];
        if (config.portfast.includes(port.id)) parts.push("edge=yes");
        const cost = config.costs.find((entry) => entry.port === port.id && entry.vlan === 0);
        if (cost) parts.push(`path-cost=${cost.cost}`);
        const priority = config.portPriorities.find((entry) => entry.port === port.id && entry.vlan === 0);
        if (priority) parts.push(`priority=${hex(priority.priority)}`);
        if (parts.length > 0) rows.push(`set [ find interface=${context.exportValue(port.name)} ] ${parts.join(" ")}`);
      }
      return rows;
    },
  };
}

export const layer2RouterOS: RouterOSFeature = () => [bridgeMenu(), portMenu()];
