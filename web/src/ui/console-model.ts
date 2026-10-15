// Everything about one device console that outlives its window: the CLI session (and with it
// the mode the user left it in), the scrollback and the command history. Framework-free.
// Port of ConsoleModel (Sources/NetSketch/Console/ConsoleManager.swift) plus the key mapping and
// the multi-line paste of ConsoleTerminalView.swift.

import type { CLIDialect, ConsoleSession } from "../cli/session-api";

export type ConsoleChunkKind = "banner" | "echo" | "output" | "notice";

/** One piece of the scrollback. Chunks are immutable once appended. */
export interface ConsoleChunk {
  readonly kind: ConsoleChunkKind;
  readonly text: string;
  /** For "echo": the prompt the line was typed at. */
  readonly prompt?: string;
}

/** Keys the console input treats specially. */
export type ConsoleKey =
  | "enter"
  | "tab"
  | "historyUp"
  | "historyDown"
  | "help"
  | "interrupt"
  | "end"
  | "pageUp"
  | "pageDown";

/** The parts of a keyboard event the key mapping looks at (a DOM KeyboardEvent fits). */
export interface ConsoleKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
}

/**
 * Maps a key press in the input line to a console key, like ConsoleKey(event:) in Swift:
 * Enter, Tab, Up/Down (history), PageUp/PageDown, Ctrl-C (abandon line), Ctrl-Z (end),
 * Ctrl-P / Ctrl-N (history) and "?" (help). Returns null for ordinary typing.
 *
 * `hasSelection`: Ctrl-C with selected text is left to the browser (copy), which matters on
 * Windows and Linux where Ctrl-C is the copy shortcut.
 */
export function consoleKeyFor(event: ConsoleKeyEvent, hasSelection = false): ConsoleKey | null {
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
  switch (event.key) {
    case "Enter":
      return "enter";
    case "Tab":
      return plain ? "tab" : null;
    case "ArrowUp":
      return plain ? "historyUp" : null;
    case "ArrowDown":
      return plain ? "historyDown" : null;
    case "PageUp":
      return "pageUp";
    case "PageDown":
      return "pageDown";
  }
  if (event.ctrlKey && !event.metaKey && !event.altKey) {
    const key = event.key.toLowerCase();
    if (key === "c") return hasSelection ? null : "interrupt";
    if (key === "z") return "end";
    if (key === "p") return "historyUp";
    if (key === "n") return "historyDown";
  }
  if (!event.metaKey && !event.ctrlKey && event.key === "?") return "help";
  return null;
}

/** Splits pasted text into lines (CRLF, CR and LF all end a line). */
export function splitPastedLines(text: string): string[] {
  return text.split(/\r\n|[\n\r\u0085\u2028\u2029]/);
}

/** True when pasted text spans several lines and must be run line by line. */
export function isMultiLinePaste(text: string): boolean {
  return /[\n\r\u0085\u2028\u2029]/.test(text);
}

export function dialectName(dialect: CLIDialect): string {
  switch (dialect) {
    case "ios":
      return "Cisco IOS";
    case "dellOS9":
      return "Dell OS9";
    case "dellOS6":
      return "Dell OS6";
    case "routerOS":
      return "MikroTik RouterOS";
    case "generic":
      return "obecný";
    case "host":
      return "příkazový řádek";
    case "edgeOS":
      return "Ubiquiti EdgeOS";
    case "unifiSwitch":
      return "UniFi Switch";
  }
}

export class ConsoleModel {
  static readonly maxChunks = 3000;
  static readonly maxHistory = 300;

  readonly deviceID: string;
  private readonly session: ConsoleSession;
  private _chunks: ConsoleChunk[] = [];
  /** Bumped when old scrollback is dropped, so a view re-renders from scratch. */
  private _generation = 0;

  private history: string[] = [];
  /** Index into `history` while browsing with the arrow keys; null while typing a new line. */
  private historyCursor: number | null = null;
  private stashedLine = "";

  private _version = 0;
  private listeners = new Set<() => void>();

  constructor(session: ConsoleSession) {
    this.session = session;
    this.deviceID = session.deviceID;
    const banner = trimNewlines(session.banner);
    if (banner !== "") this.append("banner", banner);
  }

  // MARK: Observation

  get version(): number {
    return this._version;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    this._version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  // MARK: State

  get chunks(): readonly ConsoleChunk[] {
    return this._chunks;
  }

  get generation(): number {
    return this._generation;
  }

  get prompt(): string {
    return this.session.prompt;
  }

  get isClosed(): boolean {
    return this.session.isClosed;
  }

  get dialect(): CLIDialect {
    return this.session.dialect;
  }

  get dialectName(): string {
    return dialectName(this.session.dialect);
  }

  get footerText(): string {
    return (
      `Dialekt: ${this.dialectName}   ·   Tab doplní   ·   ? nápověda   ·   ↑↓ historie   ·   ` +
      "Ctrl-C zruší řádek   ·   Ctrl-Z end   ·   ping a traceroute podle diagramu"
    );
  }

  /** The commands entered so far, oldest first (for tests and diagnostics). */
  get historyEntries(): readonly string[] {
    return this.history;
  }

  // MARK: Commands

  /** Executes one line and records the prompt, the command and the answer. */
  submit(line: string): void {
    this.append("echo", line, this.session.prompt);
    this.remember(line);
    this.appendOutput(this.session.execute(line));
    this.changed();
  }

  /** IOS-style "?": prints the help for what has been typed; the line itself stays as it is. */
  showHelp(line: string): void {
    this.append("echo", line + "?", this.session.prompt);
    this.appendOutput(this.session.help(line));
    this.changed();
  }

  /** Tab completion. Returns the new content of the input line. */
  complete(line: string): string {
    const candidates = this.session.complete(line);
    if (candidates.length === 0) return line;
    if (candidates.length === 1) {
      // "address=" waits for its value right after the "=".
      const separator = candidates[0].endsWith("=") ? "" : " ";
      return ConsoleModel.applyingCompletion(candidates[0], line) + separator;
    }
    // Several candidates: list them like IOS does and keep the line.
    this.append("echo", line, this.session.prompt);
    this.appendOutput(candidates.join("  "));
    this.changed();
    return line;
  }

  /**
   * Replaces the word being typed with `completion`. A completion that already repeats the
   * whole line is taken as it is.
   */
  static applyingCompletion(completion: string, line: string): string {
    if (line !== "" && completion.toLowerCase().startsWith(line.toLowerCase())) return completion;
    const lastSpace = line.lastIndexOf(" ");
    if (lastSpace < 0) return completion;
    return line.slice(0, lastSpace + 1) + completion;
  }

  /** Ctrl-C: the typed line is abandoned. */
  interrupt(line: string): void {
    this.append("echo", line + "^C", this.session.prompt);
    this.historyCursor = null;
    this.stashedLine = "";
    this.changed();
  }

  /** Ctrl-Z: same as typing `end`. */
  end(): void {
    this.append("echo", "^Z", this.session.prompt);
    this.appendOutput(this.session.execute("end"));
    this.historyCursor = null;
    this.changed();
  }

  /**
   * Multi-line paste: every complete line is executed (the first one continues what is already
   * typed), the rest stays in the input. Stops when a line closes the session.
   * Returns the new content of the input line.
   */
  paste(text: string, currentInput: string): string {
    const lines = splitPastedLines(text);
    const remainder = lines.pop() ?? "";
    let pending = currentInput;
    for (const line of lines) {
      if (this.isClosed) break;
      this.submit(pending + line);
      pending = "";
    }
    return pending + remainder;
  }

  /** A line added by the terminal itself (shown dimmed). */
  notice(text: string): void {
    this.append("notice", text);
    this.changed();
  }

  // MARK: History

  /** The previous command (arrow up); null when there is none. */
  historyPrevious(current: string): string | null {
    if (this.history.length === 0) return null;
    if (this.historyCursor !== null) {
      if (this.historyCursor <= 0) return null;
      this.historyCursor -= 1;
      return this.history[this.historyCursor];
    }
    this.stashedLine = current;
    this.historyCursor = this.history.length - 1;
    return this.history[this.historyCursor];
  }

  /** The next command (arrow down); past the newest one the line being typed comes back. */
  historyNext(): string | null {
    if (this.historyCursor === null) return null;
    if (this.historyCursor + 1 < this.history.length) {
      this.historyCursor += 1;
      return this.history[this.historyCursor];
    }
    this.historyCursor = null;
    return this.stashedLine;
  }

  private remember(line: string): void {
    this.historyCursor = null;
    this.stashedLine = "";
    const trimmed = line.replace(/^[ \t]+|[ \t]+$/g, "");
    if (trimmed === "" || this.history[this.history.length - 1] === trimmed) return;
    this.history.push(trimmed);
    if (this.history.length > ConsoleModel.maxHistory) {
      this.history.splice(0, this.history.length - ConsoleModel.maxHistory);
    }
  }

  // MARK: Scrollback

  private appendOutput(text: string): void {
    let output = text;
    while (output.endsWith("\n")) output = output.slice(0, -1);
    if (output === "") return;
    this.append("output", output);
  }

  private append(kind: ConsoleChunkKind, text: string, prompt?: string): void {
    const chunk: ConsoleChunk = prompt === undefined ? { kind, text } : { kind, text, prompt };
    // Copy on write: views may hold on to the previous array.
    const next = this._chunks.concat(chunk);
    if (next.length > ConsoleModel.maxChunks) {
      next.splice(0, next.length - Math.floor((ConsoleModel.maxChunks * 3) / 4));
      this._generation += 1;
    }
    this._chunks = next;
  }
}

/** Swift's trimmingCharacters(in: .newlines). */
function trimNewlines(text: string): string {
  return text.replace(/^[\n\r\u0085\u2028\u2029]+|[\n\r\u0085\u2028\u2029]+$/g, "");
}

/** IOS-style diagnostics start with "%" (after leading spaces); the view tints them. */
export function isDiagnosticLine(line: string): boolean {
  return line.replace(/^ +/, "").startsWith("%");
}
