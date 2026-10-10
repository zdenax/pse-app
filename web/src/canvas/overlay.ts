// Layout of the view-space overlays: the hover tag and the inline text editor
// (drawTooltip / beginEditing of CanvasNSView.swift). Pure functions of scene, viewport and text.

import { center, inset, midX, rectAround, roundHalfAway, type Point, type Rect, type Size } from "./geom";
import type { CanvasViewportLike, EditTarget } from "./input";
import { annotationPadding, type CanvasHit, type DiagramScene } from "./scene";
import { CanvasStrings } from "./strings";
import { TextStyles, lineHeight, textWidth, type TextStyle } from "./text";

export interface TooltipLine {
  text: string;
  style: TextStyle;
  /** Leading edge and vertical center, view coordinates. */
  x: number;
  y: number;
  /** Opacity of the ink. */
  opacity: number;
}

export interface TooltipLayout {
  plate: Rect;
  lines: TooltipLine[];
}

const tooltipLineHeight = 15;
const tooltipPadding = { width: 9, height: 6 };

/**
 * Ports get the tag right above the jack; everything else next to the pointer. The plate is kept
 * inside the view.
 */
export function tooltipLayout(
  lines: string[],
  hit: CanvasHit,
  scene: DiagramScene,
  viewport: CanvasViewportLike,
  pointer: Point,
  viewSize: Size,
): TooltipLayout | null {
  if (lines.length === 0) return null;
  const styleOf = (index: number) => (index === 0 ? TextStyles.tooltipTitle : TextStyles.tooltipBody);
  const width = lines.reduce((widest, line, index) => Math.max(widest, textWidth(line, styleOf(index))), 0);
  const size: Size = {
    width: Math.ceil(width) + 2 * tooltipPadding.width,
    height: lines.length * tooltipLineHeight + 2 * tooltipPadding.height,
  };

  let origin: Point;
  const port = hit.kind === "port" ? scene.portGeometry(hit.ref) : undefined;
  if (port) {
    const cell = viewport.viewRect(port.cell);
    origin = { x: midX(cell) - size.width / 2, y: cell.y - size.height - 8 };
    if (origin.y < 4) origin.y = cell.y + cell.height + 8;
  } else {
    origin = { x: pointer.x + 14, y: pointer.y + 18 };
    if (origin.y + size.height > viewSize.height - 4) origin.y = pointer.y - size.height - 10;
  }
  origin.x = Math.min(Math.max(origin.x, 4), Math.max(viewSize.width - size.width - 4, 4));
  origin.y = Math.min(Math.max(origin.y, 4), Math.max(viewSize.height - size.height - 4, 4));
  const plate: Rect = { x: roundHalfAway(origin.x), y: roundHalfAway(origin.y), width: size.width, height: size.height };

  return {
    plate,
    lines: lines.map((text, index) => {
      const isWarning = text === CanvasStrings.verifyAgainstHardware && lines.length > 1;
      return {
        text,
        style: styleOf(index),
        x: plate.x + tooltipPadding.width,
        y: plate.y + tooltipPadding.height + (index + 0.5) * tooltipLineHeight,
        opacity: index === 0 || isWarning ? 1 : 0.82,
      };
    }),
  };
}

export interface EditorLayout {
  /** Frame of the text field in view coordinates. */
  frame: Rect;
  fontSize: number;
  style: TextStyle;
  align: "left" | "center";
}

/** Frame and font of the inline editor for a target; null when the target no longer exists. */
export function editorLayout(
  target: EditTarget,
  text: string,
  scene: DiagramScene,
  viewport: CanvasViewportLike,
  viewSize: Size,
): EditorLayout | null {
  let canvasRect: Rect;
  let style: TextStyle = TextStyles.annotation;
  let align: "left" | "center" = "left";
  switch (target.kind) {
    case "hostname": {
      const node = scene.node(target.id);
      if (!node) return null;
      canvasRect = node.hostnameEditRect;
      style = TextStyles.hostname;
      align = node.centeredLabels ? "center" : "left";
      break;
    }
    case "annotation": {
      const note = scene.annotations.find((annotation) => annotation.id === target.id);
      if (!note) return null;
      canvasRect = inset(note.frame, -2, -2);
      canvasRect = { ...canvasRect, width: Math.max(canvasRect.width + 40, 200) };
      break;
    }
    case "newAnnotation":
      canvasRect = {
        x: target.point.x - annotationPadding.x,
        y: target.point.y - annotationPadding.y,
        width: 220,
        height: lineHeight(TextStyles.annotation) + 2 * annotationPadding.y,
      };
      break;
    case "bundleLabel": {
      const bundle = scene.bundles.find((candidate) => candidate.id === target.id);
      if (!bundle) return null;
      canvasRect = inset(bundle.labelRect, -24, -3);
      style = TextStyles.bundle;
      align = "center";
      break;
    }
  }

  const fontSize = Math.min(Math.max(style.size * viewport.clampedZoom, 11), 32);
  const frame = { ...viewport.viewRect(canvasRect) };
  const lineCount = Math.max(text.split("\n").length, 1);
  frame.width = Math.max(frame.width, 150);
  frame.height = Math.max(frame.height, lineCount * Math.ceil(fontSize * 1.28) + 8);
  if (align === "center") {
    // Keep the field centered on what it edits.
    frame.x = viewport.viewPoint(center(canvasRect)).x - frame.width / 2;
  }
  frame.x = Math.min(Math.max(frame.x, 4), Math.max(viewSize.width - frame.width - 4, 4));
  frame.y = Math.min(Math.max(frame.y, 4), Math.max(viewSize.height - frame.height - 4, 4));
  return {
    frame: rectAround(center(frame), { width: Math.round(frame.width), height: Math.round(frame.height) }),
    fontSize,
    style,
    align,
  };
}
