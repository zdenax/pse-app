// Port of Tests/NetSketchCoreTests/PortNamingTests.swift.

import { Catalog } from "../../src/core/catalog";
import {
  automaticLayout,
  blockGap,
  defaultPlaceholderWidth,
  devicePanelGrid,
  gridForPorts,
  makePanelLayout,
  makePanelSection,
  normalizeLayout,
  panelGrid,
  sectionGap,
  slotForPortIndex,
} from "../../src/core/panel-layout";
import { isPlaceholder, namedGroup, numberedGroup, placeholderGroup, portCount, portNames } from "../../src/core/port-group";
import { shortName } from "../../src/core/port-naming";
import { makeDevice, makePorts, makeTemplate, templatePanelGrid, templateSlug } from "../../src/core/template";
import { required, TemplateID } from "./support";

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("PortNamingTests", () => {
  const catalog = new Catalog();

  test("Cisco 2960 port names", () => {
    const template = required(catalog.template(TemplateID.c2960_24));
    const names = makePorts(template).map((port) => port.name);
    expect(names.slice(0, 24)).toEqual(range(1, 24).map((n) => `Fa0/${n}`));
    expect(names.slice(24)).toEqual(["Gi0/1", "Gi0/2", "Console"]);
    expect(portNames(template.portGroups[0])[0]).toBe("Fa0/1");
    expect(portNames(template.portGroups[0]).at(-1)).toBe("Fa0/24");
    expect(portCount(template.portGroups[0])).toBe(24);

    const big = required(catalog.template(TemplateID.c2960_48));
    const bigNames = makePorts(big).map((port) => port.name);
    expect(bigNames.slice(0, 48)).toEqual(range(1, 48).map((n) => `Fa0/${n}`));
    expect(bigNames.slice(48)).toEqual(["Gi0/1", "Gi0/2", "Console"]);
  });

  test("Dell S3048 port names", () => {
    const template = required(catalog.template(TemplateID.dellS3048));
    expect(template.portGroups.map(portCount)).toEqual([48, 4, 2, 1, 1]);
    expect(portNames(template.portGroups[0])).toEqual(range(1, 48).map((n) => `GigabitEthernet 1/${n}`));
    expect(portNames(template.portGroups[1])).toEqual(range(49, 52).map((n) => `TenGigabitEthernet 1/${n}`));
    expect(portNames(template.portGroups[2])).toEqual(["fortyGigE 1/53", "fortyGigE 1/55"]);
    expect(template.portGroups.map((group) => group.connector)).toEqual(["RJ45", "SFP+", "QSFP+", "mgmt", "console"]);
    expect(template.portGroups.slice(0, 3).map((group) => group.speed)).toEqual(["1G", "10G", "40G"]);

    const ports = makePorts(template);
    expect(ports.length).toBe(56);
    expect(ports.filter((port) => port.connector === "RJ45").length).toBe(48);
    expect(ports.filter((port) => port.connector === "SFP+").length).toBe(4);
    const qsfp = ports.filter((port) => port.connector === "QSFP+");
    expect(qsfp.map((port) => port.name)).toEqual(["fortyGigE 1/53", "fortyGigE 1/55"]);
    expect(qsfp.map((port) => shortName(port.name))).toEqual(["Fo1/53", "Fo1/55"]);
    expect(shortName(ports[0].name)).toBe("Gi1/1");
    expect(shortName(ports[48].name)).toBe("Te1/49");
    expect(ports[48].groupIndex).toBe(1);
  });

  test("other templates", () => {
    const hapPorts = makePorts(required(catalog.template(TemplateID.hapLite)));
    expect(hapPorts.map((port) => port.name)).toEqual(["ether1", "ether2", "ether3", "ether4", "wlan1"]);
    expect(hapPorts.slice(0, 4).every((port) => port.speed === "100M" && port.connector === "RJ45")).toBe(true);
    expect(hapPorts[4].connector).toBe("wireless");
    expect(hapPorts.map((port) => shortName(port.name))).toEqual(hapPorts.map((port) => port.name));

    const c3650 = makePorts(required(catalog.template(TemplateID.c3650)));
    expect(c3650.slice(0, 24).map((port) => port.name)).toEqual(range(1, 24).map((n) => `Gi1/0/${n}`));
    expect(c3650.filter((port) => port.connector === "SFP").map((port) => port.name)).toEqual([
      "Gi1/1/1",
      "Gi1/1/2",
      "Gi1/1/3",
      "Gi1/1/4",
    ]);
    expect(c3650.some((port) => port.connector === "console")).toBe(true);
    expect(c3650.some((port) => port.connector === "mgmt")).toBe(true);

    const isr = required(catalog.template(TemplateID.isr4321));
    expect(makePorts(isr).map((port) => port.name)).toEqual(["Gi0/0/0", "Gi0/0/1", "Console"]);
    expect(isPlaceholder(isr.portGroups[1])).toBe(true);
    expect(portNames(isr.portGroups[1])).toEqual([]);
    const bay = required(templatePanelGrid(isr).sections.find((section) => section.isPlaceholder));
    expect(bay.label).toBe("NIM");
    expect(bay.width).toBe(4);

    const crs = makePorts(required(catalog.template(TemplateID.crs)));
    expect(crs.map((port) => port.name)).toEqual([...range(1, 8).map((n) => `ether${n}`), "sfp1", "sfp2"]);

    const udm = makePorts(required(catalog.template(TemplateID.udmPro)));
    expect(udm.map((port) => port.name)).toEqual([...range(1, 8).map((n) => `LAN ${n}`), "WAN", "WAN SFP+", "LAN SFP+"]);
    expect(udm.slice(-2).every((port) => port.connector === "SFP+")).toBe(true);

    const unifi = makePorts(required(catalog.template(TemplateID.unifi24)));
    expect(unifi.filter((port) => port.connector === "RJ45").length).toBe(24);
    expect(unifi.filter((port) => port.connector === "SFP").length).toBe(2);

    expect(makePorts(required(catalog.template(TemplateID.pc))).map((port) => port.name)).toEqual(["eth0"]);
    expect(makePorts(required(catalog.template(TemplateID.server))).map((port) => port.name)).toEqual([
      "eth0",
      "eth1",
      "mgmt0",
    ]);
    expect(makePorts(required(catalog.template(TemplateID.accessPoint))).map((port) => port.name)).toEqual([
      "eth0",
      "wlan0",
    ]);
  });

  test("port group generation", () => {
    const stepped = numberedGroup({
      prefix: "fortyGigE 1/",
      rangeStart: 53,
      rangeEnd: 55,
      step: 2,
      speed: "40G",
      connector: "QSFP+",
    });
    expect(portNames(stepped)).toEqual(["fortyGigE 1/53", "fortyGigE 1/55"]);
    const suffixed = numberedGroup({ prefix: "swp", rangeStart: 1, rangeEnd: 2, suffix: "s0", speed: "10G", connector: "SFP+" });
    expect(portNames(suffixed)).toEqual(["swp1s0", "swp2s0"]);
    const named = namedGroup(["WAN", "DMZ"], "1G", "RJ45");
    expect(portNames(named)).toEqual(["WAN", "DMZ"]);
    expect(portCount(placeholderGroup("NIM"))).toBe(0);
  });

  test("short names", () => {
    const cases: [string, string][] = [
      ["GigabitEthernet 1/1", "Gi1/1"],
      ["TenGigabitEthernet 1/49", "Te1/49"],
      ["fortyGigE 1/53", "Fo1/53"],
      ["FastEthernet0/1", "Fa0/1"],
      ["GigabitEthernet1/0/24", "Gi1/0/24"],
      ["ManagementEthernet 1/1", "Ma1/1"],
      ["HundredGigE 1/1/1", "Hu1/1/1"],
      ["Ethernet1/1", "Eth1/1"],
      ["Port-channel1", "Po1"],
      // Already short or not an interface type: unchanged.
      ["ether1", "ether1"],
      ["Fa0/1", "Fa0/1"],
      ["Gi1/0/1", "Gi1/0/1"],
      ["Te1/49", "Te1/49"],
      ["eth0", "eth0"],
      ["wlan1", "wlan1"],
      ["LAN 3", "LAN 3"],
      ["WAN SFP+", "WAN SFP+"],
      ["Console", "Console"],
      ["Ethernet", "Ethernet"],
    ];
    for (const [long, short] of cases) {
      expect(shortName(long), long).toBe(short);
    }
  });

  test("panel grid of a 2960", () => {
    const template = required(catalog.template(TemplateID.c2960_24));
    const device = makeDevice(template, "SW1", { x: 0, y: 0 });
    const grid = devicePanelGrid(device);
    expect(grid).toEqual(templatePanelGrid(template));
    expect(grid.rows).toBe(2);
    expect(grid.sections.length).toBe(3);

    // Odd ports on top, even ports below, column by column.
    const fa1 = required(slotForPortIndex(grid, 0));
    const fa2 = required(slotForPortIndex(grid, 1));
    const fa3 = required(slotForPortIndex(grid, 2));
    expect(fa1.row === 0 && fa1.x === 0).toBe(true);
    expect(fa2.row === 1 && fa2.x === 0).toBe(true);
    expect(fa3.row === 0 && fa3.x === 1).toBe(true);
    // A block gap after six columns (twelve ports).
    const fa13 = required(slotForPortIndex(grid, 12));
    expect(fa13.column).toBe(6);
    expect(fa13.x).toBe(6 + blockGap);

    // Uplinks: single row at the bottom, after a section gap. Console: top row.
    const gi1 = required(slotForPortIndex(grid, 24));
    const gi2 = required(slotForPortIndex(grid, 25));
    const consolePort = required(slotForPortIndex(grid, 26));
    expect(gi1.row === 1 && gi2.row === 1).toBe(true);
    expect(gi1.x).toBe(grid.sections[0].x + grid.sections[0].width + sectionGap);
    expect(gi2.x).toBe(gi1.x + 1);
    expect(consolePort.row).toBe(0);
    expect(grid.sections[1].label).toBe("Uplink");
    expect(grid.width).toBe(consolePort.x + 1);
  });

  test("layout normalization and fallbacks", () => {
    const groups = [
      numberedGroup({ prefix: "p", rangeStart: 1, rangeEnd: 16, speed: "1G", connector: "RJ45" }),
      numberedGroup({ prefix: "s", rangeStart: 1, rangeEnd: 2, speed: "10G", connector: "SFP+", label: "Uplink" }),
      placeholderGroup("Bay"),
    ];
    const automatic = automaticLayout(groups);
    expect(automatic.rows).toBe(2);
    expect(automatic.sections.map((section) => section.arrangement)).toEqual(["oddTopEvenBottom", "singleRow", "singleRow"]);
    expect(automatic.sections[2].placeholderWidth).toBe(defaultPlaceholderWidth);

    // Bad indices are dropped, unmentioned groups appended, rows raised.
    const sloppy = makePanelLayout(1, [makePanelSection([1, 7, 1], { arrangement: "topRowThenBottomRow" })]);
    const normalized = normalizeLayout(sloppy, groups);
    expect(normalized.rows).toBe(2);
    expect(normalized.sections.map((section) => section.groups)).toEqual([[1], [0], [2]]);
    expect(normalized.sections[0].label).toBe("Uplink");
    expect(normalizeLayout(normalized, groups)).toEqual(normalized);

    // A layout that knows nothing still yields a slot for every port.
    const template = makeTemplate({ vendor: "T", model: "M", category: "switch", portGroups: groups });
    const ports = makePorts(template);
    const bare = gridForPorts(makePanelLayout(), ports);
    expect(bare.slots.length).toBe(ports.length);
    expect(bare.rows).toBe(1);

    // Row-major arrangement: first half on top.
    const rowMajor = panelGrid(makePanelLayout(2, [makePanelSection([0], { arrangement: "topRowThenBottomRow" })]), [
      0, 0, 0, 0, 0, 0,
    ]);
    expect(rowMajor.slots.map((slot) => slot.row)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(rowMajor.slots.map((slot) => slot.column)).toEqual([0, 1, 2, 0, 1, 2]);
    const evenTop = panelGrid(makePanelLayout(2, [makePanelSection([0], { arrangement: "evenTopOddBottom" })]), [0, 0, 0, 0]);
    expect(evenTop.slots.map((slot) => slot.row)).toEqual([1, 0, 1, 0]);

    // A layout that was never normalized: the single-row section still lands on the bottom row.
    const raw = panelGrid(
      makePanelLayout(1, [makePanelSection([1]), makePanelSection([0], { arrangement: "oddTopEvenBottom" })]),
      [0, 0, 0, 0, 1],
    );
    expect(raw.rows).toBe(2);
    expect(slotForPortIndex(raw, 4)?.row).toBe(1);
    expect(slotForPortIndex(raw, 4)?.x).toBe(0);
    expect(raw.slots.map((slot) => slot.portIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(slotForPortIndex(raw, 0)?.x).toBe(1 + sectionGap);
  });

  test("slug", () => {
    expect(templateSlug("Dell EMC", "S3048-ON")).toBe("dell-emc-s3048-on");
    expect(templateSlug("", "  Žluťoučký kůň!  ")).toBe("zlutoucky-kun");
    expect(templateSlug("", "???")).toBe("device");
  });
});
