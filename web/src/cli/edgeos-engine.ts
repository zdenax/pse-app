// The Ubiquiti EdgeOS console (EdgeRouter, USG) in the style of the Vyatta CLI:
// operational mode `ubnt@R1:~$`, `configure` -> `ubnt@R1#`, `set ...` / `delete ...`,
// `commit`, `save`, `exit`, `show ...`, `ping`, `traceroute`.
//
// Stub until the EdgeOS feature is written: it answers every command with a notice.

import type { DeviceAccess } from "./model-access";
import { Notices } from "./notices";
import type { ConsoleEngine } from "./session";

export class EdgeOSEngine implements ConsoleEngine {
  private readonly access: DeviceAccess;
  private closed = false;
  private lastHostname: string;

  constructor(access: DeviceAccess) {
    this.access = access;
    this.lastHostname = access.hostname;
  }

  get hostname(): string {
    const device = this.access.device;
    if (device) this.lastHostname = device.hostname;
    return this.lastHostname;
  }

  get banner(): string {
    const model = [this.access.vendor, this.access.model].filter((part) => part !== "").join(" ");
    return Notices.banner(this.hostname, model, "Ubiquiti EdgeOS", false);
  }

  get prompt(): string {
    return `ubnt@${this.hostname}:~$ `;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  execute(line: string): string {
    if (this.closed) return "";
    if (!this.access.exists) {
      this.closed = true;
      return Notices.deviceGone;
    }
    const trimmed = line.trim();
    if (trimmed === "") return "";
    if (trimmed === "exit") {
      this.closed = true;
      return "";
    }
    return "NetSketch: konzole EdgeOS se připravuje.";
  }

  complete(_partial: string): string[] {
    return [];
  }

  help(_partial: string): string {
    return "";
  }
}
