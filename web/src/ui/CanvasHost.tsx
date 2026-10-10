// The place where the shell mounts the SVG topology canvas (src/canvas). The canvas itself owns
// all pointer, keyboard, wheel and drop handling; the shell only supplies the store, the shared
// viewport and the console service for the context menu.

import { useMemo } from "react";
import { CanvasView } from "../canvas/CanvasView";
import type { CanvasInputHost } from "../canvas/input";
import type { ProjectStoreAPI } from "../core/store-api";
import { templateDragType } from "./Palette";
import { findDevice } from "./project-helpers";
import { useApp } from "./store-context";
import type { Viewport } from "./viewport";

export interface CanvasHostProps {
  store: ProjectStoreAPI;
  viewport: Viewport;
}

export function CanvasHost({ store, viewport }: CanvasHostProps) {
  const app = useApp();
  const host = useMemo<CanvasInputHost>(
    () => ({
      openConsole: (deviceID) => app.openConsole(deviceID),
      canOpenConsole: (deviceID) => {
        const device = findDevice(store.project, deviceID);
        return device !== undefined && app.consoleUnavailableReason(device) === null;
      },
    }),
    [app, store],
  );
  return (
    <div className="canvas-host">
      <CanvasView store={store} viewport={viewport} host={host} templateDragType={templateDragType} />
    </div>
  );
}
