// OSPF and RIP: Cisco IOS configuration, neighbors, learned routes in the routing table,
// ping over learned routes and the removal of routes when a cable or port goes away.

import type { ProjectStore } from "../../src/core/store";
import { CLISession } from "../../src/cli/session";
import { IPv4 } from "../../src/cli/sim/ipv4";
import { NetworkSimulator, type PingResult } from "../../src/cli/sim/network-simulator";
import { NetworkRuntime } from "../../src/cli/sim/runtime";
import { device, makeStore, ref, run } from "../cli/support";

const isr = "cisco-isr-4321";
const pcTemplate = "generic-pc";

beforeEach(() => {
  NetworkRuntime.reset();
});

function session(store: ProjectStore, hostname: string): CLISession {
  return new CLISession(store, device(store, hostname).id);
}

function ping(store: ProjectStore, from: string, target: string): PingResult {
  return new NetworkSimulator(store.project).ping(device(store, from).id, IPv4.parse(target) as IPv4);
}

function address(store: ProjectStore, hostname: string, port: string, ip: string, mask: string): void {
  run(session(store, hostname), "enable", "configure terminal", `interface ${port}`, `ip address ${ip} ${mask}`, "end");
}

/**
 * PC1 - R1 - R2 - R3 - PC3. LANs 192.168.1.0/24 and 192.168.3.0/24, links 10.0.12.0/30 and
 * 10.0.23.0/30 (R1 Gi0/0/1 - R2 Gi0/0/0, R2 Gi0/0/1 - R3 Gi0/0/0).
 */
function chain() {
  const store = makeStore();
  for (const [index, name] of ["R1", "R2", "R3"].entries()) store.addDevice(isr, { x: 100 * index, y: 0 }, name);
  store.addDevice(pcTemplate, { x: 0, y: 100 }, "PC1");
  store.addDevice(pcTemplate, { x: 300, y: 100 }, "PC3");
  store.connect(ref(store, "PC1", "eth0"), ref(store, "R1", "Gi0/0/0"));
  store.connect(ref(store, "R1", "Gi0/0/1"), ref(store, "R2", "Gi0/0/0"));
  store.connect(ref(store, "R2", "Gi0/0/1"), ref(store, "R3", "Gi0/0/0"));
  store.connect(ref(store, "R3", "Gi0/0/1"), ref(store, "PC3", "eth0"));
  session(store, "PC1").execute("netsh interface ip set address eth0 static 192.168.1.10 255.255.255.0 192.168.1.1");
  session(store, "PC3").execute("netsh interface ip set address eth0 static 192.168.3.10 255.255.255.0 192.168.3.1");
  address(store, "R1", "gi0/0/0", "192.168.1.1", "255.255.255.0");
  address(store, "R1", "gi0/0/1", "10.0.12.1", "255.255.255.252");
  address(store, "R2", "gi0/0/0", "10.0.12.2", "255.255.255.252");
  address(store, "R2", "gi0/0/1", "10.0.23.1", "255.255.255.252");
  address(store, "R3", "gi0/0/0", "10.0.23.2", "255.255.255.252");
  address(store, "R3", "gi0/0/1", "192.168.3.1", "255.255.255.0");
  return store;
}

function enableOSPF(store: ProjectStore): void {
  run(session(store, "R1"), "enable", "configure terminal", "router ospf 1", "router-id 1.1.1.1",
    "network 192.168.1.0 0.0.0.255 area 0", "network 10.0.12.0 0.0.0.3 area 0", "end");
  run(session(store, "R2"), "enable", "configure terminal", "router ospf 1",
    "network 10.0.0.0 0.0.255.255 area 0", "end");
  run(session(store, "R3"), "enable", "configure terminal", "router ospf 1", "router-id 3.3.3.3",
    "network 10.0.23.0 0.0.0.3 area 0", "network 192.168.3.0 0.0.0.255 area 0", "end");
}

function enableRIP(store: ProjectStore, summary = false): void {
  const networks: Record<string, string[]> = {
    R1: ["192.168.1.0", "10.0.0.0"],
    R2: ["10.0.0.0"],
    R3: ["10.0.0.0", "192.168.3.0"],
  };
  for (const name of ["R1", "R2", "R3"]) {
    run(
      session(store, name),
      "enable",
      "configure terminal",
      "router rip",
      "version 2",
      ...(summary ? [] : ["no auto-summary"]),
      ...networks[name].map((network) => `network ${network}`),
      "end",
    );
  }
}

describe("OSPF", () => {
  test("configuration is stored and shown in running-config", () => {
    const store = chain();
    const r1 = session(store, "R1");
    expect(run(r1, "enable", "configure terminal", "router ospf 1")).toBe("");
    expect(r1.prompt).toBe("R1(config-router)#");
    run(r1, "router-id 1.1.1.1", "network 10.0.12.0 0.0.0.3 area 0", "passive-interface gi0/0/0", "auto-cost reference-bandwidth 1000");
    expect(device(store, "R1").protocols?.ospf?.networks).toEqual([{ address: "10.0.12.0", wildcard: "0.0.0.3", area: 0 }]);
    run(r1, "end");
    expect(r1.execute("show running-config")).toContain(
      "router ospf 1\n router-id 1.1.1.1\n auto-cost reference-bandwidth 1000\n passive-interface GigabitEthernet0/0/0\n network 10.0.12.0 0.0.0.3 area 0",
    );
  });

  test("bad input is refused; a second process number is not supported", () => {
    const r1 = session(chain(), "R1");
    run(r1, "enable", "configure terminal", "router ospf 1");
    expect(run(r1, "router-id 1.2.3")).toContain("Invalid");
    expect(run(r1, "network 10.0.0.0 0.255.0.255 area 0")).toContain("contiguous");
    run(r1, "exit");
    expect(run(r1, "router ospf 2")).toContain("jediný proces");
  });

  test("neighbors, learned routes and ping across three routers", () => {
    const store = chain();
    expect(ping(store, "PC1", "192.168.3.10").success).toBe(false);
    enableOSPF(store);
    const r1 = session(store, "R1");
    const neighbors = run(r1, "show ip ospf neighbor");
    expect(neighbors).toContain("Neighbor ID");
    expect(neighbors).toMatch(/10\.0\.23\.2|10\.0\.12\.2/);
    expect(neighbors).toContain("FULL/");
    expect(neighbors).toContain("GigabitEthernet0/0/1");

    const table = run(r1, "show ip route");
    expect(table).toContain("O        192.168.3.0/24 [110/3] via 10.0.12.2, 00:00:05, GigabitEthernet0/0/1");
    expect(table).toContain("O        10.0.23.0/30 [110/2] via 10.0.12.2");
    const result = ping(store, "PC1", "192.168.3.10");
    expect(result.success).toBe(true);
    expect(run(session(store, "PC1"), "ping 192.168.3.10")).toContain("TTL");
  });

  test("show ip protocols lists networks, passive interfaces and sources", () => {
    const store = chain();
    enableOSPF(store);
    const r1 = session(store, "R1");
    run(r1, "enable", "configure terminal", "router ospf 1", "passive-interface gi0/0/0", "end");
    const output = run(r1, "show ip protocols");
    expect(output).toContain('Routing Protocol is "ospf 1"');
    expect(output).toContain("Router ID 1.1.1.1");
    expect(output).toContain("10.0.12.0 0.0.0.3 area 0");
    expect(output).toMatch(/Passive Interface\(s\):\n\s+GigabitEthernet0\/0\/0/);
    expect(output).toContain("3.3.3.3");
  });

  test("a passive interface forms no neighbor but its network is still advertised", () => {
    const store = chain();
    enableOSPF(store);
    run(session(store, "R2"), "enable", "configure terminal", "router ospf 1", "passive-interface gi0/0/0", "end");
    expect(run(session(store, "R1"), "show ip ospf neighbor")).toBe("");
    expect(ping(store, "PC1", "192.168.3.10").success).toBe(false);
    expect(run(session(store, "R3"), "show ip route")).toContain("O        10.0.12.0/30");
  });

  test("passive-interface default with an exception", () => {
    const store = chain();
    enableOSPF(store);
    const r2 = session(store, "R2");
    run(r2, "enable", "configure terminal", "router ospf 1", "passive-interface default", "no passive-interface gi0/0/0", "no passive-interface gi0/0/1", "end");
    expect(ping(store, "PC1", "192.168.3.10").success).toBe(true);
    run(r2, "configure terminal", "router ospf 1", "passive-interface gi0/0/1", "end");
    expect(ping(store, "PC1", "192.168.3.10").success).toBe(false);
  });

  test("cost follows the bandwidth and `ip ospf cost` changes the best path", () => {
    const store = chain();
    enableOSPF(store);
    run(session(store, "R1"), "enable", "configure terminal", "interface gi0/0/1", "ip ospf cost 50", "end");
    expect(run(session(store, "R1"), "show ip route")).toContain("O        192.168.3.0/24 [110/52] via 10.0.12.2");
    expect(run(session(store, "R1"), "enable", "show running-config")).toContain(" ip ospf cost 50");
  });

  test("routes disappear when the cable is removed or the port is shut down", () => {
    const store = chain();
    enableOSPF(store);
    expect(ping(store, "PC1", "192.168.3.10").success).toBe(true);
    run(session(store, "R2"), "enable", "configure terminal", "interface gi0/0/1", "shutdown", "end");
    expect(run(session(store, "R1"), "show ip route")).not.toContain("192.168.3.0/24");
    expect(ping(store, "PC1", "192.168.3.10").success).toBe(false);
    run(session(store, "R2"), "enable", "configure terminal", "interface gi0/0/1", "no shutdown", "end");
    expect(ping(store, "PC1", "192.168.3.10").success).toBe(true);
    const link = store.project.links.find((candidate) => candidate.a.deviceID === device(store, "R1").id && candidate.b.deviceID === device(store, "R2").id);
    expect(link).toBeDefined();
    store.removeLink?.(link!.id);
    expect(run(session(store, "R3"), "show ip route")).not.toContain("192.168.1.0/24");
  });

  test("no router ospf removes the process", () => {
    const store = chain();
    enableOSPF(store);
    run(session(store, "R2"), "enable", "configure terminal", "no router ospf 1", "end");
    expect(device(store, "R2").protocols?.ospf).toBeUndefined();
    expect(ping(store, "PC1", "192.168.3.10").success).toBe(false);
  });

  test("different areas form no neighbor; two areas through an ABR give O IA", () => {
    const store = chain();
    enableOSPF(store);
    run(session(store, "R3"), "enable", "configure terminal", "router ospf 1", "no network 10.0.23.0 0.0.0.3 area 0", "network 10.0.23.0 0.0.0.3 area 1",
      "no network 192.168.3.0 0.0.0.255 area 0", "network 192.168.3.0 0.0.0.255 area 1", "end");
    expect(run(session(store, "R3"), "show ip ospf neighbor")).toBe("");
    run(session(store, "R2"), "enable", "configure terminal", "router ospf 1",
      "no network 10.0.0.0 0.0.255.255 area 0", "network 10.0.12.0 0.0.0.3 area 0", "network 10.0.23.0 0.0.0.3 area 1", "end");
    expect(run(session(store, "R1"), "show ip route")).toContain("O IA     192.168.3.0/24");
  });
});

describe("RIP", () => {
  test("configuration is stored and shown in running-config", () => {
    const store = chain();
    const r1 = session(store, "R1");
    run(r1, "enable", "configure terminal", "router rip", "version 2", "no auto-summary", "network 10.1.2.3", "passive-interface gi0/0/0");
    expect(device(store, "R1").protocols?.rip?.networks).toEqual(["10.0.0.0"]);
    run(r1, "end");
    expect(r1.execute("show running-config")).toContain(
      "router rip\n version 2\n passive-interface GigabitEthernet0/0/0\n network 10.0.0.0\n no auto-summary",
    );
  });

  test("learned routes with hop counts and ping", () => {
    const store = chain();
    enableRIP(store);
    const table = run(session(store, "R1"), "show ip route");
    expect(table).toContain("R        192.168.3.0/24 [120/2] via 10.0.12.2, 00:00:05, GigabitEthernet0/0/1");
    expect(table).toContain("R        10.0.23.0/30 [120/1] via 10.0.12.2");
    expect(ping(store, "PC1", "192.168.3.10").success).toBe(true);
  });

  test("show ip protocols", () => {
    const store = chain();
    enableRIP(store);
    const output = run(session(store, "R1"), "show ip protocols");
    expect(output).toContain('Routing Protocol is "rip"');
    expect(output).toContain("send version 2, receive version 2");
    expect(output).toContain("Automatic network summarization is not in effect");
    expect(output).toContain("10.0.12.2");
  });

  test("auto-summary turns a subnet into its classful network at the border", () => {
    for (const summary of [true, false]) {
      const store = chain();
      address(store, "R3", "gi0/0/1", "172.16.3.1", "255.255.255.128");
      enableRIP(store, summary);
      run(session(store, "R3"), "enable", "configure terminal", "router rip", "network 172.16.0.0", "end");
      const table = run(session(store, "R1"), "show ip route");
      if (summary) {
        expect(table).toContain("R        172.16.0.0/16 [120/2] via 10.0.12.2");
        expect(table).not.toContain("172.16.3.0/25");
      } else {
        expect(table).toContain("R        172.16.3.0/25 [120/2] via 10.0.12.2");
      }
    }
  });

  test("a passive interface sends nothing", () => {
    const store = chain();
    enableRIP(store);
    run(session(store, "R3"), "enable", "configure terminal", "router rip", "passive-interface gi0/0/0", "end");
    expect(run(session(store, "R1"), "show ip route")).not.toContain("192.168.3.0/24");
    expect(ping(store, "PC1", "192.168.3.10").success).toBe(false);
  });

  test("shutdown removes the learned routes", () => {
    const store = chain();
    enableRIP(store);
    run(session(store, "R2"), "enable", "configure terminal", "interface gi0/0/0", "shutdown", "end");
    expect(run(session(store, "R3"), "show ip route")).not.toContain("192.168.1.0/24");
    expect(ping(store, "PC3", "192.168.1.10").success).toBe(false);
  });

  test("a RIPv1 sender is not heard by a RIPv2 receiver", () => {
    const store = chain();
    enableRIP(store);
    run(session(store, "R1"), "enable", "configure terminal", "router rip", "version 1", "end");
    expect(run(session(store, "R2"), "show ip route")).not.toContain("192.168.1.0/24");
  });

  test("OSPF (110) beats RIP (120) for the same network", () => {
    const store = chain();
    enableRIP(store);
    enableOSPF(store);
    const table = run(session(store, "R1"), "show ip route");
    expect(table).toContain("O        192.168.3.0/24");
    expect(table).not.toContain("R        192.168.3.0/24");
  });
});
