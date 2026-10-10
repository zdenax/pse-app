// Small SVG building blocks shared by the diagram layers: text, device icon, warning glyph.

import { memo } from "react";
import type { DeviceCategory } from "../../core/model";
import { deviceIconArt } from "../../ui/DeviceIcon";
import type { Point, Rect } from "../geom";
import { fillOf, strokeOf, tileColor, type Palette, type RGBA } from "../palette";
import { fontWeightValue, textAnchor, textPlacement, type HAlign, type TextStyle, type VAlign } from "../text";
import { n, warningShapes } from "./svg";

const tabularDigits = { fontVariantNumeric: "tabular-nums" } as const;

/** One line of text positioned like TextRenderer.draw (`at` interpreted by the alignments). */
export function SvgText({
  text,
  style,
  at,
  h = "leading",
  v = "top",
  color,
  opacity = 1,
  preserveSpaces = false,
}: {
  text: string;
  style: TextStyle;
  at: Point;
  h?: HAlign;
  v?: VAlign;
  color: RGBA;
  opacity?: number;
  preserveSpaces?: boolean;
}) {
  if (text === "") return null;
  const anchor = textAnchor(h);
  return (
    <text
      x={n(at.x)}
      y={n(textPlacement(at, style, v).y)}
      fontSize={style.size}
      fontWeight={fontWeightValue(style.weight)}
      textAnchor={anchor === "start" ? undefined : anchor}
      style={style.monospacedDigits ? tabularDigits : undefined}
      xmlSpace={preserveSpaces ? "preserve" : undefined}
      {...fillOf(color, opacity)}
    >
      {text}
    </text>
  );
}

/** The device icon: a colored tile with a white glyph (DeviceIconArt.draw). */
export const DeviceIconSVG = memo(function DeviceIconSVG({
  category,
  rect,
  palette,
  opacity = 1,
}: {
  category: DeviceCategory;
  rect: Rect;
  palette: Palette;
  opacity?: number;
}) {
  const art = deviceIconArt(category);
  // The art is described in a 100x100 box.
  const scale = rect.width / 100;
  const tileStroke = Math.max(rect.width * 0.02, 0.5) / scale;
  const tilePaint = { ...fillOf(tileColor(category, palette)), ...strokeOf(palette.tileStroke), strokeWidth: n(tileStroke) };
  return (
    <g
      transform={`translate(${n(rect.x)} ${n(rect.y)}) scale(${n(scale * 1000) / 1000})`}
      opacity={opacity < 1 ? opacity : undefined}
    >
      {art.tile === "circle" ? (
        <circle cx={50} cy={50} r={50} {...tilePaint} />
      ) : (
        <rect x={0} y={0} width={100} height={100} rx={100 * art.cornerRadius} {...tilePaint} />
      )}
      {art.layers.map((layer, index) =>
        layer.paint === "fill" ? (
          <path key={index} d={layer.d} {...fillOf(palette.iconGlyph)} />
        ) : (
          <path
            key={index}
            d={layer.d}
            fill="none"
            {...strokeOf(palette.iconGlyph)}
            strokeWidth={layer.width}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ),
      )}
    </g>
  );
});

/** The "verify against hardware" marker: a rounded triangle with an exclamation mark. */
export function WarningGlyph({ rect, color }: { rect: Rect; color: RGBA }) {
  const shapes = warningShapes(rect);
  return (
    <g>
      <path
        d={shapes.outline + shapes.stem}
        fill="none"
        {...strokeOf(color)}
        strokeWidth={n(shapes.lineWidth)}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={n(shapes.dot.x + shapes.dot.width / 2)}
        cy={n(shapes.dot.y + shapes.dot.height / 2)}
        r={n(shapes.dot.width / 2)}
        {...fillOf(color)}
      />
    </g>
  );
}
