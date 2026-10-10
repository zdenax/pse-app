import { describe, expect, test } from "vitest";
import {
  ConsoleModel,
  consoleKeyFor,
  dialectName,
  isDiagnosticLine,
  isMultiLinePaste,
  splitPastedLines,
} from "../../src/ui/console-model";
import { FakeSession } from "./fakes";

function makeModel(options: ConstructorParameters<typeof FakeSession>[2] = {}) {
  const session = new FakeSession("DEV-1", () => "SW1", options);
  return { session, model: new ConsoleModel(session) };
}

describe("ConsoleModel", () => {
  test("the banner is the first chunk, without surrounding newlines", () => {
    const { model } = makeModel();
    expect(model.chunks).toEqual([{ kind: "banner", text: "NetSketch — konzole zařízení\nNápověda: ?" }]);
    expect(model.deviceID).toBe("DEV-1");
  });

  test("an empty banner adds nothing", () => {
    const { model } = makeModel({ banner: "\n\n" });
    expect(model.chunks).toHaveLength(0);
  });

  test("submit echoes the line with the prompt it was typed at and appends the output", () => {
    const { model, session } = makeModel({ banner: "" });
    model.submit("enable");
    model.submit("configure terminal");
    expect(session.executed).toEqual(["enable", "configure terminal"]);
    expect(model.chunks).toEqual([
      { kind: "echo", text: "enable", prompt: "SW1>" },
      { kind: "echo", text: "configure terminal", prompt: "SW1#" },
      // Trailing newlines are dropped; empty output adds no chunk.
      { kind: "output", text: "Enter configuration commands, one per line.  End with CNTL/Z." },
    ]);
    expect(model.prompt).toBe("SW1(config)#");
  });

  test("output keeps inner blank lines but loses trailing ones", () => {
    const { model } = makeModel({ banner: "" });
    model.submit("show multi");
    expect(model.chunks[1]).toEqual({ kind: "output", text: "line one\n  % warning line\nline three" });
  });

  test("lines starting with % (after spaces) are diagnostics", () => {
    expect(isDiagnosticLine("% Invalid input")).toBe(true);
    expect(isDiagnosticLine("   % Incomplete command.")).toBe(true);
    expect(isDiagnosticLine("Success rate is 100 percent")).toBe(false);
    expect(isDiagnosticLine("\t% tab is not a space")).toBe(false);
  });

  test("? prints help for the typed line and keeps the session state", () => {
    const { model, session } = makeModel({ banner: "" });
    model.showHelp("");
    expect(session.executed).toEqual([]);
    expect(model.chunks[0]).toEqual({ kind: "echo", text: "?", prompt: "SW1>" });
    expect(model.chunks[1].kind).toBe("output");
    expect(model.chunks[1].text).toContain("enable");
  });

  test("Tab with one candidate replaces the word and adds a space", () => {
    const { model } = makeModel({ banner: "" });
    expect(model.complete("sh")).toBe("show ");
    expect(model.chunks).toHaveLength(0);
  });

  test("Tab with a candidate ending in = adds no space", () => {
    const { model, session } = makeModel({ banner: "" });
    session.completions["/ip address add addr"] = ["address="];
    expect(model.complete("/ip address add addr")).toBe("/ip address add address=");
  });

  test("Tab with several candidates lists them and keeps the line", () => {
    const { model } = makeModel({ banner: "" });
    expect(model.complete("show ip ")).toBe("show ip ");
    expect(model.chunks).toEqual([
      { kind: "echo", text: "show ip ", prompt: "SW1>" },
      { kind: "output", text: "interface  route" },
    ]);
  });

  test("Tab without candidates changes nothing", () => {
    const { model } = makeModel({ banner: "" });
    expect(model.complete("xyz")).toBe("xyz");
    expect(model.chunks).toHaveLength(0);
  });

  test("applyingCompletion replaces only the last word", () => {
    expect(ConsoleModel.applyingCompletion("interfaces", "show int")).toBe("show interfaces");
    expect(ConsoleModel.applyingCompletion("show", "sh")).toBe("show");
    // A completion that repeats the whole line (case-insensitively) is taken as it is.
    expect(ConsoleModel.applyingCompletion("show running-config", "SHOW run")).toBe("show running-config");
    expect(ConsoleModel.applyingCompletion("enable", "")).toBe("enable");
    expect(ConsoleModel.applyingCompletion("route", "show ip ")).toBe("show ip route");
  });

  test("Ctrl-C abandons the line with ^C", () => {
    const { model, session } = makeModel({ banner: "" });
    model.interrupt("show ver");
    expect(model.chunks).toEqual([{ kind: "echo", text: "show ver^C", prompt: "SW1>" }]);
    expect(session.executed).toEqual([]);
  });

  test("Ctrl-Z runs end", () => {
    const { model, session } = makeModel({ banner: "" });
    model.submit("enable");
    model.submit("conf t");
    model.end();
    expect(session.executed).toEqual(["enable", "conf t", "end"]);
    expect(model.chunks.at(-1)).toEqual({ kind: "echo", text: "^Z", prompt: "SW1(config)#" });
    expect(model.prompt).toBe("SW1#");
  });

  test("history walks back and forth and restores the typed line", () => {
    const { model } = makeModel({ banner: "" });
    model.submit("enable");
    model.submit("show vlan");
    expect(model.historyNext()).toBeNull();
    expect(model.historyPrevious("sho")).toBe("show vlan");
    expect(model.historyPrevious("ignored")).toBe("enable");
    expect(model.historyPrevious("ignored")).toBeNull();
    expect(model.historyNext()).toBe("show vlan");
    expect(model.historyNext()).toBe("sho");
    expect(model.historyNext()).toBeNull();
  });

  test("history skips empty lines and consecutive duplicates and trims spaces", () => {
    const { model } = makeModel({ banner: "" });
    model.submit("  show vlan  ");
    model.submit("show vlan");
    model.submit("");
    model.submit("   ");
    model.submit("enable");
    model.submit("show vlan");
    expect(model.historyEntries).toEqual(["show vlan", "enable", "show vlan"]);
  });

  test("history keeps at most 300 entries", () => {
    const { model } = makeModel({ banner: "" });
    for (let i = 0; i < 310; i++) model.submit(`cmd ${i}`);
    expect(model.historyEntries).toHaveLength(ConsoleModel.maxHistory);
    expect(model.historyEntries[0]).toBe("cmd 10");
    expect(model.historyEntries.at(-1)).toBe("cmd 309");
  });

  test("submitting resets history browsing", () => {
    const { model } = makeModel({ banner: "" });
    model.submit("a");
    model.submit("b");
    expect(model.historyPrevious("")).toBe("b");
    model.submit("c");
    expect(model.historyPrevious("")).toBe("c");
  });

  test("Ctrl-C resets history browsing and forgets the stashed line", () => {
    const { model } = makeModel({ banner: "" });
    model.submit("a");
    expect(model.historyPrevious("typed")).toBe("a");
    model.interrupt("a");
    expect(model.historyNext()).toBeNull();
    expect(model.historyPrevious("")).toBe("a");
    expect(model.historyNext()).toBe("");
  });

  test("scrollback is capped: beyond 3000 chunks it drops to three quarters", () => {
    const { model } = makeModel({ banner: "" });
    expect(model.generation).toBe(0);
    for (let i = 0; i < 1500; i++) model.submit("bad"); // echo + output = 2 chunks each
    expect(model.chunks).toHaveLength(3000);
    expect(model.generation).toBe(0);
    model.submit("bad");
    expect(model.generation).toBe(1);
    // 3002 chunks -> drop down to 2250 at the moment the cap is exceeded (after the echo).
    expect(model.chunks.length).toBeLessThanOrEqual(ConsoleModel.maxChunks);
    expect(model.chunks.length).toBe(2251);
    expect(model.chunks.at(-1)?.kind).toBe("output");
  });

  test("chunk arrays are replaced, not mutated (views may keep the old one)", () => {
    const { model } = makeModel({ banner: "" });
    const before = model.chunks;
    model.submit("enable");
    expect(before).toHaveLength(0);
    expect(model.chunks).not.toBe(before);
  });

  test("paste runs every complete line and leaves the rest in the input", () => {
    const { model, session } = makeModel({ banner: "" });
    const rest = model.paste("able\nconf t\r\nhostname R1\nend", "en");
    expect(session.executed).toEqual(["enable", "conf t", "hostname R1"]);
    expect(rest).toBe("end");
  });

  test("paste ending with a newline leaves an empty input", () => {
    const { model, session } = makeModel({ banner: "" });
    expect(model.paste("enable\n", "")).toBe("");
    expect(session.executed).toEqual(["enable"]);
  });

  test("paste stops when a line closes the session", () => {
    const { model, session } = makeModel({ banner: "" });
    model.paste("exit\nenable\nshow vlan\n", "");
    expect(session.executed).toEqual(["exit"]);
    expect(model.isClosed).toBe(true);
  });

  test("subscribers hear about every change", () => {
    const { model } = makeModel({ banner: "" });
    let calls = 0;
    const unsubscribe = model.subscribe(() => (calls += 1));
    model.submit("enable");
    model.showHelp("");
    model.interrupt("x");
    unsubscribe();
    model.submit("enable");
    expect(calls).toBe(3);
  });

  test("footer text names the dialect", () => {
    const { model } = makeModel({ dialect: "routerOS" });
    expect(model.footerText).toBe(
      "Dialekt: MikroTik RouterOS   ·   Tab doplní   ·   ? nápověda   ·   ↑↓ historie   ·   " +
        "Ctrl-C zruší řádek   ·   Ctrl-Z end   ·   ping a traceroute podle diagramu",
    );
    expect(dialectName("ios")).toBe("Cisco IOS");
    expect(dialectName("dellOS9")).toBe("Dell OS9");
    expect(dialectName("generic")).toBe("obecný");
    expect(dialectName("host")).toBe("příkazový řádek");
  });
});

describe("console keys", () => {
  const key = (k: string, mods: Partial<{ ctrl: boolean; meta: boolean; alt: boolean; shift: boolean }> = {}) => ({
    key: k,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
  });

  test("special keys", () => {
    expect(consoleKeyFor(key("Enter"))).toBe("enter");
    expect(consoleKeyFor(key("Enter", { shift: true }))).toBe("enter");
    expect(consoleKeyFor(key("Tab"))).toBe("tab");
    expect(consoleKeyFor(key("Tab", { shift: true }))).toBe("tab");
    expect(consoleKeyFor(key("Tab", { ctrl: true }))).toBeNull();
    expect(consoleKeyFor(key("ArrowUp"))).toBe("historyUp");
    expect(consoleKeyFor(key("ArrowDown"))).toBe("historyDown");
    expect(consoleKeyFor(key("ArrowUp", { meta: true }))).toBeNull();
    expect(consoleKeyFor(key("PageUp"))).toBe("pageUp");
    expect(consoleKeyFor(key("PageDown"))).toBe("pageDown");
  });

  test("control keys", () => {
    expect(consoleKeyFor(key("c", { ctrl: true }))).toBe("interrupt");
    expect(consoleKeyFor(key("C", { ctrl: true, shift: true }))).toBe("interrupt");
    expect(consoleKeyFor(key("c", { ctrl: true }), true)).toBeNull(); // copy the selection
    expect(consoleKeyFor(key("z", { ctrl: true }))).toBe("end");
    expect(consoleKeyFor(key("p", { ctrl: true }))).toBe("historyUp");
    expect(consoleKeyFor(key("n", { ctrl: true }))).toBe("historyDown");
    expect(consoleKeyFor(key("c", { meta: true }))).toBeNull();
    expect(consoleKeyFor(key("z", { meta: true }))).toBeNull();
  });

  test("? is help, other characters are typing", () => {
    expect(consoleKeyFor(key("?", { shift: true }))).toBe("help");
    expect(consoleKeyFor(key("?", { alt: true }))).toBe("help");
    expect(consoleKeyFor(key("?", { ctrl: true }))).toBeNull();
    expect(consoleKeyFor(key("a"))).toBeNull();
    expect(consoleKeyFor(key(" "))).toBeNull();
  });

  test("pasted text is split into lines", () => {
    expect(isMultiLinePaste("show vlan")).toBe(false);
    expect(isMultiLinePaste("a\nb")).toBe(true);
    expect(splitPastedLines("a\r\nb\rc\nd")).toEqual(["a", "b", "c", "d"]);
  });
});
