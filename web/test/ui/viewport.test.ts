import { describe, expect, test } from "vitest";
import { Viewport } from "../../src/ui/viewport";

describe("Viewport", () => {
  test("starts at 100 % with no offset", () => {
    const viewport = new Viewport();
    expect(viewport.zoom).toBe(1);
    expect(viewport.zoomPercent).toBe(100);
    expect(viewport.offset).toEqual({ x: 0, y: 0 });
  });

  test("zoomIn and zoomOut step by 1.25 and keep the view center fixed", () => {
    const viewport = new Viewport();
    viewport.setViewSize({ width: 800, height: 600 });
    const centerBefore = viewport.canvasPoint({ x: 400, y: 300 });
    viewport.zoomIn();
    expect(viewport.zoom).toBeCloseTo(1.25);
    expect(viewport.zoomPercent).toBe(125);
    const centerAfter = viewport.canvasPoint({ x: 400, y: 300 });
    expect(centerAfter.x).toBeCloseTo(centerBefore.x);
    expect(centerAfter.y).toBeCloseTo(centerBefore.y);
    viewport.zoomOut();
    expect(viewport.zoom).toBeCloseTo(1);
    viewport.zoomOut();
    expect(viewport.zoomPercent).toBe(80);
  });

  test("zoom is clamped to 20 %...400 %", () => {
    const viewport = new Viewport();
    for (let i = 0; i < 30; i++) viewport.zoomIn();
    expect(viewport.zoom).toBe(Viewport.maxZoom);
    expect(viewport.canZoomIn).toBe(false);
    for (let i = 0; i < 60; i++) viewport.zoomOut();
    expect(viewport.zoom).toBe(Viewport.minZoom);
    expect(viewport.canZoomOut).toBe(false);
    viewport.zoom = 10;
    expect(viewport.clampedZoom).toBe(Viewport.maxZoom);
    viewport.zoom = Number.NaN;
    expect(viewport.clampedZoom).toBe(1);
  });

  test("setZoom keeps the anchor point in place", () => {
    const viewport = new Viewport();
    viewport.setViewSize({ width: 1000, height: 700 });
    viewport.offset = { x: 30, y: -40 };
    const anchor = { x: 120, y: 90 };
    const before = viewport.canvasPoint(anchor);
    viewport.setZoom(2.5, anchor);
    const after = viewport.canvasPoint(anchor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  test("coordinate conversions are inverse to each other", () => {
    const viewport = new Viewport();
    viewport.set(1.6, { x: 25, y: -10 });
    const canvas = { x: 140, y: 260 };
    const view = viewport.viewPoint(canvas);
    expect(view).toEqual({ x: 140 * 1.6 + 25, y: 260 * 1.6 - 10 });
    const back = viewport.canvasPoint(view);
    expect(back.x).toBeCloseTo(canvas.x);
    expect(back.y).toBeCloseTo(canvas.y);
    const rect = viewport.viewRect({ x: 10, y: 20, width: 100, height: 50 });
    expect(rect).toEqual({ x: 41, y: 22, width: 160, height: 80 });
    const rectBack = viewport.canvasRect(rect);
    expect(rectBack.x).toBeCloseTo(10);
    expect(rectBack.width).toBeCloseTo(100);
  });

  test("fit(bounds) centers the content and never zooms beyond 100 %", () => {
    const viewport = new Viewport();
    viewport.setViewSize({ width: 1000, height: 800 });
    viewport.fit({ x: 100, y: 100, width: 200, height: 100 });
    expect(viewport.zoom).toBe(1);
    // Content center lands in the view center.
    const center = viewport.viewPoint({ x: 200, y: 150 });
    expect(center).toEqual({ x: 500, y: 400 });
  });

  test("fit(bounds) scales large content down with a margin", () => {
    const viewport = new Viewport();
    viewport.setViewSize({ width: 1000, height: 800 });
    viewport.fit({ x: 0, y: 0, width: 1808, height: 500 });
    // (1000 - 2 * 48) / 1808 = 0.5
    expect(viewport.zoom).toBeCloseTo(0.5);
    expect(viewport.zoomPercent).toBe(50);
    expect(viewport.offset).toEqual({ x: 48, y: 275 });
  });

  test("fit() uses the canvas content bounds, or resets without them", () => {
    const viewport = new Viewport();
    viewport.setViewSize({ width: 800, height: 600 });
    viewport.set(2, { x: 300, y: 300 });
    viewport.fit();
    expect(viewport.zoom).toBe(1);
    expect(viewport.offset).toEqual({ x: 0, y: 0 });

    viewport.contentBoundsProvider = () => ({ x: 0, y: 0, width: 2000, height: 1000 });
    viewport.fit();
    expect(viewport.zoom).toBeCloseTo((800 - 96) / 2000);
  });

  test("fit() without a view size goes back to 100 %", () => {
    const viewport = new Viewport();
    viewport.set(3, { x: 50, y: 50 });
    viewport.fit({ x: 0, y: 0, width: 100, height: 100 });
    expect(viewport.zoom).toBe(1);
    expect(viewport.offset).toEqual({ x: 0, y: 0 });
  });

  test("reset() returns to 100 % and brings the content into view", () => {
    const viewport = new Viewport();
    viewport.setViewSize({ width: 800, height: 600 });
    viewport.contentBoundsProvider = () => ({ x: 100, y: 50, width: 200, height: 100 });
    viewport.set(0.4, { x: -500, y: 900 });
    viewport.reset();
    expect(viewport.zoom).toBe(1);
    // Content that fits is centered.
    expect(viewport.offset).toEqual({ x: 200, y: 200 });

    viewport.contentBoundsProvider = () => ({ x: 100, y: 50, width: 3000, height: 2000 });
    viewport.reset();
    // Content that does not fit is pinned top-left with a 32 px margin.
    expect(viewport.offset).toEqual({ x: -68, y: -18 });
  });

  test("pan moves the offset", () => {
    const viewport = new Viewport();
    viewport.pan({ x: 10, y: -5 });
    viewport.pan({ x: 1, y: 1 });
    expect(viewport.offset).toEqual({ x: 11, y: -4 });
  });

  test("visibleCenter is the canvas point in the middle of the view", () => {
    const viewport = new Viewport();
    expect(viewport.visibleCenter()).toEqual({ x: 400, y: 300 });
    viewport.setViewSize({ width: 1000, height: 600 });
    viewport.set(2, { x: 100, y: 0 });
    expect(viewport.visibleCenter()).toEqual({ x: 200, y: 150 });
  });

  test("notifies subscribers once per actual change", () => {
    const viewport = new Viewport();
    let calls = 0;
    const unsubscribe = viewport.subscribe(() => (calls += 1));
    viewport.zoomIn(); // no view size yet: zooms around (0, 0), the offset stays
    viewport.offset = { x: 0, y: 0 }; // unchanged, no notification
    const afterTwo = calls;
    expect(afterTwo).toBe(1);
    viewport.zoom = viewport.zoom; // no change
    viewport.setViewSize({ width: 0, height: 0 }); // no change
    expect(calls).toBe(afterTwo);
    viewport.set(1, { x: 5, y: 5 });
    expect(calls).toBe(afterTwo + 1);
    unsubscribe();
    viewport.zoomIn();
    expect(calls).toBe(afterTwo + 1);
    expect(viewport.version).toBeGreaterThan(0);
  });
});
