// The show commands of spanning tree on the IOS-style consoles (Cisco IOS layout; a shorter
// Dell OS9 one) and the data they print, computed by computeSpanningTree (stp.ts).

import type { Device } from "../../../core/model";
import { padded, trimmingTrailingWhitespace, VLANListParser, type ParsedCommand } from "../../command-tree";
import type { IOSEngine } from "../../ios-engine";
import { PortSnapshot } from "../../model-access";
import { defaultMode, portNumber, stpOf } from "./model";
import { computeSpanningTree, type STPBridgeInfo, type STPPortInfo } from "./stp";

function joined(lines: string[]): string {
  return lines.map(trimmingTrailingWhitespace).join("\n");
}

const roleText = { root: "Root", designated: "Desg", alternate: "Altn", backup: "Back", disabled: "Dis" } as const;
const stateText = { blocking: "BLK", listening: "LIS", learning: "LRN", forwarding: "FWD", disabled: "DIS" } as const;

// MARK: What the engine knows

interface View {
  device: Device;
  info: STPBridgeInfo;
  /** The info of the root bridge (this one when it is the root). */
  root: STPBridgeInfo;
  all: Map<string, STPBridgeInfo>;
}

/** The spanning tree of the console's device; null when it does not run it (mode none, not a switch). */
function viewOf(engine: IOSEngine): View | null {
  const device = engine.access.device;
  if (!device) return null;
  const all = computeSpanningTree(engine.access.store.project);
  const info = all.get(device.id);
  if (!info) return null;
  const root = [...all.values()].find((candidate) => candidate.bridgeID === info.rootBridgeID) ?? info;
  return { device, info, root, all };
}

/** The mode as the console reports it (the engine reads an absent config as PVST). */
export function modeOf(device: Device): string {
  return stpOf(device)?.mode ?? defaultMode;
}

function portOf(device: Device, port: STPPortInfo) {
  return device.ports.find((candidate) => candidate.id === port.portID);
}

function portName(engine: IOSEngine, device: Device, port: STPPortInfo): string {
  const found = portOf(device, port);
  return found ? engine.namer.shortName(found.name) : "?";
}

/** The bridge MAC in Cisco notation, as computeSpanningTree reports it. */
function mac(info: STPBridgeInfo): string {
  return info.mac;
}

// MARK: VLANs of the device

function portCarries(port: PortSnapshot, vlan: number): boolean {
  const config = port.switchport;
  if (!config || !port.isSwitchport) return false;
  if (config.mode === "trunk") return config.allows(vlan) || config.nativeVLAN === vlan;
  return config.accessVLAN === vlan;
}

/** The VLANs that have a port with a live spanning tree state on this switch, ascending. */
function activeVLANs(engine: IOSEngine, view: View): number[] {
  const disabled = new Set(stpOf(view.device)?.disabledVLANs ?? []);
  const candidates = new Set<number>([1, ...engine.access.vlans.map((entry) => entry.id)]);
  const live = new Set(view.info.ports.filter((port) => port.role !== "disabled").map((port) => port.portID));
  const ports = engine.access.interfaces.filter((port) => live.has(port.id));
  return [...candidates]
    .filter((vlan) => !disabled.has(vlan) && ports.some((port) => portCarries(port, vlan)))
    .sort((a, b) => a - b);
}

// MARK: IOS: show spanning-tree

const timers = "Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec";

function protocolName(mode: string): string {
  return mode === "pvst" ? "ieee" : mode === "rapid-pvst" ? "rstp" : mode === "mst" ? "mstp" : mode;
}

function interfaceRows(engine: IOSEngine, view: View, ports: STPPortInfo[]): string[] {
  return ports
    .filter((port) => port.role !== "disabled")
    .map((port) => {
      const type = "P2p" + (port.edge ? " Edge" : "");
      return (
        padded(portName(engine, view.device, port), 20) +
        padded(roleText[port.role], 5) +
        padded(stateText[port.state], 4) +
        padded(`${port.cost}`, 10) +
        padded(`${port.priority}.${portNumber(view.device, port.portID)}`, 9) +
        type
      );
    });
}

const interfaceHeader = [
  "Interface           Role Sts Cost      Prio.Nbr Type",
  "------------------- ---- --- --------- -------- --------------------------------",
];

/** One VLAN0010 / MST0 section; `vlan` is the VLAN (0 for MST0). */
function instanceSection(engine: IOSEngine, view: View, vlan: number, ports: STPPortInfo[]): string {
  const mode = modeOf(view.device);
  const title = vlan === 0 ? "MST0" : `VLAN${String(vlan).padStart(4, "0")}`;
  const own = view.info.priority;
  const rootPriority = view.info.isRoot ? own : view.root.priority;
  const lines = [title, `  Spanning tree enabled protocol ${protocolName(mode)}`];
  lines.push(
    `  Root ID    Priority    ${rootPriority + vlan}`,
    `             Address     ${mac(view.root)}`,
  );
  if (view.info.isRoot) {
    lines.push("             This bridge is the root");
  } else {
    const rootPort = view.info.ports.find((port) => port.portID === view.info.rootPortID);
    lines.push(`             Cost        ${view.info.rootCost}`);
    if (rootPort) {
      const found = portOf(view.device, rootPort);
      lines.push(`             Port        ${portNumber(view.device, rootPort.portID)}(${found ? engine.namer.longName(found.name) : "?"})`);
    }
  }
  lines.push(
    `             ${timers}`,
    "",
    `  Bridge ID  Priority    ${own + vlan}  (priority ${own} sys-id-ext ${vlan})`,
    `             Address     ${mac(view.info)}`,
    `             ${timers}`,
    "             Aging Time  300 sec",
    "",
    ...interfaceHeader,
    ...interfaceRows(engine, view, ports),
  );
  return joined(lines);
}

function portsOfVLAN(engine: IOSEngine, view: View, vlan: number): STPPortInfo[] {
  const carrying = new Set(engine.access.interfaces.filter((port) => portCarries(port, vlan)).map((port) => port.id));
  return view.info.ports.filter((port) => carrying.has(port.portID));
}

const notEnabled = (vlans: string): string => `Spanning tree instance(s) for vlan ${vlans} does not exist.`;

/** `show spanning-tree [vlan LIST]`. */
export function showSpanningTree(engine: IOSEngine, command: ParsedCommand): string {
  const view = viewOf(engine);
  const wanted = command.intList("vlans");
  if (view === null) return wanted ? notEnabled(VLANListParser.format(wanted)) : "";
  if (view.info.mode === "mst") {
    if (wanted) return "% Switch is in mst mode (only 'show spanning-tree mst' is supported)";
    return instanceSection(engine, view, 0, view.info.ports);
  }
  const vlans = activeVLANs(engine, view).filter((vlan) => wanted === null || wanted.includes(vlan));
  if (vlans.length === 0) return wanted ? notEnabled(VLANListParser.format(wanted)) : "";
  return vlans.map((vlan) => instanceSection(engine, view, vlan, portsOfVLAN(engine, view, vlan))).join("\n\n");
}

/** `show spanning-tree mst [0]`. */
export function showMST(engine: IOSEngine, command: ParsedCommand): string {
  const view = viewOf(engine);
  if (view === null || view.info.mode !== "mst") return "% Switch is not in mst mode";
  const instance = command.int("instance");
  if (instance !== null && instance !== 0) return `% MST instance ${instance} does not exist`;
  const own = view.info.priority;
  const lines = [
    "",
    "##### MST0    vlans mapped:   1-4094",
    `Bridge        address ${mac(view.info)}  priority      ${own}  (${own} sys-id-ext 0)`,
  ];
  if (view.info.isRoot) {
    lines.push("Root          this switch for the CST and IST");
  } else {
    const rootPriority = view.root.priority;
    const rootPort = view.info.ports.find((port) => port.portID === view.info.rootPortID);
    lines.push(`Root          address ${mac(view.root)}  priority      ${rootPriority}  (${rootPriority} sys-id-ext 0)`);
    if (rootPort) {
      lines.push(`              port    ${portName(engine, view.device, rootPort)}          path cost   ${view.info.rootCost}`);
    }
  }
  lines.push(
    "Regional Root this switch",
    "Operational   hello time 2 , forward delay 15, max age 20, txholdcount 6",
    "Configured    hello time 2 , forward delay 15, max age 20, max hops    20",
    "",
    ...interfaceHeader,
    ...interfaceRows(engine, view, view.info.ports),
  );
  return joined(lines);
}

/** `show spanning-tree summary`. */
export function showSummary(engine: IOSEngine): string {
  const device = engine.access.device;
  if (!device) return "";
  const view = viewOf(engine);
  const mode = modeOf(device);
  const lines = [mode === "none" ? "No spanning tree instance exists." : `Switch is in ${mode} mode`];
  if (view === null) return lines.join("\n");
  const sections: { name: string; ports: STPPortInfo[] }[] =
    view.info.mode === "mst"
      ? [{ name: "MST0", ports: view.info.ports }]
      : activeVLANs(engine, view).map((vlan) => ({
          name: `VLAN${String(vlan).padStart(4, "0")}`,
          ports: portsOfVLAN(engine, view, vlan),
        }));
  if (view.info.isRoot) lines.push(`Root bridge for: ${sections.map((section) => section.name).join(", ")}`);
  lines.push(
    "Extended system ID           is enabled",
    "Portfast Default             is disabled",
    "PortFast BPDU Guard Default  is disabled",
    "Portfast BPDU Filter Default is disabled",
    "Loopguard Default            is disabled",
    "EtherChannel misconfig guard is enabled",
    "UplinkFast                   is disabled",
    "BackboneFast                 is disabled",
    "Configured Pathcost method used is short",
    "",
    "Name                   Blocking Listening Learning Forwarding STP Active",
    "---------------------- -------- --------- -------- ---------- ----------",
  );
  const totals = [0, 0, 0, 0, 0];
  for (const section of sections) {
    const live = section.ports.filter((port) => port.role !== "disabled");
    const count = (state: string): number => live.filter((port) => port.state === state).length;
    const counts = [count("blocking"), count("listening"), count("learning"), count("forwarding"), live.length];
    counts.forEach((value, index) => (totals[index] += value));
    lines.push(summaryRow(section.name, counts));
  }
  lines.push(
    "---------------------- -------- --------- -------- ---------- ----------",
    summaryRow(`${sections.length} ${sections.length === 1 ? "vlan" : "vlans"}`, totals),
  );
  return joined(lines);
}

function summaryRow(name: string, counts: number[]): string {
  const widths = [8, 9, 8, 10, 10];
  return padded(name, 22) + " " + counts.map((count, index) => String(count).padStart(widths[index])).join(" ");
}

/** `show spanning-tree interface IF`. */
export function showInterface(engine: IOSEngine, ports: PortSnapshot[]): string {
  const view = viewOf(engine);
  if (view === null) return "";
  const lines: string[] = [];
  for (const snapshot of ports) {
    const info = view.info.ports.find((port) => port.portID === snapshot.id);
    if (!info || info.role === "disabled") {
      lines.push(`no spanning tree info available for ${engine.namer.longName(snapshot.name)}`);
      continue;
    }
    const vlans = view.info.mode === "mst" ? [0] : activeVLANs(engine, view).filter((vlan) => portCarries(snapshot, vlan));
    lines.push("Vlan             Role Sts Cost      Prio.Nbr Type", "---------------- ---- --- --------- -------- --------------------------------");
    for (const vlan of vlans) {
      const title = vlan === 0 ? "MST0" : `VLAN${String(vlan).padStart(4, "0")}`;
      lines.push(padded(title, 17) + interfaceRows(engine, view, [info])[0].slice(20));
    }
    lines.push("");
  }
  return joined(lines).replace(/\n+$/, "");
}

// MARK: Dell OS9: show spanning-tree rstp|mstp|pvst|0

/** `show spanning-tree rstp|mstp|pvst [brief]` and `show spanning-tree 0`. */
export function showDellSpanningTree(engine: IOSEngine, command: ParsedCommand): string {
  const device = engine.access.device;
  const view = viewOf(engine);
  if (!device || view === null) return "% Error: Spanning tree is not enabled.";
  const asked = command.has("rstp") ? "rstp" : command.has("mstp") ? "mst" : command.has("pvst") ? "pvst" : null;
  if (asked !== null && asked !== view.info.mode) {
    return `% Error: ${asked === "mst" ? "MSTP" : asked.toUpperCase()} is not enabled.`;
  }
  const own = view.info.priority;
  const rootPriority = view.root.priority;
  const lines = [
    `Executing IEEE compatible Spanning Tree Protocol`,
    `Root ID Priority ${rootPriority}, Address ${view.root.mac}`,
    "Root Bridge hello time 2, max age 20, forward delay 15",
    `Bridge ID Priority ${own}, Address ${view.info.mac}`,
    "Configured hello time 2, max age 20, forward delay 15",
  ];
  if (view.info.isRoot) lines.push("We are the root of the spanning tree");
  else {
    const rootPort = view.info.ports.find((port) => port.portID === view.info.rootPortID);
    if (rootPort) lines.push(`Root port is ${portName(engine, device, rootPort)}, cost of root path is ${view.info.rootCost}`);
  }
  lines.push(
    "",
    "Interface                                  Designated",
    "Name       PortID  Prio Cost     Sts   Cost  Bridge ID             PortID",
    "---------- ------- ---- -------- ----- ----- --------------------- -------",
  );
  for (const port of view.info.ports.filter((entry) => entry.role !== "disabled")) {
    const designated = port.role === "root" ? view.root : view.info;
    const designatedCost = port.role === "root" ? 0 : view.info.rootCost;
    lines.push(
      padded(portName(engine, device, port), 11) +
        padded(`${port.priority}.${portNumber(device, port.portID)}`, 8) +
        padded(`${port.priority}`, 5) +
        padded(`${port.cost}`, 9) +
        padded(stateText[port.state], 6) +
        padded(`${designatedCost}`, 6) +
        padded(`${designated.priority} ${designated.mac}`, 22) +
        `${port.priority}.${portNumber(device, port.portID)}`,
    );
  }
  lines.push("", "Interface", "Name       Role   PortID  Prio Cost     Sts   Cost  Link-type Edge Boundary", "---------- ------ ------- ---- -------- ----- ----- --------- ---- --------");
  for (const port of view.info.ports.filter((entry) => entry.role !== "disabled")) {
    lines.push(
      padded(portName(engine, device, port), 11) +
        padded(roleText[port.role], 7) +
        padded(`${port.priority}.${portNumber(device, port.portID)}`, 8) +
        padded(`${port.priority}`, 5) +
        padded(`${port.cost}`, 9) +
        padded(stateText[port.state], 6) +
        padded(`${port.role === "root" ? view.info.rootCost : 0}`, 6) +
        padded("P2P", 10) +
        padded(port.edge ? "Yes" : "No", 5) +
        "No",
    );
  }
  return joined(lines);
}
