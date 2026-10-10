// Ready-made lab exercises (port of NetSketchCLI/Exercises.swift), built the way a student
// would build them: devices from the catalog, cables, and every setting typed into the device
// consoles in each vendor's syntax.
//
// examples/ holds the files the Swift tool NetSketchExamples saved from them; the tests check
// that the pings of each exercise succeed and that `fileData` reproduces those files.

import type { CableType, Device, PortRef, Project } from "../core/model";
import { PortNaming } from "../core/port-naming";
import { encodeProject } from "../core/project-io";
import type { ProjectStoreAPI } from "../core/store-api";
import { CLISession } from "./session";
import { IPv4 } from "./sim/ipv4";
import { NetworkSimulator } from "./sim/network-simulator";

export interface Exercise {
  readonly fileName: string;
  readonly title: string;
  /** Builds the finished exercise into an empty store. Throws CommandFailed. */
  readonly build: (store: ProjectStoreAPI) => void;
  /** Pairs (from hostname, to address) that must answer a ping when the exercise is done. */
  readonly pings: readonly { readonly from: string; readonly to: string }[];
  /** Console sessions that show the finished exercise working (for examples/UKAZKA.md). */
  readonly demo: readonly { readonly device: string; readonly commands: readonly string[] }[];
}

/** A console command of an exercise answered with an error (or a cable could not be drawn). */
export class CommandFailed extends Error {
  readonly hostname: string;
  readonly command: string;
  readonly output: string;

  constructor(hostname: string, command: string, output: string) {
    super(`${hostname}: ${command} -> ${output}`);
    this.name = "CommandFailed";
    this.hostname = hostname;
    this.command = command;
    this.output = output;
  }

  get description(): string {
    return `${this.hostname}: ${this.command} -> ${this.output}`;
  }
}

// MARK: Helpers

function deviceNamed(project: Project, hostname: string): Device | undefined {
  return project.devices.find((device) => device.hostname === hostname);
}

/** The port with exactly this full name, or failing that this short name. */
function refOfPort(device: Device, name: string): PortRef | null {
  const port =
    device.ports.find((candidate) => candidate.name === name) ??
    device.ports.find((candidate) => PortNaming.shortName(candidate.name) === name);
  return port ? { deviceID: device.id, portID: port.id } : null;
}

function cable(
  store: ProjectStoreAPI,
  hostA: string,
  portA: string,
  hostB: string,
  portB: string,
  cableType: CableType = "straight",
): void {
  const deviceA = deviceNamed(store.project, hostA);
  const deviceB = deviceNamed(store.project, hostB);
  const a = deviceA ? refOfPort(deviceA, portA) : null;
  const b = deviceB ? refOfPort(deviceB, portB) : null;
  if (!a || !b) throw new CommandFailed(hostA, `cable ${portA} - ${hostB} ${portB}`, "no such port");
  store.connect(a, b, cableType);
}

const failureMarkers = [
  "% ",
  "%I",
  "bad command",
  "invalid value",
  "missing value",
  "failure",
  "Invalid Command",
  "Usage:",
  "expected end",
  "no such item",
  "not found",
  "parameter is incorrect",
];

/** Types the lines into the device's console; any error message aborts the build. */
function typeLines(store: ProjectStoreAPI, device: Device, lines: readonly string[]): void {
  const session = new CLISession(store, device.id);
  for (const line of lines) {
    const output = session.execute(line);
    if (failureMarkers.some((marker) => output.includes(marker))) {
      const hostname = store.project.devices.find((item) => item.id === device.id)?.hostname ?? device.hostname;
      throw new CommandFailed(hostname, line, output);
    }
  }
}

// MARK: 1. Four multivendor switches

const multivendorSwitches: Exercise = {
  fileName: "cviceni-1-multivendor-switche.netsketch",
  title: "Cvičení 1: komunikace čtyř multivendor switchů",
  build: (store) => {
    store.snapToGrid = true;
    store.gridSize = 20;
    store.renameProject("Cvičení 1 – multivendor switche");
    const sw1 = store.addDevice("cisco-catalyst-2960-24", { x: 420, y: 260 }, "SW1-CISCO");
    const sw2 = store.addDevice("dell-s3048-on", { x: 1300, y: 260 }, "SW2-DELL");
    const sw3 = store.addDevice("mikrotik-crs-generic", { x: 1300, y: 640 }, "SW3-MIKROTIK");
    const sw4 = store.addDevice("ubiquiti-unifi-switch-24", { x: 420, y: 640 }, "SW4-UBIQUITI");
    const pc1 = store.addDevice("generic-pc", { x: 220, y: 960 }, "PC1");
    const pc2 = store.addDevice("generic-pc", { x: 620, y: 960 }, "PC2");

    cable(store, "SW1-CISCO", "Gi0/1", "SW2-DELL", "GigabitEthernet 1/1");
    cable(store, "SW2-DELL", "GigabitEthernet 1/2", "SW3-MIKROTIK", "ether1");
    cable(store, "SW3-MIKROTIK", "ether2", "SW4-UBIQUITI", "Port 1");
    cable(store, "PC1", "eth0", "SW1-CISCO", "Fa0/1");
    cable(store, "PC2", "eth0", "SW4-UBIQUITI", "Port 2");

    typeLines(store, sw1, [
      "enable",
      "configure terminal",
      "interface vlan 1",
      "ip address 192.168.10.1 255.255.255.0",
      "no shutdown",
      "exit",
      "interface gi0/1",
      "description Trunk na SW2-DELL",
      "exit",
      "interface fa0/1",
      "description PC1",
      "end",
    ]);
    typeLines(store, sw2, [
      "enable",
      "configure",
      "interface vlan 1",
      "ip address 192.168.10.2/24",
      "no shutdown",
      "exit",
      "interface gigabitethernet 1/1",
      "description Uplink SW1-CISCO",
      "no shutdown",
      "exit",
      "interface gigabitethernet 1/2",
      "description Downlink SW3-MIKROTIK",
      "no shutdown",
      "end",
    ]);
    typeLines(store, sw3, [
      "/ip address add address=192.168.10.3/24 interface=bridge",
      "/interface ethernet set ether1 comment=SW2-DELL",
      "/interface ethernet set ether2 comment=SW4-UBIQUITI",
    ]);
    typeLines(store, sw4, [
      "enable",
      "configure terminal",
      "interface vlan 1",
      "ip address 192.168.10.4 255.255.255.0",
      "exit",
      "interface Port 2",
      "description PC2",
      "end",
    ]);
    typeLines(store, pc1, ["netsh interface ip set address eth0 static 192.168.10.101 255.255.255.0"]);
    typeLines(store, pc2, ["netsh interface ip set address eth0 static 192.168.10.102 255.255.255.0"]);

    store.addAnnotation(
      [
        "Cvičení 1: čtyři switche různých výrobců v jedné síti 192.168.10.0/24 (VLAN 1).",
        "SW1 .1 (Cisco IOS), SW2 .2 (Dell OS9), SW3 .3 (MikroTik RouterOS), SW4 .4 (Ubiquiti), PC1 .101, PC2 .102.",
        "Ověření: konzole PC1 -> ping 192.168.10.102, konzole SW1 -> ping 192.168.10.3.",
      ].join("\n"),
      { x: 120, y: 40 },
    );
    store.viewMode = "physical";
  },
  pings: [
    { from: "PC1", to: "192.168.10.102" },
    { from: "PC2", to: "192.168.10.101" },
    { from: "SW1-CISCO", to: "192.168.10.2" },
    { from: "SW1-CISCO", to: "192.168.10.3" },
    { from: "SW1-CISCO", to: "192.168.10.4" },
    { from: "SW2-DELL", to: "192.168.10.4" },
    { from: "SW3-MIKROTIK", to: "192.168.10.1" },
    { from: "SW4-UBIQUITI", to: "192.168.10.101" },
  ],
  demo: [
    { device: "PC1", commands: ["ipconfig", "ping 192.168.10.102"] },
    { device: "SW1-CISCO", commands: ["enable", "show ip interface brief", "ping 192.168.10.3"] },
    { device: "SW2-DELL", commands: ["enable", "show ip route", "ping 192.168.10.4"] },
    { device: "SW3-MIKROTIK", commands: ["/ip address print", "/ping 192.168.10.101 count=3"] },
  ],
};

// MARK: 2. Four routers with static routing

const fourRouters: Exercise = {
  fileName: "cviceni-2-ctyri-routery.netsketch",
  title: "Cvičení 2: čtyři routery a statické směrování",
  build: (store) => {
    store.snapToGrid = true;
    store.gridSize = 20;
    store.renameProject("Cvičení 2 – čtyři routery");
    const r1 = store.addDevice("cisco-isr-4321", { x: 300, y: 300 }, "R1-CISCO");
    const r2 = store.addDevice("mikrotik-hap-lite", { x: 760, y: 300 }, "R2-MIKROTIK");
    const r3 = store.addDevice("ubiquiti-udm-pro", { x: 1260, y: 300 }, "R3-UBIQUITI");
    const r4 = store.addDevice("cisco-isr-4321", { x: 1800, y: 300 }, "R4-CISCO");
    const pc1 = store.addDevice("generic-pc", { x: 300, y: 640 }, "PC1");
    const pc2 = store.addDevice("generic-pc", { x: 1800, y: 640 }, "PC2");

    cable(store, "PC1", "eth0", "R1-CISCO", "Gi0/0/0", "straight");
    cable(store, "R1-CISCO", "Gi0/0/1", "R2-MIKROTIK", "ether1", "crossover");
    cable(store, "R2-MIKROTIK", "ether2", "R3-UBIQUITI", "LAN 1", "crossover");
    cable(store, "R3-UBIQUITI", "LAN 2", "R4-CISCO", "Gi0/0/1", "crossover");
    cable(store, "R4-CISCO", "Gi0/0/0", "PC2", "eth0", "straight");

    typeLines(store, r1, [
      "enable",
      "configure terminal",
      "interface gi0/0/0",
      "description LAN PC1",
      "ip address 192.168.1.1 255.255.255.0",
      "no shutdown",
      "exit",
      "interface gi0/0/1",
      "description R2-MIKROTIK",
      "ip address 10.0.12.1 255.255.255.252",
      "no shutdown",
      "exit",
      "ip route 0.0.0.0 0.0.0.0 10.0.12.2",
      "end",
    ]);
    typeLines(store, r2, [
      "/ip address add address=10.0.12.2/30 interface=ether1",
      "/ip address add address=10.0.23.1/30 interface=ether2",
      "/ip route add dst-address=192.168.1.0/24 gateway=10.0.12.1",
      "/ip route add dst-address=192.168.4.0/24 gateway=10.0.23.2",
      "/ip route add dst-address=10.0.34.0/30 gateway=10.0.23.2",
    ]);
    typeLines(store, r3, [
      "enable",
      "configure terminal",
      "interface LAN 1",
      "ip address 10.0.23.2 255.255.255.252",
      "exit",
      "interface LAN 2",
      "ip address 10.0.34.1 255.255.255.252",
      "exit",
      "ip route 192.168.4.0 255.255.255.0 10.0.34.2",
      "ip route 192.168.1.0 255.255.255.0 10.0.23.1",
      "ip route 10.0.12.0 255.255.255.252 10.0.23.1",
      "end",
    ]);
    typeLines(store, r4, [
      "enable",
      "configure terminal",
      "interface gi0/0/0",
      "description LAN PC2",
      "ip address 192.168.4.1 255.255.255.0",
      "no shutdown",
      "exit",
      "interface gi0/0/1",
      "description R3-UBIQUITI",
      "ip address 10.0.34.2 255.255.255.252",
      "no shutdown",
      "exit",
      "ip route 0.0.0.0 0.0.0.0 10.0.34.1",
      "end",
    ]);
    typeLines(store, pc1, ["netsh interface ip set address eth0 static 192.168.1.10 255.255.255.0 192.168.1.1"]);
    typeLines(store, pc2, ["netsh interface ip set address eth0 static 192.168.4.10 255.255.255.0 192.168.4.1"]);

    store.addAnnotation(
      [
        "Cvičení 2: čtyři routery (Cisco, MikroTik, Ubiquiti, Cisco) a statické směrování.",
        "LAN1 192.168.1.0/24 – R1 – 10.0.12.0/30 – R2 – 10.0.23.0/30 – R3 – 10.0.34.0/30 – R4 – LAN2 192.168.4.0/24.",
        "R1 a R4 mají výchozí trasu, R2 a R3 statické trasy do obou LAN.",
        "Ověření: konzole PC1 -> ping 192.168.4.10, tracert 192.168.4.10; konzole R1 -> show ip route.",
      ].join("\n"),
      { x: 120, y: 40 },
    );
    store.viewMode = "physical";
  },
  pings: [
    { from: "PC1", to: "192.168.4.10" },
    { from: "PC2", to: "192.168.1.10" },
    { from: "R1-CISCO", to: "10.0.34.2" },
    { from: "R2-MIKROTIK", to: "192.168.4.10" },
    { from: "R4-CISCO", to: "10.0.12.1" },
    { from: "PC1", to: "10.0.23.2" },
  ],
  demo: [
    { device: "PC1", commands: ["ipconfig", "ping 192.168.4.10", "tracert 192.168.4.10"] },
    { device: "R1-CISCO", commands: ["enable", "show ip route", "show ip interface brief", "ping 192.168.4.10"] },
    { device: "R2-MIKROTIK", commands: ["/ip address print", "/ip route print", "/ping 192.168.1.10 count=3"] },
    { device: "R3-UBIQUITI", commands: ["enable", "show ip route", "traceroute 192.168.1.10"] },
  ],
};

// MARK: Files, transcripts and checks

const uuidPattern = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;

/**
 * Replaces every UUID, in order of first appearance, by 00000000-0000-4000-8000-000000000001,
 * ...002, and so on.
 */
function stabilizeIdentifiers(text: string): string {
  const mapping = new Map<string, string>();
  return text.replace(uuidPattern, (original) => {
    let stable = mapping.get(original);
    if (stable === undefined) {
      stable = "00000000-0000-4000-8000-" + (mapping.size + 1).toString(16).toUpperCase().padStart(12, "0");
      mapping.set(original, stable);
    }
    return stable;
  });
}

/**
 * The project file (.netsketch JSON text) of a built exercise with stable identifiers: every
 * UUID is replaced, in order of first appearance, by 00000000-0000-4000-8000-000000000001,
 * ...002, and so on. The same exercise code therefore always produces the same file.
 */
function fileData(store: ProjectStoreAPI): string {
  return stabilizeIdentifiers(encodeProject(store.project));
}

/** "name.ext" -> "name" (NSString.deletingPathExtension). */
function deletingPathExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/** The demo sessions of an exercise as Markdown: each device's prompt, commands and answers. */
function demoTranscript(exercise: Exercise, store: ProjectStoreAPI): string {
  let text = `## ${exercise.title}\n\nSoubor: \`examples/${exercise.fileName}\`\n`;
  const image = deletingPathExtension(exercise.fileName);
  text += `\n![${exercise.title}](../docs/screenshots/${image}-fyzicky.png)\n`;
  for (const session of exercise.demo) {
    const device = deviceNamed(store.project, session.device);
    if (!device) continue;
    const cli = new CLISession(store, device.id);
    text += `\n### ${session.device}\n\n\`\`\`\n`;
    for (const command of session.commands) {
      const prompt = cli.prompt;
      const output = cli.execute(command);
      text += prompt + (prompt.endsWith(" ") ? "" : " ") + command + "\n";
      if (output !== "") text += output + "\n";
    }
    text += "```\n";
  }
  return text;
}

/** Runs the exercise's pings in a built project; returns the failures (empty when all pass). */
function failedPings(exercise: Exercise, store: ProjectStoreAPI): string[] {
  const simulator = new NetworkSimulator(store.project);
  const failures: string[] = [];
  for (const ping of exercise.pings) {
    const device = deviceNamed(store.project, ping.from);
    const target = IPv4.parse(ping.to);
    if (!device || !target) {
      failures.push(`${ping.from} -> ${ping.to}: unknown device or address`);
      continue;
    }
    const result = simulator.ping(device.id, target);
    if (!result.success) failures.push(`${ping.from} -> ${ping.to}: ${simulator.explain(result)}`);
  }
  return failures;
}

/** The header of examples/UKAZKA.md, as NetSketchExamples writes it. */
const transcriptHeader =
  "# Ukázka cvičení\n" +
  "\n" +
  "Výstupy konzolí z hotových cvičení, tak jak je vypíše NetSketch (generuje `swift run NetSketchExamples`).\n" +
  "Obrázky diagramů vyrenderuje `NetSketchRender` na macOS.\n";

/**
 * The whole examples/UKAZKA.md as the NetSketchExamples tool writes it: the header, then for
 * every exercise built into a fresh store from `makeStore` its demo transcript.
 */
function fullTranscript(makeStore: () => ProjectStoreAPI): string {
  let transcript = transcriptHeader;
  for (const exercise of all) {
    const store = makeStore();
    exercise.build(store);
    transcript += "\n" + demoTranscript(exercise, store);
  }
  return transcript;
}

const all: readonly Exercise[] = [multivendorSwitches, fourRouters];

/** Ready-made lab exercises and the helpers that check and save them. */
export const Exercises = {
  all,
  multivendorSwitches,
  fourRouters,
  fileData,
  stabilizeIdentifiers,
  demoTranscript,
  failedPings,
  transcriptHeader,
  fullTranscript,
};
