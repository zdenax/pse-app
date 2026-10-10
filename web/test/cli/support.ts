// Test helpers of the console tests (port of Tests/NetSketchCLITests/CLITestSupport.swift).

import type { Device, Port, PortRef, Project } from "../../src/core/model";
import { PortNaming } from "../../src/core/port-naming";
import { ProjectStore } from "../../src/core/store";
import { CLISession } from "../../src/cli/session";

export const TemplateID = {
  c2960_24: "cisco-catalyst-2960-24",
  c3650: "cisco-catalyst-3650-24ps",
  isr4321: "cisco-isr-4321",
  dellS3048: "dell-s3048-on",
  hapLite: "mikrotik-hap-lite",
  udmPro: "ubiquiti-udm-pro",
  pc: "generic-pc",
  server: "generic-server",
  accessPoint: "generic-ap",
} as const;

/** A store on the built-in catalog only. */
export function makeStore(): ProjectStore {
  const store = new ProjectStore();
  store.snapToGrid = false;
  return store;
}

/** A store with one device and a console session on it. */
export function makeSession(templateID: string, hostname?: string): [ProjectStore, Device, CLISession] {
  const store = makeStore();
  const device = store.addDevice(templateID, { x: 100, y: 100 }, hostname);
  return [store, device, new CLISession(store, device.id)];
}

/** Runs several lines and returns the output of the last one. */
export function run(cli: CLISession, ...lines: string[]): string {
  let output = "";
  for (const line of lines) output = cli.execute(line);
  return output;
}

/** A deep copy of the current project (Swift `Project` is a value type). */
export function snapshot(store: ProjectStore): Project {
  return structuredClone(store.project);
}

/** The first device with this hostname. */
export function device(store: ProjectStore, hostname: string): Device {
  const found = store.project.devices.find((candidate) => candidate.hostname === hostname);
  if (!found) throw new Error(`Missing device ${hostname}`);
  return found;
}

/** The port with exactly this full name, or failing that this short name (Device.port(named:)). */
export function port(store: ProjectStore, hostname: string, portName: string): Port {
  const owner = device(store, hostname);
  const found =
    owner.ports.find((candidate) => candidate.name === portName) ??
    owner.ports.find((candidate) => PortNaming.shortName(candidate.name) === portName);
  if (!found) throw new Error(`Missing port ${hostname} ${portName}`);
  return found;
}

export function ref(store: ProjectStore, hostname: string, portName: string): PortRef {
  return { deviceID: device(store, hostname).id, portID: port(store, hostname, portName).id };
}
