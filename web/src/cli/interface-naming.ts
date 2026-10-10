// Interface names of the IOS-like dialects. Port of InterfaceNaming.swift (NetSketchCLI).

import { chars, isNumber, isWhitespace, trimWhitespaces } from "./command-tree";
import type { PortSnapshot } from "./model-access";

/** An interface type the IOS-like dialects know how to abbreviate and expand. */
export interface InterfaceType {
  /** Long spelling used in the running configuration, e.g. "FastEthernet". */
  readonly full: string;
  /** Two/three-letter spelling of `show interfaces status`, e.g. "Fa". */
  readonly short: string;
  /** Three-letter spelling of `show cdp neighbors`, e.g. "Fas". */
  readonly cdp: string;
  /** Description shown by `interface ?`. */
  readonly help: string;
}

/** How a dialect writes interface names: "ios" ("FastEthernet0/1", "Fa0/1") or
 * "dell" ("GigabitEthernet 1/1", "Gi 1/1"). */
export type InterfaceNameStyle = "ios" | "dell";

/** Index of the first Character that is a number, or -1. */
function firstNumberIndex(characters: string[]): number {
  return characters.findIndex((character) => isNumber(character));
}

/** An interface name split into its type and its numbering.
 *
 * "GigabitEthernet 1/1" -> ("gigabitethernet", "1/1"), "Fa0/1" -> ("fa", "0/1"),
 * "ether1" -> ("ether", "1"), "WAN" -> ("wan", ""). */
export class InterfaceNameParts {
  /** Everything before the first digit, lowercased, without whitespace. */
  readonly type: string;
  /** Everything from the first digit on, lowercased, without whitespace. */
  readonly number: string;

  constructor(raw: string) {
    const compact = chars(raw.toLowerCase()).filter((character) => !isWhitespace(character));
    const index = firstNumberIndex(compact);
    if (index >= 0) {
      this.type = compact.slice(0, index).join("");
      this.number = compact.slice(index).join("");
    } else {
      this.type = compact.join("");
      this.number = "";
    }
  }

  get normalized(): string {
    return this.type + this.number;
  }

  /** The numbering split at slashes: "1/0/24" -> ["1", "0", "24"]. */
  get components(): string[] {
    return this.number.split("/");
  }

  equals(other: InterfaceNameParts): boolean {
    return this.type === other.type && this.number === other.number;
  }
}

function type(full: string, short: string, cdp: string, help: string): InterfaceType {
  return { full, short, cdp, help };
}

export class InterfaceTypes {
  static readonly ios: readonly InterfaceType[] = [
    type("Ethernet", "Et", "Eth", "IEEE 802.3"),
    type("FastEthernet", "Fa", "Fas", "FastEthernet IEEE 802.3"),
    type("GigabitEthernet", "Gi", "Gig", "GigabitEthernet IEEE 802.3z"),
    type("TwoGigabitEthernet", "Tw", "Two", "Two Gigabit Ethernet"),
    type("FiveGigabitEthernet", "Fi", "Fiv", "Five Gigabit Ethernet"),
    type("TenGigabitEthernet", "Te", "Ten", "Ten Gigabit Ethernet"),
    type("TwentyFiveGigE", "Twe", "Twe", "Twenty Five Gigabit Ethernet"),
    type("FortyGigabitEthernet", "Fo", "For", "Forty Gigabit Ethernet"),
    type("HundredGigE", "Hu", "Hun", "Hundred Gigabit Ethernet"),
    type("Serial", "Se", "Ser", "Serial"),
  ];

  /** Dell OS9 spellings; looked up before the IOS ones in the Dell dialect. */
  static readonly dell: readonly InterfaceType[] = [
    type("GigabitEthernet", "Gi", "Gi", "Gigabit Ethernet interface"),
    type("TenGigabitEthernet", "Te", "Te", "TenGigabit Ethernet interface"),
    type("fortyGigE", "Fo", "Fo", "FortyGigabit Ethernet interface"),
    type("hundredGigE", "Hu", "Hu", "HundredGigabit Ethernet interface"),
    type("ManagementEthernet", "Ma", "Ma", "Management Ethernet interface"),
  ];

  /** Lowercased long names of every known type, for prefix matching of user input. */
  static readonly allFullNames: readonly string[] = Array.from(
    new Set([...InterfaceTypes.ios, ...InterfaceTypes.dell].map((entry) => entry.full.toLowerCase())),
  ).sort();

  /** The known types a (lowercased) user or port prefix may stand for. */
  static candidates(prefix: string): Set<string> {
    if (prefix === "") return new Set();
    return new Set(InterfaceTypes.allFullNames.filter((name) => name.startsWith(prefix)));
  }
}

/** Formats interface names the way one dialect prints them. */
export class InterfaceNamer {
  constructor(readonly style: InterfaceNameStyle) {}

  private get table(): InterfaceType[] {
    return this.style === "dell"
      ? [...InterfaceTypes.dell, ...InterfaceTypes.ios]
      : [...InterfaceTypes.ios, ...InterfaceTypes.dell];
  }

  /** The known type a port name is written with, when its prefix is exactly a long or a
   * short spelling. Other prefixes ("ether", "LAN", "Port") are left alone on purpose:
   * the CLI never renames a port into something the diagram does not show. */
  knownType(portName: string): InterfaceType | null {
    const parts = new InterfaceNameParts(portName);
    if (parts.type === "" || parts.number === "") return null;
    const table = this.table;
    const exact = table.find((entry) => entry.full.toLowerCase() === parts.type);
    if (exact) return exact;
    if (parts.type === "eth") return table.find((entry) => entry.full === "Ethernet") ?? null;
    return table.find((entry) => entry.short.toLowerCase() === parts.type) ?? null;
  }

  /** The numbering of a port name with its original spelling ("0/1", "1/0/24"). */
  private numbering(portName: string): string {
    const characters = chars(portName);
    const index = firstNumberIndex(characters);
    if (index < 0) return "";
    return characters
      .slice(index)
      .filter((character) => !isWhitespace(character))
      .join("");
  }

  /** Long name: "Fa0/1" -> "FastEthernet0/1" (IOS) or "GigabitEthernet 1/1" (Dell).
   * A port that is already spelled long keeps the catalog's capitalization. */
  longName(portName: string): string {
    const known = this.knownType(portName);
    if (!known) return trimWhitespaces(portName);
    const number = this.numbering(portName);
    return this.style === "dell" ? `${known.full} ${number}` : `${known.full}${number}`;
  }

  /** Short name: "GigabitEthernet 1/1" -> "Gi1/1" (IOS) or "Gi 1/1" (Dell). */
  shortName(portName: string): string {
    const known = this.knownType(portName);
    if (!known) return trimWhitespaces(portName);
    const number = this.numbering(portName);
    return this.style === "dell" ? `${known.short} ${number}` : `${known.short}${number}`;
  }

  /** The spelling of `show cdp neighbors`: "Fas 0/1", "Gig 0/1". */
  cdpName(portName: string): string {
    const known = this.knownType(portName);
    if (!known) return trimWhitespaces(portName);
    return `${known.cdp} ${this.numbering(portName)}`;
  }

  /** The type word of a port for `interface ?` and `show version`: the long spelling of a
   * known type, otherwise the port's own prefix as the diagram writes it. */
  typeWord(portName: string): string {
    const known = this.knownType(portName);
    if (known) return known.full;
    const trimmed = trimWhitespaces(portName);
    const characters = chars(trimmed);
    const index = firstNumberIndex(characters);
    if (index < 0) return trimmed;
    return trimWhitespaces(characters.slice(0, index).join(""));
  }

  /** Lowercase two-letter tag of Dell prompts: "GigabitEthernet 1/1" -> "gi". */
  promptTag(portName: string): string {
    const known = this.knownType(portName);
    if (known) return known.short.toLowerCase();
    return new InterfaceNameParts(portName).type;
  }
}

export type InterfaceLookup =
  | { kind: "found"; port: PortSnapshot }
  /** More than one port fits (e.g. "t1/1" with both Te1/1 and Twe1/1). */
  | { kind: "ambiguous" }
  /** No port has a type that fits the typed prefix. */
  | { kind: "unknownType" }
  /** The type fits but no such number exists; `offset` is the offending position inside the
   * typed numbering. */
  | { kind: "unknownNumber"; offset: number };

/** Resolves what the user typed to the ports the device really has. */
export class InterfaceResolver {
  /** True when a typed type prefix may stand for the type prefix of a port. */
  static typeMatches(user: string, port: string): boolean {
    if (user === port) return true;
    if (user === "") return false;
    if (port.startsWith(user)) return true;
    const portCandidates = InterfaceTypes.candidates(port);
    for (const candidate of InterfaceTypes.candidates(user)) {
      if (portCandidates.has(candidate)) return true;
    }
    return false;
  }

  static lookup(spec: string, ports: PortSnapshot[]): InterfaceLookup {
    const user = new InterfaceNameParts(spec);
    if (user.normalized === "") return { kind: "unknownType" };

    // The exact name always wins, whatever it looks like.
    const exact = ports.find((port) => new InterfaceNameParts(port.name).normalized === user.normalized);
    if (exact) return { kind: "found", port: exact };
    const sameType = ports.filter((port) =>
      InterfaceResolver.typeMatches(user.type, new InterfaceNameParts(port.name).type),
    );
    if (sameType.length === 0 || user.type === "") return { kind: "unknownType" };

    const matches = sameType.filter((port) => new InterfaceNameParts(port.name).number === user.number);
    if (matches.length === 1) return { kind: "found", port: matches[0] };
    if (matches.length > 1) {
      const identical = matches.filter((port) => new InterfaceNameParts(port.name).type === user.type);
      return identical.length === 1 ? { kind: "found", port: identical[0] } : { kind: "ambiguous" };
    }
    return {
      kind: "unknownNumber",
      offset: InterfaceResolver.mismatchOffset(
        user,
        sameType.map((port) => new InterfaceNameParts(port.name)),
      ),
    };
  }

  /** Position inside the typed numbering of the first slash-separated component that no
   * port shares; real IOS puts its caret there ("fa0/99" -> under the first 9). */
  private static mismatchOffset(user: InterfaceNameParts, ports: InterfaceNameParts[]): number {
    let candidates = ports.map((port) => port.components);
    let offset = 0;
    const components = user.components;
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index];
      candidates = candidates.filter((candidate) => index < candidate.length && candidate[index] === component);
      if (candidates.length === 0) return offset;
      offset += chars(component).length + 1;
    }
    return Math.max(0, Math.min(offset, chars(user.number).length) - 1);
  }
}
