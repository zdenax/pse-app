// Shared fixtures of the canvas tests: a deterministic 24-port switch and a PC.

import { Catalog } from "../../src/core/catalog";
import type { Device, Point } from "../../src/core/model";
import { ProjectStore } from "../../src/core/store";
import { makeTemplate } from "../../src/core/template";

/** 24 RJ45 ports, automatic layout: two rows (odd on top), blocks of 6 columns, no captions. */
export const switch24 = makeTemplate({
  id: "test-switch-24",
  vendor: "Test",
  model: "S24",
  category: "switch",
  portGroups: [{ prefix: "Fa0/", rangeStart: 1, rangeEnd: 24, speed: "100M", connector: "RJ45" }],
});

/** One RJ45 port. */
export const pc = makeTemplate({
  id: "test-pc",
  vendor: "Test",
  model: "PC",
  category: "PC",
  portGroups: [{ names: ["eth0"], speed: "1G", connector: "RJ45" }],
});

export function makeStore(): ProjectStore {
  const store = new ProjectStore(new Catalog({ builtIn: [switch24, pc] }));
  store.snapToGrid = false;
  return store;
}

export function addSwitch(store: ProjectStore, hostname: string, at: Point): Device {
  return store.addDeviceFromTemplate(switch24, at, hostname);
}

export function port(device: Device, name: string): { deviceID: string; portID: string } {
  const found = device.ports.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing port ${name}`);
  return { deviceID: device.id, portID: found.id };
}
