// Dell OS6 (Dell Networking N-series, DNOS 6.x): the `show` output and the shared lookups of
// the console. Everything works on a DeviceAccess, so it needs no engine.

import { padded, trimmingTrailingWhitespace, trimWhitespaces, VLANListParser } from "./command-tree";
import { defaultVLANName } from "./ios-show";
import { computeSpanningTree } from "./features/layer2/stp";
import { readSTPConfig } from "../core/protocols/layer2";
import { type DeviceAccess, l3VLAN, parseL3Interface, type PortSnapshot } from "./model-access";
import { bridgeMAC } from "./sim/mac";
import { SwitchportConfig } from "./switchport";

export const softwareVersion = "6.5.4.23";

function joined(lines: string[]): string {
  return lines.map(trimmingTrailingWhitespace).join("\n");
}

// MARK: VLAN model

/** The VLAN numbers that exist: VLAN 1 plus the stored ones. */
export function definedVLANs(access: DeviceAccess): number[] {
  const ids = new Set<number>([1]);
  for (const entry of access.vlans) if (entry.id >= 1 && entry.id <= 4094) ids.add(entry.id);
  return [...ids].sort((a, b) => a - b);
}

export function vlanLabel(access: DeviceAccess, id: number): string {
  const stored = access.vlans.find((entry) => entry.id === id);
  const name = stored ? trimWhitespaces(stored.name) : "";
  return name === "" ? defaultVLANName(id) : name;
}

function configOf(port: PortSnapshot): SwitchportConfig {
  return port.switchport ?? new SwitchportConfig();
}

/** True when the port forwards frames of the VLAN (untagged or tagged). */
export function isMember(port: PortSnapshot, vlan: number): boolean {
  if (!port.isSwitchport) return false;
  const config = configOf(port);
  if (config.mode === "trunk") return vlan === config.nativeVLAN || config.allows(vlan);
  return config.accessVLAN === vlan;
}

/** "Gi1/0/3-24, Te1/0/1-2" as separate items, one per run of consecutive ports. */
export function portRuns(ports: PortSnapshot[]): string[] {
  const runs: string[] = [];
  let start: { prefix: string; number: number } | null = null;
  let last: { prefix: string; number: number } | null = null;
  const flush = () => {
    if (!start || !last) return;
    runs.push(start.number === last.number ? `${start.prefix}${start.number}` : `${start.prefix}${start.number}-${last.number}`);
  };
  for (const port of ports) {
    const match = /^(.*\/)(\d+)$/.exec(port.name);
    if (!match) {
      flush();
      runs.push(port.name);
      start = last = null;
      continue;
    }
    const current = { prefix: match[1], number: Number(match[2]) };
    if (last && last.prefix === current.prefix && current.number === last.number + 1) {
      last = current;
    } else {
      flush();
      start = last = current;
    }
  }
  flush();
  return runs;
}

export function switchports(access: DeviceAccess): PortSnapshot[] {
  return access.interfaces.filter((port) => port.isSwitchport);
}

/** A routing interface of a VLAN is up while a cabled, enabled port is a member. */
export function vlanIsUp(access: DeviceAccess, vlan: number): boolean {
  if (!definedVLANs(access).includes(vlan)) return false;
  return switchports(access).some((port) => port.linkState === "up" && isMember(port, vlan));
}

// MARK: show vlan

export function showVLAN(access: DeviceAccess, only: number | null): string {
  const lines = [
    "VLAN   Name                             Ports          Type      Authorization",
    "-----  ---------------                  -------------  --------  -------------",
  ];
  const ports = switchports(access);
  const ids = only === null ? definedVLANs(access) : definedVLANs(access).filter((id) => id === only);
  if (ids.length === 0) return `VLAN ${only} does not exist.`;
  for (const id of ids) {
    const members = portRuns(ports.filter((port) => isMember(port, id)));
    const type = id === 1 ? "Default" : "Static";
    const rows = members.length === 0 ? [""] : members.map((run, index) => (index < members.length - 1 ? run + "," : run));
    rows.forEach((row, index) => {
      if (index === 0) {
        lines.push(padded(`${id}`, 7) + padded(vlanLabel(access, id), 33) + padded(row, 15) + padded(type, 10) + "Required");
      } else {
        lines.push(" ".repeat(40) + row);
      }
    });
  }
  return joined(lines);
}

// MARK: show interfaces

function speedNumber(port: PortSnapshot): string {
  const match = /^\s*([\d.]+)\s*([MG])/i.exec(port.speed);
  if (!match) return "1000";
  return String(Math.round(Number(match[1]) * (match[2].toUpperCase() === "G" ? 1000 : 1)));
}

export function showInterfacesStatus(ports: PortSnapshot[]): string {
  const lines = [
    "                                                                 Link   Flow         ",
    "Port     Description                    Duplex Speed    Neg      State  Control VLAN ",
    "-------- ------------------------------ ------ -------- -------- ------ ------- -----",
  ];
  for (const port of ports) {
    const up = port.linkState === "up";
    const config = configOf(port);
    const vlan = !port.isSwitchport ? "" : config.mode === "trunk" ? "Trunk" : `${config.accessVLAN}`;
    lines.push(
      padded(port.name, 9) +
        padded(trimWhitespaces(port.description).slice(0, 30), 31) +
        padded(up ? "Full" : "", 7) +
        padded(up ? speedNumber(port) : "", 9) +
        padded("Auto", 9) +
        padded(port.linkState === "adminDown" ? "Detach" : up ? "Up" : "Down", 7) +
        padded(up ? "Inactive" : "", 8) +
        vlan,
    );
  }
  return joined(lines);
}

export function showInterfacesSwitchport(access: DeviceAccess, port: PortSnapshot): string {
  if (!port.isSwitchport) return `Port: ${port.name}\nThis is a management port without switchport settings.`;
  const config = configOf(port);
  const trunk = config.mode === "trunk";
  const mode = trunk ? "Trunk Mode" : "Access Mode";
  const vlanDefault = (id: number) => (id === 1 ? `${id} (default)` : `${id}`);
  const untagged = trunk ? config.nativeVLAN : config.accessVLAN;
  const tagged = trunk
    ? definedVLANs(access)
        .filter((id) => id !== config.nativeVLAN && config.allows(id))
    : [];
  return joined([
    `Port: ${port.name}`,
    `VLAN Membership Mode: ${mode}`,
    `Access Mode VLAN: ${vlanDefault(config.accessVLAN)}`,
    `General Mode PVID: ${vlanDefault(untagged)}`,
    "General Mode Ingress Filtering: Enabled",
    "General Mode Acceptable Frame Type: Admit All",
    "General Mode Dynamically Added VLANs:",
    `General Mode Untagged VLANs: ${untagged}`,
    `General Mode Tagged VLANs: ${tagged.length === 0 ? "" : VLANListParser.format(tagged)}`,
    "General Mode Forbidden VLANs:",
    `Trunking Mode Native VLAN: ${vlanDefault(config.nativeVLAN)}`,
    "Trunking Mode Native VLAN tagging: Disabled",
    `Trunking Mode VLANs Enabled: ${
      config.allowedVLANs === null ? "All" : config.allowedVLANs.length === 0 ? "None" : VLANListParser.format(config.allowedVLANs)
    }`,
    "Protected: Disabled",
  ]);
}

// MARK: show ip interface vlan N

function dots(label: string, value: string): string {
  return label + ".".repeat(Math.max(1, 50 - label.length)) + " " + value;
}

export function showIPInterfaceVLAN(access: DeviceAccess, vlan: number): string {
  const prefix = access.address(l3VLAN(vlan));
  const up = vlanIsUp(access, vlan);
  const device = access.device;
  const lines = [
    dots("Routing Interface Status", up ? "Up" : "Down"),
    dots(
      "Primary IP Address",
      prefix ? `${prefix.address.description}/${prefix.mask.description}` : "0.0.0.0/0.0.0.0",
    ),
    dots("Method", prefix ? "Manual" : "None"),
    dots("Routing Mode", "Enable"),
    dots("Administrative Mode", "Enable"),
    dots("Forward Net Directed Broadcasts", "Disable"),
    dots("Proxy ARP", "Enable"),
    dots("Local Proxy ARP", "Disable"),
    dots("Active State", up && prefix ? "Active" : "Inactive"),
    dots("MAC Address", device ? bridgeMAC(device, "colon") : "00:00:00:00:00:00"),
    dots("Encapsulation Type", "Ethernet"),
    dots("IP MTU", "1500"),
    dots("Bandwidth", "10000 kbps"),
    dots("Destination Unreachables", "Enabled"),
    dots("ICMP Redirects", "Enabled"),
  ];
  return joined(lines);
}

// MARK: show ip route

function l3Short(access: DeviceAccess, id: string): string {
  const parsed = parseL3Interface(id);
  if (parsed === null) return "?";
  if (parsed.kind === "vlan") return `Vl${parsed.number}`;
  return access.device?.ports.find((port) => port.id === parsed.id)?.name ?? "?";
}

export function showIPRoute(access: DeviceAccess): string {
  const routes = access.simulator.routes(access.deviceID);
  const gateway = routes.find((route) => route.destination.length === 0 && route.nextHop !== null)?.nextHop ?? null;
  const lines = [
    "Route Codes: R - RIP Derived, O - OSPF Derived, C - Connected, S - Static",
    "       B - BGP Derived, E - Externally Derived, IA - OSPF Inter Area",
    "       E1 - OSPF External Type 1, E2 - OSPF External Type 2",
    "       * Indicates the best (lowest metric) route for the subnet.",
    "",
    gateway ? `Default Gateway is ${gateway.description}` : "No default gateway has been configured.",
    "",
  ];
  for (const route of routes) {
    if (route.kind === "local") continue;
    const where = l3Short(access, route.interface.id);
    const destination = route.destination.description;
    if (route.kind === "connected") {
      lines.push(`C    ${destination} [0/1] directly connected, ${where}`);
    } else if (route.kind === "staticRoute") {
      lines.push(`S    ${destination} [1/0] via ${route.nextHop?.description ?? "?"}, ${where}`);
    } else {
      lines.push(`${padded(route.code ?? "O", 4)} ${destination} [${route.distance}/${route.metric}] via ${route.nextHop?.description ?? "?"}, ${where}`);
    }
  }
  return joined(lines);
}

// MARK: show spanning-tree

const roleText = { root: "Root", designated: "Desg", alternate: "Altn", backup: "Back", disabled: "Dis" } as const;
const stateText = { blocking: "BLK", listening: "LIS", learning: "LRN", forwarding: "FWD", disabled: "DIS" } as const;
const modeText: Record<string, string> = {
  rstp: "RSTP",
  stp: "STP",
  mst: "MSTP",
  pvst: "PVST",
  "rapid-pvst": "RPVST",
};

/** The mode shown for the device; a device without stored STP configuration runs RSTP. */
export function stpModeOf(access: DeviceAccess): string {
  const stored = access.device?.protocols?.stp;
  return stored ? (readSTPConfig(stored)?.mode ?? "rstp") : "rstp";
}

function formatPriority(info: { priority: number }): string {
  return `${info.priority}`;
}

export function showSpanningTree(access: DeviceAccess): string {
  const device = access.device;
  if (!device) return "";
  const mode = stpModeOf(access);
  if (mode === "none") return "Spanning tree disabled.";
  const all = computeSpanningTree(access.store.project);
  const info = all.get(device.id);
  if (!info) return "Spanning tree disabled.";
  const root = [...all.values()].find((candidate) => candidate.bridgeID === info.rootBridgeID) ?? info;
  const timers = "Hello Time  2 Sec  Max Age 20 Sec  Forward Delay 15 Sec";
  const lines = [
    `Spanning tree enabled mode ${modeText[mode] ?? mode.toUpperCase()}`,
    "Default Port Cost Method: long",
    "",
    `CST Root ID    Priority    ${formatPriority(root)}`,
    `               Address     ${root.mac}`,
  ];
  if (info.isRoot) {
    lines.push("               This switch is the Root.");
  } else {
    const rootPort = info.ports.find((port) => port.portID === info.rootPortID);
    lines.push(`               Path Cost   ${info.rootCost}`);
    lines.push(`               Root Port   ${rootPort ? (device.ports.find((p) => p.id === rootPort.portID)?.name ?? "?") : "?"}`);
  }
  lines.push(`               ${timers}`, "");
  lines.push(
    `Bridge ID      Priority    ${formatPriority(info)}`,
    `               Address     ${info.mac}`,
    `               ${timers}`,
    "",
    "Interfaces",
    "Name      State    Prio.Nbr Cost       Sts   Role Edge  Type",
    "--------- -------- -------- ---------- ----- ---- ----- ----",
  );
  const numbers = device.ports.filter((port) => port.connector !== "console");
  for (const port of info.ports.filter((entry) => entry.role !== "disabled")) {
    const index = numbers.findIndex((candidate) => candidate.id === port.portID) + 1;
    const name = numbers[index - 1]?.name ?? "?";
    lines.push(
      padded(name, 10) +
        padded("Enabled", 9) +
        padded(`${port.priority}.${index}`, 9) +
        padded(`${port.cost}`, 11) +
        padded(stateText[port.state], 6) +
        padded(roleText[port.role], 5) +
        padded(port.edge ? "Yes" : "No", 6) +
        "P2P",
    );
  }
  return joined(lines);
}

// MARK: show running-config

export function interfaceConfigLines(access: DeviceAccess, port: PortSnapshot): string[] {
  const lines: string[] = [];
  const description = trimWhitespaces(port.description);
  if (description !== "") lines.push(`description "${description}"`);
  if (port.adminDown) lines.push("shutdown");
  const config = port.switchport;
  if (config === null) {
    lines.push(`! (nestandardní text VLAN: ${port.vlanText.replace(/\s+/g, " ")})`);
  } else if (port.isSwitchport) {
    if (config.mode === "trunk") lines.push("switchport mode trunk");
    else if (config.mode === "access") lines.push("switchport mode access");
    if (config.accessVLAN !== 1) lines.push(`switchport access vlan ${config.accessVLAN}`);
    if (config.allowedVLANs !== null) {
      lines.push(
        config.allowedVLANs.length === 0
          ? "switchport trunk allowed vlan none"
          : `switchport trunk allowed vlan ${VLANListParser.format(config.allowedVLANs)}`,
      );
    }
    if (config.nativeVLAN !== 1) lines.push(`switchport trunk native vlan ${config.nativeVLAN}`);
  }
  const stp = access.device?.protocols?.stp;
  if (stp && readSTPConfig(stp)?.portfast.includes(port.id)) lines.push("spanning-tree portfast");
  return lines;
}

export function showRunningConfig(access: DeviceAccess): string {
  const device = access.device;
  const model = access.model;
  const lines = [
    "!Current Configuration:",
    `!System Description "Dell Networking ${model}, ${softwareVersion}"`,
    `!System Software Version ${softwareVersion}`,
    "!Cut-through mode is configured as disabled",
    "!",
    "configure",
  ];
  const named = access.vlans.filter((entry) => entry.id !== 1);
  for (const entry of named) {
    lines.push(`vlan ${entry.id}`);
    if (trimWhitespaces(entry.name) !== "") lines.push(`name "${trimWhitespaces(entry.name)}"`);
    lines.push("exit");
  }
  lines.push(`hostname "${access.hostname}"`);
  const stp = device?.protocols?.stp ? readSTPConfig(device.protocols.stp) : undefined;
  if (stp) {
    if (stp.mode === "none") lines.push("no spanning-tree");
    else lines.push(`spanning-tree mode ${stp.mode === "mst" ? "mstp" : stp.mode}`);
    const priority = stp.priorities.find((entry) => entry.vlan === 0);
    if (priority) lines.push(`spanning-tree priority ${priority.priority}`);
  }
  if (access.defaultGateway !== "") lines.push(`ip default-gateway ${access.defaultGateway}`);
  for (const route of access.staticRoutes) {
    const parts = route.destination.split("/");
    const mask = parts.length === 2 ? (maskOf(Number(parts[1]))) : "255.255.255.255";
    lines.push(`ip route ${parts[0]} ${mask} ${route.nextHop}`);
  }
  for (const entry of access.addresses) {
    const parsed = parseL3Interface(entry.interface);
    if (parsed === null || parsed.kind !== "vlan") continue;
    const prefix = access.address(entry.interface);
    if (prefix === null) continue;
    lines.push(`interface vlan ${parsed.number}`, `ip address ${prefix.address.description} ${prefix.mask.description}`, "exit");
  }
  for (const port of access.interfaces) {
    const body = interfaceConfigLines(access, port);
    if (body.length === 0) continue;
    lines.push(`interface ${port.name}`, ...body, "exit");
  }
  lines.push("exit");
  return joined(lines);
}

function maskOf(length: number): string {
  const bits = length <= 0 ? 0 : (0xffffffff << (32 - Math.min(32, length))) >>> 0;
  return [bits >>> 24, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255].join(".");
}

// MARK: show version

export function showVersion(access: DeviceAccess): string {
  const device = access.device;
  return joined([
    dots("Machine Description", `Dell Networking ${access.model}`),
    dots("System Model ID", access.model),
    dots("Machine Type", `Dell Networking ${access.model}`),
    dots("Burned In MAC Address", device ? bridgeMAC(device, "colon") : ""),
    dots("Software Version", softwareVersion),
    "",
    "NetSketch: verze softwaru, sériová čísla ani uptime nejsou v diagramu uloženy.",
  ]);
}
