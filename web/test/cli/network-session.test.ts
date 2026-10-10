// Port of DialectTests and SessionLifecycleTests (Tests/NetSketchCLITests/IOSSessionTests.swift).

import type { Device, Port } from "../../src/core/model";
import { PortNaming } from "../../src/core/port-naming";
import { ProjectStore } from "../../src/core/store";
import { CLI, CLISession } from "../../src/cli/session";
import * as cli from "../../src/cli";

const c2960 = "cisco-catalyst-2960-24";
const c3650 = "cisco-catalyst-3650-24ps";
const isr4321 = "cisco-isr-4321";
const dellS3048 = "dell-s3048-on";
const hapLite = "mikrotik-hap-lite";
const udmPro = "ubiquiti-udm-pro";
const pcTemplate = "generic-pc";
const server = "generic-server";
const accessPoint = "generic-ap";

function makeStore(): ProjectStore {
  const store = new ProjectStore();
  store.snapToGrid = false;
  return store;
}

function makeSession(templateID: string, hostname?: string) {
  const store = makeStore();
  const device = store.addDevice(templateID, { x: 100, y: 100 }, hostname);
  return { store, device, cli: new CLISession(store, device.id) };
}

function port(store: ProjectStore, hostname: string, name: string): Port {
  const owner: Device | undefined = store.project.devices.find((item) => item.hostname === hostname);
  const found =
    owner?.ports.find((item) => item.name === name) ??
    owner?.ports.find((item) => PortNaming.shortName(item.name) === name);
  if (!found) throw new Error(`missing port ${hostname} ${name}`);
  return found;
}

describe("dialects", () => {
  test("the dialect follows the vendor", () => {
    expect(CLI.dialect("Cisco", "Catalyst 2960-24", "switch")).toBe("ios");
    expect(CLI.dialect("Dell EMC", "S3048-ON", "L3 switch")).toBe("dellOS9");
    expect(CLI.dialect("MikroTik", "hAP lite", "router")).toBe("routerOS");
    expect(CLI.dialect("Ubiquiti", "UDM Pro", "router")).toBe("generic");
    expect(CLI.dialect("", "", "switch")).toBe("generic");
    expect(CLI.dialect("cisco systems", "x", "router")).toBe("ios");
  });

  test("everything but access points has a console", () => {
    const store = makeStore();
    for (const id of [c2960, c3650, isr4321, dellS3048, hapLite, udmPro, pcTemplate, server]) {
      const added = store.addDevice(id, { x: 0, y: 0 });
      expect(CLI.supportsConsole(added), id).toBe(true);
    }
    const ap = store.addDevice(accessPoint, { x: 0, y: 0 });
    expect(CLI.supportsConsole(ap)).toBe(false);
    expect(CLI.dialect("Generic", "PC", "PC")).toBe("host");
    expect(CLI.dialect(ap)).toBe("generic");
    expect(CLI.dialectOf(store.project.devices[0])).toBe("ios");
  });

  test("the session picks the engine of the dialect", () => {
    expect(makeSession(c2960).cli.dialect).toBe("ios");
    expect(makeSession(dellS3048).cli.dialect).toBe("dellOS9");
    expect(makeSession(hapLite).cli.dialect).toBe("routerOS");
    expect(makeSession(pcTemplate).cli.dialect).toBe("host");
    const generic = makeSession(udmPro).cli;
    expect(generic.dialect).toBe("generic");
    expect(generic.banner).toContain("obecnou syntaxi ve stylu Cisco IOS");
    expect(generic.prompt).toBe("R1>");
  });

  test("the package entry exports the public API", () => {
    expect(cli.CLISession).toBe(CLISession);
    expect(typeof cli.Exercises.fileData).toBe("function");
    expect(typeof cli.NetworkSimulator).toBe("function");
    expect(cli.IPv4.parse("1.2.3.4")?.value).toBe(0x01020304);
  });

  test("a session of a missing device is closed at once", () => {
    const store = makeStore();
    const session = new CLISession(store, "00000000-0000-4000-8000-000000000099");
    expect(session.dialect).toBe("generic");
    expect(session.execute("enable")).toBe("NetSketch: zařízení už v projektu neexistuje, konzole je ukončena.");
    expect(session.isClosed).toBe(true);
  });
});

describe("session lifecycle", () => {
  test("a deleted device ends the session", () => {
    const { store, device, cli: session } = makeSession(c2960);
    store.removeDevices([device.id]);
    expect(session.execute("enable")).toBe("NetSketch: zařízení už v projektu neexistuje, konzole je ukončena.");
    expect(session.isClosed).toBe(true);
    expect(session.prompt).toBe("SW1>");
    expect(session.complete("en")).toEqual([]);
  });

  test("undo after a CLI change", () => {
    const { store, cli: session } = makeSession(c2960);
    for (const line of ["enable", "configure terminal", "interface fa0/1"]) session.execute(line);
    const before = structuredClone(store.project);
    session.execute("description A");
    session.execute("description B");
    expect(store.undo()).toBe(true);
    expect(port(store, "SW1", "Fa0/1").description).toBe("A");
    expect(store.undo()).toBe(true);
    expect(store.project).toEqual(before);
  });

  test("a renamed device changes the prompt of every dialect", () => {
    for (const [id, prompt] of [
      [hapLite, "[admin@NEW] > "],
      [pcTemplate, "C:\\>"],
      [c2960, "NEW>"],
    ]) {
      const { store, device, cli: session } = makeSession(id);
      store.renameDevice(device.id, "NEW");
      expect(session.prompt).toBe(prompt);
    }
  });
});
