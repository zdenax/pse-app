// Port of Tests/NetSketchCoreTests/UndoTests.swift (behaviorHookDoesNothing is left out:
// DeviceBehavior is not part of the web core).

import { Catalog } from "../../src/core/catalog";
import { findAnnotation, findDevice, findPort, refOf } from "../../src/core/project";
import { ProjectStore } from "../../src/core/store";
import { newUUID } from "../../src/core/util";
import { expectEditError, makeStore, ref, required, TemplateID } from "./support";

const origin = { x: 0, y: 0 };

describe("UndoTests", () => {
  test("undo and redo restore state", () => {
    const store = makeStore();
    expect(!store.canUndo && !store.canRedo && !store.isDirty).toBe(true);
    expect(store.undo() || store.redo()).toBe(false);
    const empty = store.project;

    const sw1 = store.addDevice(TemplateID.c2960_24, { x: 100, y: 100 });
    const afterFirst = store.project;
    const sw2 = store.addDevice(TemplateID.c2960_24, { x: 400, y: 100 });
    const afterSecond = store.project;
    const link = store.connect(ref(store, "SW1", "Fa0/1"), ref(store, "SW2", "Fa0/1"));
    const afterLink = store.project;
    store.renameDevice(sw1.id, "CORE");
    const afterRename = store.project;
    expect(store.canUndo && !store.canRedo && store.isDirty).toBe(true);

    expect(store.undo()).toBe(true);
    expect(store.project).toEqual(afterLink);
    expect(findDevice(store.project, sw1.id)?.hostname).toBe("SW1");
    expect(store.canRedo).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.project).toEqual(afterSecond);
    expect(store.project.links.find((candidate) => candidate.id === link.id)).toBeUndefined();
    expect(store.undo()).toBe(true);
    expect(store.project).toEqual(afterFirst);
    expect(findDevice(store.project, sw2.id)).toBeUndefined();
    expect(store.undo()).toBe(true);
    expect(store.project).toEqual(empty);
    expect(!store.canUndo && !store.isDirty).toBe(true);
    expect(store.undo()).toBe(false);

    expect(store.redo() && store.redo() && store.redo() && store.redo()).toBe(true);
    expect(store.project).toEqual(afterRename);
    expect(!store.canRedo && !store.redo()).toBe(true);

    // A new edit after an undo discards the redo branch.
    store.undo();
    expect(store.canRedo).toBe(true);
    store.setDeviceNote(sw1.id, "rack 3");
    expect(store.canRedo).toBe(false);
    expect(findDevice(store.project, sw1.id)?.hostname).toBe("SW1");
  });

  test("no-ops and failures record no undo step", () => {
    const store = makeStore();
    const device = store.addDevice(TemplateID.pc, origin);
    store.renameDevice(device.id, "PC1"); // unchanged
    store.setDeviceNote(device.id, ""); // unchanged
    store.moveDevices([device.id], origin);
    store.moveDevices([newUUID()], { x: 5, y: 5 });
    store.removeSelection(); // nothing selected
    expectEditError(() => store.renameDevice(device.id, "  "), "emptyName");
    expectEditError(() => store.renameDevice(device.ports[0].id, "X"), "unknownDevice", { id: device.ports[0].id });
    expect(store.undo()).toBe(true);
    expect(store.canUndo).toBe(false);
    expect(store.project.devices).toEqual([]);
  });

  test("drag coalesces into one undo step", () => {
    const store = makeStore(true);
    const device = store.addDevice(TemplateID.c2960_24, { x: 100, y: 100 });
    const note = store.addAnnotation("label", { x: 200, y: 40 });
    const start = store.project;

    // Many small incremental moves, each far below half a grid cell.
    store.beginDrag();
    expect(store.isGrouping).toBe(true);
    for (let i = 0; i < 25; i++) {
      store.moveDevices([device.id], { x: 3, y: 1 });
    }
    expect(store.canUndo).toBe(true);
    store.endDrag();
    expect(store.isGrouping).toBe(false);
    // 25 * (3, 1) = (75, 25) -> snapped to the 20 pt grid.
    expect(findDevice(store.project, device.id)?.position).toEqual({ x: 180, y: 120 });

    expect(store.undo()).toBe(true);
    expect(store.project).toEqual(start);
    expect(store.redo()).toBe(true);
    expect(findDevice(store.project, device.id)?.position).toEqual({ x: 180, y: 120 });
    store.undo();

    // Total-translation style (a pointer drag's total offset), mixed selection.
    store.selection = [
      { kind: "device", id: device.id },
      { kind: "annotation", id: note.id },
    ];
    store.beginDrag();
    for (let step = 1; step <= 30; step++) {
      store.dragSelection({ x: step * 2, y: step });
    }
    store.endDrag();
    expect(findDevice(store.project, device.id)?.position).toEqual({ x: 160, y: 140 });
    expect(findAnnotation(store.project, note.id)?.position).toEqual({ x: 260, y: 80 });
    expect(store.undo()).toBe(true);
    expect(store.project).toEqual(start);

    // Exactly two steps remain: the annotation and the device.
    expect(store.undo() && store.undo()).toBe(true);
    expect(store.canUndo).toBe(false);
  });

  test("a drag that ends where it started or is cancelled leaves no step", () => {
    const store = makeStore();
    const device = store.addDevice(TemplateID.pc, { x: 50, y: 50 });
    const start = store.project;

    store.beginDrag();
    store.drag([{ kind: "device", id: device.id }], { x: 40, y: 0 });
    store.drag([{ kind: "device", id: device.id }], origin);
    store.endDrag();
    expect(store.project).toEqual(start);

    store.beginDrag();
    store.moveSelection({ x: 9, y: 9 }); // empty selection: nothing
    store.move([{ kind: "device", id: device.id }], { x: 33, y: 7 });
    expect(findDevice(store.project, device.id)?.position).toEqual({ x: 83, y: 57 });
    store.cancelDrag();
    expect(store.project).toEqual(start);
    expect(store.isGrouping).toBe(false);

    // Only the "add device" step exists.
    expect(store.undo()).toBe(true);
    expect(store.canUndo).toBe(false);
  });

  test("an undo group coalesces arbitrary edits", () => {
    const store = makeStore();
    const device = store.addDevice(TemplateID.pc, origin);
    const before = store.project;
    const port = refOf(device, device.ports[0]);

    store.beginUndoGroup();
    for (const text of ["u", "up", "upl", "upli", "uplin", "uplink"]) {
      store.setPortDescription(port, text);
    }
    store.beginUndoGroup(); // nested
    store.setDeviceNote(device.id, "typed");
    store.endUndoGroup();
    store.endUndoGroup();

    expect(findPort(store.project, port)?.description).toBe("uplink");
    expect(store.undo()).toBe(true);
    expect(store.project).toEqual(before);

    // Undo while a group is still open closes the group first.
    store.beginUndoGroup();
    store.setDeviceNote(device.id, "half typed");
    expect(store.canUndo).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.project).toEqual(before);
    expect(store.isGrouping).toBe(false);
    expect(store.redo()).toBe(true);
    expect(findDevice(store.project, device.id)?.note).toBe("half typed");
  });

  test("move and setPosition", () => {
    const store = makeStore(true);
    const device = store.addDevice(TemplateID.pc, { x: 100, y: 100 });
    store.moveDevices([device.id], { x: 20, y: -40 });
    expect(findDevice(store.project, device.id)?.position).toEqual({ x: 120, y: 60 });
    store.setPosition(device.id, { x: 333, y: 8 });
    expect(findDevice(store.project, device.id)?.position).toEqual({ x: 340, y: 0 });
    expectEditError(() => store.setPosition(device.ports[0].id, origin), "unknownDevice", { id: device.ports[0].id });

    expect(store.snap({ x: 29, y: 31 })).toEqual({ x: 20, y: 40 });
    store.gridSize = 50;
    expect(store.snap({ x: 74, y: 76 })).toEqual({ x: 50, y: 100 });
    store.snapToGrid = false;
    expect(store.snap({ x: 74.5, y: 76.25 })).toEqual({ x: 74.5, y: 76.25 });
    store.setPosition(device.id, { x: 1.5, y: 2.5 });
    expect(findDevice(store.project, device.id)?.position).toEqual({ x: 1.5, y: 2.5 });

    // Each move outside a drag is its own step: add + move + setPosition + setPosition.
    expect(store.undo() && store.undo() && store.undo() && store.undo()).toBe(true);
    expect(store.canUndo).toBe(false);
  });

  test("the undo stack is capped", () => {
    const store = makeStore();
    store.undoLimit = 5;
    const device = store.addDevice(TemplateID.pc, origin);
    for (let index = 1; index <= 12; index++) {
      store.renameDevice(device.id, `PC-${index}`);
    }
    let undone = 0;
    while (store.undo()) undone += 1;
    expect(undone).toBe(5);
    expect(findDevice(store.project, device.id)?.hostname).toBe("PC-7");
    expect(new ProjectStore(store.catalog).undoLimit).toBe(200);
  });

  test("device and port setters are undoable", () => {
    const store = makeStore();
    const device = store.addDevice(TemplateID.c2960_24, origin);
    const port = ref(store, "SW1", "Fa0/5");
    const base = store.project;

    store.setPortDescription(port, "printer");
    store.setPortVLAN(port, "trunk 10,20");
    store.setPortAdminDown(port, true);
    store.setVLANs(device.id, [
      { id: 20, name: "servers" },
      { id: 10, name: "users" },
      { id: 20, name: "duplicate" },
    ]);
    store.setDeviceNote(device.id, "rack 1");

    const stored = required(findPort(store.project, port));
    expect(stored.description === "printer" && stored.vlan === "trunk 10,20" && stored.adminDown).toBe(true);
    // Sorted by VLAN number, first entry of a duplicated number wins.
    expect(findDevice(store.project, device.id)?.vlans).toEqual([
      { id: 10, name: "users" },
      { id: 20, name: "servers" },
    ]);
    expect(findDevice(store.project, device.id)?.note).toBe("rack 1");

    // Five edits, five steps.
    store.undo();
    expect(findDevice(store.project, device.id)?.note).toBe("");
    store.undo();
    expect(findDevice(store.project, device.id)?.vlans).toEqual([]);
    store.undo();
    expect(findPort(store.project, port)?.adminDown).toBe(false);
    store.undo();
    expect(findPort(store.project, port)?.vlan).toBe("");
    store.undo();
    expect(store.project).toEqual(base);
    for (let i = 0; i < 5; i++) store.redo();
    expect(findPort(store.project, port)?.adminDown).toBe(true);
    expect(findDevice(store.project, device.id)?.vlans.map((vlan) => vlan.id)).toEqual([10, 20]);

    const ghost = { deviceID: device.id, portID: newUUID() };
    expectEditError(() => store.setPortDescription(ghost, "x"), "unknownPort", { ref: ghost });
    expectEditError(() => store.setPortVLAN(ghost, "x"), "unknownPort", { ref: ghost });
    expectEditError(() => store.setPortAdminDown(ghost, true), "unknownPort", { ref: ghost });
    expectEditError(() => store.setVLANs(ghost.portID, []), "unknownDevice", { id: ghost.portID });
    expectEditError(() => store.setDeviceNote(ghost.portID, "x"), "unknownDevice", { id: ghost.portID });
  });

  test("annotations", () => {
    const store = makeStore(true);
    const note = store.addAnnotation("Rack A", { x: 12, y: 47 });
    expect(note.position).toEqual({ x: 20, y: 40 });
    store.setAnnotationText(note.id, "Rack B");
    store.moveAnnotation(note.id, { x: 100, y: 100 });
    expect(store.project.annotations).toEqual([{ id: note.id, text: "Rack B", position: { x: 100, y: 100 } }]);

    store.undo();
    expect(findAnnotation(store.project, note.id)?.position).toEqual({ x: 20, y: 40 });
    store.undo();
    expect(findAnnotation(store.project, note.id)?.text).toBe("Rack A");

    const ghost = newUUID();
    expectEditError(() => store.setAnnotationText(ghost, "x"), "unknownAnnotation", { id: ghost });
    expectEditError(() => store.moveAnnotation(ghost, origin), "unknownAnnotation", { id: ghost });
    expectEditError(() => store.removeAnnotation(ghost), "unknownAnnotation", { id: ghost });
    store.removeAnnotation(note.id);
    expect(store.project.annotations).toEqual([]);
    store.undo();
    store.undo();
    expect(store.project.annotations.length === 0 && !store.canUndo).toBe(true);
  });

  test("selection helpers and view mode", () => {
    const store = makeStore();
    const a = store.addDevice(TemplateID.pc, origin);
    const b = store.addDevice(TemplateID.server, origin);
    const link = store.connect(ref(store, "PC1", "eth0"), ref(store, "SRV1", "eth0"));
    const note = store.addAnnotation("n", origin);

    store.select({ kind: "device", id: a.id });
    store.select({ kind: "link", id: link.id }, true);
    store.select({ kind: "annotation", id: note.id }, true);
    expect(store.selectedDeviceIDs).toEqual([a.id]);
    expect(store.selectedLinkIDs).toEqual([link.id]);
    expect(store.selectedAnnotationIDs).toEqual([note.id]);
    store.select({ kind: "device", id: a.id }, true);
    expect(store.isSelected({ kind: "device", id: a.id })).toBe(false);
    store.select({ kind: "device", id: b.id });
    expect(store.selection).toEqual([{ kind: "device", id: b.id }]);
    store.selectAll();
    expect(store.selection.length).toBe(4);

    // Undoing the creation of selected things drops them from the selection.
    store.undo();
    store.undo();
    expect(store.selection).toEqual([
      { kind: "device", id: a.id },
      { kind: "device", id: b.id },
    ]);
    store.clearSelection();
    expect(store.selection).toEqual([]);

    // The view mode is view state: not undoable, not dirtying, never rolled back by undo.
    const steps = store.canUndo;
    expect(store.viewMode).toBe("physical");
    store.viewMode = "logical";
    expect(store.viewMode === "logical" && store.project.viewMode === "logical").toBe(true);
    expect(store.canUndo).toBe(steps);
    store.undo();
    expect(store.viewMode).toBe("logical");
    store.redo();
    expect(store.viewMode).toBe("logical");
    store.newProject();
    expect(store.viewMode === "logical" && !store.isDirty).toBe(true);
    store.viewMode = "physical";
    expect(!store.isDirty && !store.canUndo).toBe(true);
  });
});

describe("ProjectStore (web additions)", () => {
  test("listeners hear every observable change exactly once per operation", () => {
    const store = makeStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    const count = (body: () => void): number => {
      const before = calls;
      const version = store.version;
      body();
      expect(store.version - version).toBe(calls - before);
      return calls - before;
    };

    const device = store.addDevice(TemplateID.pc, origin);
    expect(calls).toBe(1);
    expect(count(() => store.renameDevice(device.id, "PC1"))).toBe(0); // no change, no notification
    expect(count(() => store.select({ kind: "device", id: device.id }))).toBe(1);
    expect(count(() => store.select({ kind: "device", id: device.id }))).toBe(0);
    expect(count(() => (store.snapToGrid = true))).toBe(1);
    expect(count(() => (store.snapToGrid = true))).toBe(0);
    expect(count(() => (store.gridSize = 10))).toBe(1);
    expect(count(() => (store.activeCableType = "fiber"))).toBe(1);
    expect(count(() => (store.viewMode = "logical"))).toBe(1);
    expect(count(() => store.clickPort(refOf(device, device.ports[0])))).toBe(1);
    expect(count(() => store.cancelPendingPort())).toBe(1);
    expect(count(() => store.cancelPendingPort())).toBe(0);
    expect(count(() => store.undo())).toBe(1);
    expect(count(() => store.markSaved("x.netsketch"))).toBe(1);

    unsubscribe();
    store.redo();
    expect(store.version).toBeGreaterThan(0);
  });

  test("projects are immutable values with structural sharing", () => {
    const store = makeStore();
    const first = store.addDevice(TemplateID.pc, origin);
    store.addDevice(TemplateID.server, { x: 200, y: 0 });
    const note = store.addAnnotation("n", origin);
    const before = store.project;
    const firstDevice = before.devices[0];

    store.renameDevice(first.id, "WS1");
    const after = store.project;
    expect(after).not.toBe(before);
    expect(after.devices).not.toBe(before.devices);
    expect(after.devices[0]).not.toBe(firstDevice);
    expect(after.devices[1]).toBe(before.devices[1]); // untouched device keeps its identity
    expect(after.annotations).toBe(before.annotations); // untouched collection keeps its identity
    expect(after.links).toBe(before.links);
    expect(firstDevice.hostname).toBe("PC1"); // the old snapshot is unchanged

    // A refused or no-op operation keeps the very same object.
    store.renameDevice(first.id, "WS1");
    expect(store.project).toBe(after);
    expect(() => store.moveAnnotation(newUUID(), origin)).toThrow();
    expect(store.project).toBe(after);
    expect(findAnnotation(store.project, note.id)).toBe(findAnnotation(before, note.id));
  });

  test("addresses, gateway and static routes", () => {
    const store = makeStore();
    const router = store.addDevice(TemplateID.isr4321, origin);
    const port = router.ports[0];
    const interfaceID = `port:${port.id.toLowerCase()}`;

    store.setAddress(router.id, interfaceID, "192.168.1.1/24");
    store.setAddress(router.id, "vlan:10", "10.0.0.1/24");
    expect(findDevice(store.project, router.id)?.addresses).toEqual([
      { interface: `port:${port.id}`, address: "192.168.1.1/24" },
      { interface: "vlan:10", address: "10.0.0.1/24" },
    ]);
    store.setAddress(router.id, `port:${port.id}`, "192.168.1.254/24");
    store.setAddress(router.id, "vlan:10", null);
    store.setAddress(router.id, "vlan:20", null); // nothing to remove: no step
    expect(findDevice(store.project, router.id)?.addresses).toEqual([
      { interface: `port:${port.id}`, address: "192.168.1.254/24" },
    ]);
    expect(() => store.setAddress(router.id, "vlan:5000", "1.1.1.1/32")).toThrow(TypeError);

    store.setDefaultGateway(router.id, "192.168.1.1");
    store.setStaticRoutes(router.id, [
      { destination: "0.0.0.0/0", nextHop: "10.0.12.2" },
      { destination: "0.0.0.0/0", nextHop: "10.0.12.2" },
      { destination: "10.0.0.0/8", nextHop: "10.0.12.2" },
    ]);
    const stored = required(findDevice(store.project, router.id));
    expect(stored.defaultGateway).toBe("192.168.1.1");
    expect(stored.staticRoutes.length).toBe(2);

    const serialized = store.serialize();
    expect(serialized).toContain('"defaultGateway" : "192.168.1.1"');
    expect(serialized).toContain('"staticRoutes" : [');
    expect(serialized).toContain(`"interface" : "port:${port.id}"`);

    // add + 4 address changes + gateway + routes
    let steps = 0;
    while (store.undo()) steps += 1;
    expect(steps).toBe(7);
    expectEditError(() => store.setDefaultGateway(newUUID(), "x"), "unknownDevice");
  });

  test("addDeviceFromTemplate accepts a template that is not in the catalog", () => {
    const store = new ProjectStore(new Catalog({ builtIn: [] }));
    const device = store.addDeviceFromTemplate(
      {
        id: "lab-box",
        vendor: "Lab",
        model: "Box",
        category: "server",
        portGroups: [{ names: ["eth0", "eth1"], speed: "1G", connector: "RJ45" }],
      },
      { x: 10, y: 10 },
    );
    expect(device.hostname).toBe("SRV1");
    expect(device.ports.map((port) => port.name)).toEqual(["eth0", "eth1"]);
    expect(device.layout.sections.length).toBe(1);
    // 10 / 20 = 0.5 rounds away from zero, like Swift's rounded().
    expect(device.position).toEqual({ x: 20, y: 20 });
  });
});
