// Export (CanvasExporter.swift): page bounds, standalone SVG markup and the PDF container.
// PNG and PDF rasterization need a browser and are not run here.

import { buildPDF, diagramSVG, effectiveScale, exportMargin, exportPage } from "../../src/canvas/export";
import { darkPalette } from "../../src/canvas/palette";
import { approximateMeasurer, setTextMeasurer } from "../../src/canvas/text";
import { emptyProject } from "../../src/core/project";
import { addSwitch, makeStore, port } from "./support";

beforeAll(() => setTextMeasurer(approximateMeasurer));

function project() {
  const store = makeStore();
  const sw1 = addSwitch(store, "SW1", { x: 400, y: 300 });
  const sw2 = addSwitch(store, "SW2", { x: 400, y: 600 });
  const link = store.connect(port(sw1, "Fa0/2"), port(sw2, "Fa0/1"));
  store.selection = [{ kind: "link", id: link.id }];
  store.addAnnotation("Poznámka <a & b>", { x: 700, y: 100 });
  return store.project;
}

describe("export page", () => {
  test("content plus a 36 pt margin, on whole points", () => {
    const page = exportPage(project(), "physical");
    const content = page.scene.contentBounds!;
    expect(page.isEmpty).toBe(false);
    expect(page.bounds.x).toBe(Math.floor(content.x - exportMargin));
    expect(page.bounds.y).toBe(Math.floor(content.y - exportMargin));
    expect(page.bounds.x + page.bounds.width).toBe(Math.ceil(content.x + content.width + exportMargin));
  });

  test("an empty project gets a placeholder page", () => {
    const page = exportPage(emptyProject(), "physical");
    expect(page.isEmpty).toBe(true);
    expect(page.bounds).toEqual({ x: 0, y: 0, width: 480, height: 300 });
    expect(diagramSVG(emptyProject(), "physical")).toContain("Prázdný projekt");
  });

  test("bitmaps stay under 16000 px per side", () => {
    expect(effectiveScale({ x: 0, y: 0, width: 1000, height: 500 }, 2)).toBe(2);
    expect(effectiveScale({ x: 0, y: 0, width: 10000, height: 500 }, 2)).toBeCloseTo(1.6);
  });
});

describe("SVG", () => {
  const source = project();
  const svg = diagramSVG(source, "physical");

  test("is a standalone document sized like the page", () => {
    const page = exportPage(source, "physical");
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain(`width="${page.bounds.width}"`);
    expect(svg).toContain(`viewBox="0 0 ${page.bounds.width} ${page.bounds.height}"`);
    expect(svg).toContain(`translate(${-page.bounds.x} ${-page.bounds.y})`);
    // Light canvas background.
    expect(svg).toContain('fill="#f4f1ea"');
  });

  test("carries names, port labels, cable labels and escaped note text", () => {
    expect(svg).toContain(">SW1</text>");
    expect(svg).toContain(">Test S24</text>");
    expect(svg).toContain(">Fa0/2</text>");
    expect(svg).toContain("Poznámka &lt;a &amp; b&gt;");
  });

  test("has no selection, hover or empty status rings", () => {
    // The selection halo is drawn in the accent color with opacity 0.38.
    expect(svg).not.toContain('stroke-opacity="0.38"');
    // Status "none" rings are an editing affordance only.
    expect(svg).not.toContain('stroke="#5c6b7a" stroke-opacity="0.55"');
  });

  test("can be rendered with another palette and at a pixel scale", () => {
    const dark = diagramSVG(source, "logical", { palette: darkPalette, pixelScale: 2 });
    const page = exportPage(source, "logical");
    expect(dark).toContain('fill="#081b33"');
    expect(dark).toContain(`width="${page.bounds.width * 2}"`);
    expect(dark).toContain(`viewBox="0 0 ${page.bounds.width} ${page.bounds.height}"`);
  });
});

describe("PDF container", () => {
  test("one page with the image, a valid cross-reference table and a UTF-16 title", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const bytes = buildPDF({ width: 2, height: 1, data, filter: "FlateDecode" }, 100.5, 50, "Cvičení");
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text).toContain("/MediaBox [0 0 100.5 50]");
    expect(text).toContain("/Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length 6");
    expect(text).toContain("q 100.5 0 0 50 0 0 cm /Im0 Do Q");
    expect(text).toContain("/Title <FEFF004300760069010D0065006E00ED>");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);

    // Every xref entry points at "<n> 0 obj".
    const startxref = Number(/startxref\n(\d+)\n/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const entries = text.slice(startxref).split("\n").slice(3, 9);
    entries.forEach((entry, index) => {
      const offset = Number(entry.slice(0, 10));
      expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`);
    });
  });
});
