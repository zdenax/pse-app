// JSON text exactly as Foundation's JSONEncoder writes it with
// `[.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]`, so files written by the web app
// and by the Swift app are byte-identical:
//
// - two-space indentation, `"key" : value` (a space on both sides of the colon);
// - keys sorted (all keys of the format are ASCII, where Foundation's order is the code-unit order);
// - an empty array or object is written over three lines: `[`, an empty line, the indented `]`;
// - numbers as Swift's `Double.description` without a trailing ".0" (`300`, `461.25`, `1e-05`);
// - strings escape only `"`, `\` and control characters; `/` and non-ASCII stay as they are;
// - no newline at the end.

/** A JSON value. Object keys with an `undefined` value are left out, like an absent optional. */
export type JSONValue = null | boolean | number | string | JSONValue[] | JSONObject;
export interface JSONObject {
  [key: string]: JSONValue | undefined;
}

/** Encodes `value` like Foundation's pretty-printed, key-sorted JSONEncoder. */
export function writeJSON(value: JSONValue): string {
  return write(value, 0);
}

function indent(depth: number): string {
  return "  ".repeat(depth);
}

function write(value: JSONValue, depth: number): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return formatNumber(value);
    case "string":
      return quote(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `[\n\n${indent(depth)}]`;
    const items = value.map((item) => indent(depth + 1) + write(item, depth + 1));
    return `[\n${items.join(",\n")}\n${indent(depth)}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort(compareKeys);
  if (keys.length === 0) return `{\n\n${indent(depth)}}`;
  const members = keys.map((key) => `${indent(depth + 1)}${quote(key)} : ${write(value[key] as JSONValue, depth + 1)}`);
  return `{\n${members.join(",\n")}\n${indent(depth)}}`;
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A JSON string literal with Foundation's escaping (slashes left alone). */
export function quote(text: string): string {
  let result = '"';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    switch (code) {
      case 0x22:
        result += '\\"';
        break;
      case 0x5c:
        result += "\\\\";
        break;
      case 0x08:
        result += "\\b";
        break;
      case 0x0c:
        result += "\\f";
        break;
      case 0x0a:
        result += "\\n";
        break;
      case 0x0d:
        result += "\\r";
        break;
      case 0x09:
        result += "\\t";
        break;
      default:
        result += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : text[i];
    }
  }
  return result + '"';
}

/**
 * A number as JSONEncoder writes a `Double`: Swift's shortest round-trip `description` with a
 * trailing ".0" removed. Swift switches to exponent notation below 1e-4 and above 2^53
 * (`1e-05`, `1e+16`), and writes the exponent with at least two digits.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`JSON cannot represent ${value}`);
  if (Object.is(value, -0)) return "-0";
  const magnitude = Math.abs(value);
  if (Number.isInteger(value) && magnitude <= 2 ** 53) return String(value);
  const [mantissa, exponentText] = value.toExponential().split("e");
  const exponent = Number(exponentText);
  // Swift's decimal exponent counts the digits before the point: 0.0001 = 0.1e-3.
  if (exponent + 1 < -3 || magnitude > 2 ** 53) {
    const sign = exponent < 0 ? "-" : "+";
    return `${mantissa}e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  // Same digits as Swift; JavaScript only switches to exponents below 1e-6 and from 1e21 on.
  return String(value);
}
