// Device nodes: selection outline, front panel with its ports, port highlights, printed labels and
// the header (icon, hostname, model, warning). Port of the node parts of DiagramRenderer.swift.
// Every piece is memoized on its geometry, so dragging one device re-renders one node.

import { memo } from "react";
import type { ConnectorType } from "../../core/model";
import { center, inset, offset, rectAround, type Rect } from "../geom";
import type { NodeGeometry, PanelGeometry } from "../panel-geometry";
import { fillOf, strokeOf, type Palette, type RGBA } from "../palette";
import { TextStyles } from "../text";
import { SvgText, DeviceIconSVG, WarningGlyph } from "./primitives";
import { arcD, ellipseD, lineD, n, rectD, roundedRectD } from "./svg";

type PortTint = "copper" | "optic" | "console" | "mgmt" | "wireless";
const portTints: PortTint[] = ["copper", "optic", "console", "mgmt", "wireless"];

function tintOf(connector: ConnectorType): PortTint {
  switch (connector) {
    case "SFP":
    case "SFP+":
    case "QSFP+":
      return "optic";
    case "console":
      return "console";
    case "mgmt":
      return "mgmt";
    case "wireless":
      return "wireless";
    default:
      return "copper";
  }
}

function tintColor(tint: PortTint, palette: Palette): RGBA {
  switch (tint) {
    case "copper":
      return palette.portRJ45;
    case "optic":
      return palette.portOptic;
    case "console":
      return palette.portConsole;
    case "mgmt":
      return palette.portMgmt;
    case "wireless":
      return palette.portWireless;
  }
}

/** Selection outline around the whole node. */
export const NodeSelection = memo(function NodeSelection({ node, palette }: { node: NodeGeometry; palette: Palette }) {
  const d = roundedRectD(inset(node.bounds, -7, -7), 10);
  return <path d={d} {...fillOf(palette.selection, 0.09)} {...strokeOf(palette.selection)} strokeWidth={1.8} />;
});

/**
 * The plate, bays and port jacks of a panel. `used` lists the plugged port ids (joined with
 * spaces, so the memo compares a string).
 */
export const PanelView = memo(function PanelView({
  panel,
  used,
  palette,
}: {
  panel: PanelGeometry;
  used: string;
  palette: Palette;
}) {
  const m = panel.metrics;
  const s = m.scale;
  const usedSet = new Set(used === "" ? [] : used.split(" "));

  // Jack outlines batched per tint: a whole panel is a handful of paths.
  const batches = new Map<PortTint, { hollowFill: string; stroke: string; fill: string; detail: string }>(
    portTints.map((tint) => [tint, { hollowFill: "", stroke: "", fill: "", detail: "" }]),
  );
  let cutFill = "";
  let cutStroke = "";
  let adminDown = "";

  for (const port of panel.ports) {
    const isUsed = usedSet.has(port.portID);
    const batch = batches.get(tintOf(port.connector))!;
    const r = port.rect;
    switch (port.connector) {
      case "RJ45":
      case "console":
      case "mgmt": {
        const jack = roundedRectD(r, 1.8 * s);
        // Latch notch: up on the top row, down otherwise - like a real switch.
        const tabWidth = r.width * 0.38;
        const tabHeight = r.height * 0.22;
        const tabY = port.labelPlacement === "above" ? r.y + 1.2 * s : r.y + r.height - 1.2 * s - tabHeight;
        const tab = rectD({ x: r.x + r.width / 2 - tabWidth / 2, y: tabY, width: tabWidth, height: tabHeight });
        if (isUsed) {
          batch.fill += jack;
          cutFill += tab;
        } else {
          batch.hollowFill += jack;
          batch.stroke += jack;
          batch.detail += tab;
        }
        break;
      }
      case "SFP":
      case "SFP+":
      case "QSFP+": {
        const cage = roundedRectD(r, r.height * 0.32);
        if (isUsed) {
          batch.fill += cage;
        } else {
          batch.hollowFill += cage;
          batch.stroke += cage;
        }
        if (port.connector === "QSFP+") {
          // QSFP+ cages carry a center divider to tell them from SFP cages.
          const divider = lineD(
            { x: r.x + r.width / 2, y: r.y + 2.2 * s },
            { x: r.x + r.width / 2, y: r.y + r.height - 2.2 * s },
          );
          if (isUsed) cutStroke += divider;
          else batch.stroke += divider;
        }
        break;
      }
      case "wireless": {
        // Antenna mark: a dot with two arcs.
        const base = { x: r.x + r.width / 2, y: r.y + r.height - r.height * 0.22 };
        const dot = ellipseD(rectAround(base, { width: r.width * 0.2, height: r.width * 0.2 }));
        let arcs = "";
        for (const radius of [r.width * 0.28, r.width * 0.5]) {
          arcs += arcD(base, radius, -Math.PI * 0.78, -Math.PI * 0.22);
        }
        if (isUsed) {
          cutStroke += arcs;
          batch.fill += roundedRectD(inset(r, -1 * s, -1 * s), 3 * s);
          cutFill += dot;
        } else {
          batch.stroke += arcs;
          batch.fill += dot;
        }
        break;
      }
    }
    if (port.adminDown) {
      adminDown += lineD(
        { x: r.x + 1 * s, y: r.y + r.height - 1 * s },
        { x: r.x + r.width - 1 * s, y: r.y + 1 * s },
      );
    }
  }

  const strokeWidth = n(1.1 * s);
  return (
    <g>
      {/* Plate with a flat drop shadow (no blur: stays crisp, like the PDF of the Mac app). */}
      <path d={roundedRectD(offset(panel.frame, 0, 2 * s), m.cornerRadius)} {...fillOf(palette.panelShadow)} />
      <path
        d={roundedRectD(panel.frame, m.cornerRadius)}
        {...fillOf(palette.panelFill)}
        {...strokeOf(palette.panelStroke)}
        strokeWidth={1}
      />
      {panel.bays.map((bay, index) => (
        <path
          key={`bay${index}`}
          d={roundedRectD(bay.rect, 3 * s)}
          fill="none"
          {...strokeOf(palette.panelStroke)}
          strokeWidth={n(0.9 * s)}
          strokeDasharray={`${n(3 * s)} ${n(2.5 * s)}`}
        />
      ))}
      {portTints.map((tint) => {
        const batch = batches.get(tint)!;
        const color = tintColor(tint, palette);
        return (
          <g key={tint}>
            {batch.hollowFill !== "" && <path d={batch.hollowFill} {...fillOf(color, 0.07)} />}
            {batch.detail !== "" && <path d={batch.detail} {...fillOf(color, 0.45)} />}
            {batch.stroke !== "" && (
              <path
                d={batch.stroke}
                fill="none"
                {...strokeOf(color, 0.9)}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
            {batch.fill !== "" && <path d={batch.fill} {...fillOf(color)} />}
          </g>
        );
      })}
      {cutFill !== "" && <path d={cutFill} {...fillOf(palette.panelFill)} />}
      {cutStroke !== "" && (
        <path
          d={cutStroke}
          fill="none"
          {...strokeOf(palette.panelFill)}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {adminDown !== "" && (
        <path d={adminDown} fill="none" {...strokeOf(palette.reject)} strokeWidth={n(1.4 * s)} strokeLinecap="round" />
      )}
    </g>
  );
});

/** Pending, refused and hovered port markers of one panel (live canvas only). */
export const PortHighlights = memo(function PortHighlights({
  panel,
  pending,
  rejected,
  hover,
  hoverRejected,
  palette,
}: {
  panel: PanelGeometry;
  pending: string | null;
  rejected: string | null;
  hover: string | null;
  hoverRejected: boolean;
  palette: Palette;
}) {
  const s = panel.metrics.scale;
  const marks: JSX.Element[] = [];
  // One mark per port: pending wins over refused, refused over hovered.
  const ids = [pending, rejected, hover].filter((id, index, all): id is string => id !== null && all.indexOf(id) === index);
  for (const id of ids) {
    const port = panel.port(id);
    if (!port) continue;
    const r = port.rect;
    if (id === pending) {
      marks.push(
        <g key={`p${id}`}>
          <path d={roundedRectD(r, 2 * s)} {...fillOf(palette.pending)} />
          <path
            d={roundedRectD(inset(r, -3 * s), 4 * s)}
            fill="none"
            {...strokeOf(palette.pending)}
            strokeWidth={n(1.6 * s)}
          />
        </g>,
      );
    } else if (id === rejected) {
      marks.push(
        <path
          key={`r${id}`}
          d={roundedRectD(inset(r, -3 * s), 4 * s)}
          {...fillOf(palette.reject, 0.28)}
          {...strokeOf(palette.reject)}
          strokeWidth={n(1.8 * s)}
        />,
      );
    } else {
      marks.push(
        <path
          key={`h${id}`}
          d={roundedRectD(inset(r, -2.5 * s), 3.5 * s)}
          fill="none"
          {...strokeOf(hoverRejected ? palette.reject : palette.hover)}
          strokeWidth={n(1.5 * s)}
        />,
      );
    }
  }
  return marks.length === 0 ? null : <g>{marks}</g>;
});

/** Printed port labels and section captions. */
export const PanelLabels = memo(function PanelLabels({ panel, palette }: { panel: PanelGeometry; palette: Palette }) {
  const m = panel.metrics;
  return (
    <g>
      {panel.bays.map((bay, index) =>
        bay.label === "" ? null : (
          <SvgText
            key={`b${index}`}
            text={bay.label}
            style={m.captionStyle}
            at={center(bay.rect)}
            h="center"
            v="center"
            color={palette.secondaryInk}
          />
        ),
      )}
      {panel.ports.map((port) =>
        port.labelPlacement === "hidden" ? null : (
          <SvgText
            key={port.portID}
            text={port.label}
            style={m.labelStyle}
            at={port.labelCenter}
            h="center"
            v="center"
            color={palette.portLabel}
          />
        ),
      )}
      {panel.captions.map((caption, index) => (
        <SvgText
          key={`c${index}`}
          text={caption.text}
          style={m.captionStyle}
          at={caption.anchor}
          h="leading"
          v="center"
          color={palette.secondaryInk}
        />
      ))}
    </g>
  );
});

/** The header geometry relative to the icon's top-left corner (unchanged by moving the device). */
function headerShapeKey(node: NodeGeometry): string {
  const ox = node.iconRect.x;
  const oy = node.iconRect.y;
  const rel = (r: Rect | null) => (r ? `${r.x - ox},${r.y - oy},${r.width},${r.height}` : "-");
  return [
    node.category,
    node.hostname,
    node.typeText,
    node.iconRect.width,
    rel(node.hostnameRect),
    rel(node.typeRect),
    rel(node.warningRect),
    rel(node.labelPlateRect),
  ].join("|");
}

interface HeaderContentProps {
  node: NodeGeometry;
  shapeKey: string;
  palette: Palette;
  editing: boolean;
}

const HeaderContent = memo(
  function HeaderContent({ node, palette, editing }: HeaderContentProps) {
    const ox = node.iconRect.x;
    const oy = node.iconRect.y;
    const rel = (r: Rect): Rect => ({ x: r.x - ox, y: r.y - oy, width: r.width, height: r.height });
    const hostname = rel(node.hostnameRect);
    const type = rel(node.typeRect);
    return (
      <>
        <path d={roundedRectD(rel(node.labelPlateRect), 4)} {...fillOf(palette.labelPlate)} />
        <DeviceIconSVG category={node.category} rect={rel(node.iconRect)} palette={palette} />
        {!editing && (
          <SvgText text={node.hostname} style={TextStyles.hostname} at={hostname} color={palette.ink} />
        )}
        <SvgText text={node.typeText} style={TextStyles.deviceType} at={type} color={palette.secondaryInk} />
        {node.warningRect && !editing && <WarningGlyph rect={rel(node.warningRect)} color={palette.warning} />}
      </>
    );
  },
  (a, b) => a.shapeKey === b.shapeKey && a.palette === b.palette && a.editing === b.editing,
);

/**
 * Icon, hostname, device type and the "verify" marker, drawn above the cables on a plate so a
 * cable passing behind a name never strikes it through. Drawn relative to the icon, so moving a
 * device only changes the transform.
 */
export function NodeHeader({ node, palette, editing }: { node: NodeGeometry; palette: Palette; editing: boolean }) {
  return (
    <g transform={`translate(${n(node.iconRect.x)} ${n(node.iconRect.y)})`}>
      <HeaderContent node={node} shapeKey={headerShapeKey(node)} palette={palette} editing={editing} />
    </g>
  );
}
