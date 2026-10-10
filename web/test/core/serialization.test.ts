// Port of Tests/NetSketchCoreTests/SerializationTests.swift. Files become texts: `save(to:)` is
// `serialize()` + `markSaved(name)`, `open(_:)` is `openText(text, name)`.

import { EditError } from "../../src/core/errors";
import { formatNumber, quote } from "../../src/core/json-writer";
import type { Project } from "../../src/core/model";
import { devicePanelGrid } from "../../src/core/panel-layout";
import {
  deviceByHostname,
  emptyProject,
  makeLink,
  peerOf,
  portNamed,
  refOfPortNamed,
} from "../../src/core/project";
import {
  decodeProject,
  encodeProject,
  issueSentence,
  repairSummary,
  validateProject,
  type ProjectIssue,
} from "../../src/core/project-io";
import { shortName } from "../../src/core/port-naming";
import { newUUID } from "../../src/core/util";
import { buildTriangle, expectEditError, makeStore, ref, required, TemplateID } from "./support";

/** The example topology with every optional field in use. */
function makeRichProject(): Project {
  const store = buildTriangle();
  const sw1 = required(deviceByHostname(store.project, "SW1"));
  store.setPortAdminDown(ref(store, "SW1", "Fa0/24"), true);
  store.setPortVLAN(ref(store, "SW1", "Fa0/5"), "10");
  store.setPortDescription(ref(store, "SW1", "Fa0/5"), 'tiskárna "A/B"');
  store.setVLANs(sw1.id, [
    { id: 10, name: "users" },
    { id: 99, name: "mgmt" },
  ]);
  store.snapToGrid = false;
  store.setPosition(sw1.id, { x: 461.25, y: 159.5 });
  store.viewMode = "logical";
  return store.project;
}

/** Removes the keys everywhere in a parsed JSON value. */
function removing(keys: Set<string>, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((element) => removing(keys, element));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !keys.has(key))
        .map(([key, element]) => [key, removing(keys, element)]),
    );
  }
  return value;
}

describe("SerializationTests", () => {
  test("round trip", () => {
    const project = makeRichProject();
    const text = encodeProject(project);
    const decoded = decodeProject(text);
    expect(decoded).toEqual(project);
    expect(validateProject(decoded)).toEqual([]);
    expect(encodeProject(decoded)).toBe(text);

    // The CLI-related fields survive the trip.
    const sw1 = required(deviceByHostname(decoded, "SW1"));
    expect(sw1.vlans).toEqual([
      { id: 10, name: "users" },
      { id: 99, name: "mgmt" },
    ]);
    expect(portNamed(sw1, "Fa0/24")?.adminDown).toBe(true);
    expect(portNamed(sw1, "Fa0/23")?.adminDown).toBe(false);
    expect(portNamed(sw1, "Fa0/5")?.vlan).toBe("10");
    expect(portNamed(sw1, "Fa0/5")?.description).toBe('tiskárna "A/B"');
    expect(sw1.position).toEqual({ x: 461.25, y: 159.5 });
    expect(decoded.viewMode).toBe("logical");
    expect(decoded.formatVersion).toBe(1);

    // Pretty-printed, keys sorted, slashes left alone.
    expect(text).toContain('\n  "formatVersion" : 1');
    expect(text).toContain('"Fa0/1"');
    expect(text).toContain('"adminDown" : true');
    expect(text).toContain('"description" : "tiskárna \\"A/B\\""');
    expect(text).toContain('"x" : 461.25');
    const topLevelKeys = ["annotations", "bundles", "devices", "formatVersion", "links", "name", "viewMode"];
    const positions = topLevelKeys.map((key) => {
      const index = text.indexOf(`\n  "${key}" :`);
      expect(index, key).toBeGreaterThanOrEqual(0);
      return index;
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("empty project round trip", () => {
    const empty = emptyProject("nic");
    expect(decodeProject(encodeProject(empty))).toEqual(empty);
    expect(validateProject(empty)).toEqual([]);
    expect(decodeProject("{}")).toEqual(emptyProject());
  });

  test("files without new fields still decode", () => {
    // A file as an older build wrote it: no adminDown, no vlans (and other optional keys missing).
    const [deviceA, deviceB, portA, portB, link] = [newUUID(), newUUID(), newUUID(), newUUID(), newUUID()];
    const legacy = `
    {
      "formatVersion": 1,
      "name": "legacy",
      "devices": [
        { "id": "${deviceA}", "templateID": "generic-pc", "vendor": "Generic", "model": "PC", "category": "PC",
          "hostname": "PC1", "position": { "x": 40, "y": 60 },
          "ports": [ { "id": "${portA}", "name": "eth0", "connector": "RJ45", "speed": "1G",
                       "verified": false, "description": "", "vlan": "", "groupIndex": 0 } ],
          "note": "", "verified": false,
          "layout": { "rows": 1, "sections": [ { "groups": [0], "arrangement": "singleRow" } ] } },
        { "id": "${deviceB}", "category": "switch", "hostname": "SW1", "position": { "x": 300, "y": 60 },
          "ports": [ { "id": "${portB}", "name": "FastEthernet0/1", "connector": "RJ45" } ] }
      ],
      "links": [
        { "id": "${link}", "a": { "deviceID": "${deviceA}", "portID": "${portA}" },
          "b": { "deviceID": "${deviceB}", "portID": "${portB}" } }
      ]
    }`;
    const project = decodeProject(legacy);
    expect(project.name).toBe("legacy");
    expect(project.devices.length).toBe(2);
    expect(project.devices.every((device) => device.vlans.length === 0)).toBe(true);
    expect(project.devices.flatMap((device) => device.ports).every((port) => !port.adminDown)).toBe(true);
    expect(validateProject(project)).toEqual([]);
    // Swift keeps viewMode nil here; the web model shows such files physically.
    expect(project.bundles.length === 0 && project.annotations.length === 0 && project.viewMode === "physical").toBe(true);

    const sw1 = required(deviceByHostname(project, "SW1"));
    expect(shortName(sw1.ports[0].name)).toBe("Fa0/1");
    expect(sw1.ports[0].speed === "" && sw1.ports[0].vlan === "" && sw1.ports[0].groupIndex === 0).toBe(true);
    expect(devicePanelGrid(sw1).slots.length).toBe(1);
    expect(project.links[0].cableType === "straight" && project.links[0].statusA === "none").toBe(true);
    expect(peerOf(project, { deviceID: deviceA, portID: portA })?.device.hostname).toBe("SW1");

    // Stripping the new keys from a current file gives the same project back.
    const current = buildTriangle().project;
    const stripped = JSON.stringify(removing(new Set(["adminDown", "vlans"]), JSON.parse(encodeProject(current))));
    expect(stripped.includes("adminDown") || stripped.includes("vlans")).toBe(false);
    expect(decodeProject(stripped)).toEqual(current);

    // Re-encoding the legacy project writes the new keys with their defaults.
    const rewritten = encodeProject(project);
    expect(rewritten.includes('"adminDown" : false') && rewritten.includes('"vlans"')).toBe(true);
  });

  test("a newer format version is rejected", () => {
    const error = expectEditError(() => decodeProject('{"formatVersion": 99, "name": "x"}'), "newerFormat");
    expect(error.foundVersion).toBe(99);
    expect(error.supportedVersion).toBe(1);
    expect(error.message).toBe("Soubor je ve formátu verze 99, tato verze aplikace umí nejvýše verzi 1.");
    expectEditError(() => decodeProject("not json"), "invalidFile");
  });

  test("store save and open", () => {
    const store = buildTriangle();
    expect(store.isDirty && store.fileName === null).toBe(true);
    let file = store.serialize();
    store.markSaved("lab.netsketch");
    expect(!store.isDirty && store.fileName === "lab.netsketch" && store.canUndo).toBe(true);
    expect(decodeProject(file)).toEqual(store.project);

    // Dirty tracking follows the saved state through edits, undo and saving again.
    const sw1 = required(deviceByHostname(store.project, "SW1"));
    store.renameDevice(sw1.id, "CORE1");
    expect(store.isDirty).toBe(true);
    store.undo();
    expect(store.isDirty).toBe(false);
    store.redo();
    file = store.serialize();
    store.markSaved("lab.netsketch");
    expect(store.isDirty).toBe(false);
    store.undo();
    expect(store.isDirty).toBe(true);

    const reader = makeStore();
    reader.addDevice(TemplateID.pc, { x: 0, y: 0 });
    reader.selection = [{ kind: "device", id: reader.project.devices[0].id }];
    reader.openText(file, "lab.netsketch");
    expect(deviceByHostname(reader.project, "CORE1")).toBeDefined();
    expect(reader.fileName === "lab.netsketch" && !reader.isDirty && !reader.canUndo && !reader.canRedo).toBe(true);
    expect(reader.selection.length === 0 && reader.openIssues.length === 0).toBe(true);
    expect(reader.viewMode).toBe("physical");

    // A failed open keeps the current project.
    const kept = reader.project;
    expectEditError(() => reader.openText("{ missing", "missing.netsketch"), "invalidFile");
    expect(reader.project).toBe(kept);
    expect(reader.fileName).toBe("lab.netsketch");

    reader.newProject("prázdný");
    expect(reader.project.devices.length === 0 && reader.project.name === "prázdný").toBe(true);
    expect(reader.fileName === null && !reader.isDirty && !reader.canUndo).toBe(true);
  });

  test("an inconsistent file is repaired on open", () => {
    const original = buildTriangle().project;
    const sw1 = required(deviceByHostname(original, "SW1"));
    const sw2 = required(deviceByHostname(original, "SW2"));
    const bundle = required(original.bundles[0]);
    // A dangling cable, a second cable in an occupied port, a cable inside one device,
    // and a bundle that lists a link which does not exist.
    const dangling = makeLink(required(refOfPortNamed(sw1, "Fa0/10")), { deviceID: newUUID(), portID: newUUID() });
    const doubled = makeLink(required(refOfPortNamed(sw1, "Fa0/1")), required(refOfPortNamed(sw2, "Fa0/9")));
    const inside = makeLink(required(refOfPortNamed(sw2, "Fa0/11")), required(refOfPortNamed(sw2, "Fa0/12")));
    const project: Project = {
      ...original,
      links: [...original.links, dangling, doubled, inside],
      bundles: [
        { ...bundle, linkIDs: [...bundle.linkIDs, newUUID()] },
        { id: newUUID(), label: "lonely", linkIDs: [original.links[0].id] },
      ],
    };

    const issues = validateProject(project);
    expect(issues).toContainEqual({ kind: "danglingPortRef", linkID: dangling.id, end: "b" });
    expect(issues).toContainEqual({ kind: "portUsedTwice", ref: doubled.a });
    expect(issues).toContainEqual({ kind: "linkWithinDevice", linkID: inside.id });
    expect(issues.some((issue) => issue.kind === "bundleMissingLink" && issue.bundleID === bundle.id)).toBe(true);
    expect(issues.some((issue) => issue.kind === "bundleTooSmall")).toBe(true);

    const store = makeStore();
    store.openText(encodeProject(project), "broken.netsketch");
    expect(store.openIssueList).toEqual(issues);
    expect(store.openIssues).toEqual(issues.map((issue) => issueSentence(issue, project)));
    expect(validateProject(store.project)).toEqual([]);
    expect(store.isDirty).toBe(true);
    expect(store.project.links.length).toBe(5);
    expect(store.project.bundles.map((candidate) => candidate.label)).toEqual(["Po1 / bond1"]);
    expect(store.project.bundles[0].linkIDs.length).toBe(2);
    expect(store.project.devices).toEqual(project.devices);
  });
});

describe("Serialization (web additions)", () => {
  test("numbers and strings are written like Foundation", () => {
    expect(formatNumber(300)).toBe("300");
    expect(formatNumber(-0)).toBe("-0");
    expect(formatNumber(461.25)).toBe("461.25");
    expect(formatNumber(0.1 + 0.2)).toBe("0.30000000000000004");
    expect(formatNumber(0.0001)).toBe("0.0001");
    expect(formatNumber(0.00001)).toBe("1e-05");
    expect(formatNumber(-1.5e-7)).toBe("-1.5e-07");
    expect(formatNumber(2 ** 53)).toBe("9007199254740992");
    expect(formatNumber(1e16)).toBe("1e+16");
    expect(formatNumber(1.5e300)).toBe("1.5e+300");
    expect(quote('a/b "c" \\ \n\t\r\b\f \u0001 – ž')).toBe('"a/b \\"c\\" \\\\ \\n\\t\\r\\b\\f \\u0001 – ž"');
  });

  test("lenient decoding: defaults, the `group` alias, lower-case UUIDs and errors with a path", () => {
    const device = newUUID().toLowerCase();
    const port = newUUID().toLowerCase();
    const project = decodeProject(`{
      "devices": [{ "id": "${device}", "category": "router", "hostname": "R1", "position": {"x": 1, "y": 2},
        "ports": [{ "id": "${port}", "name": "Gi0/0", "connector": "RJ45", "groupIndex": 1 }],
        "layout": { "sections": [ { "group": 1, "label": null }, { "groups": [0], "row": 0 } ] },
        "addresses": [{ "interface": "port:${port}", "address": "10.0.0.1/24" }, { "interface": "vlan:+7", "address": "x" }] }]
    }`);
    const r1 = project.devices[0];
    expect(r1.id).toBe(device.toUpperCase());
    expect(r1.layout).toEqual({
      rows: 1,
      sections: [
        { groups: [1], arrangement: "singleRow" },
        { groups: [0], arrangement: "singleRow", row: 0 },
      ],
    });
    expect(r1.addresses.map((entry) => entry.interface)).toEqual([`port:${port.toUpperCase()}`, "vlan:7"]);
    expect(project.name).toBe("");
    expect(project.formatVersion).toBe(1);

    const missing = expectEditError(() => decodeProject('{"devices": [{"id": "x"}]}'), "invalidFile");
    expect(missing.detail).toBe("poškozená data (devices.[0].id).");
    const noHost = expectEditError(
      () => decodeProject(`{"devices": [{"id": "${device}", "category": "PC", "position": {"x": 0, "y": 0}}]}`),
      "invalidFile",
    );
    expect(noHost.detail).toBe("chybí položka „hostname“ (devices.[0]).");
    expect(noHost.message).toBe(
      "Soubor není platný projekt NetSketch (obsah se nepodařilo načíst). Podrobnosti: chybí položka „hostname“ (devices.[0]).",
    );
    const wrongType = expectEditError(() => decodeProject('{"name": 5}'), "invalidFile");
    expect(wrongType.detail).toBe("neočekávaná hodnota (name).");
    expect(expectEditError(() => decodeProject("[]"), "invalidFile").detail).toBe("neočekávaná hodnota (kořen dokumentu).");
    expect(expectEditError(() => decodeProject("{"), "invalidFile").cause).toBeDefined();
    expect(() => decodeProject('{"viewMode": "3d"}')).toThrow(EditError);
  });

  test("issue sentences and the repair summary are Czech", () => {
    const store = buildTriangle();
    const project = store.project;
    const sw1 = required(deviceByHostname(project, "SW1"));
    const issue: ProjectIssue = { kind: "portUsedTwice", ref: required(refOfPortNamed(sw1, "Fa0/1")) };
    expect(issueSentence(issue, project)).toBe("Port se dvěma kabely (Fa0/1 na zařízení SW1).");
    expect(issueSentence({ kind: "bundleTooSmall", bundleID: project.bundles[0].id }, project)).toBe(
      "Svazek s méně než dvěma kabely (svazek Po1 / bond1).",
    );
    expect(issueSentence({ kind: "duplicateID", id: "X" })).toBe("Dva objekty se stejným identifikátorem.");
    expect(repairSummary([])).toBe("");
    expect(repairSummary([issue, issue, { kind: "linkWithinDevice", linkID: "L" }])).toBe(
      "Při otevření bylo opraveno 3 nekonzistence (port se dvěma kabely, kabel s oběma konci na jednom zařízení). " +
        "Chybné objekty byly vynechány; původní soubor se změní až po uložení.",
    );
  });

  test("open, edit and save keep the file format of the Swift app", () => {
    const store = buildTriangle();
    const text = store.serialize();
    const reopened = makeStore();
    reopened.openText(text, "trojuhelnik.netsketch");
    expect(reopened.serialize()).toBe(text);
    reopened.setLinkNote(reopened.project.links[0].id, "nový");
    expect(reopened.isDirty).toBe(true);
    reopened.setLinkNote(reopened.project.links[0].id, "");
    expect(reopened.isDirty).toBe(false);
    expect(reopened.serialize()).toBe(text);
  });
});
