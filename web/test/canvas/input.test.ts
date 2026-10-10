// The input state machine (CanvasNSView+Input.swift) driven with plain events against a real
// ProjectStore and the shell's Viewport. View and canvas coordinates coincide (zoom 1, no offset).
// SW1 at (400, 300): icon center (303, 246), Fa0/1 center (304.5, 291.5), Fa0/2 (304.5, 308.5).
// SW2 at (400, 600): icon center (303, 546). Cable SW1 Fa0/2 - SW2 Fa0/1, status dot a at (304.5, 340).

import { CanvasInput, ClickCounter, type MenuEntry, type Scheduler } from "../../src/canvas/input";
import { SceneCache } from "../../src/canvas/scene";
import { approximateMeasurer, setTextMeasurer } from "../../src/canvas/text";
import { findDevice } from "../../src/core/project";
import { Viewport } from "../../src/ui/viewport";
import { addSwitch, makeStore, port } from "./support";

beforeAll(() => setTextMeasurer(approximateMeasurer));

class FakeScheduler implements Scheduler {
  time = 0;
  private tasks: { at: number; fn: () => void }[] = [];

  now(): number {
    return this.time;
  }

  later(ms: number, fn: () => void): () => void {
    const task = { at: this.time + ms, fn };
    this.tasks.push(task);
    return () => {
      this.tasks = this.tasks.filter((candidate) => candidate !== task);
    };
  }

  advance(ms: number): void {
    this.time += ms;
    const due = this.tasks.filter((task) => task.at <= this.time).sort((a, b) => a.at - b.at);
    this.tasks = this.tasks.filter((task) => task.at > this.time);
    for (const task of due) task.fn();
  }
}

function setup() {
  const store = makeStore();
  const sw1 = addSwitch(store, "SW1", { x: 400, y: 300 });
  const sw2 = addSwitch(store, "SW2", { x: 400, y: 600 });
  const link = store.connect(port(sw1, "Fa0/2"), port(sw2, "Fa0/1"));
  const viewport = new Viewport();
  viewport.setViewSize({ width: 1200, height: 900 });
  const cache = new SceneCache();
  const scheduler = new FakeScheduler();
  const input = new CanvasInput({
    store,
    viewport,
    scene: () => cache.scene(store.project, store.viewMode),
    scheduler,
  });
  const position = (id: string) => findDevice(store.project, id)!.position;
  return { store, sw1, sw2, link, viewport, scheduler, input, position };
}

const header1 = { x: 303, y: 246 };
const header2 = { x: 303, y: 546 };
const emptySpot = { x: 1000, y: 100 };
const plain = { clickCount: 1, extending: false, panModifier: false };
const shift = { clickCount: 1, extending: true, panModifier: false };
const double = { clickCount: 2, extending: false, panModifier: false };

function click(input: CanvasInput, at: { x: number; y: number }, options = plain) {
  input.pointerDown(at, options);
  input.pointerUp(at);
}

function items(entries: MenuEntry[] | null): Extract<MenuEntry, { kind: "item" }>[] {
  return (entries ?? []).filter((entry): entry is Extract<MenuEntry, { kind: "item" }> => entry.kind === "item");
}

describe("selection", () => {
  test("click selects, shift-click toggles, a plain click collapses a multiple selection", () => {
    const { store, sw1, sw2, input } = setup();
    click(input, header1);
    expect(store.selection).toEqual([{ kind: "device", id: sw1.id }]);
    click(input, header2, shift);
    expect(store.selection).toHaveLength(2);
    // Pressing one of several selected keeps all (so they can be dragged), releasing narrows.
    input.pointerDown(header2, plain);
    expect(store.selection).toHaveLength(2);
    input.pointerUp(header2);
    expect(store.selection).toEqual([{ kind: "device", id: sw2.id }]);
    click(input, header2, shift);
    expect(store.selection).toEqual([]);
  });

  test("clicking a cable selects it; clicking empty canvas clears", () => {
    const { store, link, input } = setup();
    click(input, { x: 306, y: 440 });
    expect(store.selection).toEqual([{ kind: "link", id: link.id }]);
    click(input, emptySpot);
    expect(store.selection).toEqual([]);
  });

  test("rubber band selects what it touches; Esc restores the previous selection", () => {
    const { store, sw1, input } = setup();
    input.pointerDown(emptySpot, plain);
    input.pointerDragged({ x: 250, y: 340 });
    expect(input.interaction.kind).toBe("rubberBand");
    expect(input.rubberBandRect).toEqual({ x: 250, y: 100, width: 750, height: 240 });
    expect(store.selection).toEqual([{ kind: "device", id: sw1.id }]);
    input.cancelCurrentOperation();
    expect(store.selection).toEqual([]);
    expect(input.interaction.kind).toBe("idle");
  });
});

describe("dragging", () => {
  test("moves the selection as ONE undo step", () => {
    const { store, sw1, link, input, position } = setup();
    input.pointerDown(header1, plain);
    input.pointerDragged({ x: 304, y: 247 }); // below the 3 px threshold
    expect(input.interaction.kind).toBe("pressed");
    expect(position(sw1.id)).toEqual({ x: 400, y: 300 });
    input.pointerDragged({ x: 313, y: 246 });
    expect(input.interaction.kind).toBe("draggingItems");
    expect(position(sw1.id)).toEqual({ x: 410, y: 300 });
    input.pointerDragged({ x: 343, y: 266 });
    expect(position(sw1.id)).toEqual({ x: 440, y: 320 });
    input.pointerUp({ x: 343, y: 266 });
    expect(store.isGrouping).toBe(false);
    expect(input.interaction.kind).toBe("idle");
    store.undo();
    expect(position(sw1.id)).toEqual({ x: 400, y: 300 });
    // The step before the drag (the cable) is still there.
    expect(store.project.links.map((candidate) => candidate.id)).toEqual([link.id]);
  });

  test("dragging a port drags its device", () => {
    const { store, sw1, input, position } = setup();
    input.pointerDown({ x: 304.5, y: 291.5 }, plain);
    input.pointerDragged({ x: 324.5, y: 291.5 });
    input.pointerUp({ x: 324.5, y: 291.5 });
    expect(position(sw1.id)).toEqual({ x: 420, y: 300 });
    expect(store.selection).toEqual([{ kind: "device", id: sw1.id }]);
    expect(store.pendingPort).toBeNull();
  });

  test("Esc cancels the drag and puts everything back without an undo step", () => {
    const { store, sw1, input, position } = setup();
    input.pointerDown(header1, plain);
    input.pointerDragged({ x: 353, y: 246 });
    expect(store.isGrouping).toBe(true);
    expect(input.keyDown({ key: "Escape" })).toBe(true);
    expect(store.isGrouping).toBe(false);
    expect(position(sw1.id)).toEqual({ x: 400, y: 300 });
    // The release that follows does nothing.
    input.pointerUp({ x: 353, y: 246 });
    expect(position(sw1.id)).toEqual({ x: 400, y: 300 });
    store.undo(); // reverts the cable, not a drag
    expect(store.project.links).toHaveLength(0);
  });

  test("a drag whose pointer-up never came is closed by the next press", () => {
    const { store, sw1, input, position } = setup();
    input.pointerDown(header1, plain);
    input.pointerDragged({ x: 353, y: 246 });
    input.pointerDown(emptySpot, plain);
    expect(store.isGrouping).toBe(false);
    expect(position(sw1.id)).toEqual({ x: 450, y: 300 });
    store.undo();
    expect(position(sw1.id)).toEqual({ x: 400, y: 300 });
  });

  test("undo mid-drag ends the drag instead of moving by the whole translation again", () => {
    const { store, sw1, input, position } = setup();
    input.pointerDown(header1, plain);
    input.pointerDragged({ x: 323, y: 246 });
    store.undo();
    expect(position(sw1.id)).toEqual({ x: 400, y: 300 });
    input.pointerDragged({ x: 343, y: 246 });
    expect(input.interaction.kind).toBe("idle");
    expect(position(sw1.id)).toEqual({ x: 400, y: 300 });
    input.pointerUp({ x: 343, y: 246 });
    expect(store.isGrouping).toBe(false);
  });

  test("shift-pressing a selected device toggles it off: nothing to drag", () => {
    const { store, sw1, input, position } = setup();
    click(input, header1);
    input.pointerDown(header1, shift);
    input.pointerDragged({ x: 343, y: 246 });
    expect(input.interaction.kind).toBe("idle");
    expect(position(sw1.id)).toEqual({ x: 400, y: 300 });
    expect(store.isGrouping).toBe(false);
  });

  test("pointer cancel and dispose keep beginDrag / endDrag balanced", () => {
    const first = setup();
    first.input.pointerDown(header1, plain);
    first.input.pointerDragged({ x: 353, y: 246 });
    first.input.pointerCancelled();
    expect(first.store.isGrouping).toBe(false);

    const second = setup();
    second.input.pointerDown(header1, plain);
    second.input.pointerDragged({ x: 353, y: 246 });
    second.input.dispose();
    expect(second.store.isGrouping).toBe(false);
  });

  test("Delete during a drag cancels it, then removes the selection", () => {
    const { store, sw1, input } = setup();
    input.pointerDown(header1, plain);
    input.pointerDragged({ x: 353, y: 246 });
    expect(input.keyDown({ key: "Delete" })).toBe(true);
    expect(store.isGrouping).toBe(false);
    expect(findDevice(store.project, sw1.id)).toBeUndefined();
    expect(store.project.links).toHaveLength(0);
    store.undo();
    expect(findDevice(store.project, sw1.id)?.position).toEqual({ x: 400, y: 300 });
  });
});

describe("cabling and status", () => {
  test("two clicks on free ports connect them and select the new cable", () => {
    const { store, sw1, sw2, input } = setup();
    click(input, { x: 304.5, y: 291.5 }); // SW1 Fa0/1
    expect(store.pendingPort).toEqual(port(sw1, "Fa0/1"));
    expect(input.pendingCable()?.start).toEqual({ x: 304.5, y: 291.5 });
    // SW2 Fa0/3: top row, second column.
    click(input, { x: 321.5, y: 591.5 });
    expect(store.pendingPort).toBeNull();
    const created = store.project.links[1];
    expect(created.a).toEqual(port(sw1, "Fa0/1"));
    expect(created.b).toEqual(port(sw2, "Fa0/3"));
    expect(store.selection).toEqual([{ kind: "link", id: created.id }]);
  });

  test("a used port refuses, flashes and shows its cable", () => {
    const { store, link, input, scheduler } = setup();
    click(input, { x: 304.5, y: 308.5 }); // SW1 Fa0/2 is plugged
    expect(store.pendingPort).toBeNull();
    expect(input.feedback).toMatch(/kabel/);
    expect(input.rejectedPort).not.toBeNull();
    expect(store.selection).toEqual([{ kind: "link", id: link.id }]);
    scheduler.advance(800);
    expect(input.rejectedPort).toBeNull();
    scheduler.advance(3000);
    expect(input.feedback).toBeNull();
  });

  test("a second port on the same device is refused but cabling continues; Esc cancels", () => {
    const { store, sw1, input } = setup();
    click(input, { x: 304.5, y: 291.5 });
    click(input, { x: 321.5, y: 291.5 }); // SW1 Fa0/3
    expect(store.pendingPort).toEqual(port(sw1, "Fa0/1"));
    expect(input.feedback).not.toBeNull();
    input.keyDown({ key: "Escape" });
    expect(store.pendingPort).toBeNull();
    expect(input.feedback).toBeNull();
  });

  test("the second click of a double-click on a port does nothing", () => {
    const { store, input } = setup();
    click(input, { x: 304.5, y: 291.5 });
    click(input, { x: 304.5, y: 291.5 }, double);
    expect(store.pendingPort).not.toBeNull();
  });

  test("clicking a status dot cycles its status", () => {
    const { store, input } = setup();
    click(input, { x: 304.5, y: 340 });
    expect(store.project.links[0].statusA).toBe("green");
    click(input, { x: 304.5, y: 340 });
    expect(store.project.links[0].statusA).toBe("orange");
    expect(store.project.links[0].statusB).toBe("none");
  });
});

describe("inline editing", () => {
  test("double-click on empty canvas writes a new note", () => {
    const { store, input } = setup();
    input.pointerDown({ x: 700, y: 120 }, double);
    expect(input.editing?.target).toEqual({ kind: "newAnnotation", point: { x: 700, y: 120 } });
    input.setEditDraft("  Ahoj\nsvete  ");
    input.finishEditing(true);
    expect(input.editing).toBeNull();
    const note = store.project.annotations[0];
    expect(note.text).toBe("Ahoj\nsvete");
    expect(note.position).toEqual({ x: 700, y: 120 });
    expect(store.selection).toEqual([{ kind: "annotation", id: note.id }]);
  });

  test("an empty new note is not created", () => {
    const { store, input } = setup();
    input.pointerDown({ x: 700, y: 120 }, double);
    input.finishEditing(true);
    expect(store.project.annotations).toHaveLength(0);
  });

  test("double-click on a device header renames it; an emptied field keeps the name", () => {
    const { store, sw1, input } = setup();
    input.pointerDown(header1, double);
    expect(input.editing?.initialText).toBe("SW1");
    input.setEditDraft("CORE-1");
    input.finishEditing(true);
    expect(findDevice(store.project, sw1.id)?.hostname).toBe("CORE-1");
    input.pointerDown(header1, double);
    input.setEditDraft("   ");
    input.finishEditing(true);
    expect(findDevice(store.project, sw1.id)?.hostname).toBe("CORE-1");
  });

  test("a note edited to nothing is removed; Esc-style finish keeps it", () => {
    const { store, input } = setup();
    const note = store.addAnnotation("Text", { x: 700, y: 120 });
    input.pointerDown({ x: 702, y: 125 }, double);
    expect(input.editing?.target).toEqual({ kind: "annotation", id: note.id });
    input.setEditDraft("");
    input.finishEditing(false);
    expect(store.project.annotations).toHaveLength(1);
    input.beginEditing({ kind: "annotation", id: note.id });
    input.setEditDraft("");
    input.finishEditing(true);
    expect(store.project.annotations).toHaveLength(0);
  });

  test("a press elsewhere commits the running edit; Enter edits the single selection", () => {
    const { store, sw1, input } = setup();
    click(input, header1);
    expect(input.keyDown({ key: "Enter" })).toBe(true);
    input.setEditDraft("EDGE");
    input.pointerDown(emptySpot, plain);
    expect(findDevice(store.project, sw1.id)?.hostname).toBe("EDGE");
  });
});

describe("keyboard", () => {
  test("Delete removes the selection and is left to others without one", () => {
    const { store, link, input } = setup();
    expect(input.keyDown({ key: "Backspace" })).toBe(false);
    click(input, { x: 306, y: 440 });
    expect(input.keyDown({ key: "Backspace" })).toBe(true);
    expect(store.project.links.find((candidate) => candidate.id === link.id)).toBeUndefined();
  });

  test("arrows nudge by one grid step (or one point without snapping)", () => {
    const { store, sw1, input, position } = setup();
    click(input, header1);
    input.keyDown({ key: "ArrowRight" });
    expect(position(sw1.id)).toEqual({ x: 401, y: 300 });
    store.snapToGrid = true;
    input.keyDown({ key: "ArrowDown" });
    expect(position(sw1.id)).toEqual({ x: 400, y: 320 });
  });

  test("shortcuts with Cmd/Ctrl are left to the shell", () => {
    const { input } = setup();
    expect(input.keyDown({ key: "Backspace", metaKey: true })).toBe(false);
    expect(input.keyDown({ key: "a", ctrlKey: true })).toBe(false);
  });

  test("Esc first cancels cabling, then clears the selection", () => {
    const { store, input } = setup();
    click(input, header1);
    click(input, { x: 304.5, y: 291.5 });
    expect(store.pendingPort).not.toBeNull();
    input.keyDown({ key: "Escape" });
    expect(store.pendingPort).toBeNull();
    expect(store.selection).toHaveLength(1);
    input.keyDown({ key: "Escape" });
    expect(store.selection).toHaveLength(0);
  });
});

describe("viewport gestures", () => {
  test("Cmd/Ctrl-wheel zooms around the pointer", () => {
    const { viewport, input } = setup();
    const at = { x: 500, y: 400 };
    const before = viewport.canvasPoint(at);
    input.wheel(at, 0, -10, true);
    expect(viewport.zoom).toBeCloseTo(Math.exp(0.1));
    const after = viewport.canvasPoint(at);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  test("plain wheel pans", () => {
    const { viewport, input } = setup();
    input.wheel({ x: 10, y: 10 }, 30, -20, false);
    expect(viewport.offset).toEqual({ x: -30, y: 20 });
  });

  test("Space-drag and middle-drag pan", () => {
    const { store, viewport, input, sw1, position } = setup();
    input.keyDown({ key: " " });
    expect(input.cursor).toBe("grab");
    input.pointerDown(header1, plain);
    input.pointerDragged({ x: 323, y: 256 });
    input.pointerUp({ x: 323, y: 256 });
    expect(viewport.offset).toEqual({ x: 20, y: 10 });
    expect(position(sw1.id)).toEqual({ x: 400, y: 300 });
    input.keyUp({ key: " " });

    expect(input.middleDown({ x: 100, y: 100 })).toBe(true);
    input.pointerDragged({ x: 90, y: 100 });
    input.middleUp({ x: 90, y: 100 });
    expect(viewport.offset).toEqual({ x: 10, y: 10 });

    // The middle button does not hijack a running drag.
    input.pointerDown({ x: 323, y: 256 }, plain);
    input.pointerDragged({ x: 343, y: 256 });
    expect(input.middleDown({ x: 343, y: 256 })).toBe(false);
    input.pointerUp({ x: 343, y: 256 });
    expect(store.isGrouping).toBe(false);
  });
});

describe("hover", () => {
  test("ports show their tag at once, cables after a delay; cursor follows", () => {
    const { input, scheduler } = setup();
    input.pointerMoved({ x: 304.5, y: 291.5 });
    expect(input.hover).toEqual({ kind: "port", ref: expect.anything() });
    expect(input.tooltipIsDue).toBe(true);
    expect(input.cursor).toBe("pointer");
    input.pointerMoved({ x: 304.5, y: 308.5 });
    expect(input.cursor).toBe("not-allowed");
    input.pointerMoved({ x: 306, y: 440 });
    expect(input.hover.kind).toBe("link");
    expect(input.tooltipIsDue).toBe(false);
    scheduler.advance(600);
    expect(input.tooltipIsDue).toBe(true);
    input.pointerMoved(null);
    expect(input.hover.kind).toBe("empty");
  });
});

describe("context menu", () => {
  test("cable menu: types, end statuses, bundling, delete", () => {
    const { store, link, input } = setup();
    const entries = input.contextMenu({ x: 306, y: 440 });
    expect(store.selection).toEqual([{ kind: "link", id: link.id }]);
    const top = items(entries);
    expect(top.map((entry) => entry.label)).toEqual([
      "Typ kabelu",
      "Stav konce A (SW1 Fa0/2)",
      "Stav konce B (SW2 Fa0/1)",
      "Sloučit do svazku (LAG)",
      "Odstranit kabel",
    ]);
    const types = items(top[0].submenu!);
    expect(types.find((entry) => entry.checked)?.label).toBe("Přímý");
    // A single cable cannot be bundled.
    expect(top[3].enabled).toBe(false);
    types.find((entry) => entry.label === "Optický")!.action!();
    expect(store.project.links[0].cableType).toBe("fiber");
    items(top[1].submenu!).find((entry) => entry.label === "Červená")!.action!();
    expect(store.project.links[0].statusA).toBe("red");
  });

  test("device and empty-canvas menus", () => {
    const opened: string[] = [];
    const { store, sw1, input, viewport } = setup();
    input.host = { openConsole: (id) => opened.push(id) };
    const deviceMenu = items(input.contextMenu(header1));
    expect(store.selection).toEqual([{ kind: "device", id: sw1.id }]);
    expect(deviceMenu.map((entry) => entry.label)).toEqual(["Přejmenovat", "Otevřít konzoli", "Odstranit"]);
    deviceMenu[1].action!();
    expect(opened).toEqual([sw1.id]);
    deviceMenu[0].action!();
    expect(input.editing?.target).toEqual({ kind: "hostname", id: sw1.id });
    input.finishEditing(false);

    const emptyMenu = items(input.contextMenu(emptySpot));
    expect(emptyMenu.map((entry) => entry.label)).toEqual([
      "Přidat poznámku",
      "Vybrat vše",
      "Přizpůsobit zobrazení",
      "Skutečná velikost",
    ]);
    viewport.contentBoundsProvider = () => ({ x: 0, y: 0, width: 2400, height: 1800 });
    emptyMenu[2].action!();
    expect(viewport.zoom).toBeLessThan(1);
  });
});

describe("palette drops", () => {
  test("a drag shows a ghost; the drop adds and selects the device", () => {
    const { store, input } = setup();
    input.dragOver({ x: 800, y: 400 }, "test-pc");
    expect(input.dropGhost?.category).toBe("PC");
    expect(input.drop({ x: 800, y: 400 }, "test-pc")).toBe(true);
    expect(input.dropGhost).toBeNull();
    const added = store.project.devices[2];
    expect(added.position).toEqual({ x: 800, y: 400 });
    expect(store.selection).toEqual([{ kind: "device", id: added.id }]);
    expect(input.drop({ x: 800, y: 400 }, "no-such-template")).toBe(false);
    expect(input.feedback).not.toBeNull();
  });
});

describe("click counter", () => {
  test("counts quick clicks at the same spot", () => {
    const counter = new ClickCounter(500, 5);
    expect(counter.register(0, { x: 10, y: 10 })).toBe(1);
    expect(counter.register(200, { x: 12, y: 11 })).toBe(2);
    expect(counter.register(350, { x: 12, y: 11 })).toBe(3);
    expect(counter.register(1000, { x: 12, y: 11 })).toBe(1);
    expect(counter.register(1100, { x: 40, y: 11 })).toBe(1);
  });
});
