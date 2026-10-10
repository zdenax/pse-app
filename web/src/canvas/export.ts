// Export of the WHOLE diagram (bounding box of all content plus a margin, not just the visible
// part of the canvas) on the light background, without selection or hover decorations
// (port of CanvasExporter.swift).
//
//   SVG: the same React drawing as the live canvas, serialized (fully vector, texts as text).
//   PNG: the SVG rasterized by the browser at 2x.
//   PDF: one page exactly as large as the diagram (1 canvas point = 1 pt). Without a PDF library
//        the page carries the diagram as a lossless 2x raster image (Flate), or as JPEG where the
//        browser lacks CompressionStream. Not vector, unlike the Mac app.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Project, ViewMode } from "../core/model";
import { inset, integral, type Rect } from "./geom";
import { hexString, lightPalette, type Palette } from "./palette";
import { DiagramLayers, exportOptions } from "./render/DiagramLayers";
import { SvgText } from "./render/primitives";
import { n } from "./render/svg";
import { DiagramScene } from "./scene";
import { CanvasStrings } from "./strings";
import { TextStyles, canvasFontFamily, installBrowserMeasurer } from "./text";

/** Free space around the content, in points. */
export const exportMargin = 36;
/** Page used for a project without any content. */
export const emptyPageSize = { width: 480, height: 300 } as const;
/** Upper bound for either side of an exported bitmap, in pixels. */
export const maxPixelSide = 16000;

/** The laid out diagram and the canvas rectangle that ends up on the page. */
export interface ExportPage {
  scene: DiagramScene;
  bounds: Rect;
  isEmpty: boolean;
}

export function exportPage(project: Project, mode: ViewMode): ExportPage {
  installBrowserMeasurer();
  const scene = new DiagramScene(project, mode);
  const content = scene.contentBounds;
  if (content && Number.isFinite(content.width) && Number.isFinite(content.height)) {
    return { scene, bounds: integral(inset(content, -exportMargin, -exportMargin)), isEmpty: false };
  }
  return { scene, bounds: { x: 0, y: 0, ...emptyPageSize }, isEmpty: true };
}

/**
 * The page as standalone SVG markup. `pixelScale` sets the width/height attributes (the viewBox
 * stays in points), so a rasterizer draws the vectors at the final resolution.
 */
export function diagramSVG(
  project: Project,
  mode: ViewMode,
  options: { palette?: Palette; pixelScale?: number; page?: ExportPage } = {},
): string {
  const palette = options.palette ?? lightPalette;
  const page = options.page ?? exportPage(project, mode);
  const scale = options.pixelScale ?? 1;
  const { width, height } = page.bounds;
  const content = page.isEmpty
    ? createElement(SvgText, {
        text: CanvasStrings.emptyProject,
        style: TextStyles.placeholder,
        at: { x: width / 2, y: height / 2 },
        h: "center",
        v: "center",
        color: palette.secondaryInk,
      })
    : createElement(
        "g",
        { transform: `translate(${n(-page.bounds.x)} ${n(-page.bounds.y)})` },
        createElement(DiagramLayers, { scene: page.scene, options: exportOptions(palette) }),
      );
  const titleText = project.name.trim();
  const svg = createElement(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      version: "1.1",
      width: n(width * scale),
      height: n(height * scale),
      viewBox: `0 0 ${width} ${height}`,
      fontFamily: canvasFontFamily,
    },
    titleText === "" ? null : createElement("title", null, titleText),
    createElement("rect", { x: 0, y: 0, width, height, fill: hexString(palette.canvas) }),
    content,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n${renderToStaticMarkup(svg)}\n`;
}

/** Pixel scale actually used for a page (keeps both sides under `maxPixelSide`). */
export function effectiveScale(bounds: Rect, requested: number): number {
  let scale = Number.isFinite(requested) ? Math.min(Math.max(requested, 0.25), 8) : 1;
  const longest = Math.max(bounds.width, bounds.height);
  if (longest * scale > maxPixelSide) scale = maxPixelSide / longest;
  return scale;
}

/** Draws the page into a canvas element at `scale` pixels per point (browser only). */
async function rasterize(project: Project, mode: ViewMode, requestedScale: number): Promise<{
  canvas: HTMLCanvasElement;
  page: ExportPage;
} | null> {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;
  const page = exportPage(project, mode);
  const scale = effectiveScale(page.bounds, requestedScale);
  const pixelWidth = Math.max(Math.ceil(page.bounds.width * scale), 1);
  const pixelHeight = Math.max(Math.ceil(page.bounds.height * scale), 1);
  const markup = diagramSVG(project, mode, { page, pixelScale: pixelWidth / page.bounds.width });
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Obrázek diagramu se nepodařilo vykreslit."));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = hexString(lightPalette.canvas);
    context.fillRect(0, 0, pixelWidth, pixelHeight);
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, pixelWidth, pixelHeight);
    return { canvas, page };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality));
}

/** PNG of the whole diagram; `scale` is the number of pixels per canvas point (2 = "Retina"). */
export async function diagramPNG(project: Project, mode: ViewMode, scale = 2): Promise<Blob | null> {
  const result = await rasterize(project, mode, scale);
  return result ? canvasBlob(result.canvas, "image/png") : null;
}

/** The SVG file of the whole diagram. */
export function diagramSVGBlob(project: Project, mode: ViewMode): Blob {
  return new Blob([diagramSVG(project, mode)], { type: "image/svg+xml;charset=utf-8" });
}

/** Single-page PDF of the whole diagram (raster image, see the file comment). */
export async function diagramPDF(project: Project, mode: ViewMode, scale = 2): Promise<Blob | null> {
  const result = await rasterize(project, mode, scale);
  if (!result) return null;
  const { canvas, page } = result;
  const context = canvas.getContext("2d");
  if (!context) return null;
  let image: PDFImage | null = null;
  if (typeof CompressionStream === "function") {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const rgb = new Uint8Array(canvas.width * canvas.height * 3);
    for (let source = 0, target = 0; source < pixels.length; source += 4, target += 3) {
      rgb[target] = pixels[source];
      rgb[target + 1] = pixels[source + 1];
      rgb[target + 2] = pixels[source + 2];
    }
    const compressed = await deflate(rgb);
    if (compressed) image = { width: canvas.width, height: canvas.height, data: compressed, filter: "FlateDecode" };
  }
  if (!image) {
    const jpeg = await canvasBlob(canvas, "image/jpeg", 0.95);
    if (!jpeg) return null;
    image = {
      width: canvas.width,
      height: canvas.height,
      data: new Uint8Array(await jpeg.arrayBuffer()),
      filter: "DCTDecode",
    };
  }
  const bytes = buildPDF(image, page.bounds.width, page.bounds.height, project.name.trim());
  return new Blob([bytes], { type: "application/pdf" });
}

async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    // "deflate" is the zlib format, exactly what the PDF FlateDecode filter expects.
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

// MARK: Minimal PDF writer

export interface PDFImage {
  width: number;
  height: number;
  /** Encoded image samples (8-bit RGB). */
  data: Uint8Array;
  filter: "FlateDecode" | "DCTDecode";
}

/** A PDF text string: UTF-16BE with a byte order mark, as a hex string. */
function pdfTextString(text: string): string {
  let hex = "FEFF";
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return `<${hex}>`;
}

/** A one-page PDF whose page (`width` x `height` points) is filled by `image`. */
export function buildPDF(image: PDFImage, width: number, height: number, title = ""): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (number: number, body: string) => {
    offsets[number] = length;
    push(`${number} 0 obj\n${body}\nendobj\n`);
  };
  const w = n(width);
  const h = n(height);

  push("%PDF-1.4\n");
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
  );
  offsets[4] = length;
  push(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${image.filter} /Length ${image.data.length} >>\nstream\n`,
  );
  push(image.data);
  push("\nendstream\nendobj\n");
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  object(5, `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`);
  object(6, `<< /Producer (NetSketch) /Creator (NetSketch)${title === "" ? "" : ` /Title ${pdfTextString(title)}`} >>`);

  const xref = length;
  let table = "xref\n0 7\n0000000000 65535 f \n";
  for (let i = 1; i <= 6; i++) table += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const result = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) {
    result.set(chunk, position);
    position += chunk.length;
  }
  return result;
}
