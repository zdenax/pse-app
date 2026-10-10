// View-space and interaction overlays of the live canvas: grid, rubber band, drop ghost, hover
// tag, banners, inline editor and context menu.

import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Point, Rect, Size } from "../geom";
import type { CanvasViewportLike, EditSession, MenuEntry } from "../input";
import type { NodeGeometry } from "../panel-geometry";
import { cssColor, fillOf, strokeOf, type Palette } from "../palette";
import type { DiagramScene } from "../scene";
import { fontWeightValue, TextStyles, canvasFontFamily } from "../text";
import { editorLayout, type TooltipLayout } from "../overlay";
import { DeviceIconSVG, SvgText } from "./primitives";
import { n, roundedRectD } from "./svg";

/** Dot grid in view coordinates; doubling the step keeps every dot a snap point when zoomed out. */
export const GridDots = memo(function GridDots({
  id,
  gridSize,
  zoom,
  offset,
  palette,
}: {
  id: string;
  gridSize: number;
  zoom: number;
  offset: Point;
  palette: Palette;
}) {
  if (!(gridSize > 0.5)) return null;
  let step = gridSize * zoom;
  while (step < 13) step *= 2;
  const dot = zoom >= 1.6 ? 2 : 1.5;
  const phase = (value: number) => ((value % step) + step) % step;
  return (
    <>
      <defs>
        <pattern
          id={id}
          width={n(step)}
          height={n(step)}
          patternUnits="userSpaceOnUse"
          x={n(phase(offset.x) - step / 2)}
          y={n(phase(offset.y) - step / 2)}
        >
          <rect x={n(step / 2 - dot / 2)} y={n(step / 2 - dot / 2)} width={dot} height={dot} {...fillOf(palette.gridDot)} />
        </pattern>
      </defs>
      <rect x={0} y={0} width="100%" height="100%" fill={`url(#${id})`} />
    </>
  );
});

export function RubberBand({ rect, palette }: { rect: Rect; palette: Palette }) {
  return (
    <rect
      x={n(rect.x + 0.5)}
      y={n(rect.y + 0.5)}
      width={n(Math.max(rect.width - 1, 0))}
      height={n(Math.max(rect.height - 1, 0))}
      {...fillOf(palette.selection, 0.1)}
      {...strokeOf(palette.selection)}
      strokeWidth={1}
    />
  );
}

/** Outline of the device a palette drag would drop (canvas coordinates). */
export function DropGhost({ ghost, palette }: { ghost: NodeGeometry; palette: Palette }) {
  return (
    <g pointerEvents="none">
      <path
        d={roundedRectD(ghost.bodyRect, 6)}
        {...fillOf(palette.hover, 0.1)}
        {...strokeOf(palette.hover)}
        strokeWidth={1.5}
        strokeDasharray="5 4"
      />
      {ghost.panel && <DeviceIconSVG category={ghost.category} rect={ghost.iconRect} palette={palette} opacity={0.6} />}
    </g>
  );
}

export function Tooltip({ layout, palette }: { layout: TooltipLayout; palette: Palette }) {
  const plate = layout.plate;
  return (
    <g pointerEvents="none">
      <path d={roundedRectD({ ...plate, y: plate.y + 1.5 }, 7)} fill="#000000" fillOpacity={0.18} />
      <path d={roundedRectD(plate, 7)} {...fillOf(palette.tooltipFill)} />
      {layout.lines.map((line, index) => (
        <SvgText
          key={index}
          text={line.text}
          style={line.style}
          at={{ x: line.x, y: line.y }}
          v="center"
          color={palette.tooltipInk}
          opacity={line.opacity}
        />
      ))}
    </g>
  );
}

export function EmptyHint({ text, size, palette }: { text: string; size: Size; palette: Palette }) {
  return (
    <SvgText
      text={text}
      style={TextStyles.placeholder}
      at={{ x: size.width / 2, y: size.height / 2 }}
      h="center"
      v="center"
      color={palette.secondaryInk}
      opacity={0.85}
    />
  );
}

// MARK: Banners

function BannerGlyph({ kind, color }: { kind: "warning" | "cable"; color: string }) {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      {kind === "warning" ? (
        <>
          <circle cx={7} cy={7} r={6.5} fill={color} />
          <path d="M7 3.6V7.8" stroke="#ffffff" strokeWidth={1.6} strokeLinecap="round" />
          <circle cx={7} cy={10.2} r={0.95} fill="#ffffff" />
        </>
      ) : (
        <>
          <path d="M2 11.5C5 11.5 5 2.5 9 2.5" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
          <rect x={9} y={1} width={4} height={3} rx={0.8} fill={color} />
        </>
      )}
    </svg>
  );
}

/** Transient notices at the top of the canvas: the last refused action and the cabling hint. */
export function Banners({
  feedback,
  pendingHint,
  palette,
}: {
  feedback: string | null;
  pendingHint: string | null;
  palette: Palette;
}) {
  if (feedback === null && pendingHint === null) return null;
  const style = {
    background: cssColor(palette.panelFill),
    color: cssColor(palette.ink),
    borderColor: cssColor(palette.panelStroke, 0.8),
    boxShadow: `0 2px 6px rgba(0, 0, 0, ${palette.isDark ? 0.45 : 0.14})`,
  };
  return (
    <div className="ns-canvas-banners" aria-live="polite">
      {feedback !== null && (
        <div className="ns-canvas-banner" style={style} role="status">
          <BannerGlyph kind="warning" color={cssColor(palette.reject)} />
          <span>{feedback}</span>
        </div>
      )}
      {pendingHint !== null && (
        <div className="ns-canvas-banner" style={style}>
          <BannerGlyph kind="cable" color={cssColor(palette.hover)} />
          <span>{pendingHint}</span>
        </div>
      )}
    </div>
  );
}

// MARK: Inline editor

/** The text field over a hostname, note or bundle caption (NSTextField of the Mac canvas). */
export function InlineEditor({
  session,
  scene,
  viewport,
  viewSize,
  palette,
  onDraft,
  onFinish,
}: {
  session: EditSession;
  scene: DiagramScene;
  viewport: CanvasViewportLike;
  viewSize: Size;
  palette: Palette;
  onDraft: (text: string) => void;
  /** commit = apply the text; refocus = hand the keyboard back to the canvas. */
  onFinish: (commit: boolean, refocus: boolean) => void;
}) {
  const [value, setValue] = useState(session.initialText);
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.select();
  }, []);

  const layout = editorLayout(session.target, value, scene, viewport, viewSize);
  if (!layout) return null;

  const finish = (commit: boolean, refocus: boolean) => {
    if (finished.current) return;
    finished.current = true;
    onFinish(commit, refocus);
  };

  // The canvas ignores keys whose target is not the canvas itself, and the shell treats a focused
  // text field as typing, so only Enter, Tab and Esc need handling here.
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      finish(false, true);
    } else if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !event.altKey)) {
      event.preventDefault();
      finish(true, true);
    }
  };

  const style = {
    left: layout.frame.x,
    top: layout.frame.y,
    width: layout.frame.width,
    height: layout.frame.height,
    fontSize: layout.fontSize,
    fontWeight: fontWeightValue(layout.style.weight),
    fontFamily: canvasFontFamily,
    textAlign: layout.align,
    background: cssColor(palette.panelFill),
    color: cssColor(palette.ink),
    borderColor: cssColor(palette.selection),
  } as const;
  const common = {
    ref: fieldRef,
    className: "ns-canvas-editor",
    style,
    value,
    placeholder: session.placeholder ?? undefined,
    spellCheck: false,
    onChange: (event: { target: { value: string } }) => {
      setValue(event.target.value);
      onDraft(event.target.value);
    },
    onKeyDown,
    onBlur: () => finish(true, false),
    onPointerDown: (event: { stopPropagation(): void }) => event.stopPropagation(),
    onContextMenu: (event: { stopPropagation(): void }) => event.stopPropagation(),
  };
  return session.multiline ? <textarea {...common} rows={1} /> : <input {...common} type="text" />;
}

// MARK: Context menu

function MenuList({
  entries,
  onDone,
  className,
}: {
  entries: MenuEntry[];
  onDone: () => void;
  className?: string;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  return (
    <div className={className ?? "ns-canvas-menu"} role="menu">
      {entries.map((entry, index) => {
        if (entry.kind === "separator") return <div key={index} className="ns-canvas-menu-separator" role="separator" />;
        const hasSubmenu = entry.submenu !== undefined && entry.submenu.length > 0;
        return (
          <div
            key={index}
            className="ns-canvas-menu-row"
            onPointerEnter={() => setOpenIndex(hasSubmenu ? index : null)}
          >
            <button
              type="button"
              role="menuitem"
              className={openIndex === index ? "ns-canvas-menu-item open" : "ns-canvas-menu-item"}
              disabled={!entry.enabled}
              aria-haspopup={hasSubmenu ? "menu" : undefined}
              aria-checked={entry.checked}
              onClick={() => {
                if (hasSubmenu) {
                  setOpenIndex(openIndex === index ? null : index);
                  return;
                }
                onDone();
                entry.action?.();
              }}
            >
              <span className="ns-canvas-menu-check">{entry.checked ? "✓" : ""}</span>
              <span className="ns-canvas-menu-label">{entry.label}</span>
              {hasSubmenu && <span className="ns-canvas-menu-arrow">{"›"}</span>}
            </button>
            {hasSubmenu && openIndex === index && (
              <MenuList entries={entry.submenu!} onDone={onDone} className="ns-canvas-menu ns-canvas-submenu" />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A context menu at a view point; closes on Escape, outside clicks and scrolling. */
export function ContextMenu({
  at,
  entries,
  viewSize,
  onClose,
}: {
  at: Point;
  entries: MenuEntry[];
  viewSize: Size;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(at);

  // Keep the menu inside the canvas.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    setPosition({
      x: Math.max(4, Math.min(at.x, viewSize.width - width - 4)),
      y: Math.max(4, Math.min(at.y, viewSize.height - height - 4)),
    });
  }, [at, viewSize.width, viewSize.height]);

  useEffect(() => {
    const element = ref.current;
    element?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      if (element && event.target instanceof Node && element.contains(event.target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    const close = () => onClose();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("wheel", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="ns-canvas-menu-host"
      style={{ left: position.x, top: position.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <MenuList entries={entries} onDone={onClose} />
    </div>
  );
}
