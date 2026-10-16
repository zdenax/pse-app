// UniFi Switch 48 (US-48-G1) console: replay of the lab transcript (shell, telnet localhost,
// FASTPATH CLI), VLAN membership feeding the simulation, management address reachable by ping.

import { describe, expect, it } from "vitest";
import { readSTPConfig } from "../../src/core/protocols/layer2";
import { CLI, CLISession } from "../../src/cli/session";
import { computeSpanningTree } from "../../src/cli/features/layer2/stp";
import { makeStore, ref, run } from "./support";

const unifi = "ubiquiti-us-48-g1";

function setup() {
  const store = makeStore();
  const sw = store.addDevice(unifi, { x: 0, y: 0 }, "UNIFI");
  const pc = store.addDevice("generic-pc", { x: 200, y: 0 }, "PC1");
  const cli = new CLISession(store, sw.id);
  const pcCli = new CLISession(store, pc.id);
  return { store, sw, pc, cli, pcCli };
}

function enterCLI(cli: CLISession) {
  cli.execute("telnet localhost");
  cli.execute("enable");
}

function pcPortName(store: ReturnType<typeof makeStore>): string {
  return store.project.devices.find((d) => d.hostname === "PC1")!.ports[0].name;
}

describe("UniFi Switch 48 dialect", () => {
  it("only US-48-G1 gets the dedicated console", () => {
    const store = makeStore();
    const a = store.addDevice(unifi, { x: 0, y: 0 });
    const b = store.addDevice("ubiquiti-unifi-switch-48", { x: 0, y: 0 });
    expect(new CLISession(store, a.id).dialect).toBe("unifiSwitch");
    expect(new CLISession(store, b.id).dialect).toBe("generic");
    expect(CLI.dialectOf(a)).toBe("unifiSwitch");
  });

  it("shell -> telnet localhost -> CLI -> exit -> shell -> exit", () => {
    const { cli } = setup();
    expect(cli.prompt).toMatch(/^US\.v7\.2\.123# /);
    expect(cli.execute("telnet localhost")).toContain("valid only until");
    expect(cli.prompt).toBe("(UBNT) >");
    cli.execute("enable");
    expect(cli.prompt).toBe("(UBNT) #");
    cli.execute("configure");
    expect(cli.prompt).toBe("(UBNT) (Config)#");
    cli.execute("interface 0/1");
    expect(cli.prompt).toBe("(UBNT) (Interface 0/1)#");
    cli.execute("exit");
    cli.execute("exit");
    expect(cli.prompt).toBe("(UBNT) #");
    cli.execute("vlan database");
    expect(cli.prompt).toBe("(UBNT) (Vlan)#");
    cli.execute("exit");
    cli.execute("exit");
    cli.execute("exit");
    expect(cli.prompt).toMatch(/^US\./);
    expect(cli.isClosed).toBe(false);
    cli.execute("exit");
    expect(cli.isClosed).toBe(true);
  });

  it("vlan database only in privileged mode", () => {
    const { cli } = setup();
    enterCLI(cli);
    cli.execute("configure");
    expect(cli.execute("vlan database")).toContain("% Invalid input");
    expect(cli.prompt).toBe("(UBNT) (Config)#");
  });

  it("ping works in the shell only", () => {
    const { cli } = setup();
    enterCLI(cli);
    expect(cli.execute("ping 192.168.1.1")).toContain("% Invalid input");
    cli.execute("exit");
    cli.execute("exit");
    expect(cli.execute("ping -c 2 192.168.1.1")).toContain("packet loss");
    expect(cli.execute("ping")).toContain("Usage");
  });

  it("STP priority goes to protocols.stp", () => {
    const { store, sw, cli } = setup();
    enterCLI(cli);
    run(cli, "configure", "spanning-tree mst priority 0 12288");
    const device = store.project.devices.find((d) => d.id === sw.id)!;
    const stp = readSTPConfig(device.protocols?.stp)!;
    expect(stp.priorities).toEqual([{ vlan: 0, priority: 12288 }]);
    expect(computeSpanningTree(store.project).get(sw.id)!.priority).toBe(12288);
    expect(cli.execute("spanning-tree mst priority 0 100")).toContain("multiple of 4096");
    cli.execute("exit");
    const out = cli.execute("show spanning-tree");
    expect(out).toContain("Bridge Priority");
    expect(out).toContain("12288");
    expect(out).toContain("This switch is the root bridge");
  });

  it("lab: VLAN 10, port 0/1 tagged, port 0/3 PVID 10", () => {
    const { store, sw, cli } = setup();
    enterCLI(cli);
    run(cli, "vlan database", "vlan 10", "vlan name 10 LAN", "exit");
    expect(store.project.devices.find((d) => d.id === sw.id)!.vlans).toEqual([{ id: 10, name: "LAN" }]);
    run(cli, "configure", "interface 0/1", "vlan participation include 10", "vlan tagging 10", "exit");
    run(cli, "interface 0/3", "vlan participation include 10", "vlan pvid 10", "vlan participation exclude 1", "exit", "exit");
    const dev = store.project.devices.find((d) => d.id === sw.id)!;
    expect(dev.ports[0].vlan).toBe("trunk 1,10");
    expect(dev.ports[2].vlan).toBe("access 10");
    const p1 = cli.execute("show vlan port 0/1");
    expect(p1).toMatch(/Port VLAN ID\.+ 1/);
    expect(p1).toMatch(/1 +default +Include +Untagged/);
    expect(p1).toMatch(/10 +LAN +Include +Tagged/);
    const p3 = cli.execute("show vlan port 0/3");
    expect(p3).toMatch(/Port VLAN ID\.+ 10/);
    expect(p3).toMatch(/1 +default +Forbidden/);
    expect(p3).toMatch(/10 +LAN +Include +Untagged/);
    expect(cli.execute("show vlan brief")).toContain("LAN");
    expect(cli.execute("show vlan")).toContain("0/3");
    expect(cli.execute("show running-config")).toContain("vlan participation include 10");
    expect(cli.execute("show port all")).toContain("0/52");
    cli.execute("configure");
    expect(cli.execute("interface 0/60")).toContain("Invalid interface");
  });

  it("errors for unknown VLAN", () => {
    const { cli } = setup();
    enterCLI(cli);
    run(cli, "configure", "interface 0/1");
    expect(cli.execute("vlan participation include 99")).toContain("does not exist");
  });

  it("port mapping: 0/49 is SFP 1, 0/52 is SFP+ 2", () => {
    const { store, sw, cli } = setup();
    enterCLI(cli);
    run(cli, "configure", "interface 0/52", "shutdown", "exit", "interface 0/49", "shutdown");
    const dev = store.project.devices.find((d) => d.id === sw.id)!;
    expect(dev.ports.filter((p) => p.adminDown).map((p) => p.name)).toEqual(["SFP 1", "SFP+ 2"]);
  });

  it("management IP is reachable from a PC through VLAN 10", () => {
    const { store, cli, pcCli } = setup();
    enterCLI(cli);
    run(cli, "vlan database", "vlan 10", "vlan name 10 LAN", "exit");
    run(cli, "configure", "interface 0/1", "vlan participation include 10", "vlan pvid 10", "vlan participation exclude 1", "exit", "exit");
    store.connect(ref(store, "UNIFI", "Port 1"), ref(store, "PC1", pcPortName(store)));
    run(cli, "network mgmt_vlan 10");
    run(cli, "network parms 192.168.10.20 255.255.255.0 192.168.10.1");
    expect(cli.execute("show network")).toMatch(/Management VLAN ID\.+ 10/);
    expect(cli.execute("show network")).toContain("192.168.10.20");
    run(pcCli, "netsh interface ip set address eth0 static 192.168.10.10 255.255.255.0 192.168.10.1");
    expect(pcCli.execute("ping 192.168.10.20")).toContain("Received = 4");
    cli.execute("exit");
    cli.execute("exit");
    const shellPing = cli.execute("ping -c 3 192.168.10.10");
    expect(shellPing).toContain("3 packets received");
    expect(shellPing).toContain("seq=0");
    expect(cli.execute("ifconfig")).toContain("192.168.10.20");
    expect(cli.execute("info")).toContain("US-48-G1");
  });

  it("VLAN membership really isolates the management VLAN", () => {
    const { store, cli, pcCli } = setup();
    enterCLI(cli);
    run(cli, "vlan database", "vlan 10", "exit");
    run(cli, "network mgmt_vlan 10", "network parms 192.168.10.20 255.255.255.0");
    store.connect(ref(store, "UNIFI", "Port 2"), ref(store, "PC1", pcPortName(store)));
    run(pcCli, "netsh interface ip set address eth0 static 192.168.10.10 255.255.255.0 192.168.10.1");
    expect(pcCli.execute("ping 192.168.10.20")).toContain("Received = 0");
  });

  it("network mgmt_vlan asks a DHCP server of the topology", () => {
    const store = makeStore();
    const sw = store.addDevice(unifi, { x: 0, y: 0 }, "UNIFI");
    const r = store.addDevice("cisco-isr-4321", { x: 100, y: 0 }, "R1");
    const cli = new CLISession(store, sw.id);
    const rc = new CLISession(store, r.id);
    const gi = r.ports.find((p) => p.name === "Gi0/0/0")!;
    store.connect(ref(store, "UNIFI", "Port 1"), { deviceID: r.id, portID: gi.id });
    run(rc, "enable", "configure terminal", `interface ${gi.name}`, "ip address 192.168.1.1 255.255.255.0", "no shutdown", "exit",
      "ip dhcp pool P", "network 192.168.1.0 255.255.255.0", "default-router 192.168.1.1", "end");
    enterCLI(cli);
    expect(cli.execute("network mgmt_vlan 1")).toBe("");
    expect(cli.execute("show network")).toMatch(/Protocol Current\.+ DHCP/);
    expect(cli.execute("show network")).toMatch(/IP Address\.+ 192\.168\.1\.\d+/);
    cli.execute("exit");
    cli.execute("exit");
    expect(cli.execute("ping -c 2 192.168.1.1")).toContain("2 packets received");
  });
});
