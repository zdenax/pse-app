// Handle on the inspector's left edge: dragging changes the width, dragging below the limit,
// a double click or ArrowRight at the minimum width hides the inspector.

import type { PointerEvent } from "react";
import { collapseBelow, inspectorLayout, inspectorLimits, useInspectorWidth } from "./right-layout";

const help = "Táhněte pro změnu šířky, dvojklik inspektor skryje";

export function RightHandle({ onHide }: { onHide: () => void }) {
  const width = useInspectorWidth();

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = inspectorLayout.width();
    const move = (e: globalThis.PointerEvent) => {
      const wanted = startWidth - (e.clientX - startX);
      if (wanted < collapseBelow) {
        stop();
        onHide();
      } else {
        inspectorLayout.set(wanted);
      }
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };

  return (
    <div
      className="panel-handle"
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={inspectorLimits.min}
      aria-valuemax={inspectorLimits.max}
      aria-valuenow={width}
      aria-label={help}
      title={help}
      tabIndex={0}
      onPointerDown={startDrag}
      onDoubleClick={onHide}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") inspectorLayout.set(width + 20);
        if (event.key === "ArrowRight") {
          if (width <= inspectorLimits.min) onHide();
          else inspectorLayout.set(width - 20);
        }
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") event.preventDefault();
      }}
    >
      <span className="panel-grip" />
    </div>
  );
}
