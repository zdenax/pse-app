// Port of Tests/NetSketchCoreTests/BundleTests.swift.

import { findBundle, findLink } from "../../src/core/project";
import { validateProject } from "../../src/core/project-io";
import type { ProjectStore } from "../../src/core/store";
import { newUUID } from "../../src/core/util";
import { expectEditError, makeStore, ref, TemplateID } from "./support";

function makeLab(): ProjectStore {
  const store = makeStore();
  for (let i = 0; i < 3; i++) store.addDevice(TemplateID.c2960_24, { x: 0, y: 0 });
  return store;
}

describe("BundleTests", () => {
  test("needs two links between the same device pair", () => {
    const store = makeLab();
    const a1 = store.connect(ref(store, "SW1", "Fa0/1"), ref(store, "SW2", "Fa0/1"));
    const a2 = store.connect(ref(store, "SW2", "Fa0/2"), ref(store, "SW1", "Fa0/2")); // reversed direction
    const other = store.connect(ref(store, "SW1", "Fa0/3"), ref(store, "SW3", "Fa0/3"));
    const before = store.project;

    expectEditError(() => store.createBundle([a1.id]), "bundleNeedsTwoLinks");
    expectEditError(() => store.createBundle([a1.id, a1.id]), "bundleNeedsTwoLinks");
    expectEditError(() => store.createBundle([]), "bundleNeedsTwoLinks");
    expectEditError(() => store.createBundle([a1.id, other.id]), "bundleNeedsSameDevices");
    expectEditError(() => store.createBundle([a1.id, a2.id, other.id]), "bundleNeedsSameDevices");
    const ghost = newUUID();
    expectEditError(() => store.createBundle([a1.id, ghost]), "unknownLink", { id: ghost });
    expect(store.project).toBe(before);
    expect(store.project.bundles).toEqual([]);

    // Direction of the individual cables does not matter.
    const bundle = store.createBundle([a2.id, a1.id]);
    expect(bundle.label).toBe("Po1 / bond1");
    expect(bundle.linkIDs).toEqual([a1.id, a2.id]);
    expect(store.project.bundles).toEqual([bundle]);
    expect(findLink(store.project, a1.id)?.bundleID).toBe(bundle.id);
    expect(findLink(store.project, a2.id)?.bundleID).toBe(bundle.id);
    expect(findLink(store.project, other.id)?.bundleID).toBeUndefined();
    expect(store.bundleOfLink(a1.id)).toEqual(bundle);
    expect(store.bundleOfLink(other.id)).toBeUndefined();
    expect(validateProject(store.project)).toEqual([]);
  });

  test("labels, unbundle and rename", () => {
    const store = makeLab();
    const first = [1, 2].map((n) => store.connect(ref(store, "SW1", `Fa0/${n}`), ref(store, "SW2", `Fa0/${n}`)));
    const second = [3, 4].map((n) => store.connect(ref(store, "SW1", `Fa0/${n}`), ref(store, "SW3", `Fa0/${n}`)));
    const third = [5, 6].map((n) => store.connect(ref(store, "SW2", `Fa0/${n}`), ref(store, "SW3", `Fa0/${n}`)));

    const po1 = store.createBundle(first.map((link) => link.id));
    const po2 = store.createBundle(second.map((link) => link.id));
    const named = store.createBundle(
      third.map((link) => link.id),
      "  MLAG peer  ",
    );
    expect([po1.label, po2.label, named.label]).toEqual(["Po1 / bond1", "Po2 / bond2", "MLAG peer"]);

    expectEditError(() => store.createBundle(first.map((link) => link.id)), "linkAlreadyBundled", { id: first[0].id });

    store.renameBundle(po2.id, "Po7 / bond7");
    expect(findBundle(store.project, po2.id)?.label).toBe("Po7 / bond7");
    expectEditError(() => store.renameBundle(po2.id, "   "), "emptyName");
    const ghost = newUUID();
    expectEditError(() => store.renameBundle(ghost, "x"), "unknownBundle", { id: ghost });
    expectEditError(() => store.unbundle(ghost), "unknownBundle", { id: ghost });

    store.unbundle(po1.id);
    expect(findBundle(store.project, po1.id)).toBeUndefined();
    expect(store.project.links.length).toBe(6);
    expect(first.every((link) => findLink(store.project, link.id)?.bundleID === undefined)).toBe(true);
    expect(validateProject(store.project)).toEqual([]);

    // The freed label is reused.
    expect(store.createBundle(first.map((link) => link.id)).label).toBe("Po1 / bond1");

    store.undo();
    store.undo();
    expect(findBundle(store.project, po1.id)).toEqual(po1);
    expect(first.every((link) => findLink(store.project, link.id)?.bundleID === po1.id)).toBe(true);
  });
});
