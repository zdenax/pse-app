// Helpers for interface names (PortNaming.swift).

import { trimWhitespace } from "./util";

/**
 * Long interface-name prefixes and their conventional abbreviations.
 * Matched case-insensitively, longest first, and only when a digit follows.
 */
const rules: readonly (readonly [long: string, short: string])[] = [
  ["TwentyFiveGigabitEthernet", "Twe"],
  ["HundredGigabitEthernet", "Hu"],
  ["FortyGigabitEthernet", "Fo"],
  ["TenGigabitEthernet", "Te"],
  ["FiveGigabitEthernet", "Fi"],
  ["TwoGigabitEthernet", "Tw"],
  ["ManagementEthernet", "Ma"],
  ["GigabitEthernet", "Gi"],
  ["TwentyFiveGigE", "Twe"],
  ["FastEthernet", "Fa"],
  ["Port-channel", "Po"],
  ["HundredGigE", "Hu"],
  ["FortyGigE", "Fo"],
  ["Loopback", "Lo"],
  ["Ethernet", "Eth"],
  ["TenGigE", "Te"],
  ["Serial", "Se"],
  ["Vlan", "Vl"],
];

/**
 * Short form of an interface name for cable-end labels.
 *
 * "GigabitEthernet 1/1" -> "Gi1/1", "TenGigabitEthernet 1/49" -> "Te1/49",
 * "fortyGigE 1/53" -> "Fo1/53", "FastEthernet0/1" -> "Fa0/1".
 * Names that are already short ("Fa0/1", "ether1", "LAN 3", "Console") are returned unchanged.
 */
export function shortName(name: string): string {
  const trimmed = trimWhitespace(name);
  for (const [long, short] of rules) {
    if (trimmed.slice(0, long.length).toLowerCase() !== long.toLowerCase()) continue;
    const tail = trimmed.slice(long.length).replace(/^ +/, "");
    const first = tail.charAt(0);
    if (first < "0" || first > "9" || first === "") continue;
    return short + tail;
  }
  return trimmed;
}

/** Namespace-style access mirroring the Swift `PortNaming` enum. */
export const PortNaming = { shortName } as const;
