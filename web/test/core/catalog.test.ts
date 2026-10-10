// Port of Tests/NetSketchCoreTests/CatalogTests.swift.

import { Catalog, decodeTemplates, encodeTemplates, type CatalogStorage } from "../../src/core/catalog";
import { deviceCategories } from "../../src/core/enums";
import { CatalogError } from "../../src/core/errors";
import { DecodeError } from "../../src/core/json-decode";
import { normalizeLayout } from "../../src/core/panel-layout";
import { namedGroup, numberedGroup, portNames } from "../../src/core/port-group";
import {
  makePorts,
  makeTemplate,
  templateNeedsVerification,
  templatePanelGrid,
  templatePortCount,
} from "../../src/core/template";
import { allTemplateIDs, required, TemplateID } from "./support";

/** Stands in for the Application Support directory of the Swift tests. */
class MemoryStorage implements CatalogStorage {
  text: string | null = null;
  backupText: string | null = null;
  load(): string | null {
    return this.text;
  }
  save(text: string): void {
    this.text = text;
  }
  backup(text: string): void {
    this.backupText = text;
  }
}

function expectCatalogError(body: () => unknown, code: CatalogError["code"], id?: string): void {
  let caught: unknown;
  try {
    body();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CatalogError);
  expect((caught as CatalogError).code).toBe(code);
  if (id !== undefined) expect((caught as CatalogError).id).toBe(id);
}

describe("CatalogTests", () => {
  const catalog = new Catalog();

  test("loads from bundle", () => {
    expect(catalog.loadIssues).toEqual([]);
    expect(catalog.builtInSource).toBe("bundle");
    expect(catalog.custom).toEqual([]);
    expect(catalog.templates.length).toBe(allTemplateIDs.length);
    for (const id of allTemplateIDs) {
      expect(catalog.template(id), `missing template ${id}`).toBeDefined();
    }
    expect(catalog.template("does-not-exist")).toBeUndefined();
  });

  test("everything is unverified", () => {
    for (const template of catalog.templates) {
      expect(template.verified, `${template.id} must be unverified`).toBe(false);
      expect(template.isCustom).toBe(false);
      expect(templateNeedsVerification(template)).toBe(true);
      expect(template.portGroups.length).toBeGreaterThan(0);
      for (const group of template.portGroups) {
        expect(group.verified, `${template.id} / ${group.prefix} must be unverified`).toBe(false);
      }
      expect(makePorts(template).every((port) => !port.verified)).toBe(true);
    }
  });

  test("categories and grouping", () => {
    expect(catalog.template(TemplateID.c3650)?.category).toBe("L3 switch");
    expect(catalog.template(TemplateID.isr4321)?.category).toBe("router");
    expect(catalog.template(TemplateID.c2960_24)?.category).toBe("switch");
    expect(catalog.template(TemplateID.pc)?.category).toBe("PC");
    expect(catalog.template(TemplateID.server)?.category).toBe("server");
    expect(catalog.template(TemplateID.accessPoint)?.category).toBe("AP");

    const groups = catalog.groups;
    expect(groups.map((group) => group.category)).toEqual(deviceCategories);
    expect(groups.reduce((sum, group) => sum + group.templates.length, 0)).toBe(catalog.templates.length);
    for (const group of groups) {
      expect(group.templates.every((template) => template.category === group.category)).toBe(true);
      expect(group.templates).toEqual(catalog.templatesIn(group.category));
    }
  });

  test("port names are unique and every port has a slot", () => {
    for (const template of catalog.templates) {
      const ports = makePorts(template);
      expect(ports.length).toBe(templatePortCount(template));
      expect(new Set(ports.map((port) => port.name)).size, `${template.id} has duplicate port names`).toBe(ports.length);
      expect(new Set(ports.map((port) => port.id)).size).toBe(ports.length);

      const grid = templatePanelGrid(template);
      expect(grid.slots.length, `${template.id}: one slot per port`).toBe(ports.length);
      expect(grid.slots.map((slot) => slot.portIndex)).toEqual(ports.map((_, index) => index));
      expect(grid.rows).toBe(template.layout.rows);
      expect(grid.width).toBeGreaterThan(0);
      const cells = new Set(grid.slots.map((slot) => `${slot.x}/${slot.row}`));
      expect(cells.size, `${template.id}: two ports share a cell`).toBe(ports.length);
      expect(
        grid.slots.every((slot) => slot.row >= 0 && slot.row < grid.rows && slot.x >= 0 && slot.x + 1 <= grid.width),
      ).toBe(true);
      // The layout stored in the catalog is already normalized.
      expect(template.layout).toEqual(normalizeLayout(template.layout, template.portGroups));
    }
  });

  test("decodes from arbitrary data", () => {
    const wrapped = `{"templates": [{"id": "x-1", "vendor": "X", "model": "One", "category": "switch",
      "portGroups": [{"prefix": "p", "rangeStart": 1, "rangeEnd": 3, "speed": "1G", "connector": "RJ45"}]}]}`;
    const fromWrapped = decodeTemplates(wrapped);
    expect(fromWrapped.length).toBe(1);
    expect(portNames(fromWrapped[0].portGroups[0])).toEqual(["p1", "p2", "p3"]);
    expect(fromWrapped[0].verified).toBe(false);
    expect(fromWrapped[0].portGroups[0].verified).toBe(false);
    expect(fromWrapped[0].layout.sections.length).toBe(1);

    const bare = `[{"vendor": "Acme Č", "model": "Švitch 8", "category": "L3 switch", "portGroups": []}]`;
    const fromBare = decodeTemplates(bare);
    expect(fromBare[0].id).toBe("acme-c-svitch-8");
    expect(fromBare[0].category).toBe("L3 switch");

    const roundTrip = decodeTemplates(encodeTemplates(catalog.templates));
    expect(roundTrip).toEqual(catalog.templates);

    const other = new Catalog({ builtIn: [] });
    other.loadBuiltIn(wrapped);
    expect(other.templates.map((template) => template.id)).toEqual(["x-1"]);
    expect(other.builtInSource).toBe("provided");
    expect(() => decodeTemplates("nonsense")).toThrow(DecodeError);
  });

  test("custom templates persist in the storage", () => {
    const storage = new MemoryStorage();

    const first = new Catalog({ storage });
    expect(first.custom).toEqual([]);
    expect(first.loadIssues).toEqual([]);

    const template = makeTemplate({
      id: first.uniqueID("Acme", "Lab Switch 10"),
      vendor: "Acme",
      model: "Lab Switch 10",
      category: "switch",
      portGroups: [
        numberedGroup({ prefix: "ge-0/0/", rangeStart: 0, rangeEnd: 7, speed: "1G", connector: "RJ45", verified: true }),
        numberedGroup({ prefix: "xe-0/1/", rangeStart: 0, rangeEnd: 1, speed: "10G", connector: "SFP+" }),
        namedGroup(["con0"], "", "console"),
      ],
      verified: true,
      note: "vlastní šablona",
    });
    const added = first.addCustom(template);
    expect(added.id).toBe("acme-lab-switch-10");
    expect(added.isCustom).toBe(true);
    expect(first.template(added.id)).toEqual(added);
    expect(storage.text).not.toBeNull();
    expectCatalogError(() => first.addCustom(template), "duplicateID", added.id);

    // A second catalog on the same storage sees it.
    const second = new Catalog({ storage });
    expect(second.custom).toEqual([added]);
    expect(makePorts(required(second.template(added.id))).map((port) => port.name).slice(0, 2)).toEqual([
      "ge-0/0/0",
      "ge-0/0/1",
    ]);
    expect(second.templatesIn("switch").at(-1)).toEqual(added);
    expect(second.uniqueID("Acme", "Lab Switch 10")).toBe("acme-lab-switch-10-2");

    second.updateCustom({ ...added, model: "Lab Switch 10 rev B" });
    expect(new Catalog({ storage }).template(added.id)?.model).toBe("Lab Switch 10 rev B");

    // Built-ins are protected; unknown ids are reported.
    const builtIn = required(second.template(TemplateID.pc));
    expectCatalogError(() => second.updateCustom(builtIn), "notCustom", TemplateID.pc);
    expectCatalogError(() => second.removeCustom(TemplateID.pc), "notCustom", TemplateID.pc);
    expectCatalogError(() => second.addCustom(builtIn), "duplicateID", TemplateID.pc);
    expectCatalogError(() => second.removeCustom("nope"), "unknownTemplate", "nope");

    second.removeCustom(added.id);
    expect(new Catalog({ storage }).custom).toEqual([]);
  });

  test("override replaces the bundled catalog", () => {
    const override = new MemoryStorage();
    const only = makeTemplate({
      vendor: "Only",
      model: "One",
      category: "PC",
      portGroups: [namedGroup(["eth0"], "1G", "RJ45")],
    });
    override.text = encodeTemplates([only]);
    const overridden = new Catalog({ override });
    expect(overridden.builtIn.map((template) => template.id)).toEqual(["only-one"]);
    expect(overridden.builtInSource).toBe("override");
    expect(overridden.loadIssues).toEqual([]);

    // A broken override falls back to the bundle and reports the problem.
    override.text = "{ not json";
    const fallback = new Catalog({ override });
    expect(fallback.builtInSource).toBe("bundle");
    expect(fallback.builtIn.length).toBe(allTemplateIDs.length);
    expect(fallback.loadIssues.length).toBe(1);
    expect(fallback.loadIssues[0]).toContain("poškozená data");
  });

  test("unreadable custom storage is kept as backup", () => {
    const storage = new MemoryStorage();
    storage.text = "broken";

    const catalog = new Catalog({ storage });
    expect(catalog.custom).toEqual([]);
    expect(catalog.loadIssues.length).toBe(1);
    catalog.addCustom(makeTemplate({ vendor: "A", model: "B", category: "PC", portGroups: [] }));
    expect(storage.backupText).toBe("broken");
    expect(new Catalog({ storage }).custom.map((template) => template.id)).toEqual(["a-b"]);
  });
});

describe("Catalog (web additions)", () => {
  test("duplicate ids are reported in Czech and the first one wins", () => {
    const override = { load: () => encodeTemplates([
      makeTemplate({ id: "dup", vendor: "A", model: "First", category: "PC", portGroups: [] }),
      makeTemplate({ id: "dup", vendor: "B", model: "Second", category: "PC", portGroups: [] }),
    ]) };
    const catalog = new Catalog({ override });
    expect(catalog.builtIn.map((template) => template.model)).toEqual(["First"]);
    expect(catalog.loadIssues).toEqual(["Šablona zařízení s duplicitním identifikátorem „dup“ byla vynechána."]);
  });

  test("an empty model is refused, a blank id is derived", () => {
    const catalog = new Catalog();
    expectCatalogError(
      () => catalog.addCustom({ id: "", vendor: "X", model: "  ", category: "PC", portGroups: [] }),
      "invalidTemplate",
    );
    const added = catalog.addCustom({ id: " ", vendor: "Generic", model: "PC", category: "PC", portGroups: [] });
    expect(added.id).toBe("generic-pc-2");
  });

  test("changes are announced and cached lists keep their identity until then", () => {
    const catalog = new Catalog();
    let calls = 0;
    const unsubscribe = catalog.subscribe(() => {
      calls += 1;
    });
    const templates = catalog.templates;
    const groups = catalog.groups;
    expect(catalog.templates).toBe(templates);
    expect(catalog.groups).toBe(groups);
    const version = catalog.version;
    catalog.addCustom(makeTemplate({ vendor: "Lab", model: "Box", category: "server", portGroups: [] }));
    expect(calls).toBe(1);
    expect(catalog.version).toBe(version + 1);
    expect(catalog.templates).not.toBe(templates);
    expect(catalog.groups.at(-1)?.templates.at(-1)?.id).toBe("lab-box");
    unsubscribe();
    catalog.removeCustom("lab-box");
    expect(calls).toBe(1);
  });

  test("a failing storage leaves the catalog unchanged", () => {
    const storage: CatalogStorage = {
      load: () => null,
      save: () => {
        throw new Error("quota exceeded");
      },
    };
    const catalog = new Catalog({ storage });
    expect(() => catalog.addCustom(makeTemplate({ vendor: "A", model: "B", category: "PC", portGroups: [] }))).toThrow(
      "quota exceeded",
    );
    expect(catalog.custom).toEqual([]);
  });

  test("custom storage text is a catalog document like the Swift custom-devices.json", () => {
    const storage = new MemoryStorage();
    const catalog = new Catalog({ storage });
    catalog.addCustom(
      makeTemplate({
        vendor: "Acme",
        model: "S1",
        category: "switch",
        portGroups: [numberedGroup({ prefix: "swp", rangeStart: 1, rangeEnd: 3, step: 2, suffix: "s0", speed: "10G", connector: "SFP+" })],
      }),
    );
    const text = required(storage.text);
    expect(text.startsWith('{\n  "formatVersion" : 1,\n  "templates" : [\n')).toBe(true);
    expect(text).toContain('"step" : 2');
    expect(text).toContain('"suffix" : "s0"');
    expect(text).toContain('"isCustom" : true');
    expect(text).not.toContain('"placeholder"');
  });
});
