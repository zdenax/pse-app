// Where the protocol features plug into the IOS-style consoles (Cisco IOS, Dell OS9, generic).
//
// Each feature exports an `IOSFeature`: for a dialect it returns command nodes for the places
// below. CommandTables merges them into its trees: a feature keyword replaces a base keyword of
// the same name at that place (e.g. the "not simulated" placeholder of `show spanning-tree`).
//
// Rule for feature modules: use values imported from ../ios-engine, ../command-tables etc. only
// inside functions, never at module top level (the imports are circular).

import { CommandNode } from "../command-tree";
import type { IOSEngine } from "../ios-engine";
import type { L3InterfaceID } from "../../core/model";
import type { CLIDialect } from "../session-api";
import { aclIOS } from "./acl/ios";
import { dhcpIOS } from "./dhcp/ios";
import { layer2IOS } from "./layer2/ios";
import { natIOS } from "./nat/ios";
import { realismIOS } from "./realism/ios";
import { routingIOS } from "./routing/ios";

export interface IOSFeatureCommands {
  /** Children of `show` (user and privileged EXEC, and `do show`). */
  show?: CommandNode[];
  /** Children of `show ip`. */
  showIP?: CommandNode[];
  /** User and privileged EXEC (and `do`). */
  exec?: CommandNode[];
  /** Privileged EXEC only (and `do`), e.g. `clear ip nat translation *`. */
  privileged?: CommandNode[];
  /** Global configuration. */
  global?: CommandNode[];
  /** Children of global `no`. */
  globalNo?: CommandNode[];
  /** Children of global `ip`. */
  globalIP?: CommandNode[];
  /** Children of global `no ip`. */
  globalNoIP?: CommandNode[];
  /** Interface configuration of physical ports (and ranges). */
  interface?: CommandNode[];
  interfaceNo?: CommandNode[];
  /** Children of interface `ip` (physical ports, IOS SVIs, Dell `interface vlan`). */
  interfaceIP?: CommandNode[];
  interfaceNoIP?: CommandNode[];
  /**
   * The feature's own configuration modes by name (enter them by setting
   * `engine.mode = { kind: "feature", name, prompt, context }`). `exit`, `end` and `do` are added.
   */
  modes?: Record<string, CommandNode[]>;
  /** Lines of `show running-config`. */
  config?: IOSConfigLines;
}

export interface IOSConfigLines {
  /** Extra lines inside `interface X` (physical port or VLAN interface), each starting with a space. */
  interfaceLines?(engine: IOSEngine, interfaceID: L3InterfaceID): string[];
  /** Global blocks after the interfaces (`router ospf 1` ..., `ip nat ...`, `access-list ...`). */
  globalBlocks?(engine: IOSEngine): string[][];
}

export type IOSFeature = (dialect: CLIDialect) => IOSFeatureCommands;

export const iosFeatures: readonly IOSFeature[] = [layer2IOS, routingIOS, dhcpIOS, aclIOS, natIOS, realismIOS];

/** All features' commands of a dialect, concatenated. */
export function collectIOSFeatures(dialect: CLIDialect): Required<Omit<IOSFeatureCommands, "config">> {
  const result = {
    show: [] as CommandNode[],
    showIP: [] as CommandNode[],
    exec: [] as CommandNode[],
    privileged: [] as CommandNode[],
    global: [] as CommandNode[],
    globalNo: [] as CommandNode[],
    globalIP: [] as CommandNode[],
    globalNoIP: [] as CommandNode[],
    interface: [] as CommandNode[],
    interfaceNo: [] as CommandNode[],
    interfaceIP: [] as CommandNode[],
    interfaceNoIP: [] as CommandNode[],
    modes: {} as Record<string, CommandNode[]>,
  };
  for (const feature of iosFeatures) {
    const commands = feature(dialect);
    for (const key of Object.keys(result) as (keyof typeof result)[]) {
      if (key === "modes") {
        Object.assign(result.modes, commands.modes ?? {});
      } else {
        result[key].push(...((commands[key] as CommandNode[] | undefined) ?? []));
      }
    }
  }
  return result;
}

/**
 * Keyword nodes of the same name become one node with the children of all of them, so two
 * features that both add e.g. `clear` (or `clear ip ...`) do not hide each other.
 */
function combineKeywords(nodes: readonly CommandNode[]): CommandNode[] {
  const result: CommandNode[] = [];
  for (const node of nodes) {
    const name = node.keyword?.toLowerCase();
    const index = name === undefined ? -1 : result.findIndex((candidate) => candidate.keyword?.toLowerCase() === name);
    if (index < 0) {
      result.push(node);
      continue;
    }
    const first = result[index];
    result[index] = new CommandNode(
      first.kind,
      first.help,
      combineKeywords([...first.children, ...node.children]),
      first.hidden && node.hidden,
      first.handler ?? node.handler,
    );
  }
  return result;
}

/** `base` with `extra` appended; base keywords that `extra` defines again are dropped. */
export function mergeNodes(base: CommandNode[], extra: readonly CommandNode[]): CommandNode[] {
  if (extra.length === 0) return base;
  const combined = combineKeywords(extra);
  const replaced = new Set(combined.map((node) => node.keyword?.toLowerCase()).filter((name) => name !== undefined));
  return [...base.filter((node) => node.keyword === null || !replaced.has(node.keyword.toLowerCase())), ...combined];
}

/** Extra `interface` lines of every feature. */
export function featureInterfaceLines(engine: IOSEngine, interfaceID: L3InterfaceID): string[] {
  return iosFeatures.flatMap((feature) => feature(engine.dialect).config?.interfaceLines?.(engine, interfaceID) ?? []);
}

/** Global configuration blocks of every feature. */
export function featureGlobalBlocks(engine: IOSEngine): string[][] {
  return iosFeatures.flatMap((feature) => feature(engine.dialect).config?.globalBlocks?.(engine) ?? []);
}
