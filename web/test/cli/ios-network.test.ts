// Port of the IOSNetworkTests suite of Tests/NetSketchCLITests/NetworkTests.swift.

import { CLISession } from "../../src/cli/session";
import { Notices } from "../../src/cli/notices";
import type { ProjectStore } from "../../src/core/store";
import { device, makeStore, ref, run, snapshot, TemplateID } from "./support";

/** Two devices of `templateA`/`templateB` named A and B, cabled `portA` - `portB`. */
function pair(
  templateA: string,
  portA: string,
  templateB: string,
  portB: string,
): [ProjectStore, CLISession, CLISession] {
  const store = makeStore();
  const a = store.addDevice(templateA, { x: 0, y: 0 }, "A");
  const b = store.addDevice(templateB, { x: 600, y: 0 }, "B");
  store.connect(ref(store, "A", portA), ref(store, "B", portB));
  return [store, new CLISession(store, a.id), new CLISession(store, b.id)];
}

describe("IOSNetworkTests", () => {
  test("routers ping over a cable", () => {
    const [store, r1, r2] = pair(TemplateID.isr4321, "Gi0/0/0", TemplateID.isr4321, "Gi0/0/0");
    run(r1, "enable", "configure terminal", "interface gi0/0/0", "ip address 10.0.0.1 255.255.255.252", "end");
    run(r2, "enable", "configure terminal", "interface gi0/0/0", "ip address 10.0.0.2 255.255.255.252", "end");
    const a = device(store, "A");
    expect(a.addresses.length).toBe(1);
    expect(a.addresses[0]?.address).toBe("10.0.0.1/30");

    const ping = r1.execute("ping 10.0.0.2");
    expect(ping).toContain("!!!!!");
    expect(ping).toContain("Success rate is 100 percent (5/5)");

    // Shutting the far end down breaks the link.
    run(r2, "configure terminal", "interface gi0/0/0", "shutdown", "end");
    const failed = r1.execute("ping 10.0.0.2");
    expect(failed).toContain(".....");
    expect(failed).toContain("Success rate is 0 percent (0/5)");
    expect(failed).toContain("NetSketch:");
  });

  test("address validation", () => {
    const [store, cli] = pair(TemplateID.isr4321, "Gi0/0/0", TemplateID.isr4321, "Gi0/0/0");
    run(cli, "enable", "configure terminal", "interface gi0/0/0");
    expect(cli.execute("ip address 10.0.0.1 255.0.255.0").startsWith("%")).toBe(true);
    expect(cli.execute("ip address 10.0.0.0 255.255.255.0").startsWith("Bad mask")).toBe(true);
    expect(cli.execute("ip address 10.0.0.1 255.255.255.0")).toBe("");
    cli.execute("interface gi0/0/1");
    expect(cli.execute("ip address 10.0.0.5 255.255.255.0")).toContain("overlaps");
    cli.execute("interface gi0/0/0");
    cli.execute("no ip address");
    expect(device(store, "A").addresses).toEqual([]);
  });

  test("switch ports take no address but the SVI does", () => {
    const [store, sw, pc] = pair(TemplateID.c2960_24, "Fa0/1", TemplateID.pc, "eth0");
    run(sw, "enable", "configure terminal", "interface fa0/2");
    expect(sw.execute("ip address 10.0.0.1 255.255.255.0")).toBe(Notices.switchPortHasNoAddress);
    run(sw, "exit", "interface vlan 1", "ip address 192.168.1.2 255.255.255.0", "no shutdown", "end");
    expect(device(store, "A").addresses).toEqual([{ interface: "vlan:1", address: "192.168.1.2/24" }]);
    expect(pc.execute("netsh interface ip set address eth0 static 192.168.1.10 255.255.255.0")).toBe("Ok.");
    expect(sw.execute("ping 192.168.1.10")).toContain("!!!!!");
    expect(pc.execute("ping 192.168.1.2")).toContain("Reply from 192.168.1.2");
    const config = sw.execute("show running-config");
    expect(config).toContain("interface Vlan1\n ip address 192.168.1.2 255.255.255.0");
    expect(sw.execute("show ip interface brief")).toContain("192.168.1.2");
  });

  test("VLANs separate and trunks join", () => {
    // PC1 - SW1 (VLAN 10) == trunk == SW2 (VLAN 10 / 20) - PC2, PC3.
    const store = makeStore();
    store.addDevice(TemplateID.c2960_24, { x: 0, y: 0 }, "SW1");
    store.addDevice(TemplateID.c2960_24, { x: 600, y: 0 }, "SW2");
    const pc1 = store.addDevice(TemplateID.pc, { x: 0, y: 400 }, "PC1");
    store.addDevice(TemplateID.pc, { x: 400, y: 400 }, "PC2");
    store.addDevice(TemplateID.pc, { x: 800, y: 400 }, "PC3");
    store.connect(ref(store, "SW1", "Gi0/1"), ref(store, "SW2", "Gi0/1"));
    store.connect(ref(store, "PC1", "eth0"), ref(store, "SW1", "Fa0/1"));
    store.connect(ref(store, "PC2", "eth0"), ref(store, "SW2", "Fa0/1"));
    store.connect(ref(store, "PC3", "eth0"), ref(store, "SW2", "Fa0/2"));
    for (const [name, address] of [
      ["PC1", "10.0.0.1"],
      ["PC2", "10.0.0.2"],
      ["PC3", "10.0.0.3"],
    ]) {
      const cli = new CLISession(store, device(store, name).id);
      cli.execute(`netsh interface ip set address eth0 static ${address} 255.255.255.0`);
    }
    const console = new CLISession(store, pc1.id);
    // Everything in VLAN 1: all reachable.
    expect(console.execute("ping 10.0.0.3")).toContain("Reply from");

    const sw1 = new CLISession(store, device(store, "SW1").id);
    const sw2 = new CLISession(store, device(store, "SW2").id);
    run(sw1, "enable", "configure terminal", "interface fa0/1", "switchport mode access", "switchport access vlan 10", "end");
    run(
      sw2,
      "enable",
      "configure terminal",
      "interface fa0/1",
      "switchport mode access",
      "switchport access vlan 10",
      "interface fa0/2",
      "switchport mode access",
      "switchport access vlan 20",
      "end",
    );
    // The uplink still carries VLAN 1 only (access port): VLAN 10 does not cross it.
    expect(console.execute("ping 10.0.0.2")).toContain("Request timed out.");
    run(sw1, "configure terminal", "interface gi0/1", "switchport mode trunk", "end");
    run(sw2, "configure terminal", "interface gi0/1", "switchport mode trunk", "end");
    expect(console.execute("ping 10.0.0.2")).toContain("Reply from 10.0.0.2");
    // VLAN 20 is another network: no reply.
    expect(console.execute("ping 10.0.0.3")).toContain("Request timed out.");
    // A trunk that does not allow VLAN 10 cuts it again.
    run(sw2, "configure terminal", "interface gi0/1", "switchport trunk allowed vlan 20", "end");
    expect(console.execute("ping 10.0.0.2")).toContain("Request timed out.");
  });

  test("static routes and show ip route", () => {
    const store = makeStore();
    const r1 = store.addDevice(TemplateID.isr4321, { x: 0, y: 0 }, "R1");
    const r2 = store.addDevice(TemplateID.isr4321, { x: 600, y: 0 }, "R2");
    const pc = store.addDevice(TemplateID.pc, { x: 0, y: 400 }, "PC1");
    store.connect(ref(store, "R1", "Gi0/0/1"), ref(store, "R2", "Gi0/0/1"));
    store.connect(ref(store, "PC1", "eth0"), ref(store, "R1", "Gi0/0/0"));
    const one = new CLISession(store, r1.id);
    const two = new CLISession(store, r2.id);
    const host = new CLISession(store, pc.id);
    run(
      one,
      "enable",
      "configure terminal",
      "interface gi0/0/0",
      "ip address 192.168.1.1 255.255.255.0",
      "interface gi0/0/1",
      "ip address 10.0.12.1 255.255.255.252",
      "end",
    );
    run(
      two,
      "enable",
      "configure terminal",
      "interface gi0/0/1",
      "ip address 10.0.12.2 255.255.255.252",
      "interface gi0/0/0",
      "ip address 192.168.2.1 255.255.255.0",
      "end",
    );
    host.execute("netsh interface ip set address eth0 static 192.168.1.10 255.255.255.0 192.168.1.1");

    // R2 does not know the way back to 192.168.1.0/24 yet.
    const failed = host.execute("ping 10.0.12.2");
    expect(failed).toContain("Request timed out.");
    expect(failed).toContain("odpověď ne");

    run(two, "configure terminal", "ip route 192.168.1.0 255.255.255.0 10.0.12.1", "end");
    expect(host.execute("ping 10.0.12.2")).toContain("Reply from 10.0.12.2");
    const routes = two.execute("show ip route");
    expect(routes).toContain("S        192.168.1.0/24 [1/0] via 10.0.12.1");
    expect(routes).toContain("C        10.0.12.0/30 is directly connected, GigabitEthernet0/0/1");
    expect(two.execute("show running-config")).toContain("ip route 192.168.1.0 255.255.255.0 10.0.12.1");
    const trace = host.execute("tracert 10.0.12.2");
    expect(trace).toContain("192.168.1.1");
    expect(trace).toContain("Trace complete.");

    run(two, "configure terminal", "no ip route 192.168.1.0 255.255.255.0", "end");
    expect(device(store, "R2").staticRoutes).toEqual([]);
  });

  test("Dell addresses and routes", () => {
    const [store, dell, pc] = pair(TemplateID.dellS3048, "GigabitEthernet 1/1", TemplateID.pc, "eth0");
    run(
      dell,
      "enable",
      "configure",
      "interface vlan 1",
      "ip address 172.16.0.1/24",
      "no shutdown",
      "exit",
      "ip route 10.9.0.0/16 172.16.0.254",
      "end",
    );
    const a = device(store, "A");
    expect(a.addresses).toEqual([{ interface: "vlan:1", address: "172.16.0.1/24" }]);
    expect(a.staticRoutes).toEqual([{ destination: "10.9.0.0/16", nextHop: "172.16.0.254" }]);
    pc.execute("netsh interface ip set address eth0 static 172.16.0.10 255.255.255.0");
    expect(dell.execute("ping 172.16.0.10")).toContain("Success rate is 100.0 percent (5/5)");
    const config = dell.execute("show running-config");
    expect(config).toContain(" ip address 172.16.0.1/24");
    expect(config).toContain("ip route 10.9.0.0/16 172.16.0.254");
  });

  test("each address command is one undo step", () => {
    const [store, cli] = pair(TemplateID.isr4321, "Gi0/0/0", TemplateID.pc, "eth0");
    run(cli, "enable", "configure terminal", "interface gi0/0/0");
    const before = snapshot(store);
    cli.execute("ip address 10.0.0.1 255.255.255.0");
    expect(store.undo()).toBe(true);
    expect(store.project).toEqual(before);
  });
});
