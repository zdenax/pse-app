// nat: commands of the Cisco IOS console.
//   interface:  ip nat inside | outside
//   global:     ip nat pool NAME START END (netmask M | prefix-length N)
//               ip nat inside source static LOCAL GLOBAL
//               ip nat inside source list ACL pool NAME [overload]
//               ip nat inside source list ACL interface IF [overload]
//   exec:       show ip nat translations | statistics, clear ip nat translation *
// The configuration is Device.protocols.nat; the translations are made in ./sim.ts.

import { closedRange, custom, kw, line, num, word, type CommandNode, type ParsedCommand } from "../../command-tree";
import { IOSEngine } from "../../ios-engine";
import type { DeviceAccess } from "../../model-access";
import { Notices } from "../../notices";
import { IPv4 } from "../../sim/ipv4";
import { NetworkSimulator } from "../../sim/network-simulator";
import { isEmptyNATConfig, type NATConfig, type NATPool, type NATRule } from "../../../core/protocols/nat";
import type { L3InterfaceID } from "../../../core/model";
import type { IOSFeature } from "../ios-commands";
import { clearTranslations, dynamicRuleText, natState, poolSize } from "./state";

type DynamicRule = Extract<NATRule, { kind: "dynamic" }>;
type StaticRule = Extract<NATRule, { kind: "static" }>;

const badAddress = "% Invalid input detected: bad IP address or mask.";
const maxPrefixLength = 32;

// MARK: Reading and writing the configuration

function currentConfig(access: DeviceAccess): NATConfig {
  return access.protocols.nat ?? { inside: [], outside: [], pools: [], rules: [] };
}

/** Changes the NAT configuration in one undo step; an empty configuration removes the key. */
function edit(access: DeviceAccess, change: (config: NATConfig) => void): void {
  access.updateProtocols((protocols) => {
    const config = protocols.nat ?? { inside: [], outside: [], pools: [], rules: [] };
    change(config);
    protocols.nat = isEmptyNATConfig(config) ? undefined : config;
  });
}

/** The layer-3 interfaces `ip nat inside|outside` applies to in the current mode, or a message. */
function modeInterfaces(engine: IOSEngine): { ids: L3InterfaceID[] } | { message: string } {
  const mode = engine.mode;
  if (mode.kind === "vlanInterface") return { ids: [`vlan:${mode.vlan}`] };
  const ports = engine.selectedPorts();
  if (mode.kind !== "interface" || ports.length === 0) {
    engine.mode = { kind: "globalConfig" };
    return { message: Notices.interfaceGone };
  }
  const category = engine.access.category;
  if (category !== null && NetworkSimulator.isSwitching(category) && ports.some((port) => port.isSwitchport)) {
    return { message: "NetSketch: port přepínače je přepínaný (L2), NAT lze zapnout jen na směrovaném rozhraní nebo na rozhraní VLAN." };
  }
  return { ids: ports.map((port) => `port:${port.id}`) };
}

function setSide(engine: IOSEngine, side: "inside" | "outside"): string {
  const target = modeInterfaces(engine);
  if ("message" in target) return target.message;
  edit(engine.access, (config) => {
    const other = side === "inside" ? "outside" : "inside";
    for (const id of target.ids) {
      config[other] = config[other].filter((candidate) => candidate !== id);
      if (!config[side].includes(id)) config[side].push(id);
    }
  });
  return "";
}

function clearSide(engine: IOSEngine, side: "inside" | "outside"): string {
  const target = modeInterfaces(engine);
  if ("message" in target) return target.message;
  edit(engine.access, (config) => {
    config[side] = config[side].filter((candidate) => !target.ids.includes(candidate));
  });
  return "";
}

// MARK: ip nat pool

function parsePool(command: ParsedCommand): NATPool | string {
  const start = IPv4.parse(command.text("start") ?? "");
  const end = IPv4.parse(command.text("end") ?? "");
  if (start === null || end === null) return badAddress;
  let length: number;
  const mask = command.text("mask");
  if (mask !== null) {
    const parsed = IPv4.parse(mask)?.prefixLength ?? null;
    if (parsed === null) return badAddress;
    length = parsed;
  } else {
    length = command.int("length") ?? maxPrefixLength;
  }
  if (end.value < start.value) return "%End address less than start address";
  const maskValue = IPv4.mask(length).value;
  if (((start.value ^ end.value) & maskValue) >>> 0 !== 0) return "%Start and end addresses on different subnets";
  return { name: command.text("name") ?? "", start: start.description, end: end.description, prefixLength: length };
}

function addPool(engine: IOSEngine, command: ParsedCommand): string {
  const pool = parsePool(command);
  if (typeof pool === "string") return pool;
  const config = currentConfig(engine.access);
  const used = config.rules.some((rule) => rule.kind === "dynamic" && rule.pool === pool.name);
  const existing = config.pools.find((candidate) => candidate.name === pool.name);
  if (existing && used && (existing.start !== pool.start || existing.end !== pool.end || existing.prefixLength !== pool.prefixLength)) {
    return `%Pool ${pool.name} in use, cannot redefine`;
  }
  edit(engine.access, (next) => {
    next.pools = [...next.pools.filter((candidate) => candidate.name !== pool.name), pool];
  });
  return "";
}

function removePool(engine: IOSEngine, command: ParsedCommand): string {
  const name = command.text("name") ?? "";
  const config = currentConfig(engine.access);
  if (!config.pools.some((pool) => pool.name === name)) return `%Pool ${name} not found`;
  if (config.rules.some((rule) => rule.kind === "dynamic" && rule.pool === name)) return `%Pool ${name} in use, cannot destroy`;
  edit(engine.access, (next) => {
    next.pools = next.pools.filter((pool) => pool.name !== name);
  });
  return "";
}

// MARK: ip nat inside source

function addStatic(engine: IOSEngine, command: ParsedCommand): string {
  const local = IPv4.parse(command.text("local") ?? "");
  const global = IPv4.parse(command.text("global") ?? "");
  if (local === null || global === null) return badAddress;
  const rules = currentConfig(engine.access).rules;
  const same = rules.find((rule): rule is StaticRule => rule.kind === "static" && rule.local === local.description && rule.global === global.description);
  if (same) return "";
  const clash = rules.find(
    (rule): rule is StaticRule => rule.kind === "static" && (rule.local === local.description || rule.global === global.description),
  );
  if (clash) {
    const address = clash.local === local.description ? local.description : global.description;
    return `%${address} already mapped (${clash.local} -> ${clash.global})`;
  }
  edit(engine.access, (config) => {
    config.rules.push({ kind: "static", local: local.description, global: global.description });
  });
  return "";
}

function removeStatic(engine: IOSEngine, command: ParsedCommand): string {
  const local = IPv4.parse(command.text("local") ?? "");
  const global = IPv4.parse(command.text("global") ?? "");
  if (local === null || global === null) return badAddress;
  edit(engine.access, (config) => {
    config.rules = config.rules.filter(
      (rule) => !(rule.kind === "static" && rule.local === local.description && rule.global === global.description),
    );
  });
  return "";
}

function dynamicRule(command: ParsedCommand, byInterface: boolean): DynamicRule | string {
  const list = command.text("list") ?? "";
  const overload = command.has("overload");
  if (byInterface) {
    const selection = command.interfaces("interface");
    const target = selection?.target;
    let id: L3InterfaceID | null = null;
    if (target?.kind === "ports" && target.ids.length === 1) id = `port:${target.ids[0]}`;
    if (target?.kind === "vlan") id = `vlan:${target.number}`;
    if (id === null) return "NetSketch: pro překlad adres lze použít jen fyzický port nebo rozhraní VLAN.";
    return { kind: "dynamic", list, interface: id, overload };
  }
  return { kind: "dynamic", list, pool: command.text("pool") ?? "", overload };
}

function sameTarget(a: DynamicRule, b: DynamicRule): boolean {
  return a.list === b.list && a.pool === b.pool && a.interface === b.interface;
}

function addDynamic(engine: IOSEngine, command: ParsedCommand, byInterface: boolean): string {
  const rule = dynamicRule(command, byInterface);
  if (typeof rule === "string") return rule;
  const config = currentConfig(engine.access);
  const same = config.rules.find((candidate): candidate is DynamicRule => candidate.kind === "dynamic" && candidate.list === rule.list);
  if (same) {
    if (sameTarget(same, rule) && same.overload === rule.overload) return "";
    return `%Dynamic mapping for access list ${rule.list} already exists, remove it first`;
  }
  edit(engine.access, (next) => {
    next.rules.push(rule);
  });
  if (rule.pool !== undefined && !config.pools.some((pool) => pool.name === rule.pool)) {
    return `%Pool ${rule.pool} not found`;
  }
  return "";
}

function removeDynamic(engine: IOSEngine, command: ParsedCommand, byInterface: boolean): string {
  const rule = dynamicRule(command, byInterface);
  if (typeof rule === "string") return rule;
  edit(engine.access, (config) => {
    config.rules = config.rules.filter((candidate) => !(candidate.kind === "dynamic" && sameTarget(candidate, rule)));
  });
  return "";
}

// MARK: show ip nat

function tableRow(protocol: string, insideGlobal: string, insideLocal: string, outsideLocal: string, outsideGlobal: string): string {
  const cell = (text: string): string => (text.length >= 18 ? `${text} ` : text.padEnd(19));
  return `${protocol.padEnd(3)} ${cell(insideGlobal)}${cell(insideLocal)}${cell(outsideLocal)}${outsideGlobal}`;
}

function showTranslations(engine: IOSEngine): string {
  const config = currentConfig(engine.access);
  const state = natState(engine.access.deviceID);
  const lines = [tableRow("Pro", "Inside global", "Inside local", "Outside local", "Outside global")];
  for (const flow of state.translations) {
    lines.push(
      tableRow(
        flow.protocol,
        `${flow.global}:${flow.globalPort}`,
        `${flow.local}:${flow.localPort}`,
        `${flow.remote}:${flow.remotePort}`,
        `${flow.remote}:${flow.remotePort}`,
      ),
    );
  }
  const seen = new Set<string>();
  for (const flow of state.translations) {
    if (flow.kind !== "dynamic" || !flow.simple) continue;
    const key = `${flow.global}|${flow.local}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(tableRow("---", flow.global, flow.local, "---", "---"));
  }
  for (const rule of config.rules) {
    if (rule.kind === "static") lines.push(tableRow("---", rule.global, rule.local, "---", "---"));
  }
  return lines.join("\n");
}

function showStatistics(engine: IOSEngine): string {
  const name = (id: L3InterfaceID): string => interfaceName(engine, id);
  const config = currentConfig(engine.access);
  const state = natState(engine.access.deviceID);
  const statics = config.rules.filter((rule) => rule.kind === "static").length;
  const simple = new Set(state.translations.filter((flow) => flow.kind === "dynamic" && flow.simple).map((flow) => `${flow.global}|${flow.local}`)).size;
  const flows = state.translations.length;
  const dynamic = flows + simple;
  const lines = [
    `Total active translations: ${statics + dynamic} (${statics} static, ${dynamic} dynamic; ${flows} extended)`,
    `Peak translations: ${Math.max(state.peak, statics + dynamic)}, occurred 00:00:00 ago`,
    "Outside interfaces:",
    ...config.outside.map((id) => `  ${name(id)}`),
    "Inside interfaces:",
    ...config.inside.map((id) => `  ${name(id)}`),
    `Hits: ${state.hits}  Misses: ${state.misses}`,
    `CEF Translated packets: ${state.hits}, CEF Punted packets: 0`,
    "Expired translations: 0",
    "Dynamic mappings:",
  ];
  const dynamicRules = config.rules.filter((rule): rule is DynamicRule => rule.kind === "dynamic");
  if (dynamicRules.length > 0) lines.push("-- Inside Source");
  dynamicRules.forEach((rule, index) => {
    const target = rule.pool !== undefined ? `pool ${rule.pool}` : `interface ${rule.interface === undefined ? "?" : name(rule.interface)}`;
    lines.push(`[Id: ${index + 1}] access-list ${rule.list} ${target} refcount ${state.translations.filter((flow) => flow.style === "ios" && flow.list === rule.list).length}`);
    const pool = rule.pool === undefined ? undefined : config.pools.find((candidate) => candidate.name === rule.pool);
    if (pool) {
      const total = poolSize(pool);
      const allocated = new Set(state.translations.filter((flow) => flow.pool === pool.name).map((flow) => flow.global)).size;
      const mask = IPv4.mask(pool.prefixLength).description;
      lines.push(` pool ${pool.name}: netmask ${mask}`);
      lines.push(`\tstart ${pool.start} end ${pool.end}`);
      lines.push(`\ttype generic, total addresses ${total}, allocated ${allocated} (${total === 0 ? 0 : Math.floor((allocated * 100) / total)}%), misses 0`);
    }
  });
  lines.push("NetSketch: časové limity překladů se nesimulují, záznamy zůstanou do příkazu clear ip nat translation *.");
  return lines.join("\n");
}

/** The IOS name of an interface ("GigabitEthernet0/0/1", "Vlan10"). */
function interfaceName(engine: IOSEngine, id: L3InterfaceID): string {
  if (id.startsWith("vlan:")) return `Vlan${id.slice(5)}`;
  const port = engine.access.device?.ports.find((candidate) => `port:${candidate.id}` === id);
  return port === undefined ? "?" : engine.namer.longName(port.name);
}

// MARK: Running configuration

function interfaceLines(engine: IOSEngine, id: L3InterfaceID): string[] {
  const config = engine.access.protocols.nat;
  if (!config) return [];
  if (config.inside.includes(id)) return [" ip nat inside"];
  if (config.outside.includes(id)) return [" ip nat outside"];
  return [];
}

function ruleLine(engine: IOSEngine, rule: NATRule): string | null {
  switch (rule.kind) {
    case "static":
      return `ip nat inside source static ${rule.local} ${rule.global}`;
    case "dynamic":
      return `ip nat inside source ${dynamicRuleText(rule, rule.interface === undefined ? null : interfaceName(engine, rule.interface)).slice("ip nat inside source ".length)}`;
    default:
      return null;
  }
}

function globalBlocks(engine: IOSEngine): string[][] {
  const config = engine.access.protocols.nat;
  if (!config) return [];
  const lines: string[] = [];
  for (const pool of config.pools) {
    lines.push(`ip nat pool ${pool.name} ${pool.start} ${pool.end} netmask ${IPv4.mask(pool.prefixLength).description}`);
  }
  for (const rule of config.rules) {
    const text = ruleLine(engine, rule);
    if (text !== null) lines.push(text);
  }
  return lines.length === 0 ? [] : [lines];
}

// MARK: Command trees

/** `ip nat ...` of the global configuration; `negated` builds the `no ip nat ...` forms. */
function globalNat(negated: boolean): CommandNode {
  const overload = (run: (engine: IOSEngine, command: ParsedCommand) => string): CommandNode[] => [
    kw("overload", "Overload an address translation", [], run),
  ];
  const poolRun = (run: (engine: IOSEngine, command: ParsedCommand) => string): CommandNode[] => [
    kw("pool", "Name pool of global addresses", [
      word("pool", "Pool name for global addresses", run, "WORD", overload(run)),
    ]),
  ];
  const interfaceRun = (run: (engine: IOSEngine, command: ParsedCommand) => string): CommandNode[] => [
    kw("interface", "Specify interface for global address", [
      custom(IOSEngine.interfaceArgument, run, "", overload(run)),
    ]),
  ];
  const listRun = (pool: (e: IOSEngine, c: ParsedCommand) => string, byInterface: (e: IOSEngine, c: ParsedCommand) => string): CommandNode =>
    kw("list", "Specify access list describing local addresses", [
      word("list", "Access list name or number", undefined, "WORD", [...poolRun(pool), ...interfaceRun(byInterface)]),
    ]);
  const staticRun = negated ? removeStatic : addStatic;
  const children: CommandNode[] = [
    kw("inside", "Inside address translation", [
      kw("source", "Source address translation", [
        kw("static", "Specify static local->global mapping", [
          word("local", "Inside local IP address", undefined, "A.B.C.D", [
            word("global", "Inside global IP address", staticRun, "A.B.C.D"),
          ]),
        ]),
        listRun(
          (e, c) => (negated ? removeDynamic(e, c, false) : addDynamic(e, c, false)),
          (e, c) => (negated ? removeDynamic(e, c, true) : addDynamic(e, c, true)),
        ),
      ]),
    ]),
  ];
  if (negated) {
    children.push(kw("pool", "Define pool of addresses", [word("name", "Pool name", removePool)]));
  } else {
    const defined = (mask: CommandNode[]): CommandNode =>
      kw("pool", "Define pool of addresses", [
        word("name", "Pool name", undefined, "WORD", [
          word("start", "Start IP address", undefined, "A.B.C.D", [word("end", "End IP address", undefined, "A.B.C.D", mask)]),
        ]),
      ]);
    children.push(
      defined([
        kw("netmask", "Specify the network mask", [word("mask", "Network mask", addPool, "A.B.C.D")]),
        kw("prefix-length", "Specify the network mask length", [
          num("length", closedRange(1, maxPrefixLength), "Prefix length", [], addPool),
        ]),
      ]),
    );
  }
  const other = (name: string, help: string): CommandNode =>
    kw(name, help, [line("rest", help, () => Notices.notStored(`ip nat ${name}`))]);
  children.push(
    other("outside", "Outside address translation"),
    other("translation", "Translation timeouts"),
    other("log", "NAT logging"),
  );
  return kw("nat", "NAT configuration commands", children);
}

function interfaceNat(negated: boolean): CommandNode {
  const side = (name: "inside" | "outside", help: string): CommandNode =>
    kw(name, help, [], (engine) => (negated ? clearSide(engine, name) : setSide(engine, name)));
  return kw("nat", "Configure NAT on the interface", [
    side("inside", "Inside interface for address translation"),
    side("outside", "Outside interface for address translation"),
  ]);
}

function showNat(): CommandNode {
  return kw("nat", "IP NAT information", [
    kw("translations", "Translation entries", [], (engine) => showTranslations(engine)),
    kw("statistics", "Translation statistics", [], (engine) => showStatistics(engine)),
  ]);
}

function clearNat(): CommandNode {
  const clearTable = (engine: IOSEngine): string => {
    clearTranslations(engine.access.deviceID);
    return "";
  };
  return kw(
    "clear",
    "Reset functions",
    [
      kw("ip", "IP", [
        kw("nat", "Clear NAT", [
          kw("translation", "Clear dynamic NAT translations", [kw("*", "Delete all dynamic translations", [], clearTable)]),
        ]),
        line("rest", "Reset functions", () => Notices.needsSimulation),
      ]),
      line("rest", "Reset functions", () => Notices.needsSimulation),
    ],
    () => Notices.needsSimulation,
  );
}

export const natIOS: IOSFeature = (dialect) => {
  if (dialect !== "ios") return {};
  return {
    showIP: [showNat()],
    privileged: [clearNat()],
    globalIP: [globalNat(false)],
    globalNoIP: [globalNat(true)],
    interfaceIP: [interfaceNat(false)],
    interfaceNoIP: [interfaceNat(true)],
    config: { interfaceLines, globalBlocks },
  };
};
