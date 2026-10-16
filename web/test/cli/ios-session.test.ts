// Port of Tests/NetSketchCLITests/IOSSessionTests.swift.

import { CLI, CLISession } from "../../src/cli/session";
import { CLILimits, Notices } from "../../src/cli/notices";
import type { ProjectStore } from "../../src/core/store";
import type { Device } from "../../src/core/model";
import { device, makeSession, makeStore, port, ref, run, snapshot, TemplateID } from "./support";

describe("DialectTests", () => {
  test("dialect follows vendor", () => {
    expect(CLI.dialect("Cisco", "Catalyst 2960-24", "switch")).toBe("ios");
    expect(CLI.dialect("Dell EMC", "S3048-ON", "L3 switch")).toBe("dellOS9");
    expect(CLI.dialect("MikroTik", "hAP lite", "router")).toBe("routerOS");
    expect(CLI.dialect("Ubiquiti", "UDM Pro", "router")).toBe("generic");
    expect(CLI.dialect("", "", "switch")).toBe("generic");
  });

  test("everything but access points has a console", () => {
    const store = makeStore();
    const supported = [
      TemplateID.c2960_24,
      TemplateID.c3650,
      TemplateID.isr4321,
      TemplateID.dellS3048,
      TemplateID.hapLite,
      TemplateID.udmPro,
      TemplateID.pc,
      TemplateID.server,
    ];
    for (const id of supported) {
      const added = store.addDevice(id, { x: 0, y: 0 });
      expect(CLI.supportsConsole(added), id).toBe(true);
    }
    const accessPoint = store.addDevice(TemplateID.accessPoint, { x: 0, y: 0 });
    expect(CLI.supportsConsole(accessPoint)).toBe(false);
    expect(CLI.dialect("Generic", "PC", "PC")).toBe("host");
  });

  test("session picks the engine of the dialect", () => {
    expect(makeSession(TemplateID.c2960_24)[2].dialect).toBe("ios");
    expect(makeSession(TemplateID.dellS3048)[2].dialect).toBe("dellOS9");
    expect(makeSession(TemplateID.hapLite)[2].dialect).toBe("routerOS");
    const [, , generic] = makeSession(TemplateID.udmPro);
    expect(generic.dialect).toBe("generic");
    expect(generic.banner).toContain("obecnou syntaxi ve stylu Cisco IOS");
    expect(generic.prompt).toBe("R1>");
  });
});

describe("IOSModeTests", () => {
  test("modes and prompts", () => {
    const [, , cli] = makeSession(TemplateID.c2960_24);
    expect(cli.banner).toContain("SW1");
    expect(cli.prompt).toBe("SW1>");
    cli.execute("enable");
    expect(cli.prompt).toBe("SW1#");
    expect(cli.execute("configure terminal")).toBe("Enter configuration commands, one per line.  End with CNTL/Z.");
    expect(cli.prompt).toBe("SW1(config)#");
    cli.execute("interface fa0/1");
    expect(cli.prompt).toBe("SW1(config-if)#");
    cli.execute("exit");
    expect(cli.prompt).toBe("SW1(config)#");
    cli.execute("interface range fa0/1 - 4");
    expect(cli.prompt).toBe("SW1(config-if-range)#");
    cli.execute("end");
    expect(cli.prompt).toBe("SW1#");
    cli.execute("disable");
    expect(cli.prompt).toBe("SW1>");
    expect(cli.isClosed).toBe(false);
    cli.execute("exit");
    expect(cli.isClosed).toBe(true);
    expect(cli.execute("enable")).toBe("");
  });

  test("abbreviations and Ctrl-Z", () => {
    const [, , cli] = makeSession(TemplateID.c2960_24);
    run(cli, "en", "conf t", "int gi0/2");
    expect(cli.prompt).toBe("SW1(config-if)#");
    cli.execute("\u001A");
    expect(cli.prompt).toBe("SW1#");
  });

  test("parser errors", () => {
    const [, , cli] = makeSession(TemplateID.c2960_24);
    cli.execute("enable");
    // The caret sits under the first character that fits no command; the prompt "SW1#" is 4 wide.
    expect(cli.execute("foo")).toBe("    ^\n% Invalid input detected at '^' marker.");
    expect(cli.execute("e")).toBe('% Ambiguous command:  "e"');
    expect(cli.execute("show")).toBe("% Incomplete command.");
    expect(cli.execute("   ")).toBe("");
  });

  test("help and completion", () => {
    const [, , cli] = makeSession(TemplateID.c2960_24);
    expect(cli.help("")).toContain("enable");
    expect(cli.help("")).not.toContain("configure");
    expect(cli.help("sh")).toBe("show");
    expect(cli.complete("sh")).toEqual(["show"]);
    cli.execute("enable");
    expect(cli.complete("conf")).toEqual(["configure"]);
    expect(cli.complete("show run")).toEqual(["running-config"]);
    // "?" typed at the end of a line asks for help instead of running the command.
    expect(cli.execute("conf?")).toBe("configure");
    expect(cli.prompt).toBe("SW1#");
  });

  test("pasted block runs line by line", () => {
    const [store, , cli] = makeSession(TemplateID.c2960_24);
    cli.execute("enable\nconfigure terminal\nhostname CORE\ninterface fa0/3\ndescription Tiskarna\nend");
    expect(cli.prompt).toBe("CORE#");
    expect(port(store, "CORE", "Fa0/3").description).toBe("Tiskarna");
  });

  test("overlong line is refused", () => {
    const [, , cli] = makeSession(TemplateID.c2960_24);
    const line = "x".repeat(CLILimits.maxLineLength + 1);
    expect(cli.execute(line)).toBe(Notices.lineTooLong);
  });
});

describe("IOSConfigTests", () => {
  function configured(templateID: string = TemplateID.c2960_24): [ProjectStore, Device, CLISession] {
    const result = makeSession(templateID);
    run(result[2], "enable", "configure terminal");
    return result;
  }

  test("hostname renames the device", () => {
    const [store, added, cli] = configured();
    cli.execute("hostname CORE");
    expect(store.project.devices.find((item) => item.id === added.id)?.hostname).toBe("CORE");
    expect(cli.prompt).toBe("CORE(config)#");
    // A rename on the canvas shows up in the prompt at once.
    store.renameDevice(added.id, "EDGE");
    expect(cli.prompt).toBe("EDGE(config)#");
    cli.execute("no hostname");
    expect(store.project.devices.find((item) => item.id === added.id)?.hostname).toBe("Switch");
  });

  test("description and shutdown", () => {
    const [store, , cli] = configured();
    run(cli, "interface fa0/1", "description Uplink na SW2", "shutdown");
    let fa1 = port(store, "SW1", "Fa0/1");
    expect(fa1.description).toBe("Uplink na SW2");
    expect(fa1.adminDown).toBe(true);
    run(cli, "no shutdown", "no description");
    fa1 = port(store, "SW1", "Fa0/1");
    expect(fa1.description).toBe("");
    expect(fa1.adminDown).toBe(false);
  });

  test("access port creates the VLAN", () => {
    const [store, , cli] = configured();
    cli.execute("interface fa0/5");
    cli.execute("switchport mode access");
    const output = cli.execute("switchport access vlan 10");
    expect(output).toBe("% Access VLAN does not exist. Creating vlan 10");
    expect(port(store, "SW1", "Fa0/5").vlan).toBe("access 10");
    expect(device(store, "SW1").vlans).toEqual([{ id: 10, name: "" }]);
    // The second port finds the VLAN already there.
    cli.execute("interface fa0/6");
    expect(cli.execute("switchport access vlan 10")).toBe("");
    expect(port(store, "SW1", "Fa0/6").vlan).toBe("10");
  });

  test("trunk settings in any order", () => {
    const [store, , cli] = configured();
    run(
      cli,
      "interface gi0/1",
      "switchport trunk native vlan 99",
      "switchport trunk allowed vlan 10,20,30-32",
      "switchport mode trunk",
    );
    expect(port(store, "SW1", "Gi0/1").vlan).toBe("trunk 10,20,30-32 native 99");
    cli.execute("switchport trunk allowed vlan remove 31");
    expect(port(store, "SW1", "Gi0/1").vlan).toBe("trunk 10,20,30,32 native 99");
    cli.execute("switchport trunk allowed vlan add 40");
    expect(port(store, "SW1", "Gi0/1").vlan).toBe("trunk 10,20,30,32,40 native 99");
    run(cli, "no switchport trunk native vlan", "switchport trunk allowed vlan all");
    expect(port(store, "SW1", "Gi0/1").vlan).toBe("trunk");
    // Leaving trunk mode keeps nothing that would change the meaning.
    cli.execute("switchport mode access");
    expect(port(store, "SW1", "Gi0/1").vlan).toBe("access 1");
  });

  test("dynamic trunking is not simulated", () => {
    const [store, , cli] = configured();
    cli.execute("interface fa0/1");
    expect(cli.execute("switchport mode dynamic desirable")).toBe(Notices.dynamicTrunking);
    expect(port(store, "SW1", "Fa0/1").vlan).toBe("");
  });

  test("hand-typed VLAN text is replaced with a notice", () => {
    const [store, , cli] = configured();
    store.setPortVLAN(ref(store, "SW1", "Fa0/7"), "tiskárny, patro 2");
    cli.execute("interface fa0/7");
    const output = cli.execute("switchport mode access");
    expect(output.startsWith("NetSketch:")).toBe(true);
    expect(output).toContain("tiskárny, patro 2");
    expect(port(store, "SW1", "Fa0/7").vlan).toBe("access 1");
  });

  test("range is one undo step", () => {
    const [store, , cli] = configured();
    cli.execute("interface range fa0/1 - 4 , gi0/2");
    const before = snapshot(store);
    cli.execute("shutdown");
    for (const name of ["Fa0/1", "Fa0/2", "Fa0/3", "Fa0/4", "Gi0/2"]) {
      expect(port(store, "SW1", name).adminDown, name).toBe(true);
    }
    expect(port(store, "SW1", "Fa0/5").adminDown).toBe(false);
    expect(store.undo()).toBe(true);
    expect(store.project).toEqual(before);
  });

  test("VLAN database", () => {
    const [store, , cli] = configured();
    cli.execute("vlan 20");
    expect(cli.prompt).toBe("SW1(config-vlan)#");
    cli.execute("name SERVERS");
    expect(device(store, "SW1").vlans).toEqual([{ id: 20, name: "SERVERS" }]);
    expect(cli.execute("vlan 1")).toBe("");
    expect(cli.execute("name X")).toBe("%Default VLAN 1 may not have its name changed.");
    // A global command typed in a sub-mode runs and leaves the sub-mode.
    cli.execute("no vlan 20");
    expect(cli.prompt).toBe("SW1(config)#");
    expect(device(store, "SW1").vlans).toEqual([]);
    expect(cli.execute("no vlan 1")).toBe("%Default VLAN 1 may not be deleted.");
  });

  test("global command from interface mode", () => {
    const [store, , cli] = configured();
    cli.execute("interface fa0/1");
    cli.execute("hostname ACCESS1");
    expect(cli.prompt).toBe("ACCESS1(config)#");
    expect(device(store, "ACCESS1").hostname).toBe("ACCESS1");
    cli.execute("interface fa0/1");
    // An error deep inside an interface command stays an interface error.
    const output = cli.execute("switchport mode bogus");
    expect(output.endsWith("% Invalid input detected at '^' marker.")).toBe(true);
    expect(cli.prompt).toBe("ACCESS1(config-if)#");
  });

  test("virtual interfaces", () => {
    const [, , cli] = configured();
    // The port-channel is a real logical interface now (test/features/etherchannel.test.ts).
    expect(cli.execute("interface port-channel 1")).toBe("");
    expect(cli.prompt).toBe("SW1(config-if)#");
    cli.execute("exit");
    // A switch has VLAN interfaces (SVI), a router has none in the diagram.
    expect(cli.execute("interface vlan 10")).toBe("");
    expect(cli.prompt).toBe("SW1(config-if)#");
    const [, , router] = configured(TemplateID.isr4321);
    expect(router.execute("interface vlan 10")).toBe(Notices.virtualInterface);
  });

  test("unknown port number is an error", () => {
    const [, , cli] = configured();
    const output = cli.execute("interface fa0/99");
    expect(output.endsWith("% Invalid input detected at '^' marker.")).toBe(true);
    expect(cli.prompt).toBe("SW1(config)#");
  });

  test("not stored commands say so", () => {
    const [store, , cli] = configured();
    const before = snapshot(store);
    expect(cli.execute("ip domain-name lab.local").startsWith("NetSketch:")).toBe(true);
    expect(cli.execute("ip routing")).toBe("");
    expect(cli.execute("do ssh 10.0.0.1")).toBe(Notices.needsSimulation);
    expect(cli.execute("do write memory")).toBe(Notices.savedInProject);
    expect(store.project).toEqual(before);
  });

  test("default interface", () => {
    const [store, , cli] = configured();
    run(cli, "interface fa0/2", "description X", "switchport access vlan 30", "shutdown", "exit");
    expect(cli.execute("default interface fa0/2")).toBe("Interface FastEthernet0/2 set to default configuration");
    const fa2 = port(store, "SW1", "Fa0/2");
    expect(fa2.description === "" && fa2.vlan === "" && !fa2.adminDown).toBe(true);
  });
});

describe("IOSShowTests", () => {
  test("running-config follows the diagram", () => {
    const [store, , cli] = makeSession(TemplateID.c2960_24);
    run(
      cli,
      "enable",
      "configure terminal",
      "vlan 10",
      "name USERS",
      "interface fa0/1",
      "description Uplink",
      "switchport mode access",
      "switchport access vlan 10",
      "end",
    );
    // A change made in the inspector is visible without reopening the console.
    store.setPortDescription(ref(store, "SW1", "Fa0/2"), "Tiskárna");

    const config = cli.execute("show running-config");
    expect(config.startsWith("Building configuration...")).toBe(true);
    expect(config).toContain("hostname SW1");
    expect(config).toContain("vlan 10\n name USERS");
    expect(config).toContain(
      "interface FastEthernet0/1\n description Uplink\n switchport access vlan 10\n switchport mode access",
    );
    expect(config).toContain("interface FastEthernet0/2\n description Tiskárna");
    expect(config).not.toContain("Console");
    expect(config.endsWith("end")).toBe(true);
  });

  test("link state comes from the cabling", () => {
    const store = makeStore();
    store.addDevice(TemplateID.c2960_24, { x: 0, y: 0 });
    store.addDevice(TemplateID.c2960_24, { x: 400, y: 0 });
    store.connect(ref(store, "SW1", "Fa0/1"), ref(store, "SW2", "Fa0/1"));
    const sw1 = device(store, "SW1");
    const cli = new CLISession(store, sw1.id);

    expect(cli.execute("show interfaces fa0/1").startsWith("FastEthernet0/1 is up, line protocol is up (connected)")).toBe(
      true,
    );
    expect(
      cli.execute("show interfaces fa0/2").startsWith("FastEthernet0/2 is down, line protocol is down (notconnect)"),
    ).toBe(true);
    // The far end shut down: the link goes down here too.
    store.setPortAdminDown(ref(store, "SW2", "Fa0/1"), true);
    expect(cli.execute("show interfaces fa0/1").startsWith("FastEthernet0/1 is down")).toBe(true);
  });

  test("history keeps the commands", () => {
    const [, , cli] = makeSession(TemplateID.c2960_24);
    run(cli, "enable", "show version");
    const history = cli.execute("show history");
    expect(history).toContain("enable");
    expect(history).toContain("show version");
  });
});

describe("SessionLifecycleTests", () => {
  test("deleted device ends the session", () => {
    const [store, added, cli] = makeSession(TemplateID.c2960_24);
    store.removeDevice(added.id);
    expect(cli.execute("enable")).toBe(Notices.deviceGone);
    expect(cli.isClosed).toBe(true);
    expect(cli.prompt).toBe("SW1>");
    expect(cli.complete("en")).toEqual([]);
  });

  test("undo after CLI change", () => {
    const [store, , cli] = makeSession(TemplateID.c2960_24);
    run(cli, "enable", "configure terminal", "interface fa0/1");
    const before = snapshot(store);
    cli.execute("description A");
    cli.execute("description B");
    expect(store.undo()).toBe(true);
    expect(port(store, "SW1", "Fa0/1").description).toBe("A");
    expect(store.undo()).toBe(true);
    expect(store.project).toEqual(before);
  });
});
