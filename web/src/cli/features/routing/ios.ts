// routing: OSPF and RIP commands of the Cisco IOS console (see docs/protokoly/ospf-rip.md).
//
//   global      router ospf N / router rip (modes router-ospf, router-rip), no router ospf N / rip
//   router-ospf network A.B.C.D WILDCARD area X, router-id, passive-interface IF | default,
//               auto-cost reference-bandwidth, no ...
//   router-rip  version 1|2, network A.B.C.D, passive-interface IF | default, auto-summary, no ...
//   interface   ip ospf cost N, ip ospf N area X
//   show        ip route (O / R routes, in ios-network.ts), ip ospf neighbor, ip protocols
// The configuration is Device.protocols.ospf / .rip; the routes are computed in ./sim.ts.
//
// Rule for feature modules (features/ios-commands.ts): values from ../../ios-engine,
// ../../ios-network etc. are used only inside functions, never at module top level.

import {
  closedRange,
  custom,
  kw,
  line,
  num,
  splitWords,
  word,
  type CommandHandler,
  type CommandNode,
  type CustomArgument,
  type ParsedCommand,
} from "../../command-tree";
import type { IOSEngine } from "../../ios-engine";
import * as Network from "../../ios-network";
import { l3Port, l3VLAN } from "../../model-access";
import { Notices } from "../../notices";
import { IPv4 } from "../../sim/ipv4";
import type { L3InterfaceID } from "../../../core/model";
import type { OSPFConfig, RIPConfig } from "../../../core/protocols";
import type { IOSFeature } from "../ios-commands";
import { classfulPrefix, emptyOSPF, emptyRIP, parseArea, setPassive, updateOSPF, updateRIP } from "./model";
import { routingView } from "./sim";

const ospfMode = "router-ospf";
const ripMode = "router-rip";
const badAddress = "% Invalid input detected: bad IP address or mask.";

// MARK: Arguments

/** `IOSEngine.interfaceArgument`, spelled out (importing the engine class here would be circular). */
const interfaceArgument: CustomArgument = {
  name: "interface",
  match: (engine, input, index) => engine.matchInterface(input, index),
  helpEntries: (engine) => engine.interfaceTypeHelp(),
  continuationHelp: (engine, pending) => engine.interfaceNumberHelp(pending),
  completions: (engine) => engine.interfaceTypeHelp().map((entry) => entry.name),
};

function selectedInterface(command: ParsedCommand): L3InterfaceID | null {
  const target = command.interfaces("interface")?.target;
  if (target === undefined) return null;
  if (target.kind === "vlan") return l3VLAN(target.number);
  return target.kind === "ports" && target.ids.length === 1 ? l3Port(target.ids[0]) : null;
}

function notStored(name: string, help: string): CommandNode {
  const report: CommandHandler = (_engine, command) => {
    const first = splitWords(command.text("rest") ?? "")[0];
    return Notices.notStored((first === undefined ? [name] : [name, first]).join(" "));
  };
  return kw(name, help, [line("rest", help, report)], report);
}

// MARK: Entering and leaving the modes

function currentOSPF(engine: IOSEngine): OSPFConfig | undefined {
  return engine.access.protocols.ospf;
}

function currentRIP(engine: IOSEngine): RIPConfig | undefined {
  return engine.access.protocols.rip;
}

function enterOSPF(engine: IOSEngine, command: ParsedCommand): string {
  const process = command.int("process") ?? 1;
  const existing = currentOSPF(engine);
  if (existing && existing.process !== process) {
    return `NetSketch: simulace podporuje jediný proces OSPF na zařízení (už běží router ospf ${existing.process}).`;
  }
  if (!existing) {
    engine.access.updateProtocols((protocols) => {
      protocols.ospf = emptyOSPF(process);
    });
  }
  engine.mode = { kind: "feature", name: ospfMode, prompt: "config-router", context: { protocol: "ospf" } };
  return "";
}

function enterRIP(engine: IOSEngine): string {
  if (!currentRIP(engine)) {
    engine.access.updateProtocols((protocols) => {
      protocols.rip = emptyRIP();
    });
  }
  engine.mode = { kind: "feature", name: ripMode, prompt: "config-router", context: { protocol: "rip" } };
  return "";
}

function removeOSPF(engine: IOSEngine, command: ParsedCommand): string {
  const process = command.int("process") ?? 1;
  const existing = currentOSPF(engine);
  if (!existing || existing.process !== process) return "";
  engine.access.updateProtocols((protocols) => {
    protocols.ospf = undefined;
  });
  return "";
}

function removeRIP(engine: IOSEngine): string {
  engine.access.updateProtocols((protocols) => {
    protocols.rip = undefined;
  });
  return "";
}

/** Runs `change` on the OSPF configuration of the current mode; leaves the mode when it is gone (undo). */
function inOSPF(change: (config: OSPFConfig, engine: IOSEngine, command: ParsedCommand) => string): CommandHandler {
  return (engine, command) => {
    if (!currentOSPF(engine)) {
      engine.mode = { kind: "globalConfig" };
      return "";
    }
    let message = "";
    updateOSPF(engine.access, (config) => {
      message = change(config, engine, command);
    });
    return message;
  };
}

function inRIP(change: (config: RIPConfig, engine: IOSEngine, command: ParsedCommand) => string): CommandHandler {
  return (engine, command) => {
    if (!currentRIP(engine)) {
      engine.mode = { kind: "globalConfig" };
      return "";
    }
    let message = "";
    updateRIP(engine.access, (config) => {
      message = change(config, engine, command);
    });
    return message;
  };
}

// MARK: router ospf

const networkOSPF = (negated: boolean): CommandHandler =>
  inOSPF((config, _engine, command) => {
    const address = IPv4.parse(command.text("address") ?? "");
    const wildcard = IPv4.parse(command.text("wildcard") ?? "");
    const area = parseArea(command.text("area") ?? "");
    if (address === null || wildcard === null || area === null) return badAddress;
    if (!isInverseMask(wildcard.value)) return "% Invalid input detected: wildcard mask must be contiguous.";
    const same = (entry: { address: string; wildcard: string; area: number }): boolean =>
      entry.address === address.description && entry.wildcard === wildcard.description && entry.area === area;
    if (negated) {
      config.networks = config.networks.filter((entry) => !same(entry));
    } else if (!config.networks.some(same)) {
      config.networks.push({ address: address.description, wildcard: wildcard.description, area });
    }
    return "";
  });

function countOnes(value: number): number {
  let ones = 0;
  for (let v = value >>> 0; v !== 0; v >>>= 1) ones += v & 1;
  return ones;
}

/** 0.0.0.255, 0.0.15.255 ...: zeros followed by ones. */
function isInverseMask(value: number): boolean {
  return IPv4.mask(32 - countOnes(value)).value === (~value >>> 0);
}

const routerID = (negated: boolean): CommandHandler =>
  inOSPF((config, _engine, command) => {
    if (negated) {
      config.routerID = "";
      return "";
    }
    const parsed = IPv4.parse(command.text("id") ?? "");
    if (parsed === null) return badAddress;
    config.routerID = parsed.description;
    return "";
  });

function ospfPassive(negated: boolean, all: boolean): CommandHandler {
  return inOSPF((config, _engine, command) => {
    if (all) {
      config.passiveDefault = !negated;
      config.passive = [];
      return "";
    }
    const id = selectedInterface(command);
    if (id === null) return "% Invalid interface.";
    setPassive(config, id, !negated);
    return "";
  });
}

const referenceBandwidth = (negated: boolean): CommandHandler =>
  inOSPF((config, _engine, command) => {
    config.referenceBandwidth = negated ? 100 : (command.int("mbps") ?? 100);
    return "";
  });

function ospfCommands(): CommandNode[] {
  const passive = (negated: boolean): CommandNode =>
    kw(
      "passive-interface",
      "Suppress routing updates on an interface",
      [kw("default", "Suppress routing updates on all interfaces", [], ospfPassive(negated, true)), custom(interfaceArgument, ospfPassive(negated, false))],
    );
  const network = (negated: boolean): CommandNode =>
    kw("network", "Enable routing on an IP network", [
      word("address", "Network number", undefined, "A.B.C.D", [
        word("wildcard", "OSPF wild card bits", undefined, "A.B.C.D", [
          kw("area", "Set the OSPF area ID", [word("area", "OSPF area ID as a decimal value or in IP address format", networkOSPF(negated), "<0-4294967295>")]),
        ]),
      ]),
    ]);
  const reference = (negated: boolean): CommandNode =>
    kw("auto-cost", "Calculate OSPF interface cost according to bandwidth", [
      kw("reference-bandwidth", "Use reference bandwidth method to assign OSPF cost", [
        num("mbps", closedRange(1, 4294967), "Rate in Mbits per second", [], referenceBandwidth(negated)),
      ]),
    ]);
  return [
    network(false),
    kw("router-id", "router-id for this OSPF process", [word("id", "OSPF router-id in IP address format", routerID(false), "A.B.C.D")]),
    passive(false),
    reference(false),
    kw("no", "Negate a command or set its defaults", [
      network(true),
      kw("router-id", "router-id for this OSPF process", [], routerID(true)),
      passive(true),
      reference(true),
    ]),
    notStored("log-adjacency-changes", "Log changes in adjacency state"),
    notStored("redistribute", "Redistribute information from another routing protocol"),
    notStored("default-information", "Control distribution of default information"),
    notStored("area", "OSPF area parameters"),
  ];
}

// MARK: router rip

const ripVersion: CommandHandler = inRIP((config, _engine, command) => {
  config.version = command.int("version") === 2 ? 2 : 1;
  return "";
});

const networkRIP = (negated: boolean): CommandHandler =>
  inRIP((config, _engine, command) => {
    const parsed = IPv4.parse(command.text("address") ?? "");
    if (parsed === null) return badAddress;
    // RIP `network` is classful: 10.1.2.0 means 10.0.0.0.
    const classful = classfulPrefix(parsed).network.description;
    config.networks = config.networks.filter((entry) => entry !== classful);
    if (!negated) config.networks.push(classful);
    return "";
  });

function ripPassive(negated: boolean, all: boolean): CommandHandler {
  return inRIP((config, _engine, command) => {
    if (all) {
      config.passiveDefault = !negated;
      config.passive = [];
      return "";
    }
    const id = selectedInterface(command);
    if (id === null) return "% Invalid interface.";
    setPassive(config, id, !negated);
    return "";
  });
}

const autoSummary = (value: boolean): CommandHandler =>
  inRIP((config) => {
    config.autoSummary = value;
    return "";
  });

function ripCommands(): CommandNode[] {
  const passive = (negated: boolean): CommandNode =>
    kw(
      "passive-interface",
      "Suppress routing updates on an interface",
      [kw("default", "Suppress routing updates on all interfaces", [], ripPassive(negated, true)), custom(interfaceArgument, ripPassive(negated, false))],
    );
  const network = (negated: boolean): CommandNode =>
    kw("network", "Enable routing on an IP network", [word("address", "Network number", networkRIP(negated), "A.B.C.D")]);
  return [
    kw("version", "Set routing protocol version", [num("version", closedRange(1, 2), "Version", [], ripVersion)]),
    network(false),
    passive(false),
    kw("auto-summary", "Enable automatic network number summarization", [], autoSummary(true)),
    kw("no", "Negate a command or set its defaults", [
      network(true),
      passive(true),
      kw("auto-summary", "Enable automatic network number summarization", [], autoSummary(false)),
      kw("version", "Set routing protocol version", [], inRIP((config) => {
        config.version = 1;
        return "";
      })),
    ]),
    notStored("redistribute", "Redistribute information from another routing protocol"),
    notStored("default-information", "Control distribution of default information"),
    notStored("timers", "Adjust routing timers"),
  ];
}

// MARK: Interface commands

function ospfInterface(negated: boolean): CommandNode {
  const costRun: CommandHandler = (engine, command) => {
    const result = Network.currentL3Interface(engine);
    if (result.kind === "failure") return result.message;
    if (!currentOSPF(engine)) return "NetSketch: nejdřív zapněte proces OSPF příkazem router ospf.";
    const id = result.interface;
    updateOSPF(engine.access, (config) => {
      config.costs = config.costs.filter((entry) => entry.interface !== id);
      if (!negated) config.costs.push({ interface: id, cost: command.int("cost") ?? 1 });
    });
    return "";
  };
  const areaRun: CommandHandler = (engine, command) => {
    const result = Network.currentL3Interface(engine);
    if (result.kind === "failure") return result.message;
    const existing = currentOSPF(engine);
    if (!existing) return "NetSketch: nejdřív zapněte proces OSPF příkazem router ospf.";
    if (existing.process !== command.int("process")) return `NetSketch: běží jen router ospf ${existing.process}.`;
    const area = parseArea(command.text("area") ?? "");
    if (area === null) return badAddress;
    const id = result.interface;
    updateOSPF(engine.access, (config) => {
      config.interfaceAreas = config.interfaceAreas.filter((entry) => entry.interface !== id);
      if (!negated) config.interfaceAreas.push({ interface: id, area });
    });
    return "";
  };
  const areaNode = (): CommandNode =>
    num("process", closedRange(1, 65535), "Process ID", [
      kw("area", "Set the OSPF area ID", [word("area", "OSPF area ID", areaRun, "<0-4294967295>")]),
    ]);
  return kw("ospf", "OSPF interface commands", [
    kw("cost", "Interface cost", negated ? [] : [num("cost", closedRange(1, 65535), "Cost", [], costRun)], negated ? costRun : null),
    areaNode(),
  ]);
}

// MARK: show

function pad(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text.padEnd(width);
}

function showOSPFNeighbor(engine: IOSEngine): string {
  const router = routingView(engine.access.simulator).ospf.get(engine.access.deviceID);
  if (!router || router.neighbors.length === 0) return "";
  const lines = ["Neighbor ID     Pri   State           Dead Time   Address         Interface"];
  for (const neighbor of router.neighbors) {
    lines.push(
      `${pad(neighbor.routerID, 16)}${"1".padStart(3)}   ${pad(neighbor.state, 16)}00:00:33    ` +
        `${pad(neighbor.address.description, 16)}${Network.l3Name(engine, neighbor.iface.id)}`,
    );
  }
  return lines.join("\n");
}

function showProtocols(engine: IOSEngine): string {
  const view = routingView(engine.access.simulator);
  const id = engine.access.deviceID;
  const lines: string[] = [];
  const filters = [
    "  Outgoing update filter list for all interfaces is not set",
    "  Incoming update filter list for all interfaces is not set",
  ];
  const ospf = view.ospf.get(id);
  if (ospf) {
    const config = ospf.config;
    const areas = new Set(ospf.interfaces.map((entry) => entry.area));
    lines.push(`Routing Protocol is "ospf ${config.process}"`, ...filters);
    lines.push(`  Router ID ${ospf.routerID}`);
    lines.push(`  Number of areas in this router is ${areas.size}. ${areas.size} normal 0 stub 0 nssa`);
    lines.push("  Maximum path: 4", "  Routing for Networks:");
    for (const network of config.networks) lines.push(`    ${network.address} ${network.wildcard} area ${network.area}`);
    for (const entry of config.interfaceAreas) lines.push(`    ${Network.l3Name(engine, entry.interface)} area ${entry.area}`);
    lines.push("  Passive Interface(s):");
    for (const entry of ospf.interfaces) if (entry.passive) lines.push(`    ${Network.l3Name(engine, entry.iface.id)}`);
    lines.push("  Routing Information Sources:", "    Gateway         Distance      Last Update");
    for (const source of ospf.sources) {
      lines.push(`    ${pad(source, 16)}${"110".padStart(8)}      00:00:05`);
    }
    lines.push("  Distance: (default is 110)");
  }
  const rip = view.rip.get(id);
  if (rip) {
    const config = rip.config;
    if (lines.length > 0) lines.push("");
    lines.push('Routing Protocol is "rip"', ...filters);
    lines.push("  Sending updates every 30 seconds, next due in 0 seconds");
    lines.push("  Invalid after 180 seconds, hold down 180, flushed after 240");
    lines.push("  Redistributing: rip");
    lines.push(`  Default version control: send version ${config.version}, receive ${config.version === 1 ? "any version" : "version 2"}`);
    lines.push("    Interface             Send  Recv  Triggered RIP  Key-chain");
    for (const entry of rip.interfaces) {
      if (entry.passive) continue;
      lines.push(`    ${pad(Network.l3Name(engine, entry.iface.id), 22)}${config.version}     ${config.version === 1 ? "1 2" : "2"}`);
    }
    lines.push(config.autoSummary || config.version === 1 ? "  Automatic network summarization is in effect" : "  Automatic network summarization is not in effect");
    lines.push("  Maximum path: 4", "  Routing for Networks:");
    for (const network of config.networks) lines.push(`    ${network}`);
    lines.push("  Passive Interface(s):");
    for (const entry of rip.interfaces) if (entry.passive) lines.push(`    ${Network.l3Name(engine, entry.iface.id)}`);
    lines.push("  Routing Information Sources:", "    Gateway         Distance      Last Update");
    for (const source of rip.sources) lines.push(`    ${pad(source.address.description, 16)}${"120".padStart(8)}      00:00:10`);
    lines.push("  Distance: (default is 120)");
  }
  return lines.join("\n");
}

// MARK: running-config

function interfaceLines(engine: IOSEngine, id: L3InterfaceID): string[] {
  const config = engine.access.protocols.ospf;
  if (!config) return [];
  const lines: string[] = [];
  const cost = config.costs.find((entry) => entry.interface === id);
  if (cost) lines.push(` ip ospf cost ${cost.cost}`);
  const area = config.interfaceAreas.find((entry) => entry.interface === id);
  if (area) lines.push(` ip ospf ${config.process} area ${area.area}`);
  return lines;
}

function globalBlocks(engine: IOSEngine): string[][] {
  const blocks: string[][] = [];
  const name = (id: L3InterfaceID): string => Network.l3Name(engine, id);
  const ospf = engine.access.protocols.ospf;
  if (ospf) {
    const lines = [`router ospf ${ospf.process}`];
    if (ospf.routerID !== "") lines.push(` router-id ${ospf.routerID}`);
    if (ospf.referenceBandwidth !== 100) lines.push(` auto-cost reference-bandwidth ${ospf.referenceBandwidth}`);
    if (ospf.passiveDefault) lines.push(" passive-interface default");
    for (const id of ospf.passive) lines.push(` ${ospf.passiveDefault ? "no " : ""}passive-interface ${name(id)}`);
    for (const network of ospf.networks) lines.push(` network ${network.address} ${network.wildcard} area ${network.area}`);
    blocks.push(lines);
  }
  const rip = engine.access.protocols.rip;
  if (rip) {
    const lines = ["router rip"];
    lines.push(` version ${rip.version}`);
    if (rip.passiveDefault) lines.push(" passive-interface default");
    for (const id of rip.passive) lines.push(` ${rip.passiveDefault ? "no " : ""}passive-interface ${name(id)}`);
    for (const network of rip.networks) lines.push(` network ${network}`);
    if (!rip.autoSummary) lines.push(" no auto-summary");
    blocks.push(lines);
  }
  return blocks;
}

// MARK: The feature

export const routingIOS: IOSFeature = (dialect) => {
  if (dialect !== "ios") return {};
  const processNode = (run: CommandHandler): CommandNode =>
    num("process", closedRange(1, 65535), "Process ID", [], run);
  return {
    global: [
      kw("router", "Enable a routing process", [
        kw("ospf", "Open Shortest Path First (OSPF)", [processNode(enterOSPF)]),
        kw("rip", "Routing Information Protocol (RIP)", [], enterRIP),
      ]),
    ],
    globalNo: [
      kw("router", "Enable a routing process", [
        kw("ospf", "Open Shortest Path First (OSPF)", [processNode(removeOSPF)]),
        kw("rip", "Routing Information Protocol (RIP)", [], removeRIP),
      ]),
    ],
    interfaceIP: [ospfInterface(false)],
    interfaceNoIP: [ospfInterface(true)],
    showIP: [
      kw("ospf", "OSPF information", [kw("neighbor", "Neighbor list", [], (engine) => showOSPFNeighbor(engine))]),
      kw("protocols", "IP routing protocol process parameters and statistics", [], (engine) => showProtocols(engine)),
    ],
    modes: { [ospfMode]: ospfCommands(), [ripMode]: ripCommands() },
    config: { interfaceLines, globalBlocks },
  };
};
