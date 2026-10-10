// IPv4 addresses and prefixes (port of NetSketchCLI/Simulation/IPv4.swift).
//
// An IPv4 holds a 32-bit unsigned number; every operation keeps it unsigned (`>>> 0`).
// Swift's failable initializers are the static factories `IPv4.parse`, `IPv4Prefix.fromCIDR`,
// `IPv4Prefix.fromAddressMask` and `IPv4Prefix.fromWords`, which return null for bad input.

const octetPattern = /^[0-9]{1,3}$/;
const lengthPattern = /^[0-9]{1,2}$/;

/** An IPv4 address. */
export class IPv4 {
  readonly value: number;

  constructor(value: number) {
    this.value = value >>> 0;
  }

  /** Parses dotted decimal ("192.168.1.10"); null for anything else. */
  static parse(text: string): IPv4 | null {
    const parts = text.split(".");
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
      if (!octetPattern.test(part)) return null;
      const octet = Number(part);
      if (octet > 255) return null;
      value = ((value << 8) | octet) >>> 0;
    }
    return new IPv4(value);
  }

  get description(): string {
    const v = this.value;
    return `${v >>> 24}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}`;
  }

  toString(): string {
    return this.description;
  }

  equals(other: IPv4 | null | undefined): boolean {
    return other != null && other.value === this.value;
  }

  /** Comparable: true when `lhs` sorts before `rhs`. */
  static lessThan(lhs: IPv4, rhs: IPv4): boolean {
    return lhs.value < rhs.value;
  }

  /** For Array.prototype.sort. */
  static compare(lhs: IPv4, rhs: IPv4): number {
    return lhs.value - rhs.value;
  }

  /** The netmask of a prefix length: 24 -> 255.255.255.0. */
  static mask(prefix: number): IPv4 {
    if (prefix <= 0) return new IPv4(0);
    const length = Math.min(prefix, 32);
    // A shift by 32 is a shift by 0 in JavaScript, which gives the full mask for /32.
    return new IPv4((0xffffffff << (32 - length)) >>> 0);
  }

  /** The prefix length of a contiguous netmask; null for masks like 255.0.255.0. */
  get prefixLength(): number | null {
    let ones = 0;
    let v = this.value;
    while (v !== 0) {
      ones += v & 1;
      v >>>= 1;
    }
    return IPv4.mask(ones).value === this.value ? ones : null;
  }
}

/** An address with its prefix ("192.168.1.10/24"), or a network ("192.168.1.0/24"). */
export class IPv4Prefix {
  readonly address: IPv4;
  readonly length: number;

  constructor(address: IPv4, length: number) {
    this.address = address;
    this.length = Math.min(Math.max(length, 0), 32);
  }

  /** "A.B.C.D/NN". */
  static fromCIDR(text: string): IPv4Prefix | null {
    const parts = text.split("/");
    if (parts.length !== 2) return null;
    const address = IPv4.parse(parts[0]);
    if (address === null || !lengthPattern.test(parts[1])) return null;
    const length = Number(parts[1]);
    if (length < 0 || length > 32) return null;
    return new IPv4Prefix(address, length);
  }

  /** "A.B.C.D" and "M.M.M.M" (a contiguous mask). */
  static fromAddressMask(text: string, maskText: string): IPv4Prefix | null {
    const address = IPv4.parse(text);
    const mask = IPv4.parse(maskText);
    if (address === null || mask === null) return null;
    const length = mask.prefixLength;
    if (length === null) return null;
    return new IPv4Prefix(address, length);
  }

  /** Either "A.B.C.D/NN" or "A.B.C.D M.M.M.M" in `words` (one or two words). */
  static fromWords(words: readonly string[]): IPv4Prefix | null {
    if (words.length === 1) return IPv4Prefix.fromCIDR(words[0]);
    if (words.length === 2) return IPv4Prefix.fromAddressMask(words[0], words[1]);
    return null;
  }

  get mask(): IPv4 {
    return IPv4.mask(this.length);
  }

  get network(): IPv4 {
    return new IPv4(this.address.value & this.mask.value);
  }

  get broadcast(): IPv4 {
    return new IPv4(this.network.value | ~this.mask.value);
  }

  get networkPrefix(): IPv4Prefix {
    return new IPv4Prefix(this.network, this.length);
  }

  contains(ip: IPv4): boolean {
    const mask = this.mask.value;
    return ((ip.value & mask) >>> 0) === this.network.value;
  }

  /** A usable host address: not the network or broadcast address of a /0-/30 network. */
  get isHostAddress(): boolean {
    if (this.length >= 31) return true;
    return !this.address.equals(this.network) && !this.address.equals(this.broadcast);
  }

  get description(): string {
    return `${this.address.description}/${this.length}`;
  }

  toString(): string {
    return this.description;
  }

  equals(other: IPv4Prefix | null | undefined): boolean {
    return other != null && other.length === this.length && other.address.value === this.address.value;
  }
}
