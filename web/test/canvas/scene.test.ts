/// <reference types="vite/client" />
// DiagramScene (DiagramScene.swift): cable exits, status dots, end-label placement, bundles,
// the logical view, hit testing and rubber-band selection. Two 24-port switches stacked
// vertically (SW1 at y 300, SW2 at y 600) give numbers that are easy to derive by hand:
// SW1 panel y 268...332, SW2 panel y 568...632, SW2 header (icon + texts) y 530...561.

import { DiagramScene, SceneCache, clearance, hitsEqual, linkMidpoint } from "../../src/canvas/scene";
import { intersects } from "../../src/canvas/geom";
import { approximateMeasurer, setTextMeasurer } from "../../src/canvas/text";
import { decodeProject } from "../../src/core/project-io";
import { addSwitch, makeStore, port } from "./support";

beforeAll(() => setTextMeasurer(approximateMeasurer));

function twoSwitches() {
  const store = makeStore();
  const sw1 = addSwitch(store, "SW1", { x: 400, y: 300 });
  const sw2 = addSwitch(store, "SW2", { x: 400, y: 600 });
  // Fa0/2 and Fa0/4 are on the bottom row of SW1, Fa0/1 and Fa0/3 on the top row of SW2.
  const first = store.connect(port(sw1, "Fa0/2"), port(sw2, "Fa0/1"));
  const second = store.connect(port(sw1, "Fa0/4"), port(sw2, "Fa0/3"));
  return { store, sw1, sw2, first, second };
}

describe("physical view: cables", () => {
  const { store, sw1, sw2, first, second } = twoSwitches();
  const scene = new DiagramScene(store.project, "physical");

  test("cables run between port centers", () => {
    expect(scene.links).toHaveLength(2);
    const link = scene.links[0];
    expect(link.id).toBe(first.id);
    expect(link.start).toEqual({ x: 304.5, y: 308.5 });
    expect(link.end).toEqual({ x: 304.5, y: 591.5 });
    expect(scene.isPortUsed(port(sw1, "Fa0/2"))).toBe(true);
    expect(scene.isPortUsed(port(sw1, "Fa0/1"))).toBe(false);
  });

  test("clearance: out of the panel, and past the own header the cable runs through", () => {
    const link = scene.links[0];
    // Leaves SW1's panel at its bottom edge (332): 23.5 below the port center.
    expect(clearance(link.start, link.end, scene.node(sw1.id)!)).toBeCloseTo(23.5);
    // From SW2 the cable runs up through the icon: clear of the header (528 incl. slop) after 63.5.
    expect(clearance(link.end, link.start, scene.node(sw2.id)!)).toBeCloseTo(63.5);
  });

  test("status dots sit just outside the clear zone", () => {
    const link = scene.links[0];
    // exitA 23.5 + 8, exitB = 283 - 63.5 - 8 (dot offset min(dotRadius + 4, 20 % of the free run)).
    expect(link.dotA).toEqual({ x: 304.5, y: 340 });
    expect(link.dotB).toEqual({ x: 304.5, y: 520 });
  });

  test("end labels go after the dots and avoid each other", () => {
    const [a, b] = scene.links;
    // Label plate 14 high (ceil(9 pt text) + 2 * 1.5): base distance 8 + 4 + 3 + 7 = 22 from the exit.
    expect(a.labelA?.text).toBe("Fa0/2");
    expect(a.labelA?.center).toEqual({ x: 305, y: 354 });
    expect(a.labelB?.text).toBe("Fa0/1");
    expect(a.labelB?.center).toEqual({ x: 305, y: 506 });
    // The neighbouring cable's labels would overlap those: they move one step (plate + 2) along.
    expect(b.labelA?.center).toEqual({ x: 322, y: 370 });
    expect(b.labelB?.center).toEqual({ x: 322, y: 490 });
    expect(b.id).toBe(second.id);
  });

  test("content bounds cover headers, panels and labels", () => {
    const bounds = scene.contentBounds!;
    expect(bounds.y).toBe(230);
    expect(bounds.y + bounds.height).toBe(632);
    expect(bounds.x).toBe(288);
  });
});

describe("bundles", () => {
  test("physical: double cables tied at their midpoints, caption at the centroid", () => {
    const { store, first, second } = twoSwitches();
    const bundle = store.createBundle([first.id, second.id], "Po1");
    const scene = new DiagramScene(store.project, "physical");
    expect(scene.links.every((link) => link.isBundled)).toBe(true);
    expect(scene.bundles).toHaveLength(1);
    const geometry = scene.bundles[0];
    expect(geometry.id).toBe(bundle.id);
    expect(geometry.tie).toEqual([
      { x: 304.5, y: 450 },
      { x: 321.5, y: 450 },
    ]);
    expect(geometry.labelCenter).toEqual({ x: 313, y: 450 });
    expect(geometry.linkIDs).toEqual([first.id, second.id]);
  });

  test("logical: a bundle collapses into one strand next to the single cables", () => {
    const { store, sw1, sw2, first, second } = twoSwitches();
    store.createBundle([first.id, second.id], "Po1");
    const third = store.connect(port(sw1, "Fa0/6"), port(sw2, "Fa0/5"));
    const scene = new DiagramScene(store.project, "logical");
    expect(scene.links).toHaveLength(2);
    const [bundled, single] = scene.links;
    expect(bundled.memberIDs).toEqual([first.id, second.id]);
    expect(bundled.isBundled).toBe(true);
    expect(single.memberIDs).toEqual([third.id]);
    // Parallel strands 9 apart.
    expect(Math.abs(bundled.start.x - single.start.x)).toBeCloseTo(9);
    // Visible from below SW1's name plate to the top of SW2's icon (inset by 3).
    const top = Math.min(bundled.start.y, bundled.end.y);
    const bottom = Math.max(bundled.start.y, bundled.end.y);
    const plate = scene.node(sw1.id)!.labelPlateRect;
    expect(top).toBeCloseTo(plate.y + plate.height);
    expect(bottom).toBeCloseTo(574);
    // The a end of the lead link is at SW1.
    expect(bundled.start.y).toBeLessThan(bundled.end.y);
    expect(scene.bundles).toHaveLength(1);
    const mid = linkMidpoint(bundled);
    expect(scene.bundles[0].labelCenter.y).toBe(Math.round(mid.y));
    expect(bundled.dotA).toBeNull();
    expect(bundled.labelA).toBeNull();
  });
});

describe("hit testing", () => {
  const { store, sw1, sw2, first } = twoSwitches();
  const scene = new DiagramScene(store.project, "physical");
  const tolerance = 5;

  test("ports win over the plugs of the cables sitting on them", () => {
    expect(scene.hitTest({ x: 304.5, y: 291.5 }, tolerance)).toEqual({ kind: "port", ref: port(sw1, "Fa0/1") });
    expect(scene.hitTest({ x: 304.5, y: 308.5 }, tolerance)).toEqual({ kind: "port", ref: port(sw1, "Fa0/2") });
  });

  test("status dots, cables, headers, warning glyphs, panels, empty space", () => {
    expect(scene.hitTest({ x: 304.5, y: 340 }, tolerance)).toEqual({ kind: "statusDot", linkID: first.id, end: "a" });
    expect(scene.hitTest({ x: 304.5, y: 521 }, tolerance)).toEqual({ kind: "statusDot", linkID: first.id, end: "b" });
    expect(scene.hitTest({ x: 307, y: 440 }, tolerance)).toEqual({ kind: "link", ids: [first.id] });
    expect(scene.hitTest({ x: 303, y: 246 }, tolerance)).toEqual({ kind: "deviceHeader", deviceID: sw1.id });
    const warning = scene.node(sw2.id)!.warningRect!;
    expect(scene.hitTest({ x: warning.x + 6, y: warning.y + 6 }, tolerance)).toEqual({
      kind: "warning",
      deviceID: sw2.id,
    });
    expect(scene.hitTest({ x: 290, y: 270 }, tolerance)).toEqual({ kind: "devicePanel", deviceID: sw1.id });
    expect(scene.hitTest({ x: 1000, y: 1000 }, tolerance)).toEqual({ kind: "empty" });
  });

  test("only the topmost panel counts: it hides the ports below it", () => {
    const local = twoSwitches();
    const top = addSwitch(local.store, "SW3", { x: 420, y: 310 });
    const overlapped = new DiagramScene(local.store.project, "physical");
    // (320, 290) is SW1's Fa0/3, but inside SW3's plate (x 308..., y 278...) above its port rows.
    expect(overlapped.hitTest({ x: 320, y: 290 }, tolerance)).toEqual({ kind: "devicePanel", deviceID: top.id });
    // Where SW1 is not covered its ports still work.
    expect(overlapped.hitTest({ x: 304.5, y: 291.5 }, tolerance)).toEqual({
      kind: "port",
      ref: port(local.sw1, "Fa0/1"),
    });
  });

  test("annotations are on top of everything", () => {
    const local = twoSwitches();
    const note = local.store.addAnnotation("Pozor", { x: 300, y: 285 });
    const withNote = new DiagramScene(local.store.project, "physical");
    expect(withNote.hitTest({ x: 305, y: 291 }, tolerance)).toEqual({ kind: "annotation", id: note.id });
  });

  test("hits compare by value", () => {
    expect(hitsEqual({ kind: "link", ids: ["a", "b"] }, { kind: "link", ids: ["a", "b"] })).toBe(true);
    expect(hitsEqual({ kind: "link", ids: ["a"] }, { kind: "link", ids: ["b"] })).toBe(false);
    expect(hitsEqual({ kind: "empty" }, { kind: "deviceHeader", deviceID: "x" })).toBe(false);
  });
});

describe("rubber band", () => {
  const { store, sw1, sw2, first, second } = twoSwitches();
  const note = store.addAnnotation("Poznámka", { x: 700, y: 100 });
  const scene = new DiagramScene(store.project, "physical");

  test("catches devices by panel or header, cables only with both ends", () => {
    expect(scene.elementsIn({ x: 280, y: 220, width: 240, height: 120 })).toEqual({
      devices: [sw1.id],
      links: [],
      annotations: [],
    });
    // Touching only SW2's header is enough for the device.
    expect(scene.elementsIn({ x: 280, y: 540, width: 20, height: 10 }).devices).toEqual([sw2.id]);
    expect(scene.elementsIn({ x: 0, y: 0, width: 1000, height: 1000 })).toEqual({
      devices: [sw1.id, sw2.id],
      links: [first.id, second.id],
      annotations: [note.id],
    });
  });
});

describe("scene cache", () => {
  test("reuses the scene and the nodes of unchanged devices", () => {
    const { store, sw1, sw2 } = twoSwitches();
    const cache = new SceneCache();
    const before = cache.scene(store.project, "physical");
    expect(cache.scene(store.project, "physical")).toBe(before);
    store.moveDevices([sw2.id], { x: 40, y: 0 });
    const after = cache.scene(store.project, "physical");
    expect(after).not.toBe(before);
    expect(after.node(sw1.id)).toBe(before.node(sw1.id));
    expect(after.node(sw2.id)).not.toBe(before.node(sw2.id));
    expect(cache.scene(store.project, "logical").mode).toBe("logical");
  });
});

describe("example projects", () => {
  const examples = import.meta.glob<string>("../../../examples/*.netsketch", {
    query: "?raw",
    import: "default",
    eager: true,
  });

  test.each(Object.entries(examples))("%s lays out in both views", (_path, text) => {
    const project = decodeProject(text);
    const physical = new DiagramScene(project, "physical");
    expect(physical.nodes).toHaveLength(project.devices.length);
    expect(physical.links).toHaveLength(project.links.length);
    expect(physical.contentBounds).not.toBeNull();
    // End labels keep clear of every device name and panel in the committed examples.
    const obstacles = physical.nodes.flatMap((node) => [node.headerRect, node.bodyRect]);
    const blocked = physical.links
      .flatMap((link) => [link.labelA, link.labelB])
      .filter((label) => label !== null)
      .filter((label) => obstacles.some((rect) => intersects(rect, label!.rect)));
    expect(blocked.map((label) => label!.text)).toEqual([]);
    expect(physical.links.every((link) => link.dotA !== null && link.dotB !== null)).toBe(true);
    const logical = new DiagramScene(project, "logical");
    expect(logical.links.length).toBeLessThanOrEqual(project.links.length);
    expect(logical.bundles).toHaveLength(project.bundles.length);
  });
});
