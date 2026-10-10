// Owns the console sessions and the floating console windows of all devices. Framework-free.
// Port of ConsoleManager (Sources/NetSketch/Console/ConsoleManager.swift).
//
// A session lives as long as its device: closing the window keeps the CLI mode and the
// scrollback. When a device disappears (deleted, undone, another project opened) its window is
// closed and its session dropped. Titles and prompts follow renames (they are read live).

import type { Device, Project } from "../core/model";
import type { ConsoleSession } from "../cli/session-api";
import { ConsoleModel } from "./console-model";

/** What the shell needs from the consoles (src/cli), injected by the app wiring. */
export interface ConsoleBackend {
  createSession(deviceID: string): ConsoleSession;
  supportsConsole(device: Device): boolean;
}

/** The part of the store the console manager watches. */
export interface ConsoleProjectSource {
  readonly project: Project;
  subscribe(listener: () => void): () => void;
}

/** Placement of one floating console window, in viewport pixels. */
export interface ConsoleWindowState {
  readonly deviceID: string;
  /** Opening order; views render windows in this stable order and stack them by z-order. */
  readonly serial: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Bumped whenever the window should take keyboard focus (opened or brought to front). */
  focusToken: number;
}

export interface Area {
  width: number;
  height: number;
}

export class ConsoleManager {
  static readonly defaultSize = { width: 780, height: 480 };
  static readonly minSize = { width: 480, height: 260 };
  static readonly cascadeStep = 26;

  private readonly source: ConsoleProjectSource;
  private readonly backend: ConsoleBackend;
  private models = new Map<string, ConsoleModel>();
  /** Open windows, back to front (the last one is on top). */
  private _windows: ConsoleWindowState[] = [];
  private cascadeIndex = 0;
  private serialCounter = 0;
  private unsubscribe: (() => void) | null = null;

  private _version = 0;
  private listeners = new Set<() => void>();

  constructor(source: ConsoleProjectSource, backend: ConsoleBackend) {
    this.source = source;
    this.backend = backend;
  }

  /** Starts following the project (device removals). Call stop() to detach. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.source.subscribe(() => this.projectDidChange());
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // MARK: Observation

  get version(): number {
    return this._version;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    this._version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  // MARK: Queries

  /** Open windows, back to front. */
  get windows(): readonly ConsoleWindowState[] {
    return this._windows;
  }

  get openConsoleCount(): number {
    return this._windows.length;
  }

  get sessionCount(): number {
    return this.models.size;
  }

  model(deviceID: string): ConsoleModel | undefined {
    return this.models.get(deviceID);
  }

  window(deviceID: string): ConsoleWindowState | undefined {
    return this._windows.find((window) => window.deviceID === deviceID);
  }

  supportsConsole(device: Device): boolean {
    return this.backend.supportsConsole(device);
  }

  static title(device: Device): string {
    return `Konzole — ${device.hostname}`;
  }

  /** Window title of a device's console ("Konzole — SW1"); follows renames. */
  title(deviceID: string): string {
    const device = this.source.project.devices.find((candidate) => candidate.id === deviceID);
    return device ? ConsoleManager.title(device) : "Konzole";
  }

  // MARK: Commands

  /** Opens the console of a device, or brings its window to the front. */
  open(deviceID: string, area: Area = { width: 1280, height: 800 }): void {
    const device = this.source.project.devices.find((candidate) => candidate.id === deviceID);
    if (!device || !this.backend.supportsConsole(device)) return;
    const existing = this.window(deviceID);
    if (existing) {
      this.bringToFront(deviceID, true);
      return;
    }
    if (!this.models.has(deviceID)) {
      this.models.set(deviceID, new ConsoleModel(this.backend.createSession(deviceID)));
    }
    this.serialCounter += 1;
    this._windows = [
      ...this._windows,
      { deviceID, serial: this.serialCounter, ...this.nextFrame(area), focusToken: 1 },
    ];
    this.changed();
  }

  /** Closes the window; the session (mode, scrollback, history) is kept for the next open. */
  close(deviceID: string): void {
    const count = this._windows.length;
    this._windows = this._windows.filter((window) => window.deviceID !== deviceID);
    if (this._windows.length !== count) this.changed();
  }

  /** `exit` at the top level: the window goes away and the next open starts a fresh session. */
  sessionEnded(deviceID: string): void {
    this.models.delete(deviceID);
    this._windows = this._windows.filter((window) => window.deviceID !== deviceID);
    this.changed();
  }

  /** Raises a window above the others; with `focus` its input line takes the keyboard focus. */
  bringToFront(deviceID: string, focus = false): void {
    const index = this._windows.findIndex((window) => window.deviceID === deviceID);
    if (index < 0) return;
    const window = this._windows[index];
    const isTop = index === this._windows.length - 1;
    if (isTop && !focus) return;
    const updated = focus ? { ...window, focusToken: window.focusToken + 1 } : window;
    this._windows = [...this._windows.slice(0, index), ...this._windows.slice(index + 1), updated];
    this.changed();
  }

  /** Moves and/or resizes a window (viewport pixels). Sizes below the minimum are raised. */
  setFrame(deviceID: string, frame: { x: number; y: number; width: number; height: number }): void {
    const index = this._windows.findIndex((window) => window.deviceID === deviceID);
    if (index < 0) return;
    const current = this._windows[index];
    const next: ConsoleWindowState = {
      ...current,
      x: Math.round(frame.x),
      y: Math.round(frame.y),
      width: Math.round(Math.max(frame.width, ConsoleManager.minSize.width)),
      height: Math.round(Math.max(frame.height, ConsoleManager.minSize.height)),
    };
    if (
      next.x === current.x &&
      next.y === current.y &&
      next.width === current.width &&
      next.height === current.height
    ) {
      return;
    }
    const windows = [...this._windows];
    windows[index] = next;
    this._windows = windows;
    this.changed();
  }

  /** Closes all windows and drops all sessions (e.g. when the app goes away). */
  closeAll(): void {
    if (this._windows.length === 0 && this.models.size === 0) return;
    this._windows = [];
    this.models.clear();
    this.changed();
  }

  // MARK: Following the project

  /** Drops windows and sessions of devices that are no longer in the project. */
  projectDidChange(): void {
    if (this.models.size === 0 && this._windows.length === 0) return;
    const ids = new Set(this.source.project.devices.map((device) => device.id));
    let didChange = false;
    for (const id of [...this.models.keys()]) {
      if (!ids.has(id)) {
        this.models.delete(id);
        didChange = true;
      }
    }
    const windows = this._windows.filter((window) => ids.has(window.deviceID));
    if (windows.length !== this._windows.length) {
      this._windows = windows;
      didChange = true;
    }
    if (didChange) this.changed();
  }

  // MARK: Placement

  /** The first window is centered; later ones cascade down and to the right. */
  private nextFrame(area: Area): { x: number; y: number; width: number; height: number } {
    const width = Math.max(ConsoleManager.minSize.width, Math.min(ConsoleManager.defaultSize.width, area.width - 40));
    const height = Math.max(
      ConsoleManager.minSize.height,
      Math.min(ConsoleManager.defaultSize.height, area.height - 80),
    );
    const baseX = Math.max(0, Math.round((area.width - width) / 2));
    const baseY = Math.max(48, Math.round((area.height - height) / 3));
    if (this._windows.length === 0) this.cascadeIndex = 0;
    let step = this.cascadeIndex * ConsoleManager.cascadeStep;
    if (baseX + step + width > area.width || baseY + step + height > area.height) {
      this.cascadeIndex = 0;
      step = 0;
    }
    this.cascadeIndex += 1;
    return { x: baseX + step, y: baseY + step, width, height };
  }
}
