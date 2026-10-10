// Typed reading of parsed JSON with the semantics of Swift's JSONDecoder: `required` is
// `decode(_:forKey:)` (a missing key or null is an error), `optional` is
// `decodeIfPresent(_:forKey:)` (a missing key or null gives undefined, a wrong type is still
// an error). Errors carry the coding path and a Czech description.

import { canonicalUUID } from "./util";

export type CodingPath = readonly (string | number)[];

export type DecodeErrorKind = "keyNotFound" | "typeMismatch" | "valueNotFound" | "dataCorrupted";

/** A value does not match the expected structure (Swift's `DecodingError`). */
export class DecodeError extends Error {
  readonly kind: DecodeErrorKind;
  readonly codingPath: CodingPath;
  /** The missing key (`keyNotFound`). */
  readonly key?: string;

  constructor(kind: DecodeErrorKind, codingPath: CodingPath, key?: string) {
    super(decodeErrorDetail(kind, codingPath, key));
    this.name = "DecodeError";
    this.kind = kind;
    this.codingPath = codingPath;
    if (key !== undefined) this.key = key;
  }
}

/** Czech description of a decoding problem (CzechText.decodingDetail in the Swift app). */
export function decodeErrorDetail(kind: DecodeErrorKind, codingPath: CodingPath, key?: string): string {
  const where =
    codingPath.length === 0
      ? "kořen dokumentu"
      : codingPath.map((part) => (typeof part === "number" ? `[${part}]` : part)).join(".");
  switch (kind) {
    case "keyNotFound":
      return `chybí položka „${key ?? ""}“ (${where}).`;
    case "typeMismatch":
    case "valueNotFound":
      return `neočekávaná hodnota (${where}).`;
    case "dataCorrupted":
      return `poškozená data (${where}).`;
  }
}

/** Reads one JSON value at `path`; throws `DecodeError`. */
export type Reader<T> = (value: unknown, path: CodingPath) => T;

export type JSONRecord = Record<string, unknown>;

/** Parses JSON text; a syntax error becomes `dataCorrupted` at the document root. */
export function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DecodeError("dataCorrupted", []);
  }
}

/** A keyed container. */
export function readObject(value: unknown, path: CodingPath): JSONRecord {
  if (value === null || value === undefined) throw new DecodeError("valueNotFound", path);
  if (typeof value !== "object" || Array.isArray(value)) throw new DecodeError("typeMismatch", path);
  return value as JSONRecord;
}

function has(object: JSONRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** `decode(_:forKey:)`. */
export function required<T>(object: JSONRecord, key: string, path: CodingPath, read: Reader<T>): T {
  if (!has(object, key)) throw new DecodeError("keyNotFound", path, key);
  const value = object[key];
  const at = [...path, key];
  if (value === null) throw new DecodeError("valueNotFound", at);
  return read(value, at);
}

/** `decodeIfPresent(_:forKey:)`. */
export function optional<T>(object: JSONRecord, key: string, path: CodingPath, read: Reader<T>): T | undefined {
  if (!has(object, key)) return undefined;
  const value = object[key];
  if (value === null) return undefined;
  return read(value, [...path, key]);
}

export const readString: Reader<string> = (value, path) => {
  if (typeof value !== "string") throw new DecodeError("typeMismatch", path);
  return value;
};

export const readBool: Reader<boolean> = (value, path) => {
  if (typeof value !== "boolean") throw new DecodeError("typeMismatch", path);
  return value;
};

/** A Swift `Int`: a number without a fractional part. */
export const readInt: Reader<number> = (value, path) => {
  if (typeof value !== "number") throw new DecodeError("typeMismatch", path);
  if (!Number.isSafeInteger(value)) throw new DecodeError("dataCorrupted", path);
  return value;
};

/** A Swift `Double` / `CGFloat`. */
export const readDouble: Reader<number> = (value, path) => {
  if (typeof value !== "number") throw new DecodeError("typeMismatch", path);
  if (!Number.isFinite(value)) throw new DecodeError("dataCorrupted", path);
  return value;
};

/** A string enum; an unknown raw value is `dataCorrupted` like in Swift. */
export function readEnum<T extends string>(values: readonly T[]): Reader<T> {
  return (value, path) => {
    const text = readString(value, path);
    if (!(values as readonly string[]).includes(text)) throw new DecodeError("dataCorrupted", path);
    return text as T;
  };
}

/** A Foundation `UUID`, returned in its canonical upper-case form. */
export const readUUID: Reader<string> = (value, path) => {
  const uuid = canonicalUUID(readString(value, path));
  if (uuid === null) throw new DecodeError("dataCorrupted", path);
  return uuid;
};

/** An array whose elements are all read with `read` (null elements are `valueNotFound`). */
export function readArray<T>(read: Reader<T>): Reader<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) throw new DecodeError("typeMismatch", path);
    return value.map((element: unknown, index) => {
      const at = [...path, index];
      if (element === null || element === undefined) throw new DecodeError("valueNotFound", at);
      return read(element, at);
    });
  };
}
