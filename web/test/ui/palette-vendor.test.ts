// Palette grouping: vendor first, then device category; search by vendor, model and category.

import { describe, expect, test } from "vitest";
import { filterVendorGroups, groupByVendor } from "../../src/ui/Palette";
import { FakeCatalog, sampleTemplates } from "./fakes";
import type { DeviceTemplate } from "../../src/core/model";

const noVendor: DeviceTemplate = {
  id: "mystery",
  vendor: "",
  model: "Mystery box",
  category: "switch",
  portGroups: [{ names: ["p1"], speed: "1G", connector: "RJ45" }],
};

describe("groupByVendor", () => {
  test("vendors alphabetically, categories inside in palette order, no vendor last", () => {
    const groups = groupByVendor(new FakeCatalog([...sampleTemplates, noVendor]).groups);
    expect(groups.map((group) => group.vendor)).toEqual(["Cisco", "Generic", ""]);
    expect(groups[0]!.categories.map((entry) => entry.category)).toEqual(["switch", "router"]);
    expect(groups[1]!.categories.map((entry) => entry.category)).toEqual(["AP", "PC"]);
    expect(groups[2]!.categories[0]!.templates.map((template) => template.id)).toEqual(["mystery"]);
  });
});

describe("filterVendorGroups", () => {
  const groups = groupByVendor(new FakeCatalog().groups);

  test("empty query keeps everything", () => {
    expect(filterVendorGroups(groups, "  ")).toBe(groups);
  });

  test("a vendor name matches the whole vendor", () => {
    const result = filterVendorGroups(groups, "cisco");
    expect(result.map((group) => group.vendor)).toEqual(["Cisco"]);
    expect(result[0]!.categories.flatMap((entry) => entry.templates)).toHaveLength(2);
  });

  test("a model narrows within the vendor", () => {
    const result = filterVendorGroups(groups, "4321");
    expect(result).toHaveLength(1);
    expect(result[0]!.categories.flatMap((entry) => entry.templates.map((template) => template.id))).toEqual(["cisco-isr-4321"]);
  });
});
