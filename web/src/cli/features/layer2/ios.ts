// layer2: spanning tree commands of the IOS-style consoles (Cisco IOS, generic; Dell OS9).
//
//   Cisco  global:     spanning-tree mode pvst|rapid-pvst|mst, spanning-tree vlan LIST priority N,
//                      spanning-tree vlan LIST root primary|secondary, spanning-tree mst 0 priority N,
//                      no spanning-tree vlan LIST (switches the tree off for the VLANs)
//          interface:  spanning-tree portfast, bpduguard enable, cost N, port-priority N,
//                      spanning-tree vlan LIST cost N | port-priority N
//          show:       show spanning-tree [vlan LIST | mst [0] | summary | interface IF]
//   Dell   global:     protocol spanning-tree rstp|mstp|pvst (mode spanning-tree: no disable,
//                      bridge-priority N)
//          interface:  spanning-tree rstp|mstp|pvst edge-port [bpduguard] | cost N | priority N,
//                      spanning-tree portfast
//          show:       show spanning-tree rstp|mstp|pvst [brief], show spanning-tree 0
//
// The configuration is Device.protocols.stp (core/protocols/layer2.ts); what it makes of the
// network is computed in stp.ts. Link aggregation (channel-group) is not handled here.
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
  vlanList,
  VLANListParser,
  type CommandHandler,
  type CommandNode,
  type CustomArgument,
  type ParsedCommand,
} from "../../command-tree";
import type { IOSEngine } from "../../ios-engine";
import { parseL3Interface } from "../../model-access";
import { Notices } from "../../notices";
import type { STPConfig, STPMode } from "../../../core/protocols";
import type { IOSFeature, IOSFeatureCommands } from "../ios-commands";
import {
  clearPriority,
  setCost,
  setMember,
  setPortPriority,
  setPriority,
  stpOf,
  updateSTP,
  validBridgePriority,
} from "./model";
import { showDellSpanningTree, showInterface, showMST, showSpanningTree, showSummary } from "./show";

// MARK: Messages

const priorityIncrements = [
  "% Bridge Priority must be in increments of 4096.",
  "% Allowed values are:",
  "  0     4096  8192  12288 16384 20480 24576 28672",
  "  32768 36864 40960 45056 49152 53248 57344 61440",
].join("\n");

function badPriority(engine: IOSEngine): string {
  return engine.isDell ? "% Error: Bridge priority must be in increments of 4096." : priorityIncrements;
}

function badPortPriority(engine: IOSEngine): string {
  return engine.isDell
    ? "% Error: Port priority must be a multiple of 16."
    : "% Port-priority must be a multiple of 16 (0-240).";
}

const portfastWarning = [
  "%Warning: portfast should only be enabled on ports connected to a single",
  " host. Connecting hubs, concentrators, switches, bridges, etc... to this",
  " interface  when portfast is enabled, can cause temporary bridging loops.",
  " Use with CAUTION",
].join("\n");

/** A command the spanning tree has but the diagram has no field for: accepted, nothing stored. */
function notStored(prefix: string): CommandNode {
  return line("rest", "Other spanning tree subcommands (accepted, not stored)", (_engine, command) =>
    Notices.notStored(`${prefix} ${splitWords(command.text("rest") ?? "")[0] ?? ""}`.trim()),
  );
}

// MARK: Cisco: global commands

function setMode(mode: STPMode): CommandHandler {
  return (engine) => {
    updateSTP(engine.access, (config) => {
      config.mode = mode;
    });
    return "";
  };
}

const setVLANPriority: CommandHandler = (engine, command) => {
  const priority = command.int("priority") ?? 0;
  if (!validBridgePriority(priority)) return badPriority(engine);
  const vlans = command.intList("vlans") ?? [];
  updateSTP(engine.access, (config) => {
    for (const vlan of vlans) setPriority(config, vlan, priority);
  });
  return "";
};

function rootHandler(priority: number): CommandHandler {
  return (engine, command) => {
    const vlans = command.intList("vlans") ?? [];
    updateSTP(engine.access, (config) => {
      for (const vlan of vlans) setPriority(config, vlan, priority);
    });
    return "";
  };
}

const setMSTPriority: CommandHandler = (engine, command) => {
  if ((command.int("instance") ?? 0) !== 0) return Notices.notStored("spanning-tree mst " + command.int("instance"));
  const priority = command.int("priority") ?? 0;
  if (!validBridgePriority(priority)) return badPriority(engine);
  updateSTP(engine.access, (config) => {
    setPriority(config, 0, priority);
  });
  return "";
};

const rootMST: (priority: number) => CommandHandler = (priority) => (engine, command) => {
  if ((command.int("instance") ?? 0) !== 0) return Notices.notStored("spanning-tree mst " + command.int("instance"));
  updateSTP(engine.access, (config) => {
    setPriority(config, 0, priority);
  });
  return "";
};

/** `spanning-tree vlan LIST` switches the tree back on for the VLANs. */
const enableVLANs: CommandHandler = (engine, command) => {
  const vlans = command.intList("vlans") ?? [];
  updateSTP(engine.access, (config) => {
    config.disabledVLANs = config.disabledVLANs.filter((vlan) => !vlans.includes(vlan));
  });
  return "";
};

const disableVLANs: CommandHandler = (engine, command) => {
  const vlans = command.intList("vlans") ?? [];
  updateSTP(engine.access, (config) => {
    config.disabledVLANs = [...new Set([...config.disabledVLANs, ...vlans])].sort((a, b) => a - b);
  });
  return "";
};

const clearVLANPriority: CommandHandler = (engine, command) => {
  const vlans = command.intList("vlans") ?? [];
  updateSTP(engine.access, (config) => {
    for (const vlan of vlans) clearPriority(config, vlan);
  });
  return "";
};

const clearMSTPriority: CommandHandler = (engine) => {
  updateSTP(engine.access, (config) => {
    clearPriority(config, 0);
  });
  return "";
};

function priorityNode(handler: CommandHandler): CommandNode {
  return kw("priority", "Set the bridge priority for the spanning tree", [
    num("priority", closedRange(0, 61440), "Bridge priority in increments of 4096", [], handler),
  ]);
}

function ciscoGlobal(): CommandNode {
  return kw("spanning-tree", "Spanning Tree Subsystem", [
    kw("mode", "Spanning tree operating mode", [
      kw("pvst", "Per-Vlan spanning tree mode", [], setMode("pvst")),
      kw("rapid-pvst", "Per-Vlan rapid spanning tree mode", [], setMode("rapid-pvst")),
      kw("mst", "Multiple spanning tree mode", [], setMode("mst")),
    ]),
    kw("vlan", "VLAN Switch Spanning Tree", [
      vlanList("vlans", "vlan range, example: 1,3-5,7,9-11", enableVLANs, [
        priorityNode(setVLANPriority),
        kw("root", "Configure switch as root", [
          kw("primary", "Configure this switch as primary root for this spanning tree", [], rootHandler(24576)),
          kw("secondary", "Configure switch as secondary root", [], rootHandler(28672)),
        ]),
        notStored("spanning-tree vlan N"),
      ]),
    ]),
    kw("mst", "Multiple spanning tree configuration", [
      num("instance", closedRange(0, 4094), "MST instance range, example: 0,3,5-7", [
        priorityNode(setMSTPriority),
        kw("root", "Configure switch as root", [
          kw("primary", "Configure this switch as primary root for this spanning tree", [], rootMST(24576)),
          kw("secondary", "Configure switch as secondary root", [], rootMST(28672)),
        ]),
      ]),
      notStored("spanning-tree mst"),
    ]),
    notStored("spanning-tree"),
  ]);
}

function ciscoGlobalNo(): CommandNode {
  return kw("spanning-tree", "Spanning Tree Subsystem", [
    kw("mode", "Spanning tree operating mode", [], setMode("pvst")),
    kw("vlan", "VLAN Switch Spanning Tree", [
      vlanList("vlans", "vlan range, example: 1,3-5,7,9-11", disableVLANs, [
        kw("priority", "Set the bridge priority for the spanning tree", [], clearVLANPriority),
        notStored("no spanning-tree vlan N"),
      ]),
    ]),
    kw("mst", "Multiple spanning tree configuration", [
      num("instance", closedRange(0, 4094), "MST instance range, example: 0,3,5-7", [
        kw("priority", "Set the bridge priority for the spanning tree", [], clearMSTPriority),
      ]),
    ]),
    notStored("no spanning-tree"),
  ]);
}

// MARK: Interface commands

/**
 * Applies a change to the spanning tree configuration for every selected port (one undo step).
 * A selection that is not made of physical ports (VLAN interface, port-channel) has no such
 * setting in the diagram.
 */
function onSelectedPorts(
  engine: IOSEngine,
  command: string,
  change: (config: STPConfig, ports: string[]) => void,
): string {
  const mode = engine.mode;
  if (mode.kind === "interface" && mode.selection.target.kind !== "ports") return Notices.notStored(command);
  const ports = engine.selectedPorts();
  if (ports.length === 0) {
    engine.mode = { kind: "globalConfig" };
    return Notices.interfaceGone;
  }
  const ids = ports.map((port) => port.id);
  updateSTP(engine.access, (config) => {
    change(config, ids);
  });
  return "";
}

function portfastHandler(on: boolean): CommandHandler {
  return (engine) => {
    const output = onSelectedPorts(engine, "spanning-tree portfast", (config, ports) => {
      for (const port of ports) config.portfast = setMember(config.portfast, port, on);
    });
    if (output !== "" || !on || engine.isDell) return output;
    const names = engine.selectedPorts().map(
      (port) =>
        `%Portfast has been configured on ${engine.namer.longName(port.name)} but will only\n` +
        " have effect when the interface is in a non-trunking mode.",
    );
    return [portfastWarning, "", ...names].join("\n");
  };
}

function bpduGuardHandler(on: boolean): CommandHandler {
  return (engine) =>
    onSelectedPorts(engine, "spanning-tree bpduguard", (config, ports) => {
      for (const port of ports) config.bpduGuard = setMember(config.bpduGuard, port, on);
    });
}

/** `cost N` / `port-priority N` for every VLAN (vlan 0) or for the listed ones. */
function costHandler(value: number | "argument" | null): CommandHandler {
  return (engine, command) => {
    const cost = value === "argument" ? (command.int("cost") ?? 1) : value;
    const vlans = command.intList("vlans") ?? [0];
    return onSelectedPorts(engine, "spanning-tree cost", (config, ports) => {
      for (const port of ports) for (const vlan of vlans) setCost(config, port, vlan, cost);
    });
  };
}

function portPriorityHandler(value: "argument" | null): CommandHandler {
  return (engine, command) => {
    const priority = value === "argument" ? (command.int("priority") ?? 128) : null;
    if (priority !== null && priority % 16 !== 0) return badPortPriority(engine);
    const vlans = command.intList("vlans") ?? [0];
    return onSelectedPorts(engine, "spanning-tree port-priority", (config, ports) => {
      for (const port of ports) for (const vlan of vlans) setPortPriority(config, port, vlan, priority);
    });
  };
}

function costNode(handler: CommandHandler): CommandNode {
  return kw("cost", "Change an interface's spanning tree port path cost", [
    num("cost", closedRange(1, 200000000), "port path cost", [], handler),
  ]);
}

function portPriorityNode(handler: CommandHandler, name: string): CommandNode {
  return kw(name, "Change an interface's spanning tree port priority", [
    num("priority", closedRange(0, 240), "port priority in increments of 16", [], handler),
  ]);
}

function ciscoInterface(): CommandNode {
  return kw("spanning-tree", "Spanning Tree Subsystem", [
    kw("portfast", "Enable an interface to move directly to forwarding on link up", [
      kw("trunk", "Enable portfast on the interface even in trunk mode", [], portfastHandler(true)),
      kw("edge", "Enable portfast edge on the interface", [], portfastHandler(true)),
    ], portfastHandler(true)),
    kw("bpduguard", "Don't accept BPDUs on this interface", [
      kw("enable", "Enable BPDU guard", [], bpduGuardHandler(true)),
      kw("disable", "Disable BPDU guard", [], bpduGuardHandler(false)),
    ]),
    costNode(costHandler("argument")),
    portPriorityNode(portPriorityHandler("argument"), "port-priority"),
    kw("vlan", "VLAN Switch Spanning Tree", [
      vlanList("vlans", "vlan range, example: 1,3-5,7,9-11", null, [
        costNode(costHandler("argument")),
        portPriorityNode(portPriorityHandler("argument"), "port-priority"),
      ]),
    ]),
    notStored("spanning-tree"),
  ]);
}

function ciscoInterfaceNo(): CommandNode {
  return kw("spanning-tree", "Spanning Tree Subsystem", [
    kw("portfast", "Enable an interface to move directly to forwarding on link up", [], portfastHandler(false)),
    kw("bpduguard", "Don't accept BPDUs on this interface", [], bpduGuardHandler(false)),
    kw("cost", "Change an interface's spanning tree port path cost", [], costHandler(null)),
    kw("port-priority", "Change an interface's spanning tree port priority", [], portPriorityHandler(null)),
    kw("vlan", "VLAN Switch Spanning Tree", [
      vlanList("vlans", "vlan range, example: 1,3-5,7,9-11", null, [
        kw("cost", "Change an interface's spanning tree port path cost", [], costHandler(null)),
        kw("port-priority", "Change an interface's spanning tree port priority", [], portPriorityHandler(null)),
      ]),
    ]),
    notStored("no spanning-tree"),
  ]);
}

// MARK: show

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

const showForInterface: CommandHandler = (engine, command) => {
  const selection = command.interfaces("interface");
  const target = selection?.target;
  if (target?.kind !== "ports") return "% Invalid interface.";
  const ids = new Set(target.ids);
  return showInterface(
    engine,
    engine.access.interfaces.filter((port) => ids.has(port.id)),
  );
};

function ciscoShow(): CommandNode {
  return kw(
    "spanning-tree",
    "Spanning tree topology",
    [
      kw("vlan", "VLAN Switch Spanning Tree", [vlanList("vlans", "vlan range, example: 1,3-5,7,9-11", showSpanningTree)]),
      kw("mst", "Multiple spanning trees", [num("instance", closedRange(0, 4094), "MST instance", [], showMST)], showMST),
      kw("summary", "Summary of port states", [], (engine) => showSummary(engine)),
      kw("interface", "Spanning Tree interface status and configuration", [custom(interfaceArgument, showForInterface)]),
    ],
    showSpanningTree,
  );
}

// MARK: Dell OS9

const dellProtocols: [string, STPMode][] = [
  ["rstp", "rstp"],
  ["mstp", "mst"],
  ["pvst", "pvst"],
];
const stpMode = "spanning-tree";

function enterProtocol(protocol: string): CommandHandler {
  return (engine) => {
    engine.mode = { kind: "feature", name: stpMode, prompt: `conf-${protocol}`, context: { protocol } };
    return "";
  };
}

function protocolOfMode(engine: IOSEngine): STPMode {
  const mode = engine.mode;
  const name = mode.kind === "feature" && mode.name === stpMode ? String(mode.context.protocol ?? "rstp") : "rstp";
  return dellProtocols.find(([word]) => word === name)?.[1] ?? "rstp";
}

/** Switches the protocol on (`no disable`) or off (`disable`). */
function enableHandler(on: boolean): CommandHandler {
  return (engine) => {
    const mode = protocolOfMode(engine);
    updateSTP(engine.access, (config) => {
      config.mode = on ? mode : "none";
    });
    return "";
  };
}

const setDellPriority: CommandHandler = (engine, command) => {
  const priority = command.int("priority") ?? 0;
  if (!validBridgePriority(priority)) return badPriority(engine);
  updateSTP(engine.access, (config) => {
    setPriority(config, 0, priority);
  });
  return "";
};

function dellProtocolNodes(handler: (protocol: string) => CommandHandler): CommandNode[] {
  return dellProtocols.map(([word]) => kw(word, `${word.toUpperCase()} spanning tree protocol`, [], handler(word)));
}

function dellGlobal(): CommandNode {
  return kw("protocol", "Enter protocol configuration mode", [
    kw("spanning-tree", "Spanning tree protocol", dellProtocolNodes(enterProtocol)),
    kw("lldp", "Link Layer Discovery Protocol", [], () => Notices.notStored("protocol lldp")),
  ]);
}

function dellGlobalNo(): CommandNode {
  return kw("protocol", "Enter protocol configuration mode", [
    kw(
      "spanning-tree",
      "Spanning tree protocol",
      dellProtocolNodes(() => (engine) => {
        updateSTP(engine.access, (config) => {
          config.mode = "none";
        });
        return "";
      }),
    ),
    kw("lldp", "Link Layer Discovery Protocol", [], () => Notices.notStored("no protocol lldp")),
  ]);
}

function dellModeCommands(): CommandNode[] {
  const unsimulated = (name: string, help: string): CommandNode =>
    kw(name, help, [line("rest", help, () => Notices.notStored(`${name}`))], () => Notices.notStored(name));
  return [
    kw("disable", "Disable the protocol globally", [], enableHandler(false)),
    kw("bridge-priority", "Set the bridge priority", [
      num("priority", closedRange(0, 65535), "Bridge priority in increments of 4096", [], setDellPriority),
    ]),
    unsimulated("forward-delay", "Set the forward delay"),
    unsimulated("hello-time", "Set the hello time"),
    unsimulated("max-age", "Set the max age"),
    kw("no", "Negate a command or set its defaults", [
      kw("disable", "Enable the protocol globally", [], enableHandler(true)),
      kw("bridge-priority", "Set the bridge priority", [], clearMSTPriority),
    ]),
  ];
}

function dellInterface(negated: boolean): CommandNode[] {
  const edge: CommandHandler = negated ? dellEdge(false, false) : dellEdge(false);
  const protocolNode = ([word]: [string, STPMode]): CommandNode => {
    const children: CommandNode[] = negated
      ? [
          kw("edge-port", "Configure the port as an edge port", [], edge),
          kw("cost", "Change the port cost", [], costHandler(null)),
          kw("priority", "Change the port priority", [], portPriorityHandler(null)),
        ]
      : [
          kw(
            "edge-port",
            "Configure the port as an edge port",
            [kw("bpduguard", "Enable BPDU guard on the port", [kw("shutdown-on-violation", "Shut the port down on violation", [], dellEdge(true))], dellEdge(true))],
            dellEdge(false),
          ),
          costNode(costHandler("argument")),
          portPriorityNode(portPriorityHandler("argument"), "priority"),
        ];
    return kw(word, `${word.toUpperCase()} interface commands`, children);
  };
  return [
    kw("spanning-tree", "Spanning tree commands", [
      ...dellProtocols.map(protocolNode),
      kw("portfast", "Configure the port as an edge port", [], edge),
    ]),
  ];
}

/** `edge-port [bpduguard ...]`: an edge port, with BPDU guard when asked for. */
function dellEdge(guard: boolean, on = true): CommandHandler {
  return (engine) =>
    onSelectedPorts(engine, "spanning-tree edge-port", (config, ports) => {
      for (const port of ports) {
        config.portfast = setMember(config.portfast, port, on);
        config.bpduGuard = setMember(config.bpduGuard, port, guard);
      }
    });
}

function dellShow(): CommandNode {
  const protocolNode = ([word]: [string, STPMode]): CommandNode =>
    kw(word, `${word.toUpperCase()} spanning tree`, [kw("brief", "Brief summary", [], showDellSpanningTree)], showDellSpanningTree);
  return kw("spanning-tree", "Spanning tree information", [
    ...dellProtocols.map(protocolNode),
    num("instance", closedRange(0, 63), "MSTI/VLAN instance", [], showDellSpanningTree),
  ]);
}

// MARK: running-config

function modeWord(mode: STPMode): string {
  return mode === "mst" ? "mstp" : mode === "pvst" ? "pvst" : "rstp";
}

/** `1,3-5` the VLANs of a priority group, `1-4094` for the entry that stands for all. */
function vlanText(vlans: number[]): string {
  return VLANListParser.format(vlans);
}

function globalBlocks(engine: IOSEngine): string[][] {
  const config = stpOf(engine.access.device);
  if (!config) return [];
  if (engine.isDell) {
    const priority = config.priorities.find((entry) => entry.vlan === 0);
    if (config.mode === "none" && !priority) return [];
    const lines = [`protocol spanning-tree ${modeWord(config.mode === "none" ? "rstp" : config.mode)}`];
    lines.push(config.mode === "none" ? " disable" : " no disable");
    if (priority) lines.push(` bridge-priority ${priority.priority}`);
    return [lines];
  }
  const lines: string[] = [];
  const mode = config.mode === "rstp" ? "rapid-pvst" : config.mode === "none" || config.mode === "stp" ? "pvst" : config.mode;
  lines.push(`spanning-tree mode ${mode}`);
  const byPriority = new Map<number, number[]>();
  for (const entry of config.priorities) {
    if (config.mode === "mst" && entry.vlan !== 0) continue;
    byPriority.set(entry.priority, [...(byPriority.get(entry.priority) ?? []), entry.vlan]);
  }
  for (const [priority, vlans] of byPriority) {
    if (config.mode === "mst") lines.push(`spanning-tree mst 0 priority ${priority}`);
    else lines.push(`spanning-tree vlan ${vlanText(vlans.map((vlan) => (vlan === 0 ? 1 : vlan)))}${vlans.includes(0) ? "-4094" : ""} priority ${priority}`);
  }
  for (const vlan of config.disabledVLANs) lines.push(`no spanning-tree vlan ${vlan}`);
  return [lines];
}

function interfaceLines(engine: IOSEngine, interfaceID: string): string[] {
  const config = stpOf(engine.access.device);
  const parsed = parseL3Interface(interfaceID);
  if (!config || parsed?.kind !== "port") return [];
  const id = parsed.id;
  const lines: string[] = [];
  const vlanSuffix = (vlan: number): string => (vlan === 0 ? "" : `vlan ${vlan} `);
  if (engine.isDell) {
    const word = modeWord(config.mode);
    if (config.portfast.includes(id)) {
      lines.push(` spanning-tree ${word} edge-port${config.bpduGuard.includes(id) ? " bpduguard" : ""}`);
    }
    for (const entry of config.costs.filter((candidate) => candidate.port === id)) {
      lines.push(` spanning-tree ${word} cost ${entry.cost}`);
    }
    for (const entry of config.portPriorities.filter((candidate) => candidate.port === id)) {
      lines.push(` spanning-tree ${word} priority ${entry.priority}`);
    }
    return lines;
  }
  if (config.portfast.includes(id)) lines.push(" spanning-tree portfast");
  if (config.bpduGuard.includes(id)) lines.push(" spanning-tree bpduguard enable");
  for (const entry of config.costs.filter((candidate) => candidate.port === id)) {
    lines.push(` spanning-tree ${vlanSuffix(entry.vlan)}cost ${entry.cost}`);
  }
  for (const entry of config.portPriorities.filter((candidate) => candidate.port === id)) {
    lines.push(` spanning-tree ${vlanSuffix(entry.vlan)}port-priority ${entry.priority}`);
  }
  return lines;
}

// MARK: The feature

export const layer2IOS: IOSFeature = (dialect): IOSFeatureCommands => {
  if (dialect === "dellOS9") {
    return {
      show: [dellShow()],
      global: [dellGlobal()],
      globalNo: [dellGlobalNo()],
      interface: dellInterface(false),
      interfaceNo: dellInterface(true),
      modes: { [stpMode]: dellModeCommands() },
      config: { interfaceLines, globalBlocks },
    };
  }
  if (dialect !== "ios" && dialect !== "generic") return {};
  return {
    show: [ciscoShow()],
    global: [ciscoGlobal()],
    globalNo: [ciscoGlobalNo()],
    interface: [ciscoInterface()],
    interfaceNo: [ciscoInterfaceNo()],
    config: { interfaceLines, globalBlocks },
  };
};
