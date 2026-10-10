// A small table-driven command parser in the style of the Cisco IOS parser.
// Port of CommandTree.swift (NetSketchCLI).
//
// Every command of the IOS-like dialects is declared exactly once as a path in a tree of
// `CommandNode`s. Execution, abbreviation matching, the three classic error messages,
// context help ("?") and Tab completion are all derived from that single definition.

import type { IOSEngine, InterfaceSelection } from "./ios-engine";

// MARK: - Swift string semantics
//
// Swift counts and walks strings by grapheme clusters (Characters) and classifies them with
// Unicode properties. The helpers below reproduce that, so column numbers, padding and
// truncation match the Swift app character for character.

const graphemeSegmenter: Intl.Segmenter | null =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** ASCII without CR: every UTF-16 unit is one Swift Character (CR LF would be one). */
const simpleText = /^[\x00-\x0c\x0e-\x7f]*$/;

/** The Characters (grapheme clusters) of a string, as Swift iterates them. */
export function chars(text: string): string[] {
  if (simpleText.test(text)) return text.split("");
  if (graphemeSegmenter) return Array.from(graphemeSegmenter.segment(text), (segment) => segment.segment);
  return Array.from(text);
}

/** Swift `String.count`: the number of Characters. */
export function charCount(text: string): number {
  return simpleText.test(text) ? text.length : chars(text).length;
}

function firstScalar(character: string): string {
  const code = character.codePointAt(0);
  return code === undefined ? "" : String.fromCodePoint(code);
}

const whitespaceScalar = /^\p{White_Space}$/u;
const numberScalar = /^\p{N}$/u;
const newlineScalar = /^[\n\v\f\r\u0085\u2028\u2029]$/;
const horizontalWhitespace = /^[\t\p{Zs}]$/u;
const whitespaceOrNewline = /^[\t\n\v\f\r\u0085\u2028\u2029\p{Zs}]$/u;

/** Swift `Character.isWhitespace` (includes newlines). */
export function isWhitespace(character: string): boolean {
  return whitespaceScalar.test(firstScalar(character));
}

/** Swift `Character.isNumber`. */
export function isNumber(character: string): boolean {
  return numberScalar.test(firstScalar(character));
}

/** Swift `Character.isNewline`. */
export function isNewline(character: string): boolean {
  return newlineScalar.test(firstScalar(character));
}

/** Swift `$0.isASCII && $0.isNumber`. */
export function isASCIIDigit(character: string): boolean {
  return character.length === 1 && character >= "0" && character <= "9";
}

/** Swift `Int(text)`: optional sign and ASCII digits only; nil otherwise. */
export function swiftInt(text: string): number | null {
  if (!/^[+-]?[0-9]+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function trimScalars(text: string, set: RegExp): string {
  const scalars = Array.from(text);
  let start = 0;
  let end = scalars.length;
  while (start < end && set.test(scalars[start])) start += 1;
  while (end > start && set.test(scalars[end - 1])) end -= 1;
  return scalars.slice(start, end).join("");
}

/** Swift `trimmingCharacters(in: .whitespaces)` (spaces and tabs, not newlines). */
export function trimWhitespaces(text: string): string {
  return trimScalars(text, horizontalWhitespace);
}

/** Swift `trimmingCharacters(in: .whitespacesAndNewlines)`. */
export function trimWhitespacesAndNewlines(text: string): string {
  return trimScalars(text, whitespaceOrNewline);
}

/** Swift `split(whereSeparator:)` over Characters, empty pieces omitted. */
export function splitCharacters(text: string, isSeparator: (character: string) => boolean): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const character of chars(text)) {
    if (isSeparator(character)) {
      if (current !== "") pieces.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current !== "") pieces.push(current);
  return pieces;
}

/** Swift `split(whereSeparator: { $0.isWhitespace })`. */
export function splitWords(text: string): string[] {
  return splitCharacters(text, isWhitespace);
}

/** Swift `split(separator: " ")` (only the space character, empty pieces omitted). */
export function splitSpaces(text: string): string[] {
  return text.split(" ").filter((piece) => piece !== "");
}

/** Swift `prefix(while:)` measured in Characters. */
export function prefixLength(text: string, predicate: (character: string) => boolean): number {
  let length = 0;
  for (const character of chars(text)) {
    if (!predicate(character)) break;
    length += 1;
  }
  return length;
}

/** Strips trailing whitespace (newlines included). */
export function trimmingTrailingWhitespace(text: string): string {
  const characters = chars(text);
  let end = characters.length;
  while (end > 0 && isWhitespace(characters[end - 1])) end -= 1;
  return end === characters.length ? text : characters.slice(0, end).join("");
}

/** Pads with spaces on the right up to `width` characters (never truncates). */
export function padded(text: string, width: number): string {
  const count = charCount(text);
  return count >= width ? text : text + " ".repeat(width - count);
}

/** Pads with spaces on the left up to `width` characters (never truncates). */
export function leftPadded(text: string, width: number): string {
  const count = charCount(text);
  return count >= width ? text : " ".repeat(width - count) + text;
}

/** Truncates to `width` characters and pads to exactly `width`. */
export function column(text: string, width: number): string {
  const characters = chars(text);
  return padded(characters.length > width ? characters.slice(0, width).join("") : text, width);
}

/** Length of the common leading part of two strings, in Characters. */
export function commonPrefixLength(a: string, b: string): number {
  const left = chars(a);
  const right = chars(b);
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) length += 1;
  return length;
}

// MARK: - Tokens

/** One whitespace-separated word of a command line together with its position. */
export class CLIToken {
  constructor(
    readonly text: string,
    /** Zero-based character offset in the echoed command line (prompt excluded). */
    readonly column: number,
  ) {}

  get lower(): string {
    return this.text.toLowerCase();
  }
}

/** A tokenized command line. Keeps the raw text so free-text arguments keep their spacing. */
export class ParseInput {
  readonly tokens: CLIToken[];

  constructor(
    readonly source: string,
    /** Column of the first character of `source` in the echoed line (non-zero for `do ...`). */
    readonly baseColumn: number = 0,
  ) {
    this.tokens = ParseInput.tokenize(source, baseColumn);
  }

  static tokenize(line: string, baseColumn: number): CLIToken[] {
    const tokens: CLIToken[] = [];
    let current = "";
    let start = baseColumn;
    let position = baseColumn;
    for (const character of chars(line)) {
      if (isWhitespace(character)) {
        if (current !== "") {
          tokens.push(new CLIToken(current, start));
          current = "";
        }
      } else {
        if (current === "") start = position;
        current += character;
      }
      position += 1;
    }
    if (current !== "") tokens.push(new CLIToken(current, start));
    return tokens;
  }

  /** Raw text from the token at `index` to the end of the line, without trailing whitespace. */
  rest(index: number): string {
    if (index >= this.tokens.length) return "";
    const offset = Math.max(0, this.tokens[index].column - this.baseColumn);
    return trimmingTrailingWhitespace(chars(this.source).slice(offset).join(""));
  }

  /** True when the line ends with whitespace (or is empty): the next word has not been started. */
  get endsWithSeparator(): boolean {
    const characters = chars(this.source);
    if (characters.length === 0) return true;
    return isWhitespace(characters[characters.length - 1]);
  }

  /** Column just behind the last character of the line. */
  get endColumn(): number {
    return this.baseColumn + charCount(this.source);
  }
}

// MARK: - Arguments

/** A parsed argument value. */
export type ArgValue =
  | { kind: "int"; value: number }
  | { kind: "text"; value: string }
  | { kind: "intList"; value: number[] }
  | { kind: "interfaces"; value: InterfaceSelection };

/** Result of a custom (multi-token, device-aware) argument matcher. */
export type CustomMatch =
  | { kind: "matched"; value: ArgValue; consumed: number }
  /** The tokens are not this kind of argument at all; other alternatives may still match. */
  | { kind: "noMatch" }
  /** The tokens start like this argument but are wrong at `column`. */
  | { kind: "invalid"; column: number }
  /** The tokens ended in the middle of the argument (e.g. an interface type without a number). */
  | { kind: "incomplete" };

export interface HelpEntry {
  readonly name: string;
  readonly text: string;
}

/** A device-aware argument that may span several tokens (interface names, interface ranges). */
export interface CustomArgument {
  readonly name: string;
  match(engine: IOSEngine, input: ParseInput, index: number): CustomMatch;
  /** Help entries shown where the argument may start. */
  helpEntries(engine: IOSEngine): HelpEntry[];
  /** Help shown when the tokens typed so far left the argument incomplete. */
  continuationHelp(engine: IOSEngine, pending: CLIToken[]): HelpEntry[];
  /** Words offered for Tab completion of the first token of the argument. */
  completions(engine: IOSEngine): string[];
}

/** The values collected while a command line was matched against the tree. */
export class ParsedCommand {
  values = new Map<string, ArgValue>();
  /** Canonical spelling of every matched keyword, in order. */
  keywords: string[] = [];

  int(name: string): number | null {
    const value = this.values.get(name);
    return value?.kind === "int" ? value.value : null;
  }

  text(name: string): string | null {
    const value = this.values.get(name);
    return value?.kind === "text" ? value.value : null;
  }

  intList(name: string): number[] | null {
    const value = this.values.get(name);
    return value?.kind === "intList" ? value.value : null;
  }

  interfaces(name: string): InterfaceSelection | null {
    const value = this.values.get(name);
    return value?.kind === "interfaces" ? value.value : null;
  }

  has(keyword: string): boolean {
    return this.keywords.includes(keyword);
  }
}

export type CommandHandler = (engine: IOSEngine, command: ParsedCommand) => string;

/** An inclusive integer range (Swift `ClosedRange<Int>`). */
export interface ClosedRange {
  readonly lowerBound: number;
  readonly upperBound: number;
}

export function closedRange(lowerBound: number, upperBound: number): ClosedRange {
  return { lowerBound, upperBound };
}

export function rangeContains(range: ClosedRange, value: number): boolean {
  return value >= range.lowerBound && value <= range.upperBound;
}

export type CommandNodeKind =
  /** The root of a mode's command tree; never matched itself. */
  | { kind: "root" }
  /** A literal keyword. Any unambiguous prefix matches, case-insensitively. */
  | { kind: "keyword"; name: string }
  /** An integer in a range, shown in help as `<low-high>`. */
  | { kind: "number"; name: string; range: ClosedRange }
  /** A single free word, shown in help as `WORD`. */
  | { kind: "word"; name: string; placeholder: string }
  /** The rest of the line, shown in help as `LINE`. */
  | { kind: "line"; name: string; placeholder: string }
  /** A list of VLAN ids such as `10,20,30-40`. */
  | { kind: "vlanList"; name: string }
  /** A device-aware argument that may span several tokens. */
  | { kind: "custom"; argument: CustomArgument };

/** One element of a command: a keyword or an argument, with its help text, the elements that
 * may follow, and (when the command may end here) the handler to run. */
export class CommandNode {
  private _children: CommandNode[];

  constructor(
    readonly kind: CommandNodeKind,
    readonly help: string,
    children: CommandNode[] = [],
    /** Hidden nodes still parse but are not listed in help or completion. */
    readonly hidden: boolean = false,
    readonly handler: CommandHandler | null = null,
  ) {
    this._children = children;
  }

  get children(): CommandNode[] {
    return this._children;
  }

  get keyword(): string | null {
    return this.kind.kind === "keyword" ? this.kind.name : null;
  }

  adding(nodes: CommandNode[]): CommandNode {
    this._children.push(...nodes);
    return this;
  }
}

// MARK: - Tree construction helpers

export function root(children: CommandNode[]): CommandNode {
  return new CommandNode({ kind: "root" }, "", children);
}

export function kw(
  name: string,
  help: string,
  children: CommandNode[] = [],
  run: CommandHandler | null = null,
  hidden = false,
): CommandNode {
  return new CommandNode({ kind: "keyword", name }, help, children, hidden, run);
}

export function num(
  name: string,
  range: ClosedRange,
  help: string,
  children: CommandNode[] = [],
  run: CommandHandler | null = null,
): CommandNode {
  return new CommandNode({ kind: "number", name, range }, help, children, false, run);
}

export function word(
  name: string,
  help: string,
  run: CommandHandler | null = null,
  placeholder = "WORD",
  children: CommandNode[] = [],
): CommandNode {
  return new CommandNode({ kind: "word", name, placeholder }, help, children, false, run);
}

export function line(name: string, help: string, run: CommandHandler | null, placeholder = "LINE"): CommandNode {
  return new CommandNode({ kind: "line", name, placeholder }, help, [], false, run);
}

export function vlanList(
  name: string,
  help: string,
  run: CommandHandler | null = null,
  children: CommandNode[] = [],
): CommandNode {
  return new CommandNode({ kind: "vlanList", name }, help, children, false, run);
}

export function custom(
  argument: CustomArgument,
  run: CommandHandler | null = null,
  help = "",
  children: CommandNode[] = [],
): CommandNode {
  return new CommandNode({ kind: "custom", argument }, help, children, false, run);
}

// MARK: - Matching

export type ParseResult =
  /** A complete command: run `node.handler`. */
  | { kind: "run"; node: CommandNode; command: ParsedCommand }
  /** The line is a valid beginning but stops too early. */
  | { kind: "incomplete" }
  /** A keyword prefix matches more than one keyword. */
  | { kind: "ambiguous" }
  /** Nothing matches at `column`. */
  | { kind: "invalid"; column: number };

/** Outcome of matching a single token position against the children of a node. */
type StepResult =
  | { kind: "next"; child: CommandNode; consumed: number; value: [string, ArgValue] | null }
  | { kind: "ambiguous" }
  | { kind: "invalid"; column: number }
  | { kind: "incomplete" };

export class VLANListParser {
  /** Parses "10", "10,20", "10-12,20" into a sorted list of unique ids within 1...4094. */
  static parse(text: string): number[] | null {
    if (text === "" || charCount(text) > 400) return null;
    const result = new Set<number>();
    for (const part of text.split(",")) {
      const bounds = part.split("-");
      switch (bounds.length) {
        case 1: {
          const value = VLANListParser.vlanID(bounds[0]);
          if (value === null) return null;
          result.add(value);
          break;
        }
        case 2: {
          const low = VLANListParser.vlanID(bounds[0]);
          const high = VLANListParser.vlanID(bounds[1]);
          if (low === null || high === null || low > high) return null;
          for (let value = low; value <= high; value += 1) result.add(value);
          break;
        }
        default:
          return null;
      }
    }
    return result.size === 0 ? null : Array.from(result).sort((a, b) => a - b);
  }

  private static vlanID(text: string): number | null {
    if (!/^[0-9]{1,4}$/.test(text)) return null;
    const value = Number(text);
    return value >= 1 && value <= 4094 ? value : null;
  }

  /** Formats a set of ids as a compact range list: [1,2,3,10] -> "1-3,10". */
  static format(ids: number[]): string {
    const sorted = Array.from(new Set(ids)).sort((a, b) => a - b);
    const parts: string[] = [];
    let index = 0;
    while (index < sorted.length) {
      let end = index;
      while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end += 1;
      parts.push(end === index ? `${sorted[index]}` : `${sorted[index]}-${sorted[end]}`);
      index = end + 1;
    }
    return parts.join(",");
  }
}

/** Where a partial line stands in the tree. */
export type Position =
  /** All complete words matched; `node` is where the next word would attach. */
  | { kind: "at"; node: CommandNode }
  /** The words so far ended inside a multi-token argument. */
  | { kind: "insideArgument"; argument: CustomArgument; pending: CLIToken[] }
  | { kind: "ambiguous" }
  | { kind: "invalid" };

export class CommandParser {
  constructor(readonly engine: IOSEngine) {}

  /** Matches a whole line against `tree`. */
  parse(input: ParseInput, tree: CommandNode): ParseResult {
    let node = tree;
    let index = 0;
    const command = new ParsedCommand();
    while (index < input.tokens.length) {
      const result = this.step(node, input, index);
      switch (result.kind) {
        case "next": {
          const keyword = result.child.keyword;
          if (keyword !== null) command.keywords.push(keyword);
          if (result.value !== null) command.values.set(result.value[0], result.value[1]);
          node = result.child;
          index += Math.max(1, result.consumed);
          break;
        }
        case "ambiguous":
          return { kind: "ambiguous" };
        case "invalid":
          return { kind: "invalid", column: result.column };
        case "incomplete":
          return { kind: "incomplete" };
      }
    }
    if (node.kind.kind === "root") return { kind: "incomplete" };
    return node.handler === null ? { kind: "incomplete" } : { kind: "run", node, command };
  }

  private step(node: CommandNode, input: ParseInput, index: number): StepResult {
    const token = input.tokens[index];
    const lower = token.lower;

    // Keywords first: an exact match wins, otherwise a unique prefix.
    const prefixMatches: CommandNode[] = [];
    for (const child of node.children) {
      const keyword = child.keyword?.toLowerCase();
      if (keyword === undefined) continue;
      if (keyword === lower) return { kind: "next", child, consumed: 1, value: null };
      if (keyword.startsWith(lower)) prefixMatches.push(child);
    }
    if (prefixMatches.length === 1) return { kind: "next", child: prefixMatches[0], consumed: 1, value: null };
    if (prefixMatches.length > 1) return { kind: "ambiguous" };

    // Arguments, in declaration order.
    let invalidColumn: number | null = null;
    for (const child of node.children) {
      const kind = child.kind;
      switch (kind.kind) {
        case "root":
        case "keyword":
          continue;
        case "number": {
          if (!/^[0-9]{1,12}$/.test(token.text)) continue;
          const value = Number(token.text);
          if (rangeContains(kind.range, value)) {
            return { kind: "next", child, consumed: 1, value: [kind.name, { kind: "int", value }] };
          }
          invalidColumn = invalidColumn ?? token.column;
          break;
        }
        case "vlanList": {
          const list = VLANListParser.parse(token.text);
          if (list !== null) {
            return { kind: "next", child, consumed: 1, value: [kind.name, { kind: "intList", value: list }] };
          }
          const first = chars(token.text)[0];
          if (first !== undefined && isNumber(first)) invalidColumn = invalidColumn ?? token.column;
          break;
        }
        case "word":
          return { kind: "next", child, consumed: 1, value: [kind.name, { kind: "text", value: token.text }] };
        case "line":
          return {
            kind: "next",
            child,
            consumed: input.tokens.length - index,
            value: [kind.name, { kind: "text", value: input.rest(index) }],
          };
        case "custom": {
          const match = kind.argument.match(this.engine, input, index);
          switch (match.kind) {
            case "matched":
              return { kind: "next", child, consumed: match.consumed, value: [kind.argument.name, match.value] };
            case "noMatch":
              continue;
            case "invalid":
              invalidColumn = invalidColumn ?? match.column;
              break;
            case "incomplete":
              return { kind: "incomplete" };
          }
          break;
        }
      }
    }
    if (invalidColumn !== null) return { kind: "invalid", column: invalidColumn };
    return { kind: "invalid", column: token.column + this.longestKeywordPrefix(lower, node) };
  }

  /** Number of leading characters of `text` that still match some keyword of `node`.
   * Real IOS puts the caret under the first character that cannot be part of any keyword. */
  private longestKeywordPrefix(text: string, node: CommandNode): number {
    let best = 0;
    for (const child of node.children) {
      const keyword = child.keyword?.toLowerCase();
      if (keyword === undefined) continue;
      best = Math.max(best, commonPrefixLength(text, keyword));
    }
    return Math.min(best, Math.max(0, charCount(text) - 1));
  }

  // MARK: Help and completion

  /** Walks `tokens` (all of them complete words) and reports the position reached. */
  position(tokens: CLIToken[], input: ParseInput, tree: CommandNode): Position {
    let node = tree;
    let index = 0;
    while (index < tokens.length) {
      const result = this.step(node, input, index);
      switch (result.kind) {
        case "next":
          node = result.child;
          index += Math.max(1, result.consumed);
          break;
        case "ambiguous":
          return { kind: "ambiguous" };
        case "invalid":
          return { kind: "invalid" };
        case "incomplete":
          for (const child of node.children) {
            if (child.kind.kind === "custom") {
              return { kind: "insideArgument", argument: child.kind.argument, pending: tokens.slice(index) };
            }
          }
          return { kind: "invalid" };
      }
    }
    return { kind: "at", node };
  }

  /** The entries listed by "?" where the next word of `node` may start. */
  helpEntries(node: CommandNode): HelpEntry[] {
    const argumentEntries: HelpEntry[] = [];
    const keywordEntries: HelpEntry[] = [];
    // Inside free text the only thing that can follow is more text (or Enter).
    if (node.kind.kind === "line") {
      argumentEntries.push({ name: node.kind.placeholder, text: node.help });
    }
    for (const child of node.children) {
      if (child.hidden) continue;
      const kind = child.kind;
      switch (kind.kind) {
        case "root":
          continue;
        case "keyword":
          keywordEntries.push({ name: kind.name, text: child.help });
          break;
        case "number":
          argumentEntries.push({ name: `<${kind.range.lowerBound}-${kind.range.upperBound}>`, text: child.help });
          break;
        case "word":
        case "line":
          argumentEntries.push({ name: kind.placeholder, text: child.help });
          break;
        case "vlanList":
          argumentEntries.push({ name: "WORD", text: child.help });
          break;
        case "custom":
          keywordEntries.push(...kind.argument.helpEntries(this.engine));
          break;
      }
    }
    keywordEntries.sort((a, b) => compareStrings(a.name.toLowerCase(), b.name.toLowerCase()));
    const entries = [...argumentEntries, ...keywordEntries];
    if (node.handler !== null) entries.push({ name: "<cr>", text: "" });
    return entries;
  }

  /** Keywords (canonical spelling) that may start the next word of `node`. */
  completionWords(node: CommandNode): string[] {
    const words: string[] = [];
    for (const child of node.children) {
      if (child.hidden) continue;
      const kind = child.kind;
      if (kind.kind === "keyword") words.push(kind.name);
      else if (kind.kind === "custom") words.push(...kind.argument.completions(this.engine));
    }
    return words;
  }
}

/** Ordering of Swift's `String <` for the texts used here. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class HelpFormatter {
  /** IOS layout: two spaces, the keyword padded to the longest one, two spaces, the description. */
  static table(entries: HelpEntry[]): string {
    const width = entries.reduce((best, entry) => Math.max(best, charCount(entry.name)), 0);
    return entries
      .map((entry) => (entry.text === "" ? `  ${entry.name}` : `  ${padded(entry.name, width)}  ${entry.text}`))
      .join("\n");
  }

  /** IOS layout of a prefix listing ("sh?"): just the words, separated by two spaces. */
  static words(words: string[]): string {
    return words.join("  ");
  }
}
