// One console of one device (port of NetSketchCLI/CLISession.swift): the public face of the
// dialect engines, plus the `CLI` entry points that need no session.

import type { Device, DeviceCategory } from "../core/model";
import type { ProjectStoreAPI } from "../core/store-api";
import { HostEngine } from "./host-engine";
import { IOSEngine } from "./ios-engine";
import { DeviceAccess } from "./model-access";
import { RouterOSEngine } from "./routeros-engine";
import type { CLIDialect, ConsoleSession } from "./session-api";

export type { CLIDialect, ConsoleSession } from "./session-api";

/** What every dialect engine offers (the Swift protocol ConsoleEngine). */
export interface ConsoleEngine {
  readonly banner: string;
  readonly prompt: string;
  readonly isClosed: boolean;
  execute(line: string): string;
  complete(partial: string): string[];
  help(partial: string): string;
}

/** All dialects, in the order of the Swift enum (CLIDialect.allCases). */
export const allDialects: readonly CLIDialect[] = ["ios", "dellOS9", "routerOS", "generic", "host"];

function dialectOfVendor(vendor: string, _model: string, category: DeviceCategory): CLIDialect {
  if (category === "PC" || category === "server") return "host";
  const lower = vendor.toLowerCase();
  if (lower.includes("cisco")) return "ios";
  if (lower.includes("dell")) return "dellOS9";
  if (lower.includes("mikrotik")) return "routerOS";
  return "generic";
}

function dialect(device: Device): CLIDialect;
function dialect(vendor: string, model: string, category: DeviceCategory): CLIDialect;
function dialect(first: Device | string, model?: string, category?: DeviceCategory): CLIDialect {
  if (typeof first === "string") return dialectOfVendor(first, model ?? "", category as DeviceCategory);
  return dialectOfVendor(first.vendor, first.model, first.category);
}

/** Entry points of the CLI that do not need a session. */
export const CLI = {
  /**
   * The dialect of a device, decided by its vendor: `CLI.dialect(device)` or
   * `CLI.dialect(vendor, model, category)`. The model and category are accepted so that a
   * vendor with several operating systems can be told apart later.
   */
  dialect,

  /** `CLI.dialect(of:)` in Swift. */
  dialectOf(device: Device): CLIDialect {
    return dialectOfVendor(device.vendor, device.model, device.category);
  },

  /**
   * Switches and routers get a configuration console, PCs and servers a command prompt.
   * Access points have nothing the console could configure.
   */
  supportsConsole(device: Device): boolean {
    switch (device.category) {
      case "switch":
      case "L3 switch":
      case "router":
      case "PC":
      case "server":
        return true;
      case "AP":
        return false;
    }
    return false;
  },
};

/**
 * One console of one device.
 *
 * The session keeps only the console state (mode, history); the configuration itself is read
 * from and written to the store, so every change is visible on the canvas and in the inspector
 * at once and can be undone. Each command is one undo step.
 */
export class CLISession implements ConsoleSession {
  readonly deviceID: string;
  readonly dialect: CLIDialect;
  private readonly engine: ConsoleEngine;

  constructor(store: ProjectStoreAPI, deviceID: string) {
    this.deviceID = deviceID;
    const access = new DeviceAccess(store, deviceID);
    const device = access.device;
    const chosen: CLIDialect = device ? CLI.dialectOf(device) : "generic";
    this.dialect = chosen;
    switch (chosen) {
      case "routerOS":
        this.engine = new RouterOSEngine(access);
        break;
      case "host":
        this.engine = new HostEngine(access);
        break;
      default:
        this.engine = new IOSEngine(access, chosen);
    }
  }

  /** The greeting printed when the console opens. */
  get banner(): string {
    return this.engine.banner;
  }

  /** The prompt for the next line, e.g. "SW1(config-if)#" or "[admin@R1] > ". */
  get prompt(): string {
    return this.engine.prompt;
  }

  /** True after `exit`/`quit` at the top level, or when the device was deleted. */
  get isClosed(): boolean {
    return this.engine.isClosed;
  }

  /** Runs one line (or a pasted block of lines) and returns what the device prints. */
  execute(line: string): string {
    return this.engine.execute(line);
  }

  /** Words that may continue the partial line (Tab completion). */
  complete(partial: string): string[] {
    return this.engine.complete(partial);
  }

  /** The `?` help for a partial line. */
  help(partial: string): string {
    return this.engine.help(partial);
  }
}
