// The Dell OS6 (DNOS 6.x, N-series) console: the lab configuration of a Dell N3024.

import { CLI, CLISession } from "../../src/cli/session";
import { device, makeSession, makeStore, port, ref, run, TemplateID } from "./support";

const n3024 = "dell-emc-n3024";
const n1124 = "dell-emc-n1124t-on";

const labConfig = [
  "enable",
  "configure",
  "hostname Dell",
  "vlan 10",
  " name LAN",
  " exit",
  "spanning-tree mode rstp",
  "spanning-tree priority 4096",
  "interface vlan 10",
  " ip address 192.168.10.3 255.255.255.0",
  " exit",
  "ip default-gateway 192.168.10.1",
  "interface gi1/0/1",
  " switchport mode trunk",
  " exit",
  "interface gi1/0/2",
  " switchport mode trunk",
  " exit",
  "interface range gi1/0/3-24",
  " switchport mode access",
  " switchport access vlan 10",
  " spanning-tree portfast",
  " exit",
  "interface range te1/0/1-2",
  " switchport mode access",
  " switchport access vlan 10",
  " exit",
  "exit",
];

describe("Dell OS6 dialect", () => {
  test("N-series templates get OS6, the S-series keeps OS9", () => {
    expect(CLI.dialect("Dell EMC", "N3024", "switch")).toBe("dellOS6");
    expect(CLI.dialect("Dell EMC", "N1124T-ON", "switch")).toBe("dellOS6");
    expect(CLI.dialect("Dell EMC", "S3048-ON", "L3 switch")).toBe("dellOS9");
    expect(makeSession(n3024)[2].dialect).toBe("dellOS6");
    expect(makeSession(n1124)[2].dialect).toBe("dellOS6");
    expect(makeSession(TemplateID.dellS3048)[2].dialect).toBe("dellOS9");
  });

  test("the OS9 console is unchanged", () => {
    const [, , cli] = makeSession(TemplateID.dellS3048, "S1");
    expect(cli.prompt).toBe("S1>");
    cli.execute("enable");
    cli.execute("configure");
    expect(cli.prompt).toBe("S1(conf)#");
    cli.execute("interface vlan 10");
    expect(cli.prompt).toBe("S1(conf-if-vl-10)#");
    expect(cli.execute("ip address 10.0.0.1/24")).toBe("");
    expect(cli.execute("foo")).toContain('% Error: Invalid input at "^" marker.');
  });
});

describe("Dell OS6 lab transcript", () => {
  test("prompts follow the modes", () => {
    const [, , cli] = makeSession(n3024, "Dell");
    expect(cli.prompt).toBe("Dell>");
    cli.execute("enable");
    expect(cli.prompt).toBe("Dell#");
    cli.execute("configure");
    expect(cli.prompt).toBe("Dell(config)#");
    cli.execute("vlan 10");
    expect(cli.prompt).toBe("Dell(config-vlan10)#");
    cli.execute("exit");
    cli.execute("interface gi1/0/1");
    expect(cli.prompt).toBe("Dell(config-if-Gi1/0/1)#");
    cli.execute("exit");
    cli.execute("interface range gi 1/0/3-24");
    expect(cli.prompt).toBe("Dell(config-if)#");
    cli.execute("end");
    expect(cli.prompt).toBe("Dell#");
  });

  test("the whole lab configuration is accepted without errors", () => {
    const [store, dell, cli] = makeSession(n3024, "Dell");
    for (const line of labConfig) {
      const output = cli.execute(line);
      if (line.startsWith("ip default-gateway")) {
        expect(output).toContain("Vlan10");
      } else {
        expect(output, line).toBe("");
      }
    }
    expect(cli.prompt).toBe("Dell#");

    const live = store.project.devices.find((d) => d.id === dell.id)!;
    expect(live.hostname).toBe("Dell");
    expect(live.vlans).toEqual([{ id: 10, name: "LAN" }]);
    expect(live.defaultGateway).toBe("192.168.10.1");
    expect(live.addresses).toEqual([{ interface: "vlan:10", address: "192.168.10.3/24" }]);
    expect(port(store, "Dell", "Gi1/0/1").vlan).toBe("trunk");
    expect(port(store, "Dell", "Gi1/0/2").vlan).toBe("trunk");
    expect(port(store, "Dell", "Gi1/0/3").vlan).toBe("access 10");
    expect(port(store, "Dell", "Gi1/0/24").vlan).toBe("access 10");
    expect(port(store, "Dell", "Te1/0/2").vlan).toBe("access 10");
    expect(live.protocols?.stp?.mode).toBe("rstp");
    expect(live.protocols?.stp?.priorities).toEqual([{ vlan: 0, priority: 4096 }]);
    expect(live.protocols?.stp?.portfast.length).toBe(22);
  });

  test("show commands after the lab configuration", () => {
    const [, , cli] = makeSession(n3024, "Dell");
    for (const line of labConfig) cli.execute(line);
    run(cli, "enable");

    const vlan = cli.execute("show vlan");
    expect(vlan).toContain("VLAN   Name");
    expect(vlan).toContain("LAN");
    expect(vlan).toContain("Gi1/0/1-24,");
    expect(vlan).toContain("Te1/0/1-2");
    expect(vlan).toMatch(/^1 +default +Gi1\/0\/1-2/m);

    const sw = cli.execute("show interfaces switchport gi1/0/1");
    expect(sw).toContain("Port: Gi1/0/1");
    expect(sw).toContain("VLAN Membership Mode: Trunk Mode");
    expect(cli.execute("show interfaces switchport gi1/0/5")).toContain("Access Mode VLAN: 10");

    const status = cli.execute("show interfaces status");
    expect(status).toContain("Gi1/0/1");
    expect(status).toContain("Trunk");

    const ip = cli.execute("show ip interface vlan 10");
    expect(ip).toContain("Primary IP Address");
    expect(ip).toContain("192.168.10.3/255.255.255.0");

    const config = cli.execute("show running-config");
    expect(config).toContain('hostname "Dell"');
    expect(config).toContain("spanning-tree priority 4096");
    expect(config).toContain("ip default-gateway 192.168.10.1");
    expect(config).toContain("interface vlan 10\nip address 192.168.10.3 255.255.255.0\nexit");
    expect(config).toContain("interface Gi1/0/1\nswitchport mode trunk\nexit");
    expect(config).toContain("interface Gi1/0/3\nswitchport mode access\nswitchport access vlan 10\nspanning-tree portfast\nexit");

    expect(cli.execute("show ip route")).toContain("Route Codes:");
    expect(cli.execute("show spanning-tree")).toContain("Bridge ID      Priority    4096");
    expect(cli.execute("show mac-address-table")).not.toBe("");
    expect(cli.execute("show arp")).not.toBe("");
  });

  test("unknown and ambiguous commands, incomplete commands", () => {
    const [, , cli] = makeSession(n3024, "Dell");
    run(cli, "enable");
    const unknown = cli.execute("show ip interface brief");
    expect(unknown).toBe(" ".repeat("Dell#".length + "show ip interface ".length) + "^\n% Invalid input detected at '^' marker.");
    expect(cli.execute("show ip interface")).toBe("% Incomplete command.");
    expect(cli.execute("show i")).toBe("% Ambiguous command.");
    expect(cli.execute("sh vl")).toContain("VLAN");
    expect(cli.execute("vlan database")).toContain("Invalid input");
    run(cli, "configure");
    expect(cli.execute("vlan database")).toBe("");
    expect(cli.prompt).toBe("Dell(Config-vlan)#");
    expect(cli.execute("vlan 30")).toBe("");
    run(cli, "exit");
    expect(cli.execute("show vlan")).toContain("VLAN0030");
  });

  test("spanning-tree priority must be a multiple of 4096", () => {
    const [, , cli] = makeSession(n3024, "Dell");
    run(cli, "enable", "configure");
    expect(cli.execute("spanning-tree priority 5000")).toContain("multiple of 4096");
    expect(cli.execute("spanning-tree priority 70000")).toContain("out of range");
    expect(cli.execute("spanning-tree priority 8192")).toBe("");
    expect(cli.execute("spanning-tree mode bogus")).toContain("Invalid input");
    expect(cli.execute("spanning-tree mode mstp")).toBe("");
    expect(cli.execute("show spanning-tree")).toContain("MSTP");
  });

  test("switchport trunk commands", () => {
    const [store, , cli] = makeSession(n1124, "SW");
    run(cli, "enable", "configure", "vlan 10,20,30", "interface gi1/0/1", "switchport mode trunk");
    expect(cli.execute("switchport trunk allowed vlan add 10,20")).toBe("");
    expect(port(store, "SW", "Gi1/0/1").vlan).toBe("trunk");
    expect(cli.execute("switchport trunk allowed vlan remove 20")).toBe("");
    expect(port(store, "SW", "Gi1/0/1").vlan).toBe("trunk 1-19,21-4094");
    expect(cli.execute("switchport trunk allowed vlan 10,30")).toBe("");
    expect(cli.execute("switchport trunk native vlan 30")).toBe("");
    expect(port(store, "SW", "Gi1/0/1").vlan).toBe("trunk 10,30 native 30");
    expect(cli.execute("switchport trunk allowed vlan all")).toBe("");
    expect(cli.execute("switchport access vlan 99")).toContain("does not exist");
    expect(cli.execute("shutdown")).toBe("");
    expect(port(store, "SW", "Gi1/0/1").adminDown).toBe(true);
    expect(cli.execute("no shutdown")).toBe("");
    expect(cli.execute("description uplink")).toBe("");
    expect(port(store, "SW", "Gi1/0/1").description).toBe("uplink");
    expect(cli.execute("interface gi1/0/99")).toBe("% Invalid interface specified.");
  });

  test("write memory asks for confirmation; clear config resets", () => {
    const [store, , cli] = makeSession(n3024, "Dell");
    for (const line of labConfig) cli.execute(line);
    expect(cli.execute("write memory")).toContain("Are you sure you want to save? (y/n)");
    expect(cli.execute("y")).toContain("Configuration Saved!");
    expect(cli.execute("copy running-config startup-config")).toContain("(y/n)");
    expect(cli.execute("n")).toContain("Not Saved");
    expect(cli.execute("clear config")).toContain("(y/n)");
    cli.execute("y");
    expect(port(store, "Dell", "Gi1/0/3").vlan).toBe("");
    expect(device(store, "Dell").vlans).toEqual([]);
  });

  test("help lists commands and abbreviations complete", () => {
    const [, , cli] = makeSession(n3024, "Dell");
    run(cli, "enable", "configure", "interface gi1/0/1");
    const help = cli.help("switchport ");
    expect(help).toContain("access");
    expect(help).toContain("mode");
    expect(help).toContain("trunk");
    expect(cli.help("switchport mode ")).toContain("trunk");
    expect(cli.complete("switchport mo")).toEqual(["mode"]);
    expect(cli.help("sw")).toContain("switchport");
  });
});

describe("Dell OS6 in the network", () => {
  test("a PC pings the management IP of the Dell, and the Dell pings the PC", () => {
    const store = makeStore();
    store.addDevice(n3024, { x: 0, y: 0 }, "Dell");
    store.addDevice(TemplateID.pc, { x: 200, y: 0 }, "PC1");
    const pcPort = device(store, "PC1").ports[0];
    store.connect(ref(store, "Dell", "Gi1/0/5"), { deviceID: device(store, "PC1").id, portID: pcPort.id });

    const dell = new CLISession(store, device(store, "Dell").id);
    for (const line of labConfig) dell.execute(line);
    store.setAddress(device(store, "PC1").id, "port:" + pcPort.id, "192.168.10.50/24");

    const pc = new CLISession(store, device(store, "PC1").id);
    expect(pc.execute("ping 192.168.10.3")).toMatch(/Reply from 192\.168\.10\.3|bytes=32/i);
    const out = dell.execute("ping 192.168.10.50");
    expect(out).toContain("Pinging 192.168.10.50 with 0 bytes of data:");
    expect(out).toContain("5 packets transmitted, 5 packets received, 0% packet loss");
    expect(dell.execute("show ip interface vlan 10")).toContain("Routing Interface Status.......................... Up");

    expect(dell.execute("show ip route")).toContain("C    192.168.10.0/24 [0/1] directly connected, Vl10");

    // A port moved to another VLAN breaks it.
    run(dell, "enable", "configure", "interface gi1/0/5", "switchport access vlan 1");
    expect(dell.execute("ping 192.168.10.50")).toContain("0 packets received, 100% packet loss");
  });
});
