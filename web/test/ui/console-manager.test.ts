import { describe, expect, test } from "vitest";
import type { Device } from "../../src/core/model";
import { ConsoleManager } from "../../src/ui/console-manager";
import { FakeSession, FakeStore } from "./fakes";

function setup() {
  const store = new FakeStore();
  const sessions: FakeSession[] = [];
  const manager = new ConsoleManager(store, {
    createSession: (deviceID) => {
      const session = new FakeSession(deviceID, () => store.project.devices.find((d) => d.id === deviceID)?.hostname ?? "?", {
        rename: (name) => store.renameDevice(deviceID, name),
      });
      sessions.push(session);
      return session;
    },
    supportsConsole: (device: Device) => device.category !== "AP",
  });
  manager.start();
  const sw = store.addDevice("cisco-catalyst-2960-24", { x: 100, y: 100 });
  const pc = store.addDevice("generic-pc", { x: 300, y: 100 });
  const ap = store.addDevice("generic-ap", { x: 500, y: 100 });
  return { store, manager, sessions, sw, pc, ap };
}

const area = { width: 1600, height: 1000 };

describe("ConsoleManager", () => {
  test("opens one window per device, titled after the hostname", () => {
    const { manager, sw, pc } = setup();
    manager.open(sw.id, area);
    manager.open(pc.id, area);
    expect(manager.openConsoleCount).toBe(2);
    expect(manager.sessionCount).toBe(2);
    expect(manager.title(sw.id)).toBe("Konzole — SW1");
    expect(manager.title(pc.id)).toBe("Konzole — PC1");
    // The second window cascades.
    const [first, second] = manager.windows;
    expect(second.x - first.x).toBe(ConsoleManager.cascadeStep);
    expect(second.y - first.y).toBe(ConsoleManager.cascadeStep);
    expect(first.width).toBe(780);
    expect(first.height).toBe(480);
  });

  test("devices without a console are refused", () => {
    const { manager, ap } = setup();
    manager.open(ap.id, area);
    expect(manager.openConsoleCount).toBe(0);
    expect(manager.sessionCount).toBe(0);
  });

  test("opening again brings the window to the front and asks for focus", () => {
    const { manager, sw, pc, sessions } = setup();
    manager.open(sw.id, area);
    manager.open(pc.id, area);
    const token = manager.window(sw.id)!.focusToken;
    manager.open(sw.id, area);
    expect(sessions).toHaveLength(2);
    expect(manager.windows.at(-1)!.deviceID).toBe(sw.id);
    expect(manager.window(sw.id)!.focusToken).toBe(token + 1);
  });

  test("closing the window keeps the session (mode and scrollback)", () => {
    const { manager, sw, sessions } = setup();
    manager.open(sw.id, area);
    manager.model(sw.id)!.submit("enable");
    manager.close(sw.id);
    expect(manager.openConsoleCount).toBe(0);
    expect(manager.sessionCount).toBe(1);
    manager.open(sw.id, area);
    expect(sessions).toHaveLength(1);
    expect(manager.model(sw.id)!.prompt).toBe("SW1#");
    expect(manager.model(sw.id)!.chunks.some((chunk) => chunk.text === "enable")).toBe(true);
  });

  test("exit at the top level drops the session; the next open starts fresh", () => {
    const { manager, sw, sessions } = setup();
    manager.open(sw.id, area);
    const model = manager.model(sw.id)!;
    model.submit("exit");
    expect(model.isClosed).toBe(true);
    manager.sessionEnded(sw.id);
    expect(manager.openConsoleCount).toBe(0);
    expect(manager.sessionCount).toBe(0);
    manager.open(sw.id, area);
    expect(sessions).toHaveLength(2);
    expect(manager.model(sw.id)!.prompt).toBe("SW1>");
  });

  test("sessions and windows go away with their device (delete, undo, new project)", () => {
    const { store, manager, sw, pc } = setup();
    manager.open(sw.id, area);
    manager.open(pc.id, area);
    manager.close(pc.id);
    store.removeDevices([sw.id]);
    expect(manager.window(sw.id)).toBeUndefined();
    expect(manager.model(sw.id)).toBeUndefined();
    expect(manager.model(pc.id)).toBeDefined();
    store.undo();
    // The device is back, the old session is not.
    expect(manager.model(sw.id)).toBeUndefined();
    store.newProject();
    expect(manager.sessionCount).toBe(0);
  });

  test("titles and prompts follow renames", () => {
    const { store, manager, sw } = setup();
    manager.open(sw.id, area);
    const model = manager.model(sw.id)!;
    model.submit("enable");
    model.submit("conf t");
    model.submit("hostname CORE");
    expect(manager.title(sw.id)).toBe("Konzole — CORE");
    expect(model.prompt).toBe("CORE(config)#");
    store.renameDevice(sw.id, "EDGE");
    expect(manager.title(sw.id)).toBe("Konzole — EDGE");
    expect(model.prompt).toBe("EDGE(config)#");
  });

  test("bringToFront reorders, setFrame moves and keeps the minimum size", () => {
    const { manager, sw, pc } = setup();
    manager.open(sw.id, area);
    manager.open(pc.id, area);
    manager.bringToFront(sw.id);
    expect(manager.windows.map((w) => w.deviceID)).toEqual([pc.id, sw.id]);
    // Serials keep the opening order for stable rendering.
    expect(manager.window(sw.id)!.serial).toBeLessThan(manager.window(pc.id)!.serial);
    manager.setFrame(sw.id, { x: 10.4, y: 20.6, width: 100, height: 50 });
    expect(manager.window(sw.id)).toMatchObject({ x: 10, y: 21, width: 480, height: 260 });
  });

  test("a small screen gets a smaller first window", () => {
    const { manager, sw } = setup();
    manager.open(sw.id, { width: 700, height: 500 });
    const window = manager.window(sw.id)!;
    expect(window.width).toBe(660);
    expect(window.height).toBe(420);
  });

  test("stop() detaches from the store", () => {
    const { store, manager, sw } = setup();
    manager.open(sw.id, area);
    manager.stop();
    store.removeDevices([sw.id]);
    expect(manager.window(sw.id)).toBeDefined();
    manager.projectDidChange();
    expect(manager.window(sw.id)).toBeUndefined();
  });
});
