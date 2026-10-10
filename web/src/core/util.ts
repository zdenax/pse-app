// Small helpers shared by the core modules: identifiers, structural equality and the few
// Foundation behaviours (trimming, rounding) the Swift sources rely on.

/** A fresh random UUID in upper case, the way Foundation's `UUID().uuidString` writes it. */
export function newUUID(): string {
  const crypto = globalThis.crypto as Crypto | undefined;
  // `randomUUID` exists only in secure contexts (https, localhost); fall back to random bytes.
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID().toUpperCase();
  const bytes = new Uint8Array(16);
  if (crypto && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The canonical (upper-case) form of a UUID string, or null when `text` is not a UUID. */
export function canonicalUUID(text: string): string | null {
  return uuidPattern.test(text) ? text.toUpperCase() : null;
}

/**
 * Structural equality of JSON-like values (plain objects, arrays, primitives), the equivalent
 * of Swift's synthesized `==` on the model structs. Object keys whose value is `undefined` count
 * as absent, so `{ label: undefined }` equals `{}` like an optional that is nil.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key of Object.keys(left)) {
    if (left[key] === undefined) continue;
    if (!deepEqual(left[key], right[key])) return false;
  }
  for (const key of Object.keys(right)) {
    if (right[key] !== undefined && left[key] === undefined) return false;
  }
  return true;
}

// Foundation's character sets: `.whitespaces` is Unicode Zs plus tab, `.whitespacesAndNewlines`
// adds the line separators (Z*, U+000A...U+000D, U+0085).
const whitespaceEdges = /^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu;
const whitespaceAndNewlineEdges = /^[\p{Z}\t\n\v\f\r\u0085]+|[\p{Z}\t\n\v\f\r\u0085]+$/gu;

/** `text.trimmingCharacters(in: .whitespaces)`. */
export function trimWhitespace(text: string): string {
  return text.replace(whitespaceEdges, "");
}

/** `text.trimmingCharacters(in: .whitespacesAndNewlines)`. */
export function trimWhitespaceAndNewlines(text: string): string {
  return text.replace(whitespaceAndNewlineEdges, "");
}

/** Swift's `Double.rounded()`: to the nearest integer, halves away from zero (`-2.5` -> `-3`). */
export function roundHalfAwayFromZero(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** Czech plural form: 1 -> `one`, 2...4 -> `few`, anything else -> `many`. */
export function czechPlural(count: number, one: string, few: string, many: string): string {
  if (count === 1) return one;
  if (count >= 2 && count <= 4) return few;
  return many;
}
