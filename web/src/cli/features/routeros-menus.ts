// Where the protocol features plug into the MikroTik RouterOS console: extra menus (e.g.
// `/ip dhcp-server`, `/ip firewall filter`, `/routing ospf instance`, `/interface bonding`) with
// their commands and their part of `/export`.

import type { L3InterfaceID } from "../../core/model";
import type { DeviceAccess } from "../model-access";
import { aclRouterOS } from "./acl/routeros";
import { dhcpRouterOS } from "./dhcp/routeros";
import { layer2RouterOS } from "./layer2/routeros";
import { natRouterOS } from "./nat/routeros";
import { routingRouterOS } from "./routing/routeros";

export interface RouterOSWord {
  readonly text: string;
  /** One-based column, as RouterOS reports it. */
  readonly column: number;
}

export type NamedValues = { kind: "values"; values: Map<string, string> } | { kind: "failure"; message: string };
export type ItemList = { kind: "items"; items: number[] } | { kind: "failure"; message: string };
export type InterfaceResult = { kind: "found"; id: L3InterfaceID; name: string } | { kind: "failure"; message: string };

/** What the engine offers to feature commands. */
export interface RouterOSContext {
  readonly access: DeviceAccess;
  readonly hostname: string;
  /** `key=value` arguments; keys may be abbreviated; a bare word is the value of `positional`. */
  named(args: RouterOSWord[], keys: string[], positional?: string | null): NamedValues;
  /** The items of `remove`/`set`/`enable` in a list of `count` rows: "0", "0,2", "numbers=1", "[find]". */
  itemNumbers(args: RouterOSWord[], count: number): ItemList;
  /** `interface=` value: a port name, or `bridge` on a switch (VLAN 1). */
  l3Interface(name: string): InterfaceResult;
  /** The RouterOS name of a layer-3 interface ("ether2", "bridge"); null when gone. */
  interfaceName(id: L3InterfaceID): string | null;
  /** "expected end of command (line 1 column N)". */
  endOfCommand(word: RouterOSWord): string;
  /** A value as `/export` writes it (quoted when needed). */
  exportValue(value: string): string;
}

export interface RouterOSFeatureCommand {
  readonly name: string;
  readonly help: string;
  run(context: RouterOSContext, args: RouterOSWord[]): string;
}

export interface RouterOSFeatureMenu {
  /** e.g. ["ip", "dhcp-server"]; missing parent menus are created. */
  readonly path: string[];
  readonly help: string;
  readonly commands: RouterOSFeatureCommand[];
  /** The rows of `/export` for this menu (without the "/ip dhcp-server" header); [] for none. */
  export?(context: RouterOSContext): string[];
}

export type RouterOSFeature = () => RouterOSFeatureMenu[];

export const routerOSFeatures: readonly RouterOSFeature[] = [
  layer2RouterOS,
  routingRouterOS,
  dhcpRouterOS,
  aclRouterOS,
  natRouterOS,
];

export function collectRouterOSMenus(): RouterOSFeatureMenu[] {
  return routerOSFeatures.flatMap((feature) => feature());
}
