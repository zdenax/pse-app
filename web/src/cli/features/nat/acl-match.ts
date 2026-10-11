// The access lists a dynamic NAT rule refers to (`ip nat inside source list ACL ...`). NAT only
// needs the answer "does the list permit this packet?", so this is a small matcher of its own:
// it reads `Device.protocols.acl.lists` and does not depend on the ACL feature's code.

import type { Device } from "../../../core/model";
import type { ACLEntry, AccessList } from "../../../core/protocols/acl";
import { IPv4 } from "../../sim/ipv4";
import type { Packet } from "../../sim/packet";

const wellKnownPorts: Record<string, number> = {
  "ftp-data": 20,
  ftp: 21,
  ssh: 22,
  telnet: 23,
  smtp: 25,
  domain: 53,
  www: 80,
  http: 80,
  pop3: 110,
  ntp: 123,
  snmp: 161,
  https: 443,
};

/** An address condition: IOS `any`, `host A`, `A W` (wildcard mask) or a bare address. */
function matchesAddress(condition: string, address: IPv4): boolean {
  const words = condition.trim().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return true;
  const first = words[0].toLowerCase();
  if (first === "any" && words.length === 1) return true;
  if (first === "host" && words.length === 2) return IPv4.parse(words[1])?.equals(address) ?? false;
  const base = IPv4.parse(words[0]);
  if (base === null) return false;
  if (words.length === 1) return base.equals(address);
  const wildcard = IPv4.parse(words[1]);
  if (wildcard === null) return false;
  return (((base.value ^ address.value) & ~wildcard.value) >>> 0) === 0;
}

function portNumber(word: string | undefined): number | null {
  if (word === undefined) return null;
  const named = wellKnownPorts[word.toLowerCase()];
  if (named !== undefined) return named;
  return /^[0-9]{1,5}$/.test(word) ? Number(word) : null;
}

/** A port condition: "" (any), `eq N`, `neq N`, `gt N`, `lt N`, `range A B`. */
function matchesPort(condition: string, port: number): boolean {
  const words = condition.trim().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return true;
  const first = portNumber(words[1]);
  switch (words[0].toLowerCase()) {
    case "eq":
      return first !== null && port === first;
    case "neq":
      return first !== null && port !== first;
    case "gt":
      return first !== null && port > first;
    case "lt":
      return first !== null && port < first;
    case "range": {
      const last = portNumber(words[2]);
      return first !== null && last !== null && port >= first && port <= last;
    }
    default:
      return false;
  }
}

function entryMatches(entry: ACLEntry, list: AccessList, packet: Packet): boolean {
  if (!matchesAddress(entry.source, packet.source)) return false;
  if (list.type === "standard") return true;
  const protocol = entry.protocol.toLowerCase();
  if (protocol !== "ip" && protocol !== packet.protocol) return false;
  if (!matchesAddress(entry.destination, packet.destination)) return false;
  if (packet.protocol !== "icmp") {
    if (!matchesPort(entry.sourcePort, packet.sourcePort)) return false;
    if (!matchesPort(entry.destinationPort, packet.destinationPort)) return false;
  } else if (entry.icmpType !== "" && entry.icmpType.toLowerCase() !== packet.icmpType) {
    return false;
  }
  return true;
}

/** True when the list exists on the device and its first matching entry is a `permit`. */
export function aclPermits(device: Device, listName: string, packet: Packet): boolean {
  const list = device.protocols?.acl?.lists.find((candidate) => candidate.name === listName);
  if (list === undefined) return false;
  const entries = [...list.entries].sort((a, b) => a.sequence - b.sequence);
  for (const entry of entries) {
    if (entry.action === "remark") continue;
    if (entryMatches(entry, list, packet)) return entry.action === "permit";
  }
  return false;
}
