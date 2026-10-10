// Text measuring for the canvas (port of TextDrawing.swift). Geometry needs text widths before
// anything is drawn; in the browser they come from a 2D canvas context set to the same font the
// SVG uses, elsewhere (tests, server rendering) from an approximate width table. Vertical metrics
// follow the system font (SF Pro) the Mac app measures with, so layouts match the native app.

export type FontWeight = "regular" | "medium" | "semibold" | "bold";

export interface TextStyle {
  size: number;
  weight: FontWeight;
  /** Tabular digits keep port numbers aligned and evenly sized. */
  monospacedDigits?: boolean;
}

export const TextStyles = {
  hostname: { size: 13, weight: "semibold" },
  deviceType: { size: 10.5, weight: "regular" },
  portLabel: { size: 8, weight: "medium", monospacedDigits: true },
  cableEnd: { size: 9, weight: "medium", monospacedDigits: true },
  bundle: { size: 10, weight: "semibold" },
  annotation: { size: 12.5, weight: "regular" },
  tooltip: { size: 11, weight: "medium" },
  tooltipTitle: { size: 11.5, weight: "semibold" },
  tooltipBody: { size: 11, weight: "regular" },
  placeholder: { size: 13, weight: "medium" },
} as const satisfies Record<string, TextStyle>;

/** The font stack of the SVG text; the same as the UI font (styles.css --font-ui). */
export const canvasFontFamily =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, "Noto Sans", "Liberation Sans", sans-serif';

/** Ascender and descender of the system font, relative to the font size (SF Pro: 1950 / 494 of 2048). */
const ascentFactor = 0.952;
const descentFactor = 0.241;

export function fontWeightValue(weight: FontWeight): number {
  switch (weight) {
    case "regular":
      return 400;
    case "medium":
      return 500;
    case "semibold":
      return 600;
    case "bold":
      return 700;
  }
}

/** A CSS `font` shorthand for the style. */
export function cssFont(style: TextStyle): string {
  return `${fontWeightValue(style.weight)} ${style.size}px ${canvasFontFamily}`;
}

export interface TextMetrics {
  width: number;
  ascent: number;
  descent: number;
  height: number;
}

/** Measures the advance width of one line of text. */
export interface TextMeasurer {
  width(text: string, style: TextStyle): number;
}

// MARK: Approximate measurer

/** Advance widths (1/1000 em) of printable ASCII in a Helvetica-like sans serif, from U+0020. */
const asciiWidths = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // space .. /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0 .. ?
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @ .. O
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P .. _
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // ` .. o
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // p .. ~
];

const weightFactor: Record<FontWeight, number> = { regular: 1, medium: 1.03, semibold: 1.06, bold: 1.09 };

function approximateCharWidth(char: string): number {
  const code = char.charCodeAt(0);
  if (code >= 0x20 && code <= 0x7e) return asciiWidths[code - 0x20];
  // Letters with diacritics measure like their base letter.
  const base = char.normalize("NFD").charAt(0);
  const baseCode = base.charCodeAt(0);
  if (base !== char && baseCode >= 0x20 && baseCode <= 0x7e) return asciiWidths[baseCode - 0x20];
  if (char === "…") return 1000;
  if (char === "–") return 556;
  if (char === "—") return 1000;
  if (char === "·") return 278;
  return 600;
}

/** Deterministic widths without a font engine (tests, server rendering, fallback). */
export const approximateMeasurer: TextMeasurer = {
  width(text: string, style: TextStyle): number {
    let total = 0;
    for (const char of text) {
      const isDigit = char >= "0" && char <= "9";
      total += isDigit && style.monospacedDigits ? 556 : approximateCharWidth(char);
    }
    return (total / 1000) * style.size * weightFactor[style.weight];
  },
};

// MARK: Browser measurer

/** Measures with a 2D canvas context (the browser's real font engine). Null outside a browser. */
export function createBrowserMeasurer(): TextMeasurer | null {
  if (typeof document === "undefined") return null;
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = document.createElement("canvas").getContext("2d");
  } catch {
    context = null;
  }
  if (!context) return null;
  const ctx = context;
  let currentFont = "";
  return {
    width(text: string, style: TextStyle): number {
      const font = cssFont(style);
      if (font !== currentFont) {
        ctx.font = font;
        currentFont = font;
      }
      const measured = ctx.measureText(text).width;
      return Number.isFinite(measured) ? measured : approximateMeasurer.width(text, style);
    },
  };
}

// MARK: Shared renderer

let measurer: TextMeasurer = approximateMeasurer;
let measurerGeneration = 0;
const cache = new Map<string, number>();
const cacheLimit = 6000;

/** Replaces the measurer (the canvas installs the browser one at start-up). Clears the cache. */
export function setTextMeasurer(next: TextMeasurer): void {
  measurer = next;
  measurerGeneration += 1;
  cache.clear();
}

/** Changes whenever the measurer is replaced; geometry caches key on it. */
export function textMeasurerGeneration(): number {
  return measurerGeneration;
}

let browserMeasurerInstalled = false;

/** Installs the browser measurer once, when running in a browser. */
export function installBrowserMeasurer(): void {
  if (browserMeasurerInstalled) return;
  browserMeasurerInstalled = true;
  const browser = createBrowserMeasurer();
  if (browser) setTextMeasurer(browser);
}

function styleKey(style: TextStyle): string {
  return `${style.size}|${style.weight}|${style.monospacedDigits ? 1 : 0}`;
}

export function textWidth(text: string, style: TextStyle): number {
  const key = `${styleKey(style)}|${text}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  if (cache.size >= cacheLimit) cache.clear();
  const width = measurer.width(text, style);
  cache.set(key, width);
  return width;
}

export function textMetrics(text: string, style: TextStyle): TextMetrics {
  const ascent = ascentFactor * style.size;
  const descent = descentFactor * style.size;
  return { width: textWidth(text, style), ascent, descent, height: ascent + descent };
}

export function textSize(text: string, style: TextStyle): { width: number; height: number } {
  const m = textMetrics(text, style);
  return { width: m.width, height: m.height };
}

/** Line height used for multi-line blocks (NSFont ascender - descender + leading, rounded up, + 1). */
export function lineHeight(style: TextStyle): number {
  return Math.ceil((ascentFactor + descentFactor) * style.size) + 1;
}

/** Splits text into display lines (hard line breaks only). */
export function textLines(text: string): string[] {
  return text.split("\n");
}

/** Size of a multi-line block. */
export function blockSize(text: string, style: TextStyle): { width: number; height: number } {
  const parts = textLines(text);
  const width = parts.reduce((widest, part) => Math.max(widest, textWidth(part, style)), 0);
  return { width: Math.ceil(width), height: lineHeight(style) * Math.max(parts.length, 1) };
}

/** Shortens `text` with an ellipsis so that it fits `maxWidth`. */
export function truncated(text: string, style: TextStyle, maxWidth: number): string {
  if (textWidth(text, style) <= maxWidth) return text;
  const characters = Array.from(text);
  while (characters.length > 1) {
    characters.pop();
    const candidate = characters.join("") + "…";
    if (textWidth(candidate, style) <= maxWidth) return candidate;
  }
  return "…";
}

export type HAlign = "leading" | "center" | "trailing";
export type VAlign = "top" | "center" | "bottom" | "baseline";

/**
 * Where to put an SVG <text> so that `point` is interpreted like TextRenderer.draw does:
 * returns the x of the anchor (with the matching text-anchor) and the y of the baseline.
 */
export function textPlacement(
  point: { x: number; y: number },
  style: TextStyle,
  v: VAlign,
): { y: number } {
  const ascent = ascentFactor * style.size;
  const descent = descentFactor * style.size;
  switch (v) {
    case "top":
      return { y: point.y + ascent };
    case "center":
      return { y: point.y + (ascent - descent) / 2 };
    case "bottom":
      return { y: point.y - descent };
    case "baseline":
      return { y: point.y };
  }
}

export function textAnchor(h: HAlign): "start" | "middle" | "end" {
  return h === "leading" ? "start" : h === "center" ? "middle" : "end";
}
