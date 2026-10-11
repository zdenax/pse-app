// MikroTik `/ip firewall filter`: the values of a rule, matching of packets and the properties
// as `print` and `/export` write them. Pure functions; used by routeros.ts and sim.ts.

import type { Device, L3InterfaceID } from "../../../core/model";
import type { FirewallRule } from "../../../core/protocols";
import { IPv4, IPv4Prefix } from "../../sim/ipv4";
import type { Packet } from "../../sim/packet";
import { isReply } from "./rules";

export type Chain = FirewallRule["chain"];

export const chains: readonly Chain[] = ["input", "forward", "output"];

export const connectionStates = ["established", "related", "new", "invalid", "untracked"] as const;

/** Splits a leading "!" (negation) from a value. */
export function splitNot(text: string): { not: boolean; body: string } {
  return text.startsWith("!") ? { not: true, body: text.slice(1) } : { not: false, body: text };
}

// MARK: Validation of typed values (null: invalid)

/** `A.B.C.D`, `A.B.C.D/NN` or `A.B.C.D-A.B.C.D`, optionally negated; returned as typed. */
export function checkAddress(text: string): string | null {
  const { body } = splitNot(text);
  if (IPv4.parse(body) || IPv4Prefix.fromCIDR(body)) return text;
  const range = body.split("-");
  if (range.length === 2) {
    const low = IPv4.parse(range[0]);
    const high = IPv4.parse(range[1]);
    if (low && high && low.value <= high.value) return text;
  }
  return null;
}

/** `tcp`, `udp`, `icmp` (or the protocol numbers 6, 17, 1), optionally negated. */
export function checkProtocol(text: string): string | null {
  const { not, body } = splitNot(text.toLowerCase());
  const name = body === "6" ? "tcp" : body === "17" ? "udp" : body === "1" ? "icmp" : body;
  return ["tcp", "udp", "icmp"].includes(name) ? (not ? "!" : "") + name : null;
}

/** `80`, `20-21`, `80,443,8000-8100`, optionally negated; returned as typed. */
export function checkPorts(text: string): string | null {
  const { body } = splitNot(text);
  if (body === "") return null;
  for (const piece of body.split(",")) {
    const range = piece.split("-");
    if (range.length > 2 || range.some((part) => !/^[0-9]{1,5}$/.test(part) || Number(part) > 65535)) return null;
    if (range.length === 2 && Number(range[0]) > Number(range[1])) return null;
  }
  return text;
}

/** `established,related`, optionally with "!" before a state; returned as typed. */
export function checkStates(text: string): string | null {
  const states = text.split(",");
  const valid = states.every((state) => (connectionStates as readonly string[]).includes(splitNot(state).body));
  return valid ? text : null;
}

// MARK: Matching

function matchAddress(value: string, address: IPv4): boolean {
  const { not, body } = splitNot(value);
  let inside = false;
  const prefix = IPv4Prefix.fromCIDR(body);
  const host = IPv4.parse(body);
  if (prefix) {
    inside = prefix.contains(address);
  } else if (host) {
    inside = host.equals(address);
  } else {
    const range = body.split("-").map((part) => IPv4.parse(part));
    inside = range.length === 2 && range[0] !== null && range[1] !== null && address.value >= range[0].value && address.value <= range[1].value;
  }
  return inside !== not;
}

function matchPortList(value: string, port: number): boolean {
  const { not, body } = splitNot(value);
  const inside = body.split(",").some((piece) => {
    const range = piece.split("-").map(Number);
    return range.length === 2 ? port >= range[0] && port <= range[1] : port === range[0];
  });
  return inside !== not;
}

function matchStates(value: string, packet: Packet): boolean {
  // The simulation tracks no connections: a reply counts as established, a request as new.
  const reply = isReply(packet);
  let positive = false;
  let any = false;
  for (const state of value.split(",")) {
    const { not, body } = splitNot(state);
    const holds = reply ? body === "established" || body === "related" : body === "new";
    if (not) {
      if (holds) return false;
    } else {
      any = true;
      if (holds) positive = true;
    }
  }
  return any ? positive : true;
}

export function ruleMatches(
  rule: FirewallRule,
  packet: Packet,
  ingress: { id: L3InterfaceID } | null,
  egress: { id: L3InterfaceID } | null,
): boolean {
  if (rule.protocol !== "") {
    const { not, body } = splitNot(rule.protocol);
    if ((packet.protocol === body) === not) return false;
  }
  if (rule.srcAddress !== "" && !matchAddress(rule.srcAddress, packet.source)) return false;
  if (rule.dstAddress !== "" && !matchAddress(rule.dstAddress, packet.destination)) return false;
  const withPorts = packet.protocol === "tcp" || packet.protocol === "udp";
  if ((rule.srcPort ?? "") !== "" && !(withPorts && matchPortList(rule.srcPort as string, packet.sourcePort))) return false;
  if (rule.dstPort !== "" && !(withPorts && matchPortList(rule.dstPort, packet.destinationPort))) return false;
  if ((rule.connectionState ?? "") !== "" && !matchStates(rule.connectionState as string, packet)) return false;
  if (rule.inInterface !== undefined) {
    if (ingress === null || (ingress.id === rule.inInterface) === (rule.inInterfaceNot === true)) return false;
  }
  if (rule.outInterface !== undefined) {
    if (egress === null || (egress.id === rule.outInterface) === (rule.outInterfaceNot === true)) return false;
  }
  return true;
}

/** The first enabled rule of the chain that matches, with its number in the whole list. */
export function evaluateChain(
  rules: readonly FirewallRule[],
  chain: Chain,
  packet: Packet,
  ingress: { id: L3InterfaceID } | null,
  egress: { id: L3InterfaceID } | null,
): { rule: FirewallRule; index: number } | null {
  for (const [index, rule] of rules.entries()) {
    if (rule.chain !== chain || rule.disabled) continue;
    if (ruleMatches(rule, packet, ingress, egress)) return { rule, index };
  }
  return null;
}

// MARK: Properties as RouterOS writes them

/** The name RouterOS gives a layer-3 interface of a device ("ether1", "bridge"); "?" when gone. */
export function interfaceLabel(device: Device | null, id: L3InterfaceID): string {
  if (id.startsWith("port:")) {
    return device?.ports.find((port) => port.id === id.slice(5))?.name ?? "?";
  }
  if (id.startsWith("vlan:")) return id === "vlan:1" ? "bridge" : `vlan${id.slice(5)}`;
  return "?";
}

/** The set properties in the order `print` shows them (comment and disabled are separate). */
export function ruleProperties(rule: FirewallRule, interfaceName: (id: L3InterfaceID) => string): [string, string][] {
  const properties: [string, string][] = [
    ["chain", rule.chain],
    ["action", rule.action],
  ];
  const optional: [string, string | undefined][] = [
    ["protocol", rule.protocol],
    ["src-address", rule.srcAddress],
    ["dst-address", rule.dstAddress],
    ["src-port", rule.srcPort],
    ["dst-port", rule.dstPort],
    ["connection-state", rule.connectionState],
    [
      "in-interface",
      rule.inInterface === undefined ? undefined : (rule.inInterfaceNot ? "!" : "") + interfaceName(rule.inInterface),
    ],
    [
      "out-interface",
      rule.outInterface === undefined ? undefined : (rule.outInterfaceNot ? "!" : "") + interfaceName(rule.outInterface),
    ],
  ];
  for (const [key, value] of optional) if (value !== undefined && value !== "") properties.push([key, value]);
  return properties;
}
