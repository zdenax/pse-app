// dhcp: commands of the IOS-style consoles (Cisco IOS, generic; Dell OS9 where it is cheap).
//
//   server  ip dhcp excluded-address, ip dhcp pool (mode dhcp-config) with network, default-router,
//           dns-server, domain-name, lease; Dell OS9: ip dhcp server > pool / excluded-address
//   relay   interface: ip helper-address
//   client  interface: ip address dhcp, privileged: renew dhcp / release dhcp
//   show    ip dhcp binding, ip dhcp pool, the blocks of show running-config
//
// Rule for feature modules (features/ios-commands.ts): values from ../../ios-engine,
// ../../ios-network etc. are used only inside functions, never at module top level.

import {
  custom,
  kw,
  line,
  splitWords,
  word,
  type CommandHandler,
  type CommandNode,
  type CustomArgument,
  type ParsedCommand,
} from "../../command-tree";
import type { IOSEngine } from "../../ios-engine";
import * as Network from "../../ios-network";
import { l3Port, l3VLAN, parseL3Interface } from "../../model-access";
import { Notices } from "../../notices";
import { IPv4, IPv4Prefix } from "../../sim/ipv4";
import type { DHCPPool } from "../../../core/protocols";
import type { L3InterfaceID } from "../../../core/model";
import type { IOSFeature, IOSFeatureCommands } from "../ios-commands";
import { dhcpOf, updateDHCP } from "./model";
import { showBindings, showPools } from "./show";
import { acquireLease, isDHCPClient, releaseLease, unmarkClient } from "./sim";

// MARK: Arguments and messages

/** One IPv4 address; a wrong one is reported at its column like any other bad word. */
function addressArgument(name: string, help: string): CustomArgument {
  return {
    name,
    match: (_engine, input, index) => {
      const token = input.tokens[index];
      return IPv4.parse(token.text)
        ? { kind: "matched", value: { kind: "text", value: token.text }, consumed: 1 }
        : { kind: "invalid", column: token.column };
    },
    helpEntries: () => [{ name: "A.B.C.D", text: help }],
    continuationHelp: () => [],
    completions: () => [],
  };
}

function badAddress(engine: IOSEngine): string {
  return engine.isDell ? "% Error: Invalid IP address." : "% Invalid input detected: bad IP address or mask.";
}

/** A command the DHCP server has but the diagram has no field for: accepted, nothing stored. */
function notStored(name: string, help: string): CommandNode {
  const report: CommandHandler = (_engine, command) => {
    const first = splitWords(command.text("rest") ?? "")[0];
    return Notices.notStored((first === undefined ? [name] : [name, first]).join(" "));
  };
  return kw(name, help, [line("rest", help, report)], report);
}

const poolMode = "dhcp-pool";
const serverMode = "dhcp-server";

// MARK: Excluded addresses

function excludedEntry(command: ParsedCommand): { entry: string; ok: boolean } {
  const low = command.text("low") ?? "";
  const high = command.text("high") ?? low;
  const ok = (IPv4.parse(high)?.value ?? 0) >= (IPv4.parse(low)?.value ?? 0);
  return { entry: low === high ? low : `${low}-${high}`, ok };
}

const addExcluded: CommandHandler = (engine, command) => {
  const { entry, ok } = excludedEntry(command);
  if (!ok) return engine.isDell ? "% Error: Invalid address range." : "% Invalid IP address range: the high address is lower than the low address.";
  if (dhcpOf(engine.access.device)?.excluded.includes(entry)) return "";
  updateDHCP(engine.access, (config) => {
    config.excluded.push(entry);
  });
  return "";
};

const removeExcluded: CommandHandler = (engine, command) => {
  const { entry } = excludedEntry(command);
  if (!dhcpOf(engine.access.device)?.excluded.includes(entry)) {
    return engine.isDell ? "% Error: Excluded range not found." : "%Excluded address range not found";
  }
  updateDHCP(engine.access, (config) => {
    config.excluded = config.excluded.filter((candidate) => candidate !== entry);
  });
  return "";
};

function excludedNodes(negated: boolean): CommandNode {
  const handler = negated ? removeExcluded : addExcluded;
  return kw("excluded-address", negated ? "Prevent DHCP from assigning certain addresses" : "Prevent DHCP from assigning certain addresses", [
    custom(addressArgument("low", "Low IP address"), handler, "", [
      custom(addressArgument("high", "High IP address"), handler),
    ]),
  ]);
}

// MARK: Pools

function enterPool(engine: IOSEngine, command: ParsedCommand): string {
  const name = command.text("name") ?? "";
  if (!dhcpOf(engine.access.device)?.pools.some((pool) => pool.name === name)) {
    updateDHCP(engine.access, (config) => {
      config.pools.push({ name, network: "", defaultRouter: "", dnsServer: "", range: "" });
    });
  }
  engine.mode = {
    kind: "feature",
    name: poolMode,
    prompt: engine.isDell ? `conf-dhcp-${name}` : "dhcp-config",
    context: { pool: name },
  };
  return "";
}

function removePool(engine: IOSEngine, command: ParsedCommand): string {
  const name = command.text("name") ?? "";
  if (!dhcpOf(engine.access.device)?.pools.some((pool) => pool.name === name)) {
    return engine.isDell ? `% Error: Pool ${name} not found.` : `%Pool ${name} not found`;
  }
  updateDHCP(engine.access, (config) => {
    config.pools = config.pools.filter((pool) => pool.name !== name);
  });
  return "";
}

/** Changes the pool of the current mode; the mode is left when the pool is gone (undo). */
function editPool(engine: IOSEngine, change: (pool: DHCPPool) => void): string {
  const mode = engine.mode;
  const name = mode.kind === "feature" && mode.name === poolMode ? String(mode.context.pool ?? "") : "";
  if (!dhcpOf(engine.access.device)?.pools.some((pool) => pool.name === name)) {
    engine.mode = { kind: "globalConfig" };
    return "NetSketch: DHCP pool už v konfiguraci neexistuje, návrat do globální konfigurace.";
  }
  updateDHCP(engine.access, (config) => {
    const pool = config.pools.find((candidate) => candidate.name === name);
    if (pool) change(pool);
  });
  return "";
}

/** "192.168.10.0 255.255.255.0", "192.168.10.0 /24", "192.168.10.0/24" or a classful network. */
function parseNetwork(text: string): IPv4Prefix | null {
  const words = splitWords(text);
  let prefix: IPv4Prefix | null = null;
  if (words.length === 1) {
    prefix = IPv4Prefix.fromCIDR(words[0]);
    const host = IPv4.parse(words[0]);
    if (prefix === null && host !== null) {
      const first = host.value >>> 24;
      prefix = new IPv4Prefix(host, first < 128 ? 8 : first < 192 ? 16 : 24);
    }
  } else if (words.length === 2) {
    prefix = words[1].startsWith("/") ? IPv4Prefix.fromCIDR(words[0] + words[1]) : IPv4Prefix.fromAddressMask(words[0], words[1]);
  }
  return prefix !== null && prefix.length >= 1 && prefix.length <= 30 ? prefix.networkPrefix : null;
}

const setNetwork: CommandHandler = (engine, command) => {
  const prefix = parseNetwork(command.text("network") ?? "");
  if (prefix === null) return badAddress(engine);
  return editPool(engine, (pool) => {
    pool.network = prefix.description;
  });
};

function addressList(text: string): string | null {
  const words = splitWords(text);
  if (words.length === 0 || words.length > 8 || words.some((entry) => IPv4.parse(entry) === null)) return null;
  return words.join(" ");
}

function listSetter(field: "defaultRouter" | "dnsServer", argument: string): CommandHandler {
  return (engine, command) => {
    const list = addressList(command.text(argument) ?? "");
    if (list === null) return badAddress(engine);
    return editPool(engine, (pool) => {
      pool[field] = list;
    });
  };
}

const setDomain: CommandHandler = (engine, command) => {
  const name = command.text("name") ?? "";
  return editPool(engine, (pool) => {
    pool.domainName = name;
  });
};

function parseLease(text: string): string | null {
  const words = splitWords(text);
  if (words.length === 0 || words.length > 3 || words.some((entry) => !/^[0-9]{1,3}$/.test(entry))) return null;
  const [days, hours, minutes] = words.map(Number);
  if (days > 365 || (hours ?? 0) > 23 || (minutes ?? 0) > 59) return null;
  return words.join(" ");
}

const setLease: CommandHandler = (engine, command) => {
  const lease = parseLease(command.text("lease") ?? "");
  if (lease === null) return "% Invalid lease time: days 0-365, hours 0-23, minutes 0-59.";
  return editPool(engine, (pool) => {
    pool.lease = lease;
  });
};

const setLeaseInfinite: CommandHandler = (engine) =>
  editPool(engine, (pool) => {
    pool.lease = "infinite";
  });

function clearField(field: "network" | "defaultRouter" | "dnsServer" | "domainName" | "lease"): CommandHandler {
  return (engine) =>
    editPool(engine, (pool) => {
      if (field === "domainName" || field === "lease") delete pool[field];
      else pool[field] = "";
    });
}

function poolCommands(dell: boolean): CommandNode[] {
  const networkHelp = dell ? "Network prefix (A.B.C.D/NN)" : "Network number and mask (A.B.C.D M.M.M.M or A.B.C.D/NN)";
  return [
    kw("network", "Network number and mask", [line("network", networkHelp, setNetwork, "A.B.C.D")]),
    kw("default-router", "Default routers", [
      line("routers", "Router IP addresses, in order of preference", listSetter("defaultRouter", "routers"), "A.B.C.D"),
    ]),
    kw("dns-server", "DNS servers", [
      line("servers", "DNS server IP addresses, in order of preference", listSetter("dnsServer", "servers"), "A.B.C.D"),
    ]),
    kw("domain-name", "Domain name", [word("name", "Domain name", setDomain, "WORD")]),
    kw("lease", "Address lease time", [
      kw("infinite", "Infinite lease", [], setLeaseInfinite),
      line("lease", "Days [hours [minutes]]", setLease, "<0-365>"),
    ]),
    kw("no", "Negate a command or set its defaults", [
      kw("network", "Network number and mask", [], clearField("network")),
      kw("default-router", "Default routers", [], clearField("defaultRouter")),
      kw("dns-server", "DNS servers", [], clearField("dnsServer")),
      kw("domain-name", "Domain name", [], clearField("domainName")),
      kw("lease", "Address lease time", [], clearField("lease")),
    ]),
    notStored("option", "Raw DHCP options"),
    notStored("netbios-name-server", "NetBIOS (WINS) name servers"),
    notStored("netbios-node-type", "NetBIOS node type"),
    notStored("next-server", "Next server in boot process"),
    notStored("bootfile", "Boot file name"),
  ];
}

// MARK: Global commands

function dhcpGlobal(dell: boolean, negated: boolean): CommandNode {
  const rest = line("rest", "Other DHCP subcommands (accepted, not stored)", (_engine, command) =>
    Notices.notStored("ip dhcp " + (splitWords(command.text("rest") ?? "")[0] ?? "")),
  );
  if (dell) {
    return kw(
      "dhcp",
      "Dynamic Host Configuration Protocol",
      [
        kw("server", "Enable the DHCP server", [], negated ? clearServer : enterServer),
        rest,
      ],
    );
  }
  return kw("dhcp", "Configure DHCP server and relay parameters", [
    excludedNodes(negated),
    kw("pool", "Configure DHCP address pools", [
      word("name", "Pool name", negated ? removePool : enterPool, "WORD"),
    ]),
    rest,
  ]);
}

const enterServer: CommandHandler = (engine) => {
  engine.mode = { kind: "feature", name: serverMode, prompt: "conf-dhcp", context: {} };
  return "";
};

const clearServer: CommandHandler = (engine) => {
  updateDHCP(engine.access, (config) => {
    config.pools = [];
    config.excluded = [];
  });
  return "";
};

function serverCommands(): CommandNode[] {
  return [
    kw("pool", "Configure a DHCP address pool", [word("name", "Pool name", enterPool, "WORD")]),
    excludedNodes(false),
    kw("no", "Negate a command or set its defaults", [
      kw("pool", "Configure a DHCP address pool", [word("name", "Pool name", removePool, "WORD")]),
      excludedNodes(true),
    ]),
  ];
}

// MARK: Interface commands

function interfaceOf(engine: IOSEngine): L3InterfaceID | { message: string } {
  const result = Network.currentL3Interface(engine);
  return result.kind === "success" ? result.interface : { message: result.message };
}

const addHelper: CommandHandler = (engine, command) => {
  const target = interfaceOf(engine);
  if (typeof target !== "string") return target.message;
  const server = command.text("server") ?? "";
  if (dhcpOf(engine.access.device)?.relays.some((relay) => relay.interface === target && relay.server === server)) return "";
  updateDHCP(engine.access, (config) => {
    config.relays.push({ interface: target, server });
  });
  return "";
};

const removeHelper: CommandHandler = (engine, command) => {
  const target = interfaceOf(engine);
  if (typeof target !== "string") return target.message;
  const server = command.text("server");
  const relays = dhcpOf(engine.access.device)?.relays ?? [];
  if (!relays.some((relay) => relay.interface === target && (server === null || relay.server === server))) return "";
  updateDHCP(engine.access, (config) => {
    config.relays = config.relays.filter((relay) => !(relay.interface === target && (server === null || relay.server === server)));
  });
  return "";
};

/** What `ip address dhcp` prints: IOS logs the assignment, the failure is explained in Czech. */
export function enableDHCPClient(engine: IOSEngine): string {
  const target = interfaceOf(engine);
  if (typeof target !== "string") return target.message;
  const access = engine.access;
  let outcome: ReturnType<typeof acquireLease> | null = null;
  access.transaction(() => {
    if (!isDHCPClient(access, target)) access.setAddress(null, target);
    outcome = acquireLease(access, target);
  });
  const result = outcome as ReturnType<typeof acquireLease> | null;
  if (result === null) return "";
  if (result.kind === "failed") {
    return (
      `NetSketch: DHCP neuspělo – ${result.reason}\n` +
      "NetSketch: rozhraní zůstává bez adresy; po opravě sítě použijte „renew dhcp <rozhraní>“."
    );
  }
  if (engine.isDell) return "";
  const prefix = result.address;
  return (
    `%DHCP-6-ADDRESS_ASSIGN: Interface ${Network.l3Name(engine, target)} assigned DHCP address ` +
    `${prefix.address.description}, mask ${prefix.mask.description}, hostname ${engine.hostname}`
  );
}

/** A manual address replaces DHCP on the interface. */
const setStaticAddress: CommandHandler = (engine, command) => {
  const target = interfaceOf(engine);
  if (typeof target !== "string") return Network.setIPAddress(engine, command);
  const typed = Network.parseAddress(command.text("address") ?? "");
  let output = "";
  engine.access.transaction(() => {
    output = Network.setIPAddress(engine, command);
    if (typed !== null && engine.access.address(target)?.equals(typed)) unmarkClient(engine.access, target);
  });
  return output;
};

const clearAddress: CommandHandler = (engine) => {
  const target = interfaceOf(engine);
  let output = "";
  engine.access.transaction(() => {
    output = Network.clearIPAddress(engine);
    if (typeof target === "string") unmarkClient(engine.access, target);
  });
  return output;
};

function interfaceCommands(): Pick<IOSFeatureCommands, "interfaceIP" | "interfaceNoIP"> {
  return {
    interfaceIP: [
      kw("address", "Set the IP address of an interface", [
        kw("dhcp", "IP Address negotiated via DHCP", [], (engine) => enableDHCPClient(engine)),
        line("address", "IP address and mask (A.B.C.D M.M.M.M or A.B.C.D/NN)", setStaticAddress, "A.B.C.D"),
      ]),
      kw("helper-address", "Specify a destination address for UDP broadcasts", [
        custom(addressArgument("server", "IP destination address"), addHelper),
      ]),
    ],
    interfaceNoIP: [
      kw(
        "address",
        "Set the IP address of an interface",
        [line("rest", "Address (ignored)", clearAddress)],
        clearAddress,
      ),
      kw(
        "helper-address",
        "Specify a destination address for UDP broadcasts",
        [custom(addressArgument("server", "IP destination address"), removeHelper)],
        removeHelper,
      ),
    ],
  };
}

// MARK: renew dhcp / release dhcp

function selectedInterface(command: ParsedCommand): L3InterfaceID | null {
  const selection = command.interfaces("interface");
  if (selection === null) return null;
  const target = selection.target;
  if (target.kind === "vlan") return l3VLAN(target.number);
  return target.kind === "ports" && target.ids.length === 1 ? l3Port(target.ids[0]) : null;
}

function leaseCommand(release: boolean): CommandHandler {
  return (engine, command) => {
    const id = selectedInterface(command);
    if (id === null) return "% Invalid interface.";
    if (!isDHCPClient(engine.access, id)) {
      return `% Interface ${Network.l3Name(engine, id)} is not configured with "ip address dhcp".`;
    }
    if (release) {
      releaseLease(engine.access, id);
      return "";
    }
    const outcome = acquireLease(engine.access, id);
    if (outcome.kind === "failed") return `NetSketch: DHCP neuspělo – ${outcome.reason}`;
    const prefix = outcome.address;
    return (
      `%DHCP-6-ADDRESS_ASSIGN: Interface ${Network.l3Name(engine, id)} assigned DHCP address ` +
      `${prefix.address.description}, mask ${prefix.mask.description}, hostname ${engine.hostname}`
    );
  };
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

function leaseNodes(): CommandNode[] {
  const argument = (release: boolean): CommandNode =>
    kw("dhcp", release ? "Release DHCP leases" : "Renew DHCP leases", [custom(interfaceArgument, leaseCommand(release))]);
  return [
    kw("renew", "Renew a lease", [argument(false)]),
    kw("release", "Release a lease", [argument(true)]),
  ];
}

// MARK: show

function showNodes(dell: boolean): CommandNode[] {
  const children: CommandNode[] = [
    kw("binding", "DHCP address bindings", [custom(addressArgument("address", "Hardware address or IP address"), showBindings)], showBindings),
  ];
  if (!dell) children.push(kw("pool", "DHCP pools information", [word("name", "Pool name", showPools, "WORD")], showPools));
  const unsimulated: [string, string][] = dell
    ? [["server", "DHCP server information"]]
    : [
        ["conflict", "DHCP address conflicts"],
        ["database", "DHCP database agents"],
        ["server", "Miscellaneous DHCP server information"],
      ];
  for (const [name, help] of unsimulated) {
    children.push(kw(name, help, [line("rest", help, () => Notices.needsSimulation)], () => Notices.needsSimulation));
  }
  return [kw("dhcp", "Show items in the DHCP database", children)];
}

// MARK: running-config

function networkLine(dell: boolean, network: string): string {
  const prefix = IPv4Prefix.fromCIDR(network);
  if (!prefix || dell) return `network ${network}`;
  return `network ${prefix.address.description} ${prefix.mask.description}`;
}

function poolLines(pool: DHCPPool, dell: boolean, indent: string): string[] {
  const lines = [`${indent}${dell ? "pool" : "ip dhcp pool"} ${pool.name}`];
  const inner = indent + " ";
  if (pool.network !== "") lines.push(inner + networkLine(dell, pool.network));
  if (pool.defaultRouter !== "") lines.push(`${inner}default-router ${pool.defaultRouter}`);
  if (pool.dnsServer !== "") lines.push(`${inner}dns-server ${pool.dnsServer}`);
  if (pool.domainName) lines.push(`${inner}domain-name ${pool.domainName}`);
  if (pool.lease) lines.push(`${inner}lease ${pool.lease}`);
  return lines;
}

function excludedLine(entry: string, dell: boolean): string {
  const [low, high] = entry.split("-");
  return `${dell ? " " : "ip dhcp "}excluded-address ${low}${high ? ` ${high}` : ""}`;
}

function globalBlocks(engine: IOSEngine): string[][] {
  const config = dhcpOf(engine.access.device);
  if (!config) return [];
  const dell = engine.isDell;
  const blocks: string[][] = [];
  if (dell) {
    if (config.pools.length > 0 || config.excluded.length > 0) {
      blocks.push([
        "ip dhcp server",
        ...config.excluded.map((entry) => excludedLine(entry, true)),
        ...config.pools.flatMap((pool) => poolLines(pool, true, " ")),
      ]);
    }
    return blocks;
  }
  if (config.excluded.length > 0) blocks.push(config.excluded.map((entry) => excludedLine(entry, false)));
  for (const pool of config.pools) blocks.push(poolLines(pool, false, ""));
  // A VLAN interface that asked for DHCP but has no address yet is not listed with the addressed ones.
  for (const id of config.clients) {
    const parsed = parseL3Interface(id);
    if (parsed?.kind !== "vlan" || engine.access.address(id) !== null) continue;
    blocks.push([`interface Vlan${parsed.number}`, " ip address dhcp"]);
  }
  return blocks;
}

function interfaceLines(engine: IOSEngine, interfaceID: L3InterfaceID): string[] {
  const relays = dhcpOf(engine.access.device)?.relays ?? [];
  return relays.filter((relay) => relay.interface === interfaceID).map((relay) => ` ip helper-address ${relay.server}`);
}

// MARK: The feature

export const dhcpIOS: IOSFeature = (dialect) => {
  const dell = dialect === "dellOS9";
  return {
    showIP: showNodes(dell),
    globalIP: [dhcpGlobal(dell, false)],
    globalNoIP: [dhcpGlobal(dell, true)],
    privileged: dell ? [] : leaseNodes(),
    ...interfaceCommands(),
    modes: dell
      ? ({ [serverMode]: serverCommands(), [poolMode]: poolCommands(true) } as Record<string, CommandNode[]>)
      : ({ [poolMode]: poolCommands(false) } as Record<string, CommandNode[]>),
    config: { interfaceLines, globalBlocks },
  };
};
