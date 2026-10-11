// The command prompt of an end device (PC, server), in the style of the Packet Tracer
// "Command Prompt": `C:\>` (port of NetSketchCLI/HostEngine.swift).
//
// It shows the adapters with their cabling and address, sets the address and the default
// gateway (`netsh interface ip set address ...`, the Windows syntax) and runs `ping` and
// `tracert` through `NetworkSimulator`. Commands that need more than the simulation offers
// (arp, netstat, nslookup, ...) answer with the simulation notice.

import { PortNaming } from "../core/port-naming";
import {
  charCount,
  chars,
  isNewline,
  isWhitespace,
  leftPadded,
  padded,
  splitCharacters,
  splitWords,
  swiftInt,
  trimWhitespaces,
  trimmingTrailingWhitespace,
} from "./command-tree";
import type { DeviceAccess } from "./model-access";
import { CLILimits, Notices } from "./notices";
import type { ConsoleEngine } from "./session";
import { IPv4, IPv4Prefix } from "./sim/ipv4";
import { collectHostCommands } from "./features/host-commands";
import {
  announcePing,
  announceTraceroute,
  lossNotice,
  planPing,
  planTraceroute,
  tracerouteAnswered,
  tracerouteLossNotice,
  windowsMilliseconds,
  windowsTime,
  windowsTraceTime,
} from "./features/realism/timing";

interface HostCommand {
  readonly name: string;
  readonly help: string;
  readonly run: (engine: HostEngine, words: string[]) => string;
}

function lastCharacter(text: string): string | null {
  const characters = chars(text);
  return characters.length > 0 ? characters[characters.length - 1] : null;
}

/** Swift `trimmingCharacters(in: CharacterSet(charactersIn: "\""))`. */
function trimQuotes(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === '"') start += 1;
  while (end > start && text[end - 1] === '"') end -= 1;
  return text.slice(start, end);
}

export class HostEngine implements ConsoleEngine {
  private readonly access: DeviceAccess;
  private closed = false;
  private lastHostname: string;

  constructor(access: DeviceAccess) {
    this.access = access;
    this.lastHostname = access.hostname;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** The base commands with those of the protocol features (features/host-commands.ts). */
  private static allCommands: readonly HostCommand[] | null = null;

  private static get commands(): readonly HostCommand[] {
    if (HostEngine.allCommands === null) {
      const features = collectHostCommands().map(
        (command): HostCommand => ({
          name: command.name,
          help: command.help,
          run: (engine, words) => command.run({ access: engine.access, hostname: engine.hostname }, words),
        }),
      );
      const replaced = new Set(features.map((command) => command.name));
      HostEngine.allCommands = [
        ...HostEngine.baseCommands.filter((command) => !replaced.has(command.name)),
        ...features,
      ];
    }
    return HostEngine.allCommands;
  }

  private static readonly baseCommands: readonly HostCommand[] = [
    { name: "help", help: "Display the available commands", run: (engine) => engine.helpText() },
    {
      name: "ipconfig",
      help: "Display the IP configuration of the network adapters",
      run: (engine, words) => engine.ipconfig(words),
    },
    {
      name: "netsh",
      help: "Set an address: netsh interface ip set address eth0 static 192.168.1.10 255.255.255.0 192.168.1.1",
      run: (engine, words) => engine.netsh(words),
    },
    {
      name: "hostname",
      help: "Display the name of this computer",
      run: (engine, words) => (words.length === 0 ? engine.hostname : "hostname: too many arguments"),
    },
    {
      name: "getmac",
      help: "Display the MAC addresses of the adapters",
      run: () => "NetSketch: MAC adresy diagram neukládá.",
    },
    { name: "ver", help: "Display the system version", run: (engine) => engine.version() },
    { name: "cls", help: "Clear the screen", run: () => "" },
    {
      name: "exit",
      help: "Quit the command prompt",
      run: (engine) => {
        engine.closed = true;
        return "";
      },
    },
    { name: "ping", help: "Send echo messages", run: (engine, words) => engine.ping(words) },
    { name: "tracert", help: "Trace the route to a destination", run: (engine, words) => engine.tracert(words) },
    { name: "arp", help: "Display the ARP table", run: () => Notices.needsSimulation },
    { name: "netstat", help: "Display network connections", run: () => Notices.needsSimulation },
    { name: "nslookup", help: "Query a DNS server", run: () => Notices.needsSimulation },
    { name: "telnet", help: "Open a telnet connection", run: () => Notices.needsSimulation },
    { name: "ssh", help: "Open a secure shell connection", run: () => Notices.needsSimulation },
    { name: "ftp", help: "Transfer files to and from an FTP server", run: () => Notices.needsSimulation },
  ];

  // MARK: Banner and prompt

  get hostname(): string {
    const device = this.access.device;
    if (device) this.lastHostname = device.hostname;
    return this.lastHostname;
  }

  private get modelText(): string {
    return [this.access.vendor, this.access.model].filter((part) => part !== "").join(" ");
  }

  get banner(): string {
    return Notices.banner(this.hostname, this.modelText, "příkazový řádek", false);
  }

  get prompt(): string {
    return "C:\\>";
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
    if (trimmed.endsWith("?")) {
      return this.help(line.slice(0, line.lastIndexOf("?")));
    }
    const words = splitWords(trimmed);
    // Commands are case-insensitive and must be typed in full, as on Windows.
    const name = words[0].toLowerCase();
    const command = HostEngine.commands.find((candidate) => candidate.name === name);
    if (!command) return "Invalid Command.";
    return command.run(this, words.slice(1));
  }

  // MARK: Output

  private helpText(): string {
    const width = Math.max(0, ...HostEngine.commands.map((command) => charCount(command.name)));
    return HostEngine.commands.map((command) => padded(command.name, width) + "  " + command.help).join("\n");
  }

  private version(): string {
    const model = this.modelText;
    return [`NetSketch Command Prompt (${model === "" ? "-" : model})`, Notices.versionStatic].join("\n");
  }

  private ipconfig(args: string[]): string {
    if (args.length > 0) {
      const option = args[0];
      if (!["/all", "-all"].includes(option.toLowerCase())) {
        return `Error: unrecognized or incomplete command line option "${option}".`;
      }
    }
    const detailed = args.length > 0;
    const lines: string[] = [];
    for (const port of this.access.interfaces) {
      const kind = port.connector === "wireless" ? "Wireless LAN adapter" : "Ethernet adapter";
      lines.push("");
      lines.push(`${kind} ${port.name}:`);
      lines.push("");
      switch (port.linkState) {
        case "adminDown":
          lines.push(HostEngine.field("Media State", "Media disabled"));
          break;
        case "down":
          lines.push(HostEngine.field("Media State", "Media disconnected"));
          break;
        case "up":
          lines.push(HostEngine.field("Media State", "Media connected"));
          break;
      }
      const peer = port.peer;
      if (peer) {
        lines.push(HostEngine.field("Cabled to", `${peer.hostname} ${PortNaming.shortName(peer.portName)}`));
      }
      const prefix = this.access.address(`port:${port.id}`);
      if (prefix) {
        lines.push(HostEngine.field("IPv4 Address", prefix.address.description));
        lines.push(HostEngine.field("Subnet Mask", prefix.mask.description));
      } else {
        lines.push(HostEngine.field("IPv4 Address", "0.0.0.0"));
        lines.push(HostEngine.field("Subnet Mask", "0.0.0.0"));
      }
      lines.push(HostEngine.field("Default Gateway", IPv4.parse(this.access.defaultGateway)?.description ?? "0.0.0.0"));
      const description = splitCharacters(port.description, isNewline).join(" ");
      if (description !== "") lines.push(HostEngine.field("Description", description));
      if (detailed) {
        lines.push(HostEngine.field("Connector", port.connector));
        if (port.speed !== "") lines.push(HostEngine.field("Speed", port.speed));
      }
    }
    if (lines.length === 0) lines.push("No network adapters.");
    return lines.join("\n");
  }

  // MARK: Addresses

  private static readonly netshUsage =
    "Usage: netsh interface ip set address <adapter> static <address> <mask> [<gateway>]\n" +
    "       netsh interface ip set address <adapter> dhcp";

  /**
   * `netsh interface ip set address "eth0" static 192.168.1.10 255.255.255.0 192.168.1.1`.
   * `ipv4` may stand for `ip`, and the keywords `name=`, `source=`, `address=`, `mask=` and
   * `gateway=` of the long form are accepted as well.
   */
  private netsh(args: string[]): string {
    const words = args.map((word) => {
      let text = word;
      for (const key of ["name=", "source=", "address=", "mask=", "gateway="]) {
        if (text.toLowerCase().startsWith(key)) text = chars(text).slice(charCount(key)).join("");
      }
      return trimQuotes(text);
    });
    const lower = words.map((word) => word.toLowerCase());
    if (
      !(
        lower.length >= 5 &&
        lower[0] === "interface" &&
        ["ip", "ipv4"].includes(lower[1]) &&
        lower[2] === "set" &&
        lower[3] === "address"
      )
    ) {
      return HostEngine.netshUsage;
    }
    const rest = words.slice(4);
    const adapterName = rest[0];
    const interfaces = this.access.interfaces;
    const port =
      adapterName === undefined
        ? undefined
        : interfaces.find((candidate) => candidate.name.toLowerCase() === adapterName.toLowerCase());
    if (!port) {
      return (
        `The interface "${rest[0] ?? ""}" was not found. Adapters: ` + interfaces.map((item) => item.name).join(", ")
      );
    }
    const mode = rest.length > 1 ? rest[1].toLowerCase() : "";
    if (mode === "dhcp") return Notices.dhcpNotSimulated;
    if (mode !== "static" || rest.length < 4) return HostEngine.netshUsage;
    const prefix = IPv4Prefix.fromAddressMask(rest[2], rest[3]) ?? IPv4Prefix.fromCIDR(rest[2]);
    if (!prefix || !prefix.isHostAddress) {
      return `The parameter is incorrect: ${rest[2]} ${rest[3]}`;
    }
    let gateway: IPv4 | null = null;
    if (rest.length >= 5) {
      const value = IPv4.parse(rest[4]);
      if (!value || !prefix.contains(value)) {
        return `The default gateway ${rest[4]} is not in the network ${prefix.networkPrefix.description}.`;
      }
      gateway = value;
    }
    const interfaceID = `port:${port.id}`;
    this.access.transaction(() => {
      this.access.setAddress(prefix, interfaceID);
      if (rest.length >= 5) this.access.setDefaultGateway(gateway);
    });
    const owner = this.access.addressConflict(prefix.address, interfaceID);
    if (owner != null) {
      return Notices.duplicateAddress(prefix.address.description, owner);
    }
    return "Ok.";
  }

  // MARK: ping and tracert

  private ping(args: string[]): string {
    const target = args.find((word) => !word.startsWith("-"));
    if (target === undefined) return "Usage: ping [-n count] target_name";
    const destination = IPv4.parse(target);
    if (!destination) {
      return `Ping request could not find host ${target}. Please check the name and try again.`;
    }
    let count = 4;
    const index = args.indexOf("-n");
    if (index >= 0 && index + 1 < args.length) {
      const value = swiftInt(args[index + 1]);
      if (value !== null && value >= 1 && value <= 100) count = value;
    }
    const simulator = this.access.simulator;
    const result = simulator.ping(this.access.deviceID, destination);
    const plan = planPing(simulator, this.access.deviceID, destination, result, count);
    announcePing(this.access.deviceID, result, plan);
    const lines = ["", `Pinging ${destination.description} with 32 bytes of data:`, ""];
    let reply: string;
    const failure = result.forward.failure;
    const lastHop = result.forward.hops.length > 0 ? result.forward.hops[result.forward.hops.length - 1] : null;
    if (result.success) {
      const owner = simulator.interfaces.find((iface) => iface.prefix.address.equals(destination));
      const targetCategory = owner ? simulator.device(owner.deviceID)?.category ?? null : null;
      const isEndDevice = targetCategory === null ? true : targetCategory === "PC" || targetCategory === "server";
      const initial = isEndDevice ? 128 : 255;
      const routers = plan.active ? plan.routersOnReturn : Math.max(0, result.hopCount - 1);
      const ttl = Math.max(1, initial - routers);
      reply = `Reply from ${destination.description}: bytes=32 time<1ms TTL=${ttl}`;
    } else if (failure?.kind === "noRoute" && failure.deviceID !== this.access.deviceID && lastHop !== null) {
      reply = `Reply from ${lastHop.description}: Destination host unreachable.`;
    } else {
      reply = "Request timed out.";
    }
    for (let i = 0; i < count; i++) {
      const sample = plan.active ? plan.samples[i] : undefined;
      if (sample === undefined) lines.push(reply);
      else if (sample.lost) lines.push("Request timed out.");
      else lines.push(reply.replace("time<1ms", windowsTime(sample.rtt)));
    }
    const received = plan.active ? plan.received : result.success ? count : 0;
    lines.push("");
    lines.push(`Ping statistics for ${destination.description}:`);
    lines.push(
      `    Packets: Sent = ${count}, Received = ${received}, Lost = ${count - received} (${Math.trunc(
        ((count - received) * 100) / count,
      )}% loss),`,
    );
    if (received > 0) {
      lines.push("Approximate round trip times in milli-seconds:");
      const ms = plan.active
        ? [plan.minimum, plan.maximum, plan.average].map(windowsMilliseconds)
        : [0, 0, 0];
      lines.push(`    Minimum = ${ms[0]}ms, Maximum = ${ms[1]}ms, Average = ${ms[2]}ms`);
    } else {
      const reason = simulator.explain(result);
      if (reason !== "") lines.push(reason);
    }
    const lostNotice = lossNotice(plan);
    if (lostNotice !== "") lines.push(lostNotice);
    return lines.join("\n");
  }

  private tracert(args: string[]): string {
    const target = args.find((word) => !word.startsWith("-"));
    if (target === undefined) return "Usage: tracert target_name";
    const destination = IPv4.parse(target);
    if (!destination) return `Unable to resolve target system name ${target}.`;
    const simulator = this.access.simulator;
    const delivery = simulator.deliver(this.access.deviceID, destination);
    const plan = planTraceroute(simulator, this.access.deviceID, destination, delivery);
    announceTraceroute(this.access.deviceID, delivery);
    const lines = ["", `Tracing route to ${destination.description} over a maximum of 30 hops:`, ""];
    delivery.hops.forEach((hop, index) => {
      const probes = plan.active ? plan.hops[index] ?? [] : [];
      if (!plan.active) {
        lines.push(leftPadded(`${index + 1}`, 3) + `   0 ms      0 ms      0 ms      ${hop.description}`);
      } else if (probes.every((probe) => probe.rtt === null)) {
        lines.push(leftPadded(`${index + 1}`, 3) + "   *         *         *         Request timed out.");
      } else {
        const columns = probes.map((probe) =>
          padded(probe.rtt === null ? "*" : windowsTraceTime(probe.rtt), 10),
        );
        lines.push(leftPadded(`${index + 1}`, 3) + "   " + columns.join("") + hop.description);
      }
    });
    if (delivery.delivered) {
      if (tracerouteAnswered(plan)) {
        lines.push("");
        lines.push("Trace complete.");
      }
    } else {
      lines.push(leftPadded(`${delivery.hops.length + 1}`, 3) + "   *         *         *         Request timed out.");
      const reason = simulator.explain(simulator.ping(this.access.deviceID, destination));
      if (reason !== "") lines.push(reason);
    }
    const lostNotice = tracerouteLossNotice(plan);
    if (lostNotice !== "") lines.push(lostNotice);
    return lines.join("\n");
  }

  /** "   Media State . . . . . . . . . : value", the dotted layout of Windows ipconfig. */
  private static field(name: string, value: string): string {
    const dotted = trimmingTrailingWhitespace(chars(name + " .".repeat(20)).slice(0, 33).join(""));
    return "   " + padded(dotted, 34) + ": " + value;
  }

  // MARK: Help and completion

  help(partial: string): string {
    if (!this.access.exists || this.closed || charCount(partial) > CLILimits.maxLineLength) return "";
    const words = splitWords(partial);
    const last = lastCharacter(partial);
    if (words.length > 1 || (words.length === 1 && last !== null && isWhitespace(last))) {
      return "NetSketch: k parametrům příkazů není nápověda, zkuste „help“.";
    }
    const prefix = words.length > 0 ? words[0].toLowerCase() : "";
    const matches = HostEngine.commands.filter((command) => command.name.startsWith(prefix));
    if (matches.length === 0) return "Invalid Command.";
    const width = Math.max(0, ...matches.map((command) => charCount(command.name)));
    return matches.map((command) => "  " + padded(command.name, width) + "  " + command.help).join("\n");
  }

  complete(partial: string): string[] {
    if (!this.access.exists || this.closed || charCount(partial) > CLILimits.maxLineLength) return [];
    const words = splitWords(partial);
    const last = lastCharacter(partial);
    if (words.length > 1 || (last !== null && isWhitespace(last))) return [];
    const prefix = words.length > 0 ? words[0].toLowerCase() : "";
    return HostEngine.commands
      .map((command) => command.name)
      .filter((name) => name.startsWith(prefix))
      .sort();
  }
}
