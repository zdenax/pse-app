/// <reference types="vite/client" />
// The single place where the UI shell meets the implementations of src/core, src/cli and
// src/canvas. main.tsx calls loadWiring(); when it throws, a friendly "rozpracováno" page is
// shown instead. Keep every import of those implementations in this file.

import { Catalog, ProjectStore } from "../core";
import type { CatalogStorage } from "../core";
import { CLI, CLISession } from "../cli";
import { canvasExporters } from "../canvas/exporters";
import type { AppWiring } from "./App";

/** The lab exercises of examples/, bundled so the app can open them without files. */
const exerciseFiles = import.meta.glob<string>("../../../examples/cviceni-*.netsketch", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Exercise file name -> project text, e.g. "cviceni-2-ctyri-routery.netsketch". */
export const bundledExercises: Record<string, string> = Object.fromEntries(
  Object.entries(exerciseFiles).map(([path, text]) => [path.slice(path.lastIndexOf("/") + 1), text]),
);

/**
 * The exercise to open at start: `#cviceni-1` / `#cviceni-2` in the address, or
 * `window.NETSKETCH_START` set by a hosting page (e.g. "cviceni-2").
 */
function startExercise(): string | undefined {
  const requested =
    (typeof window !== "undefined" && (window as { NETSKETCH_START?: string }).NETSKETCH_START) ||
    (typeof location !== "undefined" ? location.hash.replace(/^#/, "") : "");
  if (!requested) return undefined;
  return Object.keys(bundledExercises).find((name) => name.startsWith(requested));
}

/** Custom device templates ("Nové zařízení…") live in the browser's local storage. */
const customTemplatesKey = "netsketch.customTemplates";

function browserStorage(): CatalogStorage | undefined {
  try {
    const storage = window.localStorage;
    return {
      load: () => {
        try {
          return storage.getItem(customTemplatesKey);
        } catch {
          return null;
        }
      },
      save: (text: string) => {
        try {
          storage.setItem(customTemplatesKey, text);
        } catch {
          // Storage full or blocked: the templates stay for this session only.
        }
      },
    };
  } catch {
    // Private mode or blocked storage: custom templates live for this session only.
    return undefined;
  }
}

export async function loadWiring(): Promise<AppWiring> {
  const catalog = new Catalog({ storage: browserStorage() });
  const store = new ProjectStore(catalog);
  const exercise = startExercise();
  if (exercise) {
    try {
      store.openText(bundledExercises[exercise], exercise);
    } catch {
      // A broken bundled file must not keep the app from starting.
    }
  }
  return {
    store,
    createSession: (deviceID) => new CLISession(store, deviceID),
    supportsConsole: (device) => CLI.supportsConsole(device),
    exporters: canvasExporters,
  };
}
