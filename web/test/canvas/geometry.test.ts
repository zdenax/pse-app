// Panel and node geometry (PanelGeometry.swift). The expected numbers are derived by hand from
// the Swift code: cell 17, padding 8 x 5, label strip 10, block gap 0.25 cell, jack 0.76 cell.

import { clipInterval, distanceToSegment, exitParameter, roundHalfAway } from "../../src/canvas/geom";
import { NodeGeometry, PanelGeometry, PanelMetrics } from "../../src/canvas/panel-geometry";
import { TextStyles, approximateMeasurer, setTextMeasurer, textWidth, truncated } from "../../src/canvas/text";
import { makeDevice } from "../../src/core/template";
import { pc, switch24 } from "./support";

beforeAll(() => setTextMeasurer(approximateMeasurer));

describe("segment helpers", () => {
  test("distance to a segment clamps to the ends", () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(distanceToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });

  test("exit parameter of a segment leaving a rect", () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(exitParameter({ x: 5, y: 5 }, { x: 25, y: 5 }, rect)).toBeCloseTo(0.25);
    expect(exitParameter({ x: 5, y: 5 }, { x: 5, y: -15 }, rect)).toBeCloseTo(0.25);
    // Starts outside: 0; never leaves: 1.
    expect(exitParameter({ x: 20, y: 5 }, { x: 25, y: 5 }, rect)).toBe(0);
    expect(exitParameter({ x: 2, y: 2 }, { x: 8, y: 8 }, rect)).toBe(1);
  });

  test("clip interval (Liang-Barsky)", () => {
    const rect = { x: 10, y: -5, width: 10, height: 10 };
    const interval = clipInterval({ x: 0, y: 0 }, { x: 40, y: 0 }, rect);
    expect(interval?.[0]).toBeCloseTo(0.25);
    expect(interval?.[1]).toBeCloseTo(0.5);
    expect(clipInterval({ x: 0, y: 20 }, { x: 40, y: 20 }, rect)).toBeNull();
  });

  test("rounding halves away from zero like Swift", () => {
    expect(roundHalfAway(2.5)).toBe(3);
    expect(roundHalfAway(-2.5)).toBe(-3);
    expect(roundHalfAway(-2.4)).toBe(-2);
  });
});

describe("PanelGeometry", () => {
  const device = makeDevice(switch24, "SW1", { x: 400, y: 300 });
  const panel = PanelGeometry.of(device);

  test("frame of a dense 24-port panel", () => {
    // 12 columns of 17 + one block gap of 0.25 * 17 = 208.25; plus 2 * 8 padding.
    // Height: 5 + 10 (top labels) + 2 * 17 + 10 (bottom labels) + 5 = 64.
    expect(panel.isRoomy).toBe(false);
    expect(panel.frame).toEqual({ x: 288, y: 268, width: 224.25, height: 64 });
    expect(panel.ports).toHaveLength(24);
    expect(panel.captions).toEqual([]);
  });

  test("odd ports on top, even below, block gap after six columns", () => {
    const first = panel.ports[0];
    expect(first.cell).toEqual({ x: 296, y: 283, width: 17, height: 17 });
    expect(first.center).toEqual({ x: 304.5, y: 291.5 });
    expect(first.rect.width).toBeCloseTo(12.92);
    expect(first.labelPlacement).toBe("above");
    expect(first.labelCenter).toEqual({ x: 304.5, y: 278 });
    // The full name does not fit a 17 pt column: only the number is printed.
    expect(first.label).toBe("1");

    const second = panel.ports[1];
    expect(second.cell.y).toBe(300);
    expect(second.labelPlacement).toBe("below");
    expect(second.labelCenter.y).toBe(322);

    expect(panel.ports[12].cell.x).toBe(402.25);
    const last = panel.ports[23];
    expect(last.cell.x + last.cell.width).toBe(panel.frame.x + 8 + 208.25);
    expect(last.label).toBe("24");
  });

  test("port lookup by id and by point", () => {
    const third = panel.ports[2];
    expect(panel.port(third.portID)).toBe(third);
    expect(panel.portAt({ x: third.cell.x + 1, y: third.cell.y + 1 })).toBe(third);
    // Between the rows and the frame edge there is no port.
    expect(panel.portAt({ x: panel.frame.x + 2, y: panel.frame.y + 2 })).toBeUndefined();
    expect(panel.portAt({ x: 0, y: 0 })).toBeUndefined();
  });

  test("a sparse panel gets roomy cells with full names", () => {
    const small = PanelGeometry.of(makeDevice(pc, "PC1", { x: 0, y: 0 }));
    expect(small.isRoomy).toBe(true);
    expect(small.ports[0].label).toBe("eth0");
    expect(small.ports[0].labelPlacement).toBe("below");
    // One row: 5 + 17 + 10 + 5; the plate is never narrower than 84.
    expect(small.frame.height).toBe(37);
    expect(small.frame.width).toBe(84);
  });

  test("printed label falls back to the number or an abbreviation", () => {
    const style = PanelMetrics.standard.labelStyle;
    expect(PanelGeometry.printedLabel("Gi1/0/24", 12, style)).toBe("24");
    expect(PanelGeometry.printedLabel("Console", 17, style)).toBe("Con");
    expect(PanelGeometry.printedLabel("eth0", 100, style)).toBe("eth0");
    expect(PanelGeometry.printedLabel("Gi1/0/12345", 4, style)).toBe("");
  });

  test("metrics scale with the cell", () => {
    const big = PanelGeometry.of(makeDevice(switch24, "SW1", { x: 0, y: 0 }), new PanelMetrics(34));
    expect(big.frame.height).toBe(128);
    expect(big.frame.width).toBeCloseTo(448.5);
  });
});

describe("NodeGeometry", () => {
  const device = makeDevice(switch24, "SW1", { x: 400, y: 300 });

  test("physical node: header above the panel", () => {
    const node = new NodeGeometry(device, "physical");
    expect(node.iconRect).toEqual({ x: 288, y: 231, width: 30, height: 30 });
    expect(node.hostnameRect.x).toBe(326);
    expect(node.hostnameRect.y).toBe(230);
    // ceil(13 pt * 1.193) = 16.
    expect(node.hostnameRect.height).toBe(16);
    expect(node.typeRect.y).toBe(246);
    expect(node.warningRect).not.toBeNull();
    expect(node.warningRect!.x).toBe(node.hostnameRect.x + node.hostnameRect.width + 6);
    expect(node.bodyRect).toBe(node.panel!.frame);
    expect(node.bounds.y).toBe(230);
    expect(node.bounds.y + node.bounds.height).toBe(332);
    expect(node.labelPlateRect.x).toBe(322);
  });

  test("logical node: icon centered on the position, texts below", () => {
    const node = new NodeGeometry(device, "logical");
    expect(node.panel).toBeNull();
    expect(node.iconRect).toEqual({ x: 377, y: 277, width: 46, height: 46 });
    expect(node.hostnameRect.y).toBe(328);
    expect(node.hostnameRect.x + node.hostnameRect.width / 2).toBe(400);
    expect(node.bodyRect).toBe(node.iconRect);
    expect(node.centeredLabels).toBe(true);
    expect(node.hostnameEditRect.width).toBe(120);
  });

  test("a verified device has no warning glyph", () => {
    const verified = { ...device, verified: true, ports: device.ports.map((p) => ({ ...p, verified: true })) };
    expect(new NodeGeometry(verified, "physical").warningRect).toBeNull();
  });
});

describe("text", () => {
  test("truncation adds an ellipsis", () => {
    const style = TextStyles.portLabel;
    const fitted = truncated("Management port", style, 30);
    expect(fitted.endsWith("…")).toBe(true);
    expect(textWidth(fitted, style)).toBeLessThanOrEqual(30);
    expect(truncated("ok", style, 30)).toBe("ok");
  });
});
