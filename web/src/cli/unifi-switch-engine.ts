// The console of the UniFi Switch 48 (US-48-G1, firmware 7.2.123), modelled on the lab transcript.
//
// Two layers like on the device: an SSH login (`ubnt`) gives a BusyBox shell with `ping`,
// `ifconfig`, `info`, ...; `telnet localhost` enters the switch CLI (FASTPATH/Broadcom style:
// `(UBNT) >`, `(UBNT) #`, `(UBNT) (Config)#`, `(UBNT) (Interface 0/1)#`, `(UBNT) (Vlan)#`).
// The CLI has no `ping`. `exit` in the CLI goes back to the shell, `exit` in the shell closes
// the console. Port names, VLAN membership and the management interface: unifi-switch-model.ts.
//
// Simplifications: the console starts logged in (no password prompt); the CLI warning "valid
// until reboot" is printed, but the configuration lives in the project and `reload`/`reboot`
// do not revert it; there is no MAC learning, so `show mac-addr-table` is empty; the factory
// address 192.168.1.20 is shown by `show network` but only becomes active once it is set.

import { charCount, isNewline, chars, splitCharacters, splitWords, swiftInt, trimWhitespaces } from "./command-tree";
import type { DeviceAccess, PortSnapshot } from "./model-access";
import { CLILimits, Notices } from "./notices";
import type { ConsoleEngine } from "./session";
import { IPv4, IPv4Prefix } from "./sim/ipv4";
import { macAddress } from "./sim/mac";
import { acquireLease, markClient, unmarkClient } from "./features/dhcp/sim";
import { dhcpOf } from "./features/dhcp/model";
import { announcePing, lossNotice, planPing } from "./features/realism/timing";
import { computeSpanningTree } from "./features/layer2/stp";
import { configuredPriority, stpOf, updateSTP } from "./features/layer2/model";
import { readSTPConfig } from "../core/protocols/layer2";
import {
  cliPorts,
  findCliPort,
  forgetVLAN,
  membershipOf,
  mgmtInterface,
  mgmtVLAN,
  project,
  unifiFirmware,
} from "./unifi-switch-model";

type Mode = "shell" | "user" | "priv" | "config" | "interface" | "vlan";

const invalid = "% Invalid input detected at '^' marker.";
const incomplete = "% Incomplete command.";
const validUntilReboot =
  "NOTE: Configuration made in this CLI is valid only until the switch reboots " +
  "(permanent configuration is done in the UniFi controller).";

const shellCommands = [
  "cat", "exit", "hostname", "ifconfig", "info", "ip", "ls", "ping", "pwd", "reboot", "telnet", "uname", "whoami", "help",
];
const userCommands = ["enable", "exit", "logout", "show", "help"];
const privCommands = [
  "configure", "enable", "exit", "logout", "network", "reload", "show", "vlan", "write", "copy", "help",
];
const configCommands = ["exit", "interface", "network", "no", "show", "spanning-tree", "end", "help"];
const interfaceCommands = ["description", "exit", "no", "shutdown", "vlan", "end", "show", "help"];
const vlanCommands = ["exit", "no", "vlan", "show", "help"];

/** Unique-prefix abbreviation of a command word (FASTPATH accepts `conf`, `sh`, ...). */
function resolve(word: string, names: readonly string[]): string | null {
  const lower = word.toLowerCase();
  if (names.includes(lower)) return lower;
  const matches = names.filter((name) => name.startsWith(lower));
  return matches.length === 1 ? matches[0] : null;
}

/** "0/1,0/2,0/3,0/5" -> "0/1-0/3,0/5". */
function portRanges(names: string[]): string {
  const numbers = names.map((name) => Number(name.slice(2)));
  const parts: string[] = [];
  for (let i = 0; i < numbers.length; ) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j += 1;
    parts.push(j > i ? `0/${numbers[i]}-0/${numbers[j]}` : `0/${numbers[i]}`);
    i = j + 1;
  }
  return parts.join(",");
}

function dots(label: string, value: string, width = 44): string {
  return label + ".".repeat(Math.max(3, width - label.length)) + " " + value;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text + " " : text + " ".repeat(width - text.length);
}

export class UniFiSwitchEngine implements ConsoleEngine {
  private readonly access: DeviceAccess;
  private closed = false;
  private mode: Mode = "shell";
  private interfaceName = "";
  private lastHostname: string;

  constructor(access: DeviceAccess) {
    this.access = access;
    this.lastHostname = access.hostname;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get hostname(): string {
    const device = this.access.device;
    if (device) this.lastHostname = device.hostname;
    return this.lastHostname;
  }

  get banner(): string {
    const model = [this.access.vendor, this.access.model].filter((part) => part !== "").join(" ");
    return [
      Notices.banner(this.hostname, model, "UniFi Switch (BusyBox + FASTPATH CLI)", false),
      "",
      `UniFi Switch 48 (US-48-G1), firmware ${unifiFirmware}. Přihlášen uživatel ubnt; CLI přepínače: telnet localhost`,
    ].join("\n");
  }

  get prompt(): string {
    switch (this.mode) {
      case "shell":
        return `US.v${unifiFirmware}# `;
      case "user":
        return "(UBNT) >";
      case "priv":
        return "(UBNT) #";
      case "config":
        return "(UBNT) (Config)#";
      case "interface":
        return `(UBNT) (Interface ${this.interfaceName})#`;
      case "vlan":
        return "(UBNT) (Vlan)#";
    }
  }

  // MARK: Execution

  execute(line: string): string {
    if (chars(line).some(isNewline)) {
      const outputs = splitCharacters(line, isNewline).map((part) => this.execute(part));
      return outputs.filter((output) => output !== "").join("\n");
    }
    if (this.closed) return "";
    if (!this.access.exists) {
      this.closed = true;
      return Notices.deviceGone;
    }
    if (charCount(line) > CLILimits.maxLineLength) return Notices.lineTooLong;
    const trimmed = trimWhitespaces(line);
    if (trimmed === "") return "";
    if (trimmed.endsWith("?")) return this.help(line.slice(0, line.lastIndexOf("?")));
    const words = splitWords(trimmed);
    return this.mode === "shell" ? this.shell(words) : this.cli(words);
  }

  complete(partial: string): string[] {
    const words = splitWords(partial);
    if (words.length > 1 || partial.endsWith(" ")) return [];
    const prefix = (words[0] ?? "").toLowerCase();
    return this.commandNames().filter((name) => name.startsWith(prefix));
  }

  help(partial: string): string {
    const words = splitWords(partial);
    if (words.length > 1 || partial.endsWith(" ")) return "";
    const prefix = (words[0] ?? "").toLowerCase();
    return this.commandNames().filter((name) => name.startsWith(prefix)).join("\n");
  }

  private commandNames(): readonly string[] {
    switch (this.mode) {
      case "shell":
        return shellCommands;
      case "user":
        return userCommands;
      case "priv":
        return privCommands;
      case "config":
        return configCommands;
      case "interface":
        return interfaceCommands;
      case "vlan":
        return vlanCommands;
    }
  }

  // MARK: Shell (BusyBox)

  private shell(words: string[]): string {
    const name = words[0];
    const args = words.slice(1);
    switch (name) {
      case "exit":
      case "logout":
        this.closed = true;
        return "";
      case "telnet":
        if (args[0] === "localhost" || args[0] === "127.0.0.1") {
          this.mode = "user";
          return [
            "Trying 127.0.0.1...",
            "Connected to localhost.",
            "Escape character is '^]'.",
            "",
            validUntilReboot,
          ].join("\n");
        }
        return args[0] === undefined ? "telnet: usage: telnet HOST [PORT]" : `telnet: can't connect to remote host (${args[0]}): Connection refused`;
      case "ping":
        return this.shellPing(args);
      case "ifconfig":
        return this.ifconfig();
      case "ip":
        return args[0] === "a" || args[0] === "addr" || args[0] === "address" ? this.ifconfigIP() : "ip: only `ip a` is available here";
      case "info":
        return this.info();
      case "ls":
        return args.length === 0 || args[0] === "/" ? "bin  dev  etc  lib  proc  sbin  sys  tmp  usr  var" : "";
      case "pwd":
        return "/";
      case "whoami":
        return "ubnt";
      case "hostname":
        return "UBNT";
      case "uname":
        return args[0] === "-a" ? `Linux UBNT 4.14.76 #1 SMP PREEMPT armv7l GNU/Linux` : "Linux";
      case "cat":
        return this.cat(args);
      case "reboot":
        return "NetSketch: přepínač se nerestartuje, konfigurace je součástí projektu. Nic se nezměnilo.";
      case "help":
        return shellCommands.join("  ");
      default:
        return `-sh: ${name}: not found`;
    }
  }

  private cat(args: string[]): string {
    const file = args[0];
    if (file === undefined) return "";
    switch (file) {
      case "/etc/version":
      case "/etc/version.txt":
        return `US.v${unifiFirmware}`;
      case "/etc/hostname":
        return "UBNT";
      case "/proc/version":
        return "Linux version 4.14.76 (builder) #1 SMP PREEMPT";
      default:
        return `cat: can't open '${file}': No such file or directory`;
    }
  }

  private mgmtPrefix(): IPv4Prefix | null {
    return this.access.address(mgmtInterface(mgmtVLAN(this.access)));
  }

  private mac(): string {
    const first = this.access.device?.ports[0]?.id ?? this.access.deviceID;
    return macAddress(first, "colon").toLowerCase();
  }

  private ifconfig(): string {
    const vlan = mgmtVLAN(this.access);
    const prefix = this.mgmtPrefix();
    const lines = [`${vlan === 1 ? "switch0" : `switch0.${vlan}`}  Link encap:Ethernet  HWaddr ${this.mac().toUpperCase()}`];
    if (prefix) {
      lines.push(`          inet addr:${prefix.address.description}  Bcast:${prefix.broadcast.description}  Mask:${prefix.mask.description}`);
    }
    lines.push("          UP BROADCAST RUNNING MULTICAST  MTU:1500  Metric:1", "", "lo        Link encap:Local Loopback", "          inet addr:127.0.0.1  Mask:255.0.0.0", "          UP LOOPBACK RUNNING  MTU:65536  Metric:1");
    return lines.join("\n");
  }

  private ifconfigIP(): string {
    const vlan = mgmtVLAN(this.access);
    const prefix = this.mgmtPrefix();
    const lines = [
      "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536",
      "    inet 127.0.0.1/8 scope host lo",
      `2: ${vlan === 1 ? "switch0" : `switch0.${vlan}`}: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500`,
      `    link/ether ${this.mac()} brd ff:ff:ff:ff:ff:ff`,
    ];
    if (prefix) lines.push(`    inet ${prefix.description.replace(/^[^/]+/, prefix.address.description)} brd ${prefix.broadcast.description} scope global switch0`);
    return lines.join("\n");
  }

  private info(): string {
    const prefix = this.mgmtPrefix();
    return [
      "",
      "Model:       US-48-G1",
      `Version:     ${unifiFirmware}`,
      `MAC Address: ${this.mac()}`,
      `IP Address:  ${prefix ? prefix.address.description : "192.168.1.20"}`,
      "Hostname:    UBNT",
      "Uptime:      1 days, 0:00",
      "",
      "Status:      Unknown (http://192.168.1.20:8080/inform)",
    ].join("\n");
  }

  private shellPing(args: string[]): string {
    let count = 4;
    let target: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-c") {
        const value = swiftInt(args[i + 1] ?? "");
        if (value === null || value < 1) return `ping: invalid number '${args[i + 1] ?? ""}'`;
        count = Math.min(value, 100);
        i += 1;
      } else if (!args[i].startsWith("-")) {
        target = args[i];
      }
    }
    if (target === undefined) return "BusyBox v1.25.1 multi-call binary.\n\nUsage: ping [OPTIONS] HOST";
    const destination = IPv4.parse(target);
    if (destination === null) return `ping: bad address '${target}'`;
    const simulator = this.access.simulator;
    const result = simulator.ping(this.access.deviceID, destination);
    const plan = planPing(simulator, this.access.deviceID, destination, result, count);
    announcePing(this.access.deviceID, result, plan);
    const lines = [`PING ${destination.description} (${destination.description}): 56 data bytes`];
    const ttl = Math.max(1, 64 - (plan.active ? plan.routersOnReturn : Math.max(0, result.hopCount - 1)));
    let received = 0;
    const times: number[] = [];
    for (let seq = 0; seq < count; seq++) {
      const sample = plan.active ? plan.samples[seq] : undefined;
      const lost = plan.active ? (sample?.lost ?? true) : !result.success;
      if (lost) continue;
      received += 1;
      const rtt = sample ? sample.rtt : 0.5;
      times.push(rtt);
      lines.push(`64 bytes from ${destination.description}: seq=${seq} ttl=${ttl} time=${rtt.toFixed(3)} ms`);
    }
    lines.push("", `--- ${destination.description} ping statistics ---`);
    lines.push(`${count} packets transmitted, ${received} packets received, ${Math.trunc(((count - received) * 100) / count)}% packet loss`);
    if (received > 0) {
      const min = Math.min(...times);
      const max = Math.max(...times);
      const avg = times.reduce((sum, value) => sum + value, 0) / times.length;
      lines.push(`round-trip min/avg/max = ${min.toFixed(3)}/${avg.toFixed(3)}/${max.toFixed(3)} ms`);
    } else {
      const reason = simulator.explain(result);
      if (reason !== "") lines.push(reason);
    }
    const lost = lossNotice(plan);
    if (lost !== "") lines.push(lost);
    return lines.join("\n");
  }

  // MARK: Switch CLI

  private cli(words: string[]): string {
    const command = resolve(words[0], this.commandNames());
    if (command === null) return invalid;
    const args = words.slice(1);
    if (command === "help") return this.help("");
    if (command === "show") return this.show(args);
    switch (this.mode) {
      case "user":
        return this.userMode(command);
      case "priv":
        return this.privMode(command, args);
      case "config":
        return this.configMode(command, args);
      case "interface":
        return this.interfaceMode(command, args);
      case "vlan":
        return this.vlanMode(command, args);
      default:
        return invalid;
    }
  }

  private userMode(command: string): string {
    switch (command) {
      case "enable":
        this.mode = "priv";
        return "";
      case "exit":
      case "logout":
        this.mode = "shell";
        return "";
      default:
        return invalid;
    }
  }

  private privMode(command: string, args: string[]): string {
    switch (command) {
      case "enable":
        return "";
      case "exit":
      case "logout":
        this.mode = "user";
        return "";
      case "configure":
        this.mode = "config";
        return "";
      case "vlan":
        if (resolve(args[0] ?? "", ["database"]) !== "database") return args.length === 0 ? incomplete : invalid;
        this.mode = "vlan";
        return "";
      case "network":
        return this.network(args);
      case "write":
        if (resolve(args[0] ?? "", ["memory"]) !== "memory") return args.length === 0 ? incomplete : invalid;
        return ["", "This operation may take a few minutes.", "Management interfaces will not be available during this time.", "", "Configuration Saved!", validUntilReboot].join("\n");
      case "copy":
        return ["Configuration Saved!", validUntilReboot].join("\n");
      case "reload":
        return "NetSketch: přepínač se nerestartuje, konfigurace je součástí projektu. Nic se nezměnilo.";
      default:
        return invalid;
    }
  }

  private configMode(command: string, args: string[]): string {
    switch (command) {
      case "exit":
        this.mode = "priv";
        return "";
      case "end":
        this.mode = "priv";
        return "";
      case "network":
        return this.network(args);
      case "interface": {
        const name = args[0];
        if (name === undefined) return incomplete;
        const found = findCliPort(this.access, name);
        if (!found) return `Error: Invalid interface ${name}.`;
        this.interfaceName = found.name;
        this.mode = "interface";
        return "";
      }
      case "spanning-tree":
        return this.spanningTree(args, false);
      case "no":
        if (resolve(args[0] ?? "", ["spanning-tree"]) === "spanning-tree") return this.spanningTree(args.slice(1), true);
        return invalid;
      default:
        return invalid;
    }
  }

  private vlanMode(command: string, args: string[]): string {
    switch (command) {
      case "exit":
        this.mode = "priv";
        return "";
      case "vlan": {
        if (args[0]?.toLowerCase() === "name") return this.setVLANName(args.slice(1));
        return this.createVLAN(args[0]);
      }
      case "no":
        if (args[0]?.toLowerCase() !== "vlan") return invalid;
        return this.deleteVLAN(args[1]);
      default:
        return invalid;
    }
  }

  private parseVLAN(text: string | undefined): number | null {
    if (text === undefined || !/^[0-9]{1,4}$/.test(text)) return null;
    const value = Number(text);
    return value >= 1 && value <= 4093 ? value : null;
  }

  private createVLAN(text: string | undefined): string {
    if (text === undefined) return incomplete;
    const id = this.parseVLAN(text);
    if (id === null) return "Error: VLAN ID must be in the range 1-4093.";
    if (id === 1) return "Error: VLAN 1 is the default VLAN and already exists.";
    if (this.access.vlans.some((entry) => entry.id === id)) return "";
    this.access.setVLANs([...this.access.vlans, { id, name: "" }]);
    return "";
  }

  private setVLANName(args: string[]): string {
    if (args.length < 2) return incomplete;
    const id = this.parseVLAN(args[0]);
    if (id === null) return "Error: VLAN ID must be in the range 1-4093.";
    const name = args.slice(1).join(" ").replace(/^"(.*)"$/, "$1");
    if (name.length > 32) return "Error: VLAN name is too long (maximum 32 characters).";
    if (id === 1) return "Error: The name of the default VLAN cannot be changed.";
    const vlans = this.access.vlans;
    if (!vlans.some((entry) => entry.id === id)) return "Error: This VLAN does not exist.";
    this.access.setVLANs(vlans.map((entry) => (entry.id === id ? { ...entry, name } : entry)));
    return "";
  }

  private deleteVLAN(text: string | undefined): string {
    if (text === undefined) return incomplete;
    const id = this.parseVLAN(text);
    if (id === null) return "Error: VLAN ID must be in the range 1-4093.";
    if (id === 1) return "Error: The default VLAN cannot be deleted.";
    const vlans = this.access.vlans;
    if (!vlans.some((entry) => entry.id === id)) return "Error: This VLAN does not exist.";
    this.access.transaction(() => {
      this.access.setVLANs(vlans.filter((entry) => entry.id !== id));
      forgetVLAN(this.access, id);
    });
    return "";
  }

  // MARK: Interface mode

  private interfaceMode(command: string, args: string[]): string {
    const found = findCliPort(this.access, this.interfaceName);
    if (!found) {
      this.mode = "config";
      return Notices.interfaceGone;
    }
    const portID = found.port.id;
    switch (command) {
      case "exit":
        this.mode = "config";
        return "";
      case "end":
        this.mode = "priv";
        return "";
      case "shutdown":
        this.access.setAdminDown(true, portID);
        return "";
      case "description":
        this.access.setDescription(args.join(" ").replace(/^"(.*)"$/, "$1"), portID);
        return "";
      case "no":
        if (args[0]?.toLowerCase() === "shutdown") {
          this.access.setAdminDown(false, portID);
          return "";
        }
        if (args[0]?.toLowerCase() === "vlan") return this.interfaceVLAN(portID, args.slice(1), true);
        return invalid;
      case "vlan":
        return this.interfaceVLAN(portID, args, false);
      default:
        return invalid;
    }
  }

  private interfaceVLAN(portID: string, args: string[], negated: boolean): string {
    const device = this.access.device;
    if (!device) return Notices.deviceGone;
    const sub = resolve(args[0] ?? "", ["participation", "tagging", "pvid"]);
    if (sub === null) return args.length === 0 ? incomplete : invalid;
    const state = membershipOf(device, portID);
    const exists = (id: number) => id === 1 || device.vlans.some((entry) => entry.id === id);
    switch (sub) {
      case "participation": {
        const kind = resolve(args[1] ?? "", ["include", "exclude", "auto"]);
        if (kind === null) return args.length < 2 ? incomplete : invalid;
        const id = this.parseVLAN(args[2]);
        if (args[2] === undefined) return incomplete;
        if (id === null) return "Error: VLAN ID must be in the range 1-4093.";
        if (!exists(id)) return "Error: This VLAN does not exist.";
        if (kind === "exclude") {
          state.members.delete(id);
        } else if (!state.members.has(id)) {
          state.members.set(id, "untagged");
        }
        break;
      }
      case "tagging": {
        const id = this.parseVLAN(args[1]);
        if (args[1] === undefined) return incomplete;
        if (id === null) return "Error: VLAN ID must be in the range 1-4093.";
        if (!exists(id)) return "Error: This VLAN does not exist.";
        if (!state.members.has(id)) return "Error: The port must participate in the VLAN before tagging is changed.";
        state.members.set(id, negated ? "untagged" : "tagged");
        break;
      }
      case "pvid": {
        if (negated) {
          state.pvid = 1;
          break;
        }
        const id = this.parseVLAN(args[1]);
        if (args[1] === undefined) return incomplete;
        if (id === null) return "Error: VLAN ID must be in the range 1-4093.";
        if (!exists(id)) return "Error: This VLAN does not exist.";
        state.pvid = id;
        break;
      }
    }
    project(this.access, portID, state);
    return "";
  }

  // MARK: Spanning tree

  private spanningTree(args: string[], negated: boolean): string {
    const first = args[0]?.toLowerCase();
    if (first === undefined) {
      updateSTP(this.access, (config) => {
        config.mode = negated ? "none" : "rstp";
      });
      return "";
    }
    if (first === "mst") {
      if (negated) return invalid;
      if (args[1]?.toLowerCase() !== "priority") return invalid;
      if (args.length < 4) return incomplete;
      const instance = swiftInt(args[2]);
      const priority = swiftInt(args[3]);
      if (instance === null || instance < 0 || instance > 4094) return "Error: MST instance ID must be in the range 0-4094.";
      if (priority === null || priority < 0 || priority > 61440 || priority % 4096 !== 0) {
        return "Error: Priority must be a multiple of 4096 in the range 0-61440.";
      }
      if (instance !== 0) return "NetSketch: jen instance 0 (CST) se v simulaci používá, nic se nezměnilo.";
      updateSTP(this.access, (config) => {
        if (config.mode === "pvst") config.mode = "rstp";
        config.priorities = [...config.priorities.filter((entry) => entry.vlan !== 0), { vlan: 0, priority }];
      });
      return "";
    }
    return invalid;
  }

  // MARK: Management interface

  private network(args: string[]): string {
    const sub = resolve(args[0] ?? "", ["parms", "mgmt_vlan"]);
    if (sub === null) return args.length === 0 ? incomplete : invalid;
    if (sub === "mgmt_vlan") return this.mgmtVLANCommand(args[1]);
    return this.networkParms(args.slice(1));
  }

  private networkParms(args: string[]): string {
    if (args.length < 2) return incomplete;
    const prefix = IPv4Prefix.fromAddressMask(args[0], args[1]);
    if (prefix === null) return "Error: Invalid IP address or subnet mask.";
    const gateway = args[2] === undefined ? null : IPv4.parse(args[2]);
    if (args[2] !== undefined && gateway === null) return "Error: Invalid gateway address.";
    const interfaceID = mgmtInterface(mgmtVLAN(this.access));
    const conflict = this.access.addressConflict(prefix.address, interfaceID);
    if (conflict !== null) return `Error: The address ${prefix.address.description} is already used by ${conflict}.`;
    this.access.transaction(() => {
      unmarkClient(this.access, interfaceID);
      this.access.setAddress(prefix, interfaceID);
      this.access.setDefaultGateway(gateway);
    });
    return "";
  }

  private mgmtVLANCommand(text: string | undefined): string {
    if (text === undefined) return incomplete;
    const id = this.parseVLAN(text);
    if (id === null) return "Error: Management VLAN ID must be in the range 1-4093.";
    const old = mgmtVLAN(this.access);
    const interfaceID = mgmtInterface(id);
    const device = this.access.device;
    const hasDHCP = dhcpOf(device)?.clients.includes(interfaceID) ?? false;
    if (old === id && (hasDHCP || this.access.address(interfaceID) !== null)) return "";
    let failure: string | null = null;
    this.access.transaction(() => {
      const oldID = mgmtInterface(old);
      unmarkClient(this.access, oldID);
      this.access.setAddress(null, oldID);
      this.access.setDefaultGateway(null);
      markClient(this.access, interfaceID);
      const outcome = acquireLease(this.access, interfaceID);
      if (outcome.kind === "failed") failure = outcome.reason;
    });
    if (failure === null) return "";
    return `NetSketch: management VLAN je ${id}, adresu zatím nikdo nepřidělil přes DHCP – ${failure}`;
  }

  // MARK: show

  private show(args: string[]): string {
    const sub = resolve(args[0] ?? "", [
      "vlan", "spanning-tree", "port", "network", "running-config", "mac-addr-table", "interface", "version", "hardware",
    ]);
    if (sub === null) return args.length === 0 ? incomplete : invalid;
    switch (sub) {
      case "vlan":
        return this.showVLAN(args.slice(1));
      case "spanning-tree":
        return this.showSpanningTree();
      case "port":
        return resolve(args[1] ?? "", ["all"]) === "all" ? this.showPortAll() : args.length < 2 ? incomplete : invalid;
      case "network":
        return this.showNetwork();
      case "running-config":
        return this.runningConfig();
      case "mac-addr-table":
        return this.showMACTable();
      case "interface":
        return resolve(args[1] ?? "", ["status"]) === "status" ? this.showInterfaceStatus() : args.length < 2 ? incomplete : invalid;
      case "version":
      case "hardware":
        return [dots("System Description", "UniFi Switch 48"), dots("Machine Model", "US-48-G1"), dots("Software Version", unifiFirmware)].join("\n");
      default:
        return invalid;
    }
  }

  private vlanName(id: number): string {
    return id === 1 ? "default" : (this.access.vlans.find((entry) => entry.id === id)?.name ?? "");
  }

  private allVLANIDs(): number[] {
    return [...new Set([1, ...this.access.vlans.map((entry) => entry.id)])].sort((a, b) => a - b);
  }

  private showVLAN(args: string[]): string {
    const device = this.access.device;
    if (!device) return Notices.deviceGone;
    const sub = args[0] === undefined ? "" : resolve(args[0], ["brief", "port", "id"]);
    if (sub === null) return invalid;
    if (sub === "port") {
      const name = args[1];
      if (name === undefined) return incomplete;
      const found = findCliPort(this.access, name);
      if (!found) return `Error: Invalid interface ${name}.`;
      const state = membershipOf(device, found.port.id);
      const lines = [
        dots("Port VLAN ID", `${state.pvid}`),
        dots("Port Acceptable Frame Types", "Admit All"),
        dots("Port Ingress Filtering", "Disable"),
        dots("Port Default Priority", "0"),
        "",
        "VLAN ID  VLAN Name                         Participation  Tagging",
        "-------  --------------------------------  -------------  --------",
      ];
      for (const id of this.allVLANIDs()) {
        const tagging = state.members.get(id);
        lines.push(
          pad(`${id}`, 9) + pad(this.vlanName(id), 34) + pad(tagging ? "Include" : "Forbidden", 15) + (tagging === "tagged" ? "Tagged" : "Untagged"),
        );
      }
      return lines.join("\n");
    }
    const withPorts = sub === "";
    const lines = [
      withPorts ? "VLAN ID  VLAN Name                         VLAN Type  Interface(s)" : "VLAN ID  VLAN Name                         VLAN Type",
      withPorts ? "-------  --------------------------------  ---------  ------------" : "-------  --------------------------------  ---------",
    ];
    const ports = cliPorts(this.access);
    for (const id of this.allVLANIDs()) {
      let row = pad(`${id}`, 9) + pad(this.vlanName(id), 34) + (id === 1 ? "Default" : "Static");
      if (withPorts) {
        const members = ports.filter((entry) => membershipOf(device, entry.port.id).members.has(id)).map((entry) => entry.name);
        row = pad(row, 54) + portRanges(members);
      }
      lines.push(row.trimEnd());
    }
    return lines.join("\n");
  }

  private showSpanningTree(): string {
    const device = this.access.device;
    if (!device) return Notices.deviceGone;
    const config = readSTPConfig(device.protocols?.stp ?? {});
    const mode = config?.mode ?? "pvst";
    if (mode === "none") return "Spanning tree is disabled.";
    const info = computeSpanningTree(this.access.store.project).get(device.id);
    const priority = configuredPriority(stpOf(device), 0) ?? info?.priority ?? 32768;
    const ports = cliPorts(this.access);
    const lines = [
      dots("Spanning Tree Adminmode", "Enabled"),
      dots("Spanning Tree Version", mode === "stp" ? "IEEE 802.1D" : mode === "mst" ? "IEEE 802.1s" : "IEEE 802.1w"),
      dots("Configuration Name", this.mac().toUpperCase()),
      dots("Bridge Priority", `${priority}`),
      dots("Bridge Identifier", info?.bridgeID ?? `${priority}.${this.mac()}`),
    ];
    if (info) {
      lines.push(dots("Root Bridge Identifier", info.rootBridgeID), dots("Root Path Cost", `${info.rootCost}`));
      const rootPort = info.rootPortID ? ports.find((entry) => entry.port.id === info.rootPortID)?.name : undefined;
      lines.push(dots("Root Port", info.isRoot ? "This switch is the root bridge" : (rootPort ?? "-")));
      lines.push("", "Interface  State        Cost", "---------  -----------  ---------");
      for (const entry of ports) {
        const port = info.ports.find((candidate) => candidate.portID === entry.port.id);
        if (!port) continue;
        const state = port.state === "forwarding" ? "Forwarding" : port.state === "blocking" ? "Discarding" : port.state === "learning" ? "Learning" : "Disabled";
        lines.push(pad(entry.name, 11) + pad(state, 13) + port.cost);
      }
    }
    return lines.join("\n");
  }

  private showPortAll(): string {
    const lines = [
      "                 Admin   Physical   Physical   Link    Link    LACP",
      "Intf   Type      Mode    Mode       Status     Status  Trap    Mode",
      "------ --------- ------- ---------- ---------- ------- ------- -------",
    ];
    for (const { name, port } of cliPorts(this.access)) {
      const up = port.linkState === "up";
      lines.push(
        pad(name, 7) + pad(port.connector === "RJ45" ? "" : port.connector, 10) + pad(port.adminDown ? "Disable" : "Enable", 8) +
          pad("Auto", 11) + pad(up ? this.speedText(port) : "", 11) + pad(up ? "Up" : "Down", 8) + pad("Enable", 8) + "Enable",
      );
    }
    return lines.join("\n");
  }

  private speedText(port: PortSnapshot): string {
    const speed = port.speed === "" ? "1000" : port.speed.replace(/G/i, "000").replace(/M/i, "");
    return `${speed} Full`;
  }

  private showInterfaceStatus(): string {
    const device = this.access.device;
    const lines = [
      "Port   Name                  Link     State    Speed        VLAN",
      "------ --------------------- -------- -------- ------------ -----",
    ];
    for (const { name, port } of cliPorts(this.access)) {
      const state = device ? membershipOf(device, port.id) : null;
      lines.push(
        pad(name, 7) + pad(port.description, 22) + pad(port.linkState === "up" ? "Up" : "Down", 9) +
          pad(port.adminDown ? "Disabled" : "Enabled", 9) + pad(port.linkState === "up" ? this.speedText(port) : "", 13) + (state ? state.pvid : 1),
      );
    }
    return lines.join("\n");
  }

  private showNetwork(): string {
    const vlan = mgmtVLAN(this.access);
    const interfaceID = mgmtInterface(vlan);
    const prefix = this.mgmtPrefix();
    const dhcp = dhcpOf(this.access.device)?.clients.includes(interfaceID) ?? false;
    const lines = [
      dots("IP Address", prefix ? prefix.address.description : dhcp ? "0.0.0.0" : "192.168.1.20"),
      dots("Subnet Mask", prefix ? prefix.mask.description : dhcp ? "0.0.0.0" : "255.255.255.0"),
      dots("Default Gateway", this.access.defaultGateway !== "" ? this.access.defaultGateway : dhcp ? "0.0.0.0" : "192.168.1.1"),
      dots("Burned In MAC Address", this.mac().toUpperCase()),
      dots("Network Configuration Protocol Current", dhcp ? "DHCP" : "None"),
      dots("Management VLAN ID", `${vlan}`),
    ];
    if (!prefix && !dhcp) lines.push("NetSketch: tovární adresa je jen zobrazena; aktivní se stane po „network parms“.");
    return lines.join("\n");
  }

  private showMACTable(): string {
    return [
      "Mac Address        Interface   Status",
      "-----------------  ----------  --------",
      "NetSketch: simulace se MAC adresy neučí, tabulka je prázdná.",
    ].join("\n");
  }

  private runningConfig(): string {
    const device = this.access.device;
    if (!device) return Notices.deviceGone;
    const lines = ["!Current Configuration:", "!", `!System Software Version "${unifiFirmware}"`, "!"];
    const vlan = mgmtVLAN(this.access);
    if (vlan !== 1) lines.push(`network mgmt_vlan ${vlan}`);
    const prefix = this.mgmtPrefix();
    if (prefix) {
      lines.push(`network parms ${prefix.address.description} ${prefix.mask.description}${this.access.defaultGateway !== "" ? " " + this.access.defaultGateway : ""}`);
    }
    if (this.access.vlans.length > 0) {
      lines.push("vlan database");
      for (const entry of this.access.vlans) {
        lines.push(`vlan ${entry.id}`);
        if (entry.name !== "") lines.push(`vlan name ${entry.id} "${entry.name}"`);
      }
      lines.push("exit");
    }
    lines.push("configure");
    const stp = stpOf(device);
    const priority = configuredPriority(stp, 0);
    if (stp?.mode === "none") lines.push("no spanning-tree");
    if (priority !== undefined) lines.push(`spanning-tree mst priority 0 ${priority}`);
    for (const { name, port } of cliPorts(this.access)) {
      const state = membershipOf(device, port.id);
      const body: string[] = [];
      if (port.adminDown) body.push("shutdown");
      if (port.description !== "") body.push(`description "${port.description}"`);
      const ids = [...new Set([...state.members.keys(), 1, state.pvid])].sort((a, b) => a - b);
      for (const id of ids) {
        const tagging = state.members.get(id);
        if (id !== 1 && tagging !== undefined) body.push(`vlan participation include ${id}`);
        if (id !== 1 && tagging === "tagged") body.push(`vlan tagging ${id}`);
      }
      if (state.pvid !== 1) body.push(`vlan pvid ${state.pvid}`);
      if (!state.members.has(1)) body.push("vlan participation exclude 1");
      if (body.length > 0) lines.push(`interface ${name}`, ...body, "exit");
    }
    lines.push("exit");
    return lines.join("\n");
  }
}
