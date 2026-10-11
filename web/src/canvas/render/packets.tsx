// Drawing of the moving packet (an envelope), the red cross of a lost one and the markers of
// blocking spanning-tree ports. The envelope layer owns the animation loop; the markers are
// plain shapes. Both are drawn in canvas coordinates, inside the transform of the diagram.

import { memo, useEffect, useRef, useState } from "react";
import type { Project } from "../../core/model";
import {
  PacketAnimator,
  buildPacketPlan,
  type AnimationFrame,
  type Leg,
  type PacketPhase,
  type PacketSource,
  type StpMarker,
} from "../packet-animation";
import type { DiagramScene } from "../scene";
import { n } from "./svg";

/** Colours of the packet: the request, the reply and the place where it was lost. */
export const packetColors = {
  request: "#2f7de1",
  reply: "#1f9d55",
  failure: "#e5484d",
} as const;

/** The orange of a blocking spanning-tree port. */
export const stpBlockingColor = "#f08c00";

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Zoomed far out the packet would vanish: it grows (up to 2.5x) as the diagram shrinks. */
export function markScale(zoom: number): number {
  return Math.min(2.5, Math.max(1, 1 / Math.max(zoom, 0.01)));
}

function Envelope({
  x,
  y,
  phase,
  angle,
  scale,
}: {
  x: number;
  y: number;
  phase: PacketPhase;
  angle: number;
  scale: number;
}) {
  const color = packetColors[phase];
  // The envelope hovers over the cable; a short trail behind it shows the direction.
  const tail = 14 * scale;
  return (
    <g data-packet={phase} pointerEvents="none">
      <line
        x1={n(x - Math.cos(angle) * tail)}
        y1={n(y - Math.sin(angle) * tail)}
        x2={n(x)}
        y2={n(y)}
        stroke={color}
        strokeOpacity={0.45}
        strokeWidth={3 * scale}
        strokeLinecap="round"
      />
      <g transform={`translate(${n(x)} ${n(y)}) scale(${n(scale)})`}>
        <rect x={-8} y={-5.5} width={16} height={11} rx={2} fill={color} stroke="#ffffff" strokeWidth={1.3} />
        <path d="M-7 -4.2 L0 1.6 L7 -4.2" fill="none" stroke="#ffffff" strokeWidth={1.3} strokeLinejoin="round" />
      </g>
    </g>
  );
}

function Cross({ x, y, opacity, scale }: { x: number; y: number; opacity: number; scale: number }) {
  const r = 7 * scale;
  return (
    <g data-packet="failure" opacity={opacity} pointerEvents="none">
      <circle cx={n(x)} cy={n(y)} r={r + 4} fill="#ffffff" fillOpacity={0.85} stroke={packetColors.failure} strokeWidth={1.2} />
      <path
        d={`M${n(x - r)} ${n(y - r)}L${n(x + r)} ${n(y + r)}M${n(x + r)} ${n(y - r)}L${n(x - r)} ${n(y + r)}`}
        stroke={packetColors.failure}
        strokeWidth={3.2 * scale}
        strokeLinecap="round"
      />
    </g>
  );
}

function Highlight({ legs, opacity, scale }: { legs: readonly Leg[]; opacity: number; scale: number }) {
  return (
    <g data-packet="highlight" opacity={opacity} pointerEvents="none">
      {legs.map((leg, index) => (
        <line
          key={index}
          x1={n(leg.from.x)}
          y1={n(leg.from.y)}
          x2={n(leg.to.x)}
          y2={n(leg.to.y)}
          stroke={packetColors[leg.phase]}
          strokeOpacity={0.75}
          strokeWidth={5 * scale}
          strokeLinecap="round"
        />
      ))}
    </g>
  );
}

/** The frame of the animation as SVG (also used by the tests and the headless check). */
export function PacketFrameView({ frame, zoom = 1 }: { frame: AnimationFrame | null; zoom?: number }) {
  if (!frame) return null;
  const scale = markScale(zoom);
  return (
    <g data-packet-layer="">
      {frame.highlight && <Highlight legs={frame.highlight.legs} opacity={frame.highlight.opacity} scale={scale} />}
      {frame.envelope && (
        <Envelope
          x={frame.envelope.point.x}
          y={frame.envelope.point.y}
          phase={frame.envelope.phase}
          angle={frame.envelope.angle}
          scale={scale}
        />
      )}
      {frame.cross && (
        <Cross x={frame.cross.point.x} y={frame.cross.point.y} opacity={frame.cross.opacity} scale={scale} />
      )}
    </g>
  );
}

/**
 * Subscribes to the packet traces and plays them one after another over the cables of `scene`.
 * With `enabled` false nothing is shown and the traces are ignored.
 */
export const PacketLayer = memo(function PacketLayer({
  source,
  enabled,
  scene,
  project,
  zoom,
}: {
  source: PacketSource | undefined;
  enabled: boolean;
  scene: DiagramScene;
  project: Project;
  zoom: number;
}) {
  const [frame, setFrame] = useState<AnimationFrame | null>(null);
  const latest = useRef({ scene, project });
  latest.current = { scene, project };

  useEffect(() => {
    if (!source || !enabled) {
      setFrame(null);
      return;
    }
    const animator = new PacketAnimator();
    let handle = 0;
    const loop = (now: number) => {
      const next = animator.frame(now);
      setFrame(next);
      handle = next ? requestAnimationFrame(loop) : 0;
    };
    const stop = source.subscribe((trace) => {
      const plan = buildPacketPlan(latest.current.scene, latest.current.project, trace);
      if (!plan) return;
      animator.enqueue(plan, performance.now(), prefersReducedMotion());
      if (handle === 0) handle = requestAnimationFrame(loop);
    });
    return () => {
      stop();
      if (handle !== 0) cancelAnimationFrame(handle);
      animator.clear();
      setFrame(null);
    };
  }, [source, enabled]);

  return <PacketFrameView frame={frame} zoom={zoom} />;
});

/** The markers of blocking spanning-tree ports: an orange bar across the cable near the port. */
export const StpMarkers = memo(function StpMarkers({
  markers,
  zoom = 1,
}: {
  markers: readonly StpMarker[];
  zoom?: number;
}) {
  if (markers.length === 0) return null;
  const scale = Math.min(1.8, markScale(zoom));
  return (
    <g data-stp-markers="" pointerEvents="none">
      {markers.map((marker) => {
        const degrees = (marker.angle * 180) / Math.PI;
        return (
          <g key={marker.key} transform={`translate(${n(marker.point.x)} ${n(marker.point.y)}) rotate(${n(degrees)}) scale(${n(scale)})`}>
            <title>Port blokuje provoz (STP blocking)</title>
            <rect x={-2.2} y={-6.5} width={4.4} height={13} rx={1.6} fill={stpBlockingColor} stroke="#7a4300" strokeWidth={0.9} />
          </g>
        );
      })}
    </g>
  );
});
