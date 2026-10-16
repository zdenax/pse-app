// macarp: MAC address table and ARP table on the Cisco IOS-style consoles (ios, generic).
//
//   show:       show mac address-table [dynamic] [vlan N | interface IF]   (also mac-address-table)
//               show arp, show ip arp [A.B.C.D | vlan N]
//   privileged: clear mac address-table dynamic [vlan N | interface IF]    (also mac-address-table)
//               clear arp-cache, clear ip arp
//
// The tables are run-time state filled by traffic (model.ts, which also documents the model);
// nothing is stored in the project. Dell OS9 has its own syntax and keeps the notice.
//
// Rule for feature modules (features/ios-commands.ts): values from ../../ios-engine,
// ../../ios-network etc. are used only inside functions, never at module top level.

import {
  closedRange,
  custom,
  kw,
  leftPadded,
  num,
  padded,
  trimmingTrailingWhitespace,
  word,
  type CommandHandler,
  type CommandNode,
  type CustomArgument,
  type ParsedCommand,
} from "../../command-tree";
import type { IOSEngine } from "../../ios-engine";
import { l3Name } from "../../ios-network";
import { IPv4 } from "../../sim/ipv4";
import type { IOSFeature, IOSFeatureCommands } from "../ios-commands";
import { arpTable, clearArpCache, clearMacTable, isSwitch, macTable, type MACRow } from "./model";

const notSwitch = "NetSketch: toto zařízení není přepínač, nemá tabulku MAC adres.";

const macNote =
  "NetSketch: tabulka se plní provozem (ping, traceroute); nestárne a po obnovení stránky se vyprázdní. " +
  "Statické záznamy (CPU) se nezobrazují.";

const arpNote =
  "NetSketch: tabulka se plní provozem (ping, traceroute) a sousedy na druhém konci kabelu; " +
  "záznamy nestárnou (Age je vždy 0) a po obnovení stránky se vyprázdní.";

function joined(lines: string[]): string {
  return lines.map(trimmingTrailingWhitespace).join("\n");
}

/**
 * The interface argument of `IOSEngine.interfaceArgument`, spelled out here: importing the engine
 * class would make this module part of a circular import it cannot be evaluated in safely.
 */
const interfaceArgument: CustomArgument = {
  name: "interface",
  match: (engine, input, index) => engine.matchInterface(input, index),
  helpEntries: (engine) => engine.interfaceTypeHelp(),
  continuationHelp: (engine, pending) => engine.interfaceNumberHelp(pending),
  completions: (engine) => engine.interfaceTypeHelp().map((entry) => entry.name),
};

// MARK: MAC address table

interface MACFilter {
  vlan?: number;
  portIDs?: Set<string>;
}

/** The filter of `vlan N` / `interface IF`; a string is the error message. */
function macFilter(command: ParsedCommand): MACFilter | string {
  const filter: MACFilter = {};
  const vlan = command.int("vlan");
  if (vlan !== null) filter.vlan = vlan;
  const selection = command.interfaces("interface");
  if (selection) {
    if (selection.target.kind !== "ports") return "% Invalid interface.";
    filter.portIDs = new Set(selection.target.ids);
  }
  return filter;
}

function matches(row: MACRow, filter: MACFilter): boolean {
  return (
    (filter.vlan === undefined || row.vlan === filter.vlan) &&
    (filter.portIDs === undefined || filter.portIDs.has(row.port.id))
  );
}

function showMACTable(engine: IOSEngine, command: ParsedCommand): string {
  const filter = macFilter(command);
  if (typeof filter === "string") return filter;
  if (!isSwitch(engine.access.device)) return notSwitch;
  const rows = macTable(engine.access.simulator, engine.access.deviceID).filter((row) => matches(row, filter));
  const lines = [
    "          Mac Address Table",
    "-------------------------------------------",
    "",
    "Vlan    Mac Address       Type        Ports",
    "----    -----------       --------    -----",
  ];
  for (const row of rows) {
    lines.push(
      leftPadded(String(row.vlan), 4) +
        "    " +
        padded(row.mac, 18) +
        padded(row.type, 12) +
        engine.namer.shortName(row.port.name),
    );
  }
  lines.push(`Total Mac Addresses for this criterion: ${rows.length}`, macNote);
  return joined(lines);
}

function clearMACTable(engine: IOSEngine, command: ParsedCommand): string {
  const filter = macFilter(command);
  if (typeof filter === "string") return filter;
  if (!isSwitch(engine.access.device)) return notSwitch;
  clearMacTable(engine.access.deviceID, filter);
  return "";
}

/** `[vlan N | interface IF]`, the filters of show and clear. */
function macFilters(run: CommandHandler): CommandNode[] {
  return [
    kw("vlan", "VLAN keyword", [num("vlan", closedRange(1, 4094), "VLAN id", [], run)]),
    kw("interface", "interface keyword", [custom(interfaceArgument, run)]),
  ];
}

function macShowChildren(): CommandNode[] {
  return [
    kw("dynamic", "dynamic entries only", macFilters(showMACTable), showMACTable),
    ...macFilters(showMACTable),
  ];
}

function macClearChildren(): CommandNode[] {
  return [kw("dynamic", "Clear dynamic entries", macFilters(clearMACTable), clearMACTable)];
}

// MARK: ARP table

function showARPTable(engine: IOSEngine, command: ParsedCommand): string {
  const text = command.text("address");
  const only = text === null ? null : IPv4.parse(text);
  if (text !== null && only === null) return "% Invalid input detected.";
  const vlan = command.int("vlan");
  const rows = arpTable(engine.access.simulator, engine.access.deviceID).filter(
    (row) =>
      (only === null || row.address.equals(only)) && (vlan === null || row.interfaceID === `vlan:${vlan}`),
  );
  if (rows.length === 0 && (only !== null || vlan !== null)) return "";
  const lines = ["Protocol  Address          Age (min)  Hardware Addr   Type   Interface"];
  for (const row of rows) {
    lines.push(
      "Internet  " +
        padded(row.address.description, 17) +
        leftPadded(row.kind === "own" ? "-" : "0", 9) +
        "  " +
        padded(row.mac, 16) +
        "ARPA   " +
        l3Name(engine, row.interfaceID),
    );
  }
  lines.push(arpNote);
  return joined(lines);
}

const clearARP: CommandHandler = (engine) => {
  clearArpCache(engine.access.deviceID);
  return "";
};

function arpShowChildren(): CommandNode[] {
  return [
    kw("vlan", "VLAN keyword", [num("vlan", closedRange(1, 4094), "VLAN id", [], showARPTable)]),
    word("address", "IP address", showARPTable, "A.B.C.D"),
  ];
}

// MARK: The feature

export const macarpIOS: IOSFeature = (dialect): IOSFeatureCommands => {
  if (dialect !== "ios" && dialect !== "generic") return {};
  return {
    show: [
      kw("mac", "MAC configuration", [kw("address-table", "MAC forwarding table", macShowChildren(), showMACTable)]),
      kw("mac-address-table", "MAC forwarding table", macShowChildren(), showMACTable),
      kw("arp", "ARP table", arpShowChildren(), showARPTable),
    ],
    showIP: [kw("arp", "IP ARP table", arpShowChildren(), showARPTable)],
    privileged: [
      kw("clear", "Reset functions", [
        kw("mac", "MAC forwarding table", [kw("address-table", "MAC forwarding table", macClearChildren())]),
        kw("mac-address-table", "MAC forwarding table", macClearChildren()),
        kw("arp-cache", "Clear the entire ARP cache", [], clearARP),
        kw("ip", "IP", [kw("arp", "Clear the entire ARP cache", [], clearARP)]),
      ]),
    ],
  };
};
