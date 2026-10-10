// Port of the RouterOS part (RouterOSTests) of Tests/NetSketchCLITests/DellAndRouterOSTests.swift,
// plus checks of the exact RouterOS output formats.

import type { Device, Port } from "../../src/core/model";
import { ProjectStore } from "../../src/core/store";
import { CLISession } from "../../src/cli/session";

const hapLite = "mikrotik-hap-lite";

function makeSession(templateID: string, hostname?: string) {
  const store = new ProjectStore();
  store.snapToGrid = false;
  const device = store.addDevice(templateID, { x: 100, y: 100 }, hostname);
  return { store, device, cli: new CLISession(store, device.id) };
}

function device(store: ProjectStore, hostname: string): Device {
  const found = store.project.devices.find((item) => item.hostname === hostname);
  if (!found) throw new Error(`missing device ${hostname}`);
  return found;
}

function port(store: ProjectStore, hostname: string, name: string): Port {
  const found = device(store, hostname).ports.find((item) => item.name === name);
  if (!found) throw new Error(`missing port ${hostname} ${name}`);
  return found;
}

describe("RouterOS console", () => {
  test("menus and prompts", () => {
    const { cli } = makeSession(hapLite);
    expect(cli.dialect).toBe("routerOS");
    expect(cli.prompt).toBe("[admin@R1] > ");
    cli.execute("/interface");
    expect(cli.prompt).toBe("[admin@R1] /interface> ");
    cli.execute("ethernet");
    expect(cli.prompt).toBe("[admin@R1] /interface ethernet> ");
    cli.execute("..");
    expect(cli.prompt).toBe("[admin@R1] /interface> ");
    cli.execute("/");
    expect(cli.prompt).toBe("[admin@R1] > ");
    expect(cli.execute("foo")).toBe("bad command name foo (line 1 column 1)");
    cli.execute("/quit");
    expect(cli.isClosed).toBe(true);
    expect(cli.execute("/interface print")).toBe("");
  });

  test("slashes separate menu names and errors report the column", () => {
    const { cli } = makeSession(hapLite);
    cli.execute("/interface/ethernet");
    expect(cli.prompt).toBe("[admin@R1] /interface ethernet> ");
    expect(cli.execute("/ip  bogus")).toBe("bad command name bogus (line 1 column 6)");
    expect(cli.execute("/quit now")).toBe("expected end of command (line 1 column 7)");
    expect(cli.execute("# a comment")).toBe("");
    expect(cli.execute("\u001a")).toBe("");
  });

  test("comments and disabling", () => {
    const { store, cli } = makeSession(hapLite);
    cli.execute("/interface ethernet");
    cli.execute("set ether1 comment=WAN");
    cli.execute("disable ether2");
    expect(port(store, "R1", "ether1").description).toBe("WAN");
    expect(port(store, "R1", "ether2").adminDown).toBe(true);
    cli.execute('comment ether3 "to the printer"');
    expect(port(store, "R1", "ether3").description).toBe("to the printer");
    cli.execute("enable ether2");
    expect(port(store, "R1", "ether2").adminDown).toBe(false);

    const listing = cli.execute("print");
    expect(listing).toContain(";;; WAN");
    expect(listing).not.toContain("wlan1");
    expect(cli.execute("/interface print")).toContain("wlan1");
  });

  test("print shows flags, comments and types", () => {
    const { cli } = makeSession(hapLite);
    cli.execute("/interface set ether1 comment=WAN");
    cli.execute("/interface disable ether2");
    const lines = cli.execute("/interface print").split("\n");
    expect(lines[0]).toBe("Flags: X - disabled, R - running");
    expect(lines[1]).toBe(" #    NAME                                TYPE");
    expect(lines[2]).toBe(" 0    ;;; WAN");
    expect(lines[3]).toBe("      ether1                              ether");
    expect(lines[4]).toBe(" 1 X  ether2                              ether");
    expect(lines[lines.length - 1]).toBe(
      "NetSketch: příznak R (running) plyne jen z kabeláže v diagramu a z příznaku disabled.",
    );
    const ethernet = cli.execute("/interface ethernet print").split("\n");
    expect(ethernet[1]).toBe(" #    NAME");
    expect(ethernet[3]).toBe("      ether1");
  });

  test("set is one undo step", () => {
    const { store, cli } = makeSession(hapLite);
    const before = structuredClone(store.project);
    cli.execute("/interface set ether1,ether2 comment=LAN disabled=yes");
    expect(port(store, "R1", "ether2").description).toBe("LAN");
    expect(port(store, "R1", "ether1").adminDown).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.project).toEqual(before);
  });

  test("set by number, by find and with unstored properties", () => {
    const { store, cli } = makeSession(hapLite);
    expect(cli.execute("/interface set 0,2 comment=X")).toBe("");
    expect(port(store, "R1", "ether1").description).toBe("X");
    expect(port(store, "R1", "ether3").description).toBe("X");
    expect(cli.execute("/interface set [ find default-name=ether4 ] disabled=yes")).toBe("");
    expect(port(store, "R1", "ether4").adminDown).toBe(true);
    expect(cli.execute("/interface set ether1 mtu=1500")).toBe(
      "NetSketch: příkaz „mtu“ je rozpoznán, ale neukládá se – diagram pro něj nemá datové pole. Nic se nezměnilo.",
    );
    expect(cli.execute("/interface set ether1 disabled=maybe")).toBe("invalid value for argument disabled");
    expect(cli.execute("/interface set ether1 bogus=1")).toBe("expected end of command (line 1 column 23)");
    expect(cli.execute("/interface set 99 comment=X")).toBe("no such item");
    expect(cli.execute("/interface set comment=X")).toBe("missing value(s) of argument(s) numbers");
  });

  test("identity", () => {
    const { store, device: added, cli } = makeSession(hapLite);
    cli.execute("/system identity set name=GW");
    expect(store.project.devices.find((item) => item.id === added.id)?.hostname).toBe("GW");
    expect(cli.prompt).toBe("[admin@GW] > ");
    expect(cli.execute("/system identity print")).toBe("  name: GW");
    expect(cli.execute("/export")).toContain("set name=GW");
    expect(cli.execute('/system identity set name=""')).toBe(
      "NetSketch: název zařízení nesmí být prázdný, nic se nezměnilo.",
    );
    expect(device(store, "GW").hostname).toBe("GW");
  });

  test("export quotes values that need it", () => {
    const { cli } = makeSession(hapLite);
    cli.execute('/interface set ether1 comment="to the $ server"');
    cli.execute("/interface disable ether2");
    const exported = cli.execute("/export").split("\n");
    expect(exported[0]).toBe("# NetSketch: export z dat diagramu (MikroTik hAP lite (RB941-2nD)); nic se nesimuluje");
    expect(exported).toContain("/interface ethernet");
    expect(exported).toContain('set [ find default-name=ether1 ] comment="to the \\$ server"');
    expect(exported).toContain("set [ find default-name=ether2 ] disabled=yes");
    expect(exported.slice(-2)).toEqual(["/system identity", "set name=R1"]);
  });

  test("help and completion", () => {
    const { cli } = makeSession(hapLite);
    expect(cli.complete("/int")).toEqual(["interface"]);
    expect(cli.help("")).toContain("interface -- Interface configuration");
    cli.execute("/interface");
    expect(cli.complete("set eth")).toContain("ether1");
    expect(cli.help("..")).toBe(".. -- Go up to the parent menu");
    expect(cli.help("bogus ")).toBe("NetSketch: k tomuto vstupu není nápověda (neznámý příkaz).");
    expect(cli.execute("?")).toContain(".. -- Go up to the parent menu");
  });

  test("an unknown item is reported", () => {
    const { store, cli } = makeSession(hapLite);
    const before = structuredClone(store.project);
    expect(cli.execute("/interface disable ether9")).toBe("input does not match any value of numbers");
    expect(store.project).toEqual(before);
  });

  test("a deleted device ends the session", () => {
    const { store, device: added, cli } = makeSession(hapLite);
    store.removeDevices([added.id]);
    expect(cli.execute("/interface print")).toBe(
      "NetSketch: zařízení už v projektu neexistuje, konzole je ukončena.",
    );
    expect(cli.isClosed).toBe(true);
    expect(cli.prompt).toBe("[admin@R1] > ");
    expect(cli.complete("/int")).toEqual([]);
  });
});
