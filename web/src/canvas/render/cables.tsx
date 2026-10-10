// Cables, their decorations (status dots, port names), bundles and annotations
// (port of the cable / bundle / annotation parts of DiagramRenderer.swift).

import { memo } from "react";
import type { ViewMode } from "../../core/model";
import { inset, rectAround, type Point } from "../geom";
import {
  bundleRailSpacing,
  bundleRailWidthFactor,
  cableStyle,
  fillOf,
  statusColor,
  strokeOf,
  type CableStyle,
  type Palette,
} from "../palette";
import {
  dotRadius,
  linkDot,
  linkEndStatus,
  linkLength,
  type AnnotationGeometry,
  type BundleGeometry,
  type LinkGeometry,
} from "../scene";
import { TextStyles, lineHeight, textLines } from "../text";
import { SvgText } from "./primitives";
import { lineD, n, polylineD, roundedRectD } from "./svg";

function strokeStyle(style: CableStyle, widthFactor = 1) {
  return {
    fill: "none",
    ...strokeOf(style.color),
    strokeWidth: n(style.width * widthFactor),
    strokeLinecap: style.cap,
    strokeLinejoin: "round" as const,
    strokeDasharray: style.dash.length > 0 ? style.dash.join(" ") : undefined,
  };
}

function hasAny(ids: string[], set: ReadonlySet<string>): boolean {
  if (set.size === 0) return false;
  return ids.some((id) => set.has(id));
}

/** One cable with its optional halo and plugs. */
const Cable = memo(function Cable({
  link,
  physical,
  palette,
  selected,
  hovered,
}: {
  link: LinkGeometry;
  physical: boolean;
  palette: Palette;
  selected: boolean;
  hovered: boolean;
}) {
  const style = cableStyle(link.cableType, palette);
  const length = linkLength(link);
  let body: JSX.Element;
  if (link.isBundled && length > 0.5) {
    // LAG member: two parallel rails.
    const nx = (-(link.end.y - link.start.y) / length) * (bundleRailSpacing / 2);
    const ny = ((link.end.x - link.start.x) / length) * (bundleRailSpacing / 2);
    const d = [1, -1]
      .map((sign) =>
        lineD(
          { x: link.start.x + nx * sign, y: link.start.y + ny * sign },
          { x: link.end.x + nx * sign, y: link.end.y + ny * sign },
        ),
      )
      .join("");
    body = <path d={d} {...strokeStyle(style, bundleRailWidthFactor)} />;
  } else {
    body = <path d={lineD(link.start, link.end)} {...strokeStyle(style)} />;
  }
  return (
    <g>
      {(selected || hovered) && (
        <path
          d={lineD(link.start, link.end)}
          fill="none"
          {...strokeOf(selected ? palette.selection : palette.hover, selected ? 0.38 : 0.3)}
          strokeWidth={n(style.width + (link.isBundled ? bundleRailSpacing : 0) + (selected ? 7 : 5))}
          strokeLinecap="round"
        />
      )}
      {body}
      {physical &&
        [link.start, link.end].map((point, index) => (
          <circle key={index} cx={n(point.x)} cy={n(point.y)} r={2.6} {...fillOf(style.color)} />
        ))}
    </g>
  );
});

/** Cable strokes and the plugs at their ends. */
export const CableLayer = memo(function CableLayer({
  links,
  mode,
  palette,
  selectedLinks,
  hoverLinks,
  isExport,
}: {
  links: LinkGeometry[];
  mode: ViewMode;
  palette: Palette;
  selectedLinks: ReadonlySet<string>;
  hoverLinks: ReadonlySet<string>;
  isExport: boolean;
}) {
  return (
    <g>
      {links.map((link) => (
        <Cable
          key={link.id}
          link={link}
          physical={mode === "physical"}
          palette={palette}
          selected={!isExport && hasAny(link.memberIDs, selectedLinks)}
          hovered={!isExport && hasAny(link.memberIDs, hoverLinks)}
        />
      ))}
    </g>
  );
});

/** Status dots and port names at the cable ends (physical view only); on top of all cables. */
export const CableDecorations = memo(function CableDecorations({
  links,
  palette,
  isExport,
  showLabels,
}: {
  links: LinkGeometry[];
  palette: Palette;
  isExport: boolean;
  showLabels: boolean;
}) {
  const dots: JSX.Element[] = [];
  for (const link of links) {
    for (const end of ["a", "b"] as const) {
      const dot = linkDot(link, end);
      if (!dot) continue;
      const color = statusColor(linkEndStatus(link, end), palette);
      const key = `${link.id}${end}`;
      if (color) {
        dots.push(
          <g key={key}>
            <circle cx={n(dot.x)} cy={n(dot.y)} r={dotRadius + 1.3} {...fillOf(palette.canvas)} />
            <circle cx={n(dot.x)} cy={n(dot.y)} r={dotRadius} {...fillOf(color)} />
          </g>,
        );
      } else if (!isExport) {
        // No status yet: a faint ring shows where to click to set one.
        dots.push(
          <circle
            key={key}
            cx={n(dot.x)}
            cy={n(dot.y)}
            r={dotRadius - 0.9}
            {...fillOf(palette.canvas)}
            {...strokeOf(palette.statusNone)}
            strokeWidth={1}
          />,
        );
      }
    }
  }
  const labels: JSX.Element[] = [];
  if (showLabels) {
    for (const link of links) {
      const style = cableStyle(link.cableType, palette);
      for (const label of [link.labelA, link.labelB]) {
        if (!label) continue;
        labels.push(
          <g key={`${link.id}${label === link.labelA ? "a" : "b"}`}>
            <path
              d={roundedRectD(label.rect, 3.5)}
              {...fillOf(palette.labelPlate)}
              {...strokeOf(style.color, 0.55)}
              strokeWidth={0.75}
            />
            <SvgText text={label.text} style={TextStyles.cableEnd} at={label.center} h="center" v="center" color={palette.ink} />
          </g>,
        );
      }
    }
  }
  return (
    <g>
      {dots}
      {labels}
    </g>
  );
});

/** Bundle ties and captions. */
export const BundleLayer = memo(function BundleLayer({
  bundles,
  palette,
  selectedLinks,
  isExport,
}: {
  bundles: BundleGeometry[];
  palette: Palette;
  selectedLinks: ReadonlySet<string>;
  isExport: boolean;
}) {
  return (
    <g>
      {bundles.map((bundle) => {
        const rect = bundle.labelRect;
        const selected = !isExport && hasAny(bundle.linkIDs, selectedLinks);
        return (
          <g key={bundle.id}>
            {bundle.tie.length > 1 && (
              <path
                d={polylineD(bundle.tie)}
                fill="none"
                {...strokeOf(palette.bundlePlate)}
                strokeWidth={1.3}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
            {bundle.tie.map((point: Point, index) => (
              <circle key={index} cx={n(point.x)} cy={n(point.y)} r={3.2} {...fillOf(palette.bundlePlate)} />
            ))}
            {selected && (
              <path d={roundedRectD(inset(rect, -2.5), rect.height / 2 + 2.5)} {...fillOf(palette.selection, 0.45)} />
            )}
            <path d={roundedRectD(rect, rect.height / 2)} {...fillOf(palette.bundlePlate)} />
            <SvgText
              text={bundle.label}
              style={TextStyles.bundle}
              at={bundle.labelCenter}
              h="center"
              v="center"
              color={palette.bundleInk}
            />
          </g>
        );
      })}
    </g>
  );
});

/** One note plate. */
export const AnnotationView = memo(function AnnotationView({
  annotation,
  palette,
  selected,
  editing,
}: {
  annotation: AnnotationGeometry;
  palette: Palette;
  selected: boolean;
  editing: boolean;
}) {
  const style = TextStyles.annotation;
  const height = lineHeight(style);
  return (
    <g>
      {selected && (
        <path
          d={roundedRectD(inset(annotation.frame, -3), 8)}
          fill="none"
          {...strokeOf(palette.selection)}
          strokeWidth={1.8}
        />
      )}
      <path
        d={roundedRectD(annotation.frame, 5)}
        {...fillOf(palette.annotationFill)}
        {...strokeOf(palette.annotationStroke)}
        strokeWidth={0.8}
      />
      {!editing &&
        textLines(annotation.text).map((line, index) => (
          <SvgText
            key={index}
            text={line}
            style={style}
            at={{ x: annotation.textOrigin.x, y: annotation.textOrigin.y + index * height + height / 2 }}
            h="leading"
            v="center"
            color={palette.ink}
            preserveSpaces
          />
        ))}
    </g>
  );
});

/** The cable being pulled from the first clicked port to the pointer. */
export function PendingCable({
  start,
  end,
  style,
}: {
  start: Point;
  end: Point;
  style: CableStyle;
}) {
  return (
    <g opacity={0.85} pointerEvents="none">
      <path d={lineD(start, end)} {...strokeStyle(style)} />
      <path d={roundedRectD(rectAround(end, { width: 6, height: 6 }), 3)} {...fillOf(style.color)} />
    </g>
  );
}
