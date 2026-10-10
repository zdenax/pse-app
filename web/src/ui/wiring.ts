// The single place where the UI shell meets the implementations of src/core, src/cli and
// src/canvas. main.tsx calls loadWiring(); when it throws, a friendly "rozpracováno" page is
// shown instead. Keep every import of those implementations in this file.

import { Catalog, ProjectStore } from "../core";
import type { CatalogStorage } from "../core";
import { CLI, CLISession } from "../cli";
import { canvasExporters } from "../canvas/exporters";
import type { AppWiring } from "./App";

/** Custom device templates ("Nové zařízení…") live in the browser's local storage. */
const customTemplatesKey = "netsketch.customTemplates";

function browserStorage(): CatalogStorage | undefined {
  try {
    const storage = window.localStorage;
    return {
      load: () => storage.getItem(customTemplatesKey),
      save: (text: string) => storage.setItem(customTemplatesKey, text),
    };
  } catch {
    // Private mode or blocked storage: custom templates live for this session only.
    return undefined;
  }
}

export async function loadWiring(): Promise<AppWiring> {
  const catalog = new Catalog({ storage: browserStorage() });
  const store = new ProjectStore(catalog);
  return {
    store,
    createSession: (deviceID) => new CLISession(store, deviceID),
    supportsConsole: (device) => CLI.supportsConsole(device),
    exporters: canvasExporters,
  };
}
