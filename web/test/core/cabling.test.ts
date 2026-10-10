// Port of Tests/NetSketchCoreTests/CablingTests.swift.

import { nextLinkStatus } from "../../src/core/enums";
import type { PortRef } from "../../src/core/model";
import {
  devicePairKey,
  deviceByHostname,
  deviceNeedsVerification,
  findBundle,
  findDevice,
  findLink,
  findPort,
  linkEndAt,
  linkEndOnDevice,
  linksBetween,
  linksOfDevice,
  otherEnd,
} from "../../src/core/project";
import { validateProject } from "../../src/core/project-io";
import type { ProjectStore } from "../../src/core/store";
import { makePorts } from "../../src/core/template";
import { newUUID } from "../../src/core/util";
import { expectEditError, makeStore, ref, required, TemplateID } from "./support";

const origin = { x: 0, y: 0 };

/** SW1 and SW2 (2960-24) plus DELL1 (S3048-ON), nothing connected. */
function makeLab(): ProjectStore {
  const store = makeStore();
  store.addDevice(TemplateID.c2960_24, { x: 100, y: 100 });
  store.addDevice(TemplateID.c2960_24, { x: 500, y: 100 });
  store.addDevice(TemplateID.dellS3048, { x: 300, y: 400 }, "DELL1");
  return store;
}

describe("CablingTests", () => {
  test("automatic hostnames", () => {
    const store = makeStore();
    const names = [
      TemplateID.c2960_24,
      TemplateID.c2960_48,
      TemplateID.c3650,
      TemplateID.isr4321,
      TemplateID.pc,
      TemplateID.pc,
      TemplateID.server,
      TemplateID.accessPoint,
      TemplateID.hapLite,
    ].map((id) => store.addDevice(id, origin).hostname);
    expect(names).toEqual(["SW1", "SW2", "SW3", "R1", "PC1", "PC2", "SRV1", "AP1", "R2"]);

    // The lowest free number is reused; an explicit hostname wins.
    store.removeDevice(required(deviceByHostname(store.project, "SW2")).id);
    expect(store.nextHostname("switch")).toBe("SW2");
    expect(store.addDevice(TemplateID.pc, origin, " Kiosk ").hostname).toBe("Kiosk");
    expectEditError(() => store.addDevice("nope", origin), "unknownTemplate", { id: "nope" });
  });

  test("new device carries a template snapshot", () => {
    const store = makeStore(true);
    const device = store.addDevice(TemplateID.dellS3048, { x: 107, y: 93 });
    const template = required(store.catalog.template(TemplateID.dellS3048));
    expect(device.position).toEqual({ x: 100, y: 100 });
    expect(device.templateID).toBe(template.id);
    expect(device.vendor === "Dell EMC" && device.model === "S3048-ON").toBe(true);
    expect(device.category).toBe(template.category);
    expect(device.layout).toEqual(template.layout);
    expect(device.ports.map((port) => port.name)).toEqual(makePorts(template).map((port) => port.name));
    expect(deviceNeedsVerification(device)).toBe(true);
    expect(device.note === "" && device.vlans.length === 0).toBe(true);
    expect(device.ports.every((port) => !port.adminDown && port.description === "" && port.vlan === "")).toBe(true);
    expect(findDevice(store.project, device.id)).toEqual(device);
  });

  test("connect and refuse double use", () => {
    const store = makeLab();
    const sw1fa1 = ref(store, "SW1", "Fa0/1");
    const sw2fa1 = ref(store, "SW2", "Fa0/1");
    const sw2fa2 = ref(store, "SW2", "Fa0/2");
    const dell1 = ref(store, "DELL1", "GigabitEthernet 1/1");

    store.activeCableType = "fiber";
    const link = store.connect(sw1fa1, sw2fa1, "crossover");
    expect(link.cableType).toBe("crossover");
    expect(link.statusA === "none" && link.statusB === "none").toBe(true);
    expect(store.project.links).toEqual([link]);
    expect(store.isPortUsed(sw1fa1) && store.isPortUsed(sw2fa1)).toBe(true);
    expect(store.isPortUsed(sw2fa2)).toBe(false);
    expect(store.linkAt(sw2fa1)).toEqual(link);
    expect(store.linkAt(sw2fa2)).toBeUndefined();

    // A port takes one cable only, whichever end it would be.
    const before = store.project;
    expectEditError(() => store.connect(sw1fa1, sw2fa2), "portInUse", { ref: sw1fa1 });
    expectEditError(() => store.connect(dell1, sw2fa1), "portInUse", { ref: sw2fa1 });
    expectEditError(() => store.connect(sw1fa1, sw2fa1), "portInUse", { ref: sw1fa1 });
    expect(store.project).toBe(before);

    // Without an explicit cable the active cable type is used.
    expect(store.connect(dell1, sw2fa2).cableType).toBe("fiber");
    expect(validateProject(store.project)).toEqual([]);
  });

  test("same port, same device and unknown ports are refused", () => {
    const store = makeLab();
    const fa1 = ref(store, "SW1", "Fa0/1");
    const fa2 = ref(store, "SW1", "Fa0/2");
    const ghostPort: PortRef = { deviceID: fa1.deviceID, portID: newUUID() };
    const ghostDevice: PortRef = { deviceID: newUUID(), portID: fa1.portID };
    const other = ref(store, "SW2", "Fa0/1");
    const before = store.project;

    expectEditError(() => store.connect(fa1, fa1), "samePort");
    expectEditError(() => store.connect(fa1, fa2), "sameDevice");
    expectEditError(() => store.connect(ghostPort, other), "unknownPort", { ref: ghostPort });
    expectEditError(() => store.connect(other, ghostDevice), "unknownPort", { ref: ghostDevice });

    expect(store.project).toBe(before);
    expect(store.project.links).toEqual([]);
    // Refused operations leave no undo step behind: three undos remove the three devices.
    expect(store.undo() && store.undo() && store.undo()).toBe(true);
    expect(store.canUndo).toBe(false);
  });

  test("two-click flow", () => {
    const store = makeLab();
    const a = ref(store, "SW1", "Fa0/1");
    const sameDevice = ref(store, "SW1", "Fa0/2");
    const b = ref(store, "SW2", "Fa0/1");
    const c = ref(store, "DELL1", "GigabitEthernet 1/1");
    store.activeCableType = "crossover";

    expect(store.clickPort(a)).toEqual({ kind: "pending", port: a });
    expect(store.pendingPort).toEqual(a);
    expect(store.clickPort(a)).toEqual({ kind: "cancelled" });
    expect(store.pendingPort).toBeNull();

    expect(store.clickPort(a)).toEqual({ kind: "pending", port: a });
    // An invalid second click throws and keeps the first port armed.
    expectEditError(() => store.clickPort(sameDevice), "sameDevice");
    expect(store.pendingPort).toEqual(a);
    const result = store.clickPort(b);
    if (result.kind !== "connected") throw new Error("expected a connection");
    const link = result.link;
    expect(link.a).toEqual(a);
    expect(link.b).toEqual(b);
    expect(link.cableType).toBe("crossover");
    expect(store.pendingPort).toBeNull();
    expect(store.project.links).toEqual([link]);

    // An occupied port cannot start a cable, nor end one.
    expectEditError(() => store.clickPort(a), "portInUse", { ref: a });
    expect(store.pendingPort).toBeNull();
    expect(store.clickPort(c)).toEqual({ kind: "pending", port: c });
    expectEditError(() => store.clickPort(b), "portInUse", { ref: b });
    expect(store.pendingPort).toEqual(c);
    store.cancelPendingPort();
    expect(store.pendingPort).toBeNull();
    const ghost: PortRef = { deviceID: newUUID(), portID: newUUID() };
    expectEditError(() => store.clickPort(ghost), "unknownPort", { ref: ghost });

    // A pending port disappears together with its device.
    expect(store.clickPort(c)).toEqual({ kind: "pending", port: c });
    store.removeDevice(c.deviceID);
    expect(store.pendingPort).toBeNull();
  });

  test("peers and connections", () => {
    const store = makeLab();
    const a = ref(store, "SW1", "Gi0/1");
    const b = ref(store, "DELL1", "GigabitEthernet 1/1");
    const link = store.connect(a, b, "straight");

    const peer = required(store.peerOf(a));
    expect(peer.device.hostname).toBe("DELL1");
    expect(peer.port.name).toBe("GigabitEthernet 1/1");
    expect(peer.ref).toEqual(b);
    expect(peer.end).toBe("b");
    expect(peer.link).toEqual(link);
    const back = required(store.peerOf(b));
    expect(back.device.hostname === "SW1" && back.port.name === "Gi0/1" && back.end === "a").toBe(true);
    expect(store.peerOf(ref(store, "SW1", "Gi0/2"))).toBeUndefined();

    const rows = store.connections(a.deviceID);
    expect(rows.length).toBe(27);
    expect(rows.filter((row) => row.link !== undefined).map((row) => row.port.name)).toEqual(["Gi0/1"]);
    expect(rows.find((row) => row.port.name === "Gi0/1")?.peer).toEqual(peer);
    expect(store.connections(newUUID())).toEqual([]);

    expect(linkEndAt(link, a)).toBe("a");
    expect(linkEndOnDevice(link, b.deviceID)).toBe("b");
    expect(otherEnd(link, a)).toEqual(b);
    expect(linksOfDevice(store.project, a.deviceID)).toEqual([link]);
    expect(linksBetween(store.project, b.deviceID, a.deviceID)).toEqual([link]);
    expect(devicePairKey(a.deviceID, b.deviceID)).toBe(devicePairKey(b.deviceID, a.deviceID));
  });

  test("link attributes", () => {
    const store = makeLab();
    const link = store.connect(ref(store, "SW1", "Fa0/1"), ref(store, "SW2", "Fa0/1"));
    store.setCableType(link.id, "console");
    store.setLinkNote(link.id, "patch 12");
    store.setStatus(link.id, "b", "red");
    expect(store.cycleStatus(link.id, "a")).toBe("green");
    expect(store.cycleStatus(link.id, "a")).toBe("orange");
    expect(store.cycleStatus(link.id, "b")).toBe("none");

    const stored = required(findLink(store.project, link.id));
    expect(stored.cableType === "console" && stored.note === "patch 12").toBe(true);
    expect(stored.statusA === "orange" && stored.statusB === "none").toBe(true);
    expect(nextLinkStatus("red")).toBe("none");
    expect(nextLinkStatus("orange")).toBe("red");

    const ghost = newUUID();
    expectEditError(() => store.setCableType(ghost, "fiber"), "unknownLink", { id: ghost });
    expectEditError(() => store.cycleStatus(ghost, "a"), "unknownLink", { id: ghost });
    expectEditError(() => store.removeLink(ghost), "unknownLink", { id: ghost });

    store.removeLink(link.id);
    expect(store.project.links).toEqual([]);
    expect(store.isPortUsed(link.a)).toBe(false);
  });

  test("removing a device removes its links and cleans bundles", () => {
    const store = makeLab();
    const trunk = store.connect(ref(store, "SW1", "Fa0/1"), ref(store, "SW2", "Fa0/1"));
    const lag1 = store.connect(ref(store, "SW1", "Gi0/1"), ref(store, "DELL1", "GigabitEthernet 1/1"));
    const lag2 = store.connect(ref(store, "SW1", "Gi0/2"), ref(store, "DELL1", "GigabitEthernet 1/2"));
    const bundle = store.createBundle([lag1.id, lag2.id]);
    const dell = required(deviceByHostname(store.project, "DELL1"));
    store.selection = [
      { kind: "device", id: dell.id },
      { kind: "link", id: lag1.id },
      { kind: "link", id: trunk.id },
    ];

    store.removeDevice(dell.id);

    expect(store.project.devices.map((device) => device.hostname)).toEqual(["SW1", "SW2"]);
    expect(store.project.links).toEqual([trunk]);
    expect(store.project.bundles).toEqual([]);
    expect(findBundle(store.project, bundle.id)).toBeUndefined();
    expect(store.isPortUsed(lag1.a) || store.isPortUsed(lag2.a)).toBe(false);
    expect(validateProject(store.project)).toEqual([]);
    // Selection no longer mentions anything that is gone.
    expect(store.selection).toEqual([{ kind: "link", id: trunk.id }]);

    // One undo brings back the device, both cables and the bundle.
    store.undo();
    expect(store.project.devices.length === 3 && store.project.links.length === 3).toBe(true);
    expect(findBundle(store.project, bundle.id)?.linkIDs).toEqual([lag1.id, lag2.id]);
    expect(findLink(store.project, lag1.id)?.bundleID).toBe(bundle.id);
    expect(validateProject(store.project)).toEqual([]);

    const ghost = newUUID();
    expectEditError(() => store.removeDevices([dell.id, ghost]), "unknownDevice", { id: ghost });
    expect(store.project.devices.length).toBe(3);
  });

  test("shrinking a bundle below two links dissolves it", () => {
    const store = makeLab();
    const links = [1, 2, 3].map((n) => store.connect(ref(store, "SW1", `Fa0/${n}`), ref(store, "SW2", `Fa0/${n}`)));
    const bundle = store.createBundle(links.map((link) => link.id));

    store.removeLink(links[0].id);
    expect(findBundle(store.project, bundle.id)?.linkIDs).toEqual([links[1].id, links[2].id]);
    expect(validateProject(store.project)).toEqual([]);

    store.selection = [{ kind: "link", id: links[1].id }];
    store.removeSelection();
    expect(store.project.bundles).toEqual([]);
    expect(store.project.links.map((link) => link.id)).toEqual([links[2].id]);
    expect(store.project.links[0].bundleID).toBeUndefined();
    expect("bundleID" in store.project.links[0]).toBe(false);
    expect(validateProject(store.project)).toEqual([]);
    expect(store.selection).toEqual([]);
  });

  test("removeSelection is one undo step", () => {
    const store = makeLab();
    const link = store.connect(ref(store, "SW1", "Fa0/1"), ref(store, "SW2", "Fa0/1"));
    const other = store.connect(ref(store, "SW2", "Fa0/2"), ref(store, "DELL1", "GigabitEthernet 1/1"));
    const note = store.addAnnotation("rack A", { x: 10, y: 10 });
    const sw1 = required(deviceByHostname(store.project, "SW1"));
    const before = store.project;

    store.selection = [
      { kind: "device", id: sw1.id },
      { kind: "link", id: other.id },
      { kind: "annotation", id: note.id },
    ];
    store.removeSelection();
    expect(store.project.devices.map((device) => device.hostname)).toEqual(["SW2", "DELL1"]);
    expect(store.project.links).toEqual([]);
    expect(findLink(store.project, link.id)).toBeUndefined();
    expect(store.project.annotations).toEqual([]);
    expect(store.selection).toEqual([]);

    store.undo();
    expect(store.project).toEqual(before);
  });

  test("portInUse names the occupied port in Czech", () => {
    const store = makeLab();
    const sw1fa1 = ref(store, "SW1", "Fa0/1");
    store.connect(sw1fa1, ref(store, "SW2", "Fa0/1"));
    const error = expectEditError(() => store.connect(sw1fa1, ref(store, "SW2", "Fa0/2")), "portInUse");
    expect(error.message).toBe(
      "V portu už kabel je (port Fa0/1 na zařízení SW1). Do jednoho portu lze zapojit jen jeden kabel.",
    );
    expect(findPort(store.project, sw1fa1)?.name).toBe("Fa0/1");
  });
});
