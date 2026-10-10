// =============================================================================================
// PLACEHOLDER: the SVG canvas is implemented by another agent and replaces the body of this
// component. Keep the props contract (CanvasHostProps) and the export name.
//
// What the shell already provides for the canvas:
//   - `store`: ProjectStoreAPI (selection, drag, cabling, annotations...).
//   - `viewport`: the shared Viewport (ui/viewport.ts). The canvas should call
//     viewport.setViewSize() on resize, set viewport.contentBoundsProvider, map coordinates
//     with viewport.canvasPoint()/viewPoint(), and re-render on viewport changes
//     (useObservable(viewport) from ui/store-context.tsx).
//   - Palette drags carry the template id as dataTransfer type "application/x-netsketch-template"
//     (helper: templateIDFromDrag() in ui/Palette.tsx); on drop call
//     store.addDevice(templateID, viewport.canvasPoint(dropPointInView)).
//   - Global shortcuts (Delete, Cmd/Ctrl+A, zoom, view mode) are handled by the shell; Escape
//     (cancel pending cable) and double-click editing belong to the canvas.
// =============================================================================================

import { useEffect, useRef, type DragEvent } from "react";
import type { ProjectStoreAPI } from "../core/store-api";
import { categoryName } from "./czech";
import { DeviceIcon } from "./DeviceIcon";
import { templateDragType, templateIDFromDrag } from "./Palette";
import { useApp, useObservable } from "./store-context";
import type { Viewport } from "./viewport";

export interface CanvasHostProps {
  store: ProjectStoreAPI;
  viewport: Viewport;
}

export function CanvasHost({ store, viewport }: CanvasHostProps) {
  useObservable(store);
  const app = useApp();
  const hostRef = useRef<HTMLDivElement>(null);

  // Report the visible size, so that "add at a free spot" and fit() work.
  useEffect(() => {
    const element = hostRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      viewport.setViewSize({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [viewport]);

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes(templateDragType)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const templateID = templateIDFromDrag(event.dataTransfer);
    if (!templateID) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const point = viewport.canvasPoint({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    app.perform("Zařízení nelze přidat", () => {
      const device = store.addDevice(templateID, store.snapToGrid ? store.snap(point) : point);
      store.selection = [{ kind: "device", id: device.id }];
    });
  };

  const project = store.project;
  const isSelected = (kind: "device" | "link" | "annotation", id: string) => store.isSelected({ kind, id });

  return (
    <div
      ref={hostRef}
      className="canvas-host canvas-placeholder"
      data-view-mode={store.viewMode}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={(event) => {
        if (event.target === event.currentTarget) store.clearSelection();
      }}
    >
      <div className="canvas-placeholder-note" role="note">
        <strong>Plátno – rozpracováno</strong>
        <span>
          Tady bude SVG plátno (CanvasHost). Zatím lze zařízení přidat z palety a vybrat je v tomto seznamu.
        </span>
      </div>
      <ul className="canvas-placeholder-list" aria-label="Objekty projektu">
        {project.devices.map((device) => (
          <li key={device.id}>
            <button
              type="button"
              className={isSelected("device", device.id) ? "placeholder-item selected" : "placeholder-item"}
              onClick={(event) => store.select({ kind: "device", id: device.id }, event.shiftKey || event.metaKey)}
              onDoubleClick={() => app.openConsole(device.id)}
            >
              <DeviceIcon category={device.category} size={22} />
              <span>{device.hostname}</span>
              <span className="secondary small">{categoryName(device.category)}</span>
            </button>
          </li>
        ))}
        {project.links.map((link) => (
          <li key={link.id}>
            <button
              type="button"
              className={isSelected("link", link.id) ? "placeholder-item selected" : "placeholder-item"}
              onClick={(event) => store.select({ kind: "link", id: link.id }, event.shiftKey || event.metaKey)}
            >
              <span>
                {`Kabel ${project.devices.find((d) => d.id === link.a.deviceID)?.hostname ?? "?"} – ${
                  project.devices.find((d) => d.id === link.b.deviceID)?.hostname ?? "?"
                }`}
              </span>
            </button>
          </li>
        ))}
        {project.annotations.map((annotation) => (
          <li key={annotation.id}>
            <button
              type="button"
              className={isSelected("annotation", annotation.id) ? "placeholder-item selected" : "placeholder-item"}
              onClick={(event) =>
                store.select({ kind: "annotation", id: annotation.id }, event.shiftKey || event.metaKey)
              }
            >
              <span>{`Poznámka: ${annotation.text.split("\n")[0]}`}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
