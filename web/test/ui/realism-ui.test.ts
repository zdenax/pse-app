// UI parts of the realism feature: the console shortcut, the "Animace paketů" setting and the
// delay / loss fields of the cable inspector.

import { describe, expect, test } from "vitest";
import { AppModel, packetAnimationKey, type SettingsStorage } from "../../src/ui/app-model";
import { commitLinkQuality, parseQualityText, qualityText } from "../../src/ui/link-quality";
import { consoleShortcutLabel } from "../../src/ui/platform";
import { shortcutFor, type ShortcutKeyEvent } from "../../src/ui/shortcuts";
import { FakeFiles, FakeSession, FakeStore } from "./fakes";

function key(overrides: Partial<ShortcutKeyEvent>): ShortcutKeyEvent {
  return { key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides };
}

describe("console shortcut", () => {
  test("Alt+T opens the console on Windows and Linux", () => {
    expect(shortcutFor(key({ key: "t", code: "KeyT", altKey: true }), false, false)).toBe("console");
    expect(shortcutFor(key({ key: "t", code: "KeyT", altKey: true }), false, true)).toBe("console");
  });

  test("Option+T opens it on the Mac, where the key reports a dagger", () => {
    expect(shortcutFor(key({ key: "†", code: "KeyT", altKey: true }), true, false)).toBe("console");
    // In a text field the Mac keeps Option+T for typing.
    expect(shortcutFor(key({ key: "†", code: "KeyT", altKey: true }), true, true)).toBeNull();
  });

  test("Ctrl+T and Cmd+T are left to the browser (a new tab)", () => {
    expect(shortcutFor(key({ key: "t", code: "KeyT", ctrlKey: true }), false, false)).toBeNull();
    expect(shortcutFor(key({ key: "t", code: "KeyT", metaKey: true }), true, false)).toBeNull();
    expect(shortcutFor(key({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true }), false, false)).toBeNull();
  });

  test("AltGr (Ctrl+Alt) and other Alt combinations do not open it", () => {
    expect(shortcutFor(key({ key: "t", code: "KeyT", altKey: true, ctrlKey: true }), false, false)).toBeNull();
    expect(shortcutFor(key({ key: "t", code: "KeyT", altKey: true, shiftKey: true }), false, false)).toBeNull();
    expect(shortcutFor(key({ key: "s", code: "KeyS", altKey: true }), false, false)).toBeNull();
  });

  test("the other shortcuts still work", () => {
    expect(shortcutFor(key({ key: "s", code: "KeyS", ctrlKey: true }), false, false)).toBe("save");
    expect(shortcutFor(key({ key: "z", code: "KeyZ", metaKey: true }), true, false)).toBe("undo");
  });

  test("the label names Alt on Windows and Linux and Option on the Mac", () => {
    expect(consoleShortcutLabel(false)).toBe("Alt+T");
    expect(consoleShortcutLabel(true)).toBe("⌥T");
  });
});

class MemorySettings implements SettingsStorage {
  readonly values = new Map<string, string>();
  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function makeApp(settings: SettingsStorage) {
  const store = new FakeStore();
  return new AppModel({
    store,
    consoles: {
      createSession: (deviceID) => new FakeSession(deviceID, () => "X"),
      supportsConsole: () => true,
    },
    files: new FakeFiles(),
    settings,
  });
}

describe("Animace paketů", () => {
  test("is on by default, notifies when toggled and is remembered", () => {
    const settings = new MemorySettings();
    const app = makeApp(settings);
    expect(app.packetAnimation).toBe(true);
    let changes = 0;
    app.subscribe(() => (changes += 1));
    app.packetAnimation = false;
    expect(app.packetAnimation).toBe(false);
    expect(changes).toBe(1);
    expect(settings.values.get(packetAnimationKey)).toBe("off");
    app.packetAnimation = false;
    expect(changes).toBe(1);

    // A new session reads the remembered choice.
    expect(makeApp(settings).packetAnimation).toBe(false);
    app.packetAnimation = true;
    expect(settings.values.get(packetAnimationKey)).toBe("on");
    expect(makeApp(settings).packetAnimation).toBe(true);
  });

  test("works without any storage (blocked local storage)", () => {
    const broken: SettingsStorage = {
      get: () => null,
      set: () => {
        // Nothing is kept.
      },
    };
    const app = makeApp(broken);
    expect(app.packetAnimation).toBe(true);
    app.packetAnimation = false;
    expect(app.packetAnimation).toBe(false);
  });

  test("the console button names the shortcut in its tooltip", () => {
    const app = makeApp(new MemorySettings());
    const device = app.store.addDevice("generic-pc", { x: 0, y: 0 });
    app.store.selection = [{ kind: "device", id: device.id }];
    expect(app.consoleCommandState.help).toMatch(/\((Alt\+T|⌥T)\)$/);
  });
});

describe("delay and loss fields of the cable inspector", () => {
  function connected() {
    const store = new FakeStore();
    const a = store.addDevice("generic-pc", { x: 0, y: 0 });
    const b = store.addDevice("cisco-isr-4321", { x: 300, y: 0 });
    const link = store.connect(
      { deviceID: a.id, portID: a.ports[0].id },
      { deviceID: b.id, portID: b.ports[0].id },
    );
    return { store, link };
  }

  test("parses numbers with a comma or a dot, empty text clears and nonsense is refused", () => {
    expect(parseQualityText("20")).toBe(20);
    expect(parseQualityText(" 0,5 ")).toBe(0.5);
    expect(parseQualityText("12.25")).toBe(12.25);
    expect(parseQualityText("")).toBe(0);
    expect(parseQualityText("-3")).toBeNull();
    expect(parseQualityText("abc")).toBeNull();
    expect(parseQualityText("1e3")).toBeNull();
    expect(qualityText(undefined)).toBe("");
    expect(qualityText(0)).toBe("");
    expect(qualityText(12.5)).toBe("12.5");
  });

  test("typing a delay stores it and keeps the loss; one edit is one undo step", () => {
    const { store, link } = connected();
    expect(commitLinkQuality(store, link, "loss", "10")).toBe(true);
    expect(commitLinkQuality(store, link, "delay", "20")).toBe(true);
    const stored = store.project.links[0];
    expect(stored.delay).toBe(20);
    expect(stored.loss).toBe(10);
    expect(store.undo()).toBe(true);
    expect(store.project.links[0].delay).toBeUndefined();
    expect(store.project.links[0].loss).toBe(10);
  });

  test("emptying a field removes the setting", () => {
    const { store, link } = connected();
    commitLinkQuality(store, link, "delay", "15");
    expect(commitLinkQuality(store, link, "delay", "")).toBe(true);
    expect(store.project.links[0].delay).toBeUndefined();
  });

  test("refused text changes nothing and tells the field to fall back", () => {
    const { store, link } = connected();
    commitLinkQuality(store, link, "delay", "15");
    expect(commitLinkQuality(store, link, "delay", "fast")).toBe(false);
    expect(commitLinkQuality(store, link, "loss", "-1")).toBe(false);
    expect(store.project.links[0].delay).toBe(15);
    expect(store.project.links[0].loss).toBeUndefined();
  });

  test("loss is limited to 100 % and delay to a sensible maximum", () => {
    const { store, link } = connected();
    commitLinkQuality(store, link, "loss", "250");
    commitLinkQuality(store, link, "delay", "99999");
    expect(store.project.links[0].loss).toBe(100);
    expect(store.project.links[0].delay).toBe(10_000);
  });

  test("the same value again is not a new undo step", () => {
    const { store, link } = connected();
    commitLinkQuality(store, link, "delay", "20");
    const before = store.version;
    expect(commitLinkQuality(store, link, "delay", "20.0")).toBe(true);
    expect(store.version).toBe(before);
  });
});
