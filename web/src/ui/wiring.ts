// The single place where the UI shell meets the implementations of src/core and src/cli.
// main.tsx calls loadWiring(); when it throws, a friendly "rozpracováno" page is shown instead.
//
// TODO(integration): replace the stub below once src/core and src/cli are finished, e.g.:
//
//   import { Catalog, ProjectStore } from "../core";
//   import { CLI, CLISession } from "../cli";
//
//   export async function loadWiring(): Promise<AppWiring> {
//     const store = new ProjectStore(new Catalog());
//     return {
//       store,
//       createSession: (deviceID) => new CLISession(store, deviceID),
//       supportsConsole: (device) => CLI.supportsConsole(device),
//       // exporters: { png, pdf, svg }   // from the canvas implementation
//     };
//   }
//
// Keep every import of src/core and src/cli implementations in this file.

import type { AppWiring } from "./App";

export class WiringNotReadyError extends Error {
  constructor() {
    super("Jádro aplikace (src/core) a konzole (src/cli) zatím nejsou v ui/wiring.ts propojené.");
    this.name = "WiringNotReadyError";
  }
}

export async function loadWiring(): Promise<AppWiring> {
  throw new WiringNotReadyError();
}
