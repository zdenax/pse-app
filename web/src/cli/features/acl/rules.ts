// Access list rules of the Cisco/Dell dialects: the text grammar (parser with the position of the
// first wrong word and the help of the next one), the matching of packets and the listings.
// Pure functions without access to the consoles; used by ios.ts (commands) and sim.ts (packets).

import type { HelpEntry } from "../../command-tree";
import type { AccessList, ACLEntry } from "../../../core/protocols";
import { IPv4, IPv4Prefix } from "../../sim/ipv4";
import type { Packet } from "../../sim/packet";

export type ListType = "standard" | "extended";

// MARK: Ports and ICMP types

/** Names IOS accepts (and prints) for TCP ports. The first name of a number is the one printed. */
const tcpNames: readonly [string, number][] = [
  ["echo", 7],
  ["discard", 9],
  ["daytime", 13],
  ["chargen", 19],
  ["ftp-data", 20],
  ["ftp", 21],
  ["telnet", 23],
  ["smtp", 25],
  ["time", 37],
  ["whois", 43],
  ["tacacs", 49],
  ["domain", 53],
  ["gopher", 70],
  ["finger", 79],
  ["www", 80],
  ["hostname", 101],
  ["pop2", 109],
  ["pop3", 110],
  ["sunrpc", 111],
  ["ident", 113],
  ["nntp", 119],
  ["bgp", 179],
  ["irc", 194],
  ["exec", 512],
  ["login", 513],
  ["cmd", 514],
  ["lpd", 515],
  ["talk", 517],
  ["uucp", 540],
  ["klogin", 543],
  ["kshell", 544],
];

const udpNames: readonly [string, number][] = [
  ["echo", 7],
  ["discard", 9],
  ["time", 37],
  ["nameserver", 42],
  ["tacacs", 49],
  ["domain", 53],
  ["bootps", 67],
  ["bootpc", 68],
  ["tftp", 69],
  ["sunrpc", 111],
  ["ntp", 123],
  ["netbios-ns", 137],
  ["netbios-dgm", 138],
  ["netbios-ss", 139],
  ["snmp", 161],
  ["snmptrap", 162],
  ["xdmcp", 177],
  ["isakmp", 500],
  ["biff", 512],
  ["who", 513],
  ["syslog", 514],
  ["talk", 517],
  ["rip", 520],
];

/** Names accepted on input only (IOS prints the number): newer software knows them. */
const aliases: readonly [string, number][] = [
  ["ssh", 22],
  ["https", 443],
];

function namesOf(protocol: string): readonly [string, number][] {
  return protocol === "udp" ? udpNames : tcpNames;
}

/** A port number from a number or (IOS) a name; null when it is neither. */
export function portNumber(text: string, protocol: string, allowNames: boolean): number | null {
  if (/^[0-9]{1,5}$/.test(text)) {
    const value = Number(text);
    return value <= 65535 ? value : null;
  }
  if (!allowNames) return null;
  const lower = text.toLowerCase();
  const known = namesOf(protocol).find(([name]) => name === lower);
  if (known) return known[1];
  return protocol === "tcp" ? (aliases.find(([name]) => name === lower)?.[1] ?? null) : null;
}

function portLabel(value: number, protocol: string, names: boolean): string {
  if (!names) return `${value}`;
  return namesOf(protocol).find(([, number]) => number === value)?.[0] ?? `${value}`;
}

const icmpTypeNames = [
  "administratively-prohibited",
  "alternate-address",
  "conversion-error",
  "echo",
  "echo-reply",
  "general-parameter-problem",
  "host-isolated",
  "host-precedence-unreachable",
  "host-redirect",
  "host-tos-redirect",
  "host-tos-unreachable",
  "host-unknown",
  "host-unreachable",
  "information-reply",
  "information-request",
  "mask-reply",
  "mask-request",
  "mobile-redirect",
  "net-redirect",
  "net-tos-redirect",
  "net-tos-unreachable",
  "net-unreachable",
  "network-unknown",
  "no-room-for-option",
  "option-missing",
  "packet-too-big",
  "parameter-problem",
  "port-unreachable",
  "precedence-unreachable",
  "protocol-unreachable",
  "reassembly-timeout",
  "redirect",
  "router-advertisement",
  "router-solicitation",
  "source-quench",
  "source-route-failed",
  "time-exceeded",
  "timestamp-reply",
  "timestamp-request",
  "traceroute",
  "ttl-exceeded",
  "unreachable",
];

const icmpTypeNumbers = new Map<number, string>([
  [0, "echo-reply"],
  [3, "unreachable"],
  [5, "redirect"],
  [8, "echo"],
  [11, "time-exceeded"],
  [12, "parameter-problem"],
  [13, "timestamp-request"],
  [14, "timestamp-reply"],
  [17, "mask-request"],
  [18, "mask-reply"],
]);

/** Exact keyword first, otherwise the only keyword that starts with the word. */
export function keyword(word: string, candidates: readonly string[]): string | null {
  const lower = word.toLowerCase();
  if (candidates.includes(lower)) return lower;
  const matches = candidates.filter((candidate) => candidate.startsWith(lower));
  return matches.length === 1 ? matches[0] : null;
}

// MARK: Address specifications ("any", "host A", "A W")

const allBits = 0xffffffff;

/** Wildcard text of a prefix length: 24 -> 0.0.0.255. */
function wildcardOf(length: number): IPv4 {
  return new IPv4(~IPv4.mask(length).value >>> 0);
}

/** Normalises an address and a wildcard mask: all zero is a host, all ones is "any". */
function normaliseWildcard(address: IPv4, wildcard: IPv4): string {
  if (wildcard.value === 0) return `host ${address.description}`;
  if (wildcard.value === allBits) return "any";
  return `${address.description} ${wildcard.description}`;
}

/** Normalises `A.B.C.D/NN` (Dell). */
function normalisePrefix(prefix: IPv4Prefix): string {
  if (prefix.length === 0) return "any";
  if (prefix.length === 32) return `host ${prefix.address.description}`;
  return `${prefix.network.description} ${wildcardOf(prefix.length).description}`;
}

/** True when the normalised specification covers `address`. */
export function matchSpec(spec: string, address: IPv4): boolean {
  if (spec === "" || spec === "any") return true;
  const words = spec.split(" ");
  if (words[0] === "host") return IPv4.parse(words[1] ?? "")?.equals(address) ?? false;
  const base = IPv4.parse(words[0]);
  const wildcard = IPv4.parse(words[1] ?? "");
  if (!base || !wildcard) return false;
  return (((base.value ^ address.value) & ~wildcard.value) >>> 0) === 0;
}

export interface FormatStyle {
  /** Dell OS9 (CIDR networks, numeric ports, `seq N`). */
  dell: boolean;
  /** A standard list: a host is written without the word `host`. */
  standard: boolean;
  /** `show access-lists` (standard lists: "A, wildcard bits W"), not the configuration. */
  show: boolean;
}

export function formatSpec(spec: string, style: FormatStyle): string {
  if (spec === "any" || spec === "") return "any";
  const words = spec.split(" ");
  if (words[0] === "host") return style.standard && !style.dell ? (words[1] ?? "") : spec;
  const wildcard = IPv4.parse(words[1] ?? "");
  const base = IPv4.parse(words[0]);
  if (style.dell && base && wildcard) {
    const length = new IPv4(~wildcard.value >>> 0).prefixLength;
    if (length !== null) return `${base.description}/${length}`;
  }
  if (style.standard && style.show && !style.dell) return `${words[0]}, wildcard bits ${words[1] ?? ""}`;
  return spec;
}

// MARK: Port conditions ("eq 80", "range 20 21")

/** True when the condition (numeric IOS text, "" for none) holds for `port`. */
export function matchPorts(condition: string, port: number): boolean {
  if (condition === "") return true;
  const words = condition.split(" ");
  const numbers = words.slice(1).map(Number);
  switch (words[0]) {
    case "eq":
      return numbers.includes(port);
    case "neq":
      return !numbers.includes(port);
    case "gt":
      return port > (numbers[0] ?? 65535);
    case "lt":
      return port < (numbers[0] ?? 0);
    case "range":
      return port >= (numbers[0] ?? 0) && port <= (numbers[1] ?? 65535);
    default:
      return false;
  }
}

function portText(condition: string, protocol: string, names: boolean): string {
  const words = condition.split(" ");
  return [words[0], ...words.slice(1).map((value) => portLabel(Number(value), protocol, names))].join(" ");
}

// MARK: Matching packets

/**
 * First ephemeral port: probes use ports from here up, so a packet to such a port is the
 * reply of a connection the other side opened (what `established` and `connection-state`
 * recognise, as the simulation tracks no connections).
 */
export const ephemeralStart = 49152;

/** True for the answer of a request (echo reply, packet to the ephemeral port of a client). */
export function isReply(packet: Packet): boolean {
  if (packet.protocol === "icmp") return packet.icmpType === "echo-reply";
  return packet.destinationPort >= ephemeralStart && packet.sourcePort < ephemeralStart;
}

export function entryMatches(entry: ACLEntry, type: ListType, packet: Packet): boolean {
  if (entry.action === "remark") return false;
  if (!matchSpec(entry.source, packet.source)) return false;
  if (type === "standard") return true;
  if (entry.protocol !== "ip" && entry.protocol !== packet.protocol) return false;
  if (!matchSpec(entry.destination, packet.destination)) return false;
  if (packet.protocol === "icmp") {
    return entry.protocol !== "icmp" || entry.icmpType === "" || entry.icmpType === packet.icmpType;
  }
  if (entry.protocol === "ip") return true;
  if (!matchPorts(entry.sourcePort, packet.sourcePort)) return false;
  if (!matchPorts(entry.destinationPort, packet.destinationPort)) return false;
  return entry.established !== true || isReply(packet);
}

export interface ListVerdict {
  permit: boolean;
  /** The line that decided; null for the implicit deny at the end (and for an empty list). */
  entry: ACLEntry | null;
}

/** First match wins; no match is the implicit deny; a list without lines permits everything. */
export function evaluateList(list: AccessList, packet: Packet): ListVerdict {
  const rules = list.entries.filter((entry) => entry.action !== "remark");
  if (rules.length === 0) return { permit: true, entry: null };
  for (const entry of rules) {
    if (entryMatches(entry, list.type, packet)) return { permit: entry.action === "permit", entry };
  }
  return { permit: false, entry: null };
}

// MARK: Lists

/** The kind of list a number belongs to; null outside the access list ranges. */
export function typeOfNumber(number: number): ListType | null {
  if ((number >= 1 && number <= 99) || (number >= 1300 && number <= 1999)) return "standard";
  if ((number >= 100 && number <= 199) || (number >= 2000 && number <= 2699)) return "extended";
  return null;
}

export function isNumbered(list: AccessList): boolean {
  return /^[0-9]+$/.test(list.name) && typeOfNumber(Number(list.name)) === list.type;
}

/** The sequence number of the next line added without one (10, 20, ...; Dell 5, 10, ...). */
export function nextSequence(list: AccessList, step: number): number {
  const last = list.entries.reduce((best, entry) => Math.max(best, entry.sequence), 0);
  return last + step;
}

/** Inserts the entry at its place by sequence number. */
export function insertEntry(list: AccessList, entry: ACLEntry): void {
  const index = list.entries.findIndex((other) => other.sequence > entry.sequence);
  if (index < 0) list.entries.push(entry);
  else list.entries.splice(index, 0, entry);
}

// MARK: Rule text

export interface ParsedRule {
  protocol: string;
  source: string;
  destination: string;
  sourcePort: string;
  destinationPort: string;
  icmpType: string;
  established: boolean;
  log: boolean;
}

export interface RuleOptions {
  kind: ListType;
  dell: boolean;
}

export type RuleParse =
  | { kind: "ok"; rule: ParsedRule }
  /** The word at index `at` is wrong. */
  | { kind: "invalid"; at: number }
  /** The rule ends too early; `next` is what may follow. */
  | { kind: "incomplete"; next: HelpEntry[] };

type Step<T> =
  | { kind: "ok"; value: T; next: number }
  | { kind: "invalid"; at: number }
  | { kind: "incomplete"; next: HelpEntry[] };

const protocols = ["ip", "icmp", "tcp", "udp"];

function sorted(entries: HelpEntry[]): HelpEntry[] {
  return [...entries].sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
}

export function protocolHelp(): HelpEntry[] {
  return sorted([
    { name: "icmp", text: "Internet Control Message Protocol" },
    { name: "ip", text: "Any Internet Protocol" },
    { name: "tcp", text: "Transmission Control Protocol" },
    { name: "udp", text: "User Datagram Protocol" },
  ]);
}

function addressHelp(role: "source" | "destination", options: RuleOptions): HelpEntry[] {
  return sorted([
    { name: options.dell ? "A.B.C.D/NN" : "A.B.C.D", text: `${role === "source" ? "Source" : "Destination"} address` },
    { name: "any", text: `Any ${role} host` },
    { name: "host", text: `A single ${role} host` },
  ]);
}

function portOperatorHelp(): HelpEntry[] {
  return sorted([
    { name: "eq", text: "Match only packets on a given port number" },
    { name: "gt", text: "Match only packets with a greater port number" },
    { name: "lt", text: "Match only packets with a lower port number" },
    { name: "neq", text: "Match only packets not on a given port number" },
    { name: "range", text: "Match only packets in the range of port numbers" },
  ]);
}

function parseAddress(words: string[], start: number, role: "source" | "destination", options: RuleOptions): Step<string> {
  const word = words[start];
  if (word === undefined) return { kind: "incomplete", next: addressHelp(role, options) };
  const key = keyword(word, ["any", "host"]);
  if (key === "any") return { kind: "ok", value: "any", next: start + 1 };
  if (key === "host") {
    const text = words[start + 1];
    if (text === undefined) {
      return { kind: "incomplete", next: [{ name: "A.B.C.D", text: `${role === "source" ? "Source" : "Destination"} address` }] };
    }
    const address = IPv4.parse(text);
    if (!address) return { kind: "invalid", at: start + 1 };
    return { kind: "ok", value: `host ${address.description}`, next: start + 2 };
  }
  if (options.dell) {
    const prefix = IPv4Prefix.fromCIDR(word);
    return prefix ? { kind: "ok", value: normalisePrefix(prefix), next: start + 1 } : { kind: "invalid", at: start };
  }
  const address = IPv4.parse(word);
  if (!address) return { kind: "invalid", at: start };
  const maskText = words[start + 1];
  if (maskText === undefined) {
    if (options.kind === "standard") return { kind: "ok", value: `host ${address.description}`, next: start + 1 };
    return { kind: "incomplete", next: [{ name: "A.B.C.D", text: `${role === "source" ? "Source" : "Destination"} wildcard bits` }] };
  }
  const wildcard = IPv4.parse(maskText);
  if (!wildcard) {
    if (options.kind === "standard" && keyword(maskText, ["log"]) !== null) {
      return { kind: "ok", value: `host ${address.description}`, next: start + 1 };
    }
    return { kind: "invalid", at: start + 1 };
  }
  return { kind: "ok", value: normaliseWildcard(address, wildcard), next: start + 2 };
}

/** `eq|neq|gt|lt|range PORT...` at `start`; ok with an empty value when the word is no operator. */
function parsePorts(words: string[], start: number, protocol: string, options: RuleOptions): Step<string> {
  const operator = words[start] === undefined ? null : keyword(words[start], ["eq", "gt", "lt", "neq", "range"]);
  if (operator === null) return { kind: "ok", value: "", next: start };
  const names = !options.dell;
  const portHelp: HelpEntry[] = [{ name: "<0-65535>", text: "Port number" }];
  if (names) portHelp.push({ name: "WORD", text: "Port name" });
  const wanted = operator === "range" ? 2 : 1;
  const numbers: number[] = [];
  let index = start + 1;
  for (;;) {
    const text = words[index];
    if (text === undefined) {
      if (numbers.length < wanted) return { kind: "incomplete", next: portHelp };
      break;
    }
    const value = portNumber(text, protocol, names);
    if (value === null) {
      if (numbers.length < wanted) return { kind: "invalid", at: index };
      break;
    }
    numbers.push(value);
    index += 1;
    const more = (operator === "eq" || operator === "neq") && names;
    if (numbers.length >= wanted && !more) break;
  }
  if (operator === "range" && numbers[0] > numbers[1]) return { kind: "invalid", at: start + 2 };
  return { kind: "ok", value: `${operator} ${numbers.join(" ")}`, next: index };
}

function parseICMPType(words: string[], start: number): Step<string> {
  const text = words[start];
  if (text === undefined || keyword(text, ["log"]) !== null) return { kind: "ok", value: "", next: start };
  if (/^[0-9]{1,3}$/.test(text)) {
    const number = Number(text);
    if (number > 255) return { kind: "invalid", at: start };
    let next = start + 1;
    // An optional ICMP code follows the number.
    if (words[next] !== undefined && /^[0-9]{1,3}$/.test(words[next])) next += 1;
    return { kind: "ok", value: icmpTypeNumbers.get(number) ?? `${number}`, next };
  }
  const name = keyword(text, icmpTypeNames);
  return name === null ? { kind: "invalid", at: start } : { kind: "ok", value: name, next: start + 1 };
}

/**
 * Parses the part of a rule after `permit`/`deny`: standard `SOURCE [log]`, extended
 * `PROTOCOL SOURCE [ports] DESTINATION [ports|icmp-type|established] [log]`.
 */
export function parseRule(words: string[], options: RuleOptions): RuleParse {
  const rule: ParsedRule = {
    protocol: "ip",
    source: "any",
    destination: "",
    sourcePort: "",
    destinationPort: "",
    icmpType: "",
    established: false,
    log: false,
  };
  let index = 0;
  if (options.kind === "extended") {
    if (words[0] === undefined) return { kind: "incomplete", next: protocolHelp() };
    const protocol = keyword(words[0], protocols);
    if (protocol === null) return { kind: "invalid", at: 0 };
    rule.protocol = protocol;
    index = 1;
  }
  const source = parseAddress(words, index, "source", options);
  if (source.kind !== "ok") return source;
  rule.source = source.value;
  index = source.next;

  const hasPorts = rule.protocol === "tcp" || rule.protocol === "udp";
  if (options.kind === "extended") {
    if (hasPorts) {
      const ports = parsePorts(words, index, rule.protocol, options);
      if (ports.kind !== "ok") return ports;
      rule.sourcePort = ports.value;
      index = ports.next;
    }
    const destination = parseAddress(words, index, "destination", options);
    if (destination.kind !== "ok") {
      if (destination.kind === "incomplete" && hasPorts && rule.sourcePort === "") {
        return { kind: "incomplete", next: sorted([...portOperatorHelp(), ...destination.next]) };
      }
      return destination;
    }
    rule.destination = destination.value;
    index = destination.next;
    if (hasPorts) {
      const ports = parsePorts(words, index, rule.protocol, options);
      if (ports.kind !== "ok") return ports;
      rule.destinationPort = ports.value;
      index = ports.next;
    } else if (rule.protocol === "icmp") {
      const type = parseICMPType(words, index);
      if (type.kind !== "ok") return type;
      rule.icmpType = type.value;
      index = type.next;
    }
  }

  const allowed = ["log"];
  if (rule.protocol === "tcp" && !options.dell) allowed.unshift("established");
  while (index < words.length) {
    const flag = keyword(words[index], allowed);
    if (flag === null) return { kind: "invalid", at: index };
    if (flag === "established") rule.established = true;
    else rule.log = true;
    index += 1;
  }
  return { kind: "ok", rule };
}

/** The help for the word after the words typed so far; [] when the rule is complete or wrong. */
export function ruleHelp(words: string[], options: RuleOptions): HelpEntry[] {
  const result = parseRule(words, options);
  return result.kind === "incomplete" ? result.next : [];
}

/** The words that may start a rule. */
export function ruleStart(options: RuleOptions): HelpEntry[] {
  return options.kind === "extended" ? protocolHelp() : addressHelp("source", options);
}

/** An entry for the stored list from a parsed rule. */
export function entryFromRule(sequence: number, action: "permit" | "deny", rule: ParsedRule): ACLEntry {
  const entry: ACLEntry = {
    sequence,
    action,
    protocol: rule.protocol,
    source: rule.source,
    destination: rule.destination,
    destinationPort: rule.destinationPort,
    sourcePort: rule.sourcePort,
    icmpType: rule.icmpType,
    remark: "",
  };
  if (rule.established) entry.established = true;
  if (rule.log) entry.log = true;
  return entry;
}

/** True when two entries say the same (sequence and logging ignored): `no permit ...`. */
export function sameRule(a: ACLEntry, b: ACLEntry): boolean {
  return (
    a.action === b.action &&
    a.protocol === b.protocol &&
    a.source === b.source &&
    a.destination === b.destination &&
    a.sourcePort === b.sourcePort &&
    a.destinationPort === b.destinationPort &&
    a.icmpType === b.icmpType &&
    (a.established ?? false) === (b.established ?? false)
  );
}

// MARK: Listings

/**
 * One line of a list as the device prints it, without sequence number:
 * "permit tcp any any eq www", "deny   10.0.0.0 0.0.0.255" (`padDeny` as in the IOS
 * configuration and in `show access-lists` of standard lists).
 */
export function formatEntry(entry: ACLEntry, type: ListType, style: FormatStyle, padDeny: boolean): string {
  if (entry.action === "remark") return `remark ${entry.remark}`;
  const action = entry.action === "deny" && padDeny && !style.dell ? "deny  " : entry.action;
  const words: string[] = [action];
  const names = !style.dell;
  const spec = { ...style, standard: type === "standard" };
  if (type === "extended") {
    words.push(entry.protocol, formatSpec(entry.source, spec));
    if (entry.sourcePort !== "") words.push(portText(entry.sourcePort, entry.protocol, names));
    words.push(formatSpec(entry.destination, spec));
    if (entry.destinationPort !== "") words.push(portText(entry.destinationPort, entry.protocol, names));
    if (entry.icmpType !== "") words.push(entry.icmpType);
    if (entry.established) words.push("established");
  } else {
    words.push(formatSpec(entry.source, spec));
  }
  if (entry.log) words.push("log");
  return words.join(" ");
}
