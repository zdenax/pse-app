// Shared helpers of the core tests (TestSupport.swift).

import { Catalog } from "../../src/core/catalog";
import { EditError } from "../../src/core/errors";
import type { PortRef, Project } from "../../src/core/model";
import { deviceByHostname, refOfPortNamed } from "../../src/core/project";
import { ProjectStore } from "../../src/core/store";
import type { EditErrorCode } from "../../src/core/store-api";

/** A store on the bundled catalog only; never touches any storage. */
export function makeStore(snap = false): ProjectStore {
  const store = new ProjectStore(new Catalog());
  store.snapToGrid = snap;
  return store;
}

export const TemplateID = {
  c2960_24: "cisco-catalyst-2960-24",
  c2960_48: "cisco-catalyst-2960-48",
  c3650: "cisco-catalyst-3650-24ps",
  isr4321: "cisco-isr-4321",
  dellS3048: "dell-s3048-on",
  hapLite: "mikrotik-hap-lite",
  crs: "mikrotik-crs-generic",
  udmPro: "ubiquiti-udm-pro",
  unifi24: "ubiquiti-unifi-switch-24",
  pc: "generic-pc",
  server: "generic-server",
  accessPoint: "generic-ap",
  // Added from the photo of the lab rack.
  c2811: "cisco-2811",
  c3550: "cisco-catalyst-3550-48",
  c3750: "cisco-catalyst-3750-48ps",
  crs326: "mikrotik-crs326-24g-2s",
  usgPro4: "ubiquiti-usg-pro-4",
  fs726t: "netgear-fs726t",
  edgeRouterX: "ubiquiti-edgerouter-x",
} as const;

export const allTemplateIDs: string[] = Object.values(TemplateID);

/** Reference to a port by hostname and port name; throws when either is missing. */
export function ref(source: ProjectStore | Project, hostname: string, portName: string): PortRef {
  const project = source instanceof ProjectStore ? source.project : source;
  const device = deviceByHostname(project, hostname);
  const result = device ? refOfPortNamed(device, portName) : undefined;
  if (!result) throw new Error(`missing port ${hostname}:${portName}`);
  return result;
}

/** The value or a test failure. */
export function required<T>(value: T | undefined | null, what = "value"): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

/** Runs `body` and checks that it throws an `EditError` with this code (and details). */
export function expectEditError(
  body: () => unknown,
  code: EditErrorCode,
  details: { id?: string; ref?: PortRef } = {},
): EditError {
  let caught: unknown;
  try {
    body();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EditError);
  const error = caught as EditError;
  expect(error.code).toBe(code);
  if (details.id !== undefined) expect(error.id).toBe(details.id);
  if (details.ref !== undefined) expect(error.ref).toEqual(details.ref);
  expect(error.message.length).toBeGreaterThan(0);
  return error;
}

/** Builds the example project "trojuhelnik" purely through `ProjectStore` operations. */
export function buildTriangle(): ProjectStore {
  const store = new ProjectStore(new Catalog());
  store.snapToGrid = true;
  store.gridSize = 20;
  store.renameProject("Trojúhelník");

  // Triangle of switches, Dell to the lower left of SW1.
  store.addDevice(TemplateID.c2960_24, { x: 460, y: 160 }); // SW1
  store.addDevice(TemplateID.c2960_24, { x: 1040, y: 160 }); // SW2
  const hap = store.addDevice(TemplateID.hapLite, { x: 800, y: 520 });
  store.renameDevice(hap.id, "SW3");
  const dell = store.addDevice(TemplateID.dellS3048, { x: 340, y: 520 });
  store.renameDevice(dell.id, "DELL1");

  // The triangle: crossover between switches.
  store.connect(ref(store, "SW1", "Fa0/1"), ref(store, "SW2", "Fa0/1"), "crossover");
  store.connect(ref(store, "SW1", "Fa0/2"), ref(store, "SW3", "ether1"), "crossover");
  const redundant = store.connect(ref(store, "SW2", "Fa0/2"), ref(store, "SW3", "ether2"), "crossover");

  // Double link SW1 - DELL1, drawn as one bundle.
  const lag1 = store.connect(ref(store, "SW1", "Gi0/1"), ref(store, "DELL1", "GigabitEthernet 1/1"), "crossover");
  const lag2 = store.connect(ref(store, "SW1", "Gi0/2"), ref(store, "DELL1", "GigabitEthernet 1/2"), "crossover");
  store.createBundle([lag1.id, lag2.id]);

  // Manual status dots: everything up, the redundant triangle side held back at SW3.
  for (const link of store.project.links) {
    store.setStatus(link.id, "a", "green");
    store.setStatus(link.id, "b", "green");
  }
  store.setStatus(redundant.id, "b", "orange");
  store.setLinkNote(redundant.id, "Záložní strana trojúhelníku");

  store.setDeviceNote(dell.id, "Dell OS9. Port-channel 1 směrem na SW1 (Gi0/1 + Gi0/2).");
  store.setPortDescription(ref(store, "SW1", "Gi0/1"), "LAG na DELL1");
  store.setPortDescription(ref(store, "SW1", "Gi0/2"), "LAG na DELL1");
  store.addAnnotation("Trojúhelník SW1-SW2-SW3 a dvojitý svazek SW1-DELL1 (Po1 / bond1)", { x: 300, y: 40 });
  store.viewMode = "physical";
  return store;
}
