// The canvas exporters for AppProps.exporters (pass `canvasExporters` in ui/wiring.ts).
// The export code (and react-dom/server, which serializes the SVG) loads on first use only.

import type { ProjectStoreAPI } from "../core/store-api";
import type { ExportHandlers } from "../ui/app-model";

const load = () => import("./export");

export const canvasExporters: ExportHandlers = {
  png: async (store: ProjectStoreAPI) => (await load()).diagramPNG(store.project, store.viewMode),
  svg: async (store: ProjectStoreAPI) => (await load()).diagramSVGBlob(store.project, store.viewMode),
  pdf: async (store: ProjectStoreAPI) => (await load()).diagramPDF(store.project, store.viewMode),
};
