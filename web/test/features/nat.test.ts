// NAT/PAT: Cisco IOS and MikroTik RouterOS configuration, the translation of packets in the
// network simulation (ping across NAT) and the translation table.

import type { Device } from "../../src/core/model";
import type { AccessList } from "../../src/core/protocols/acl";
import type { ProjectStore } from "../../src/core/store";
import { CLISession } from "../../src/cli/session";
import { IPv4 } from "../../src/cli/sim/ipv4";
import { NetworkSimulator, type PingResult } from "../../src/cli/sim/network-simulator";
import type { Packet } from "../../src/cli/sim/packet";
import { NetworkRuntime } from "../../src/cli/sim/runtime";
import { kw } from "../../src/cli/command-tree";
import { mergeNodes } from "../../src/cli/features/ios-commands";
import { device, makeStore, ref, run } from "../cli/support";

const isr = "cisco-isr-4321";
const c2960 = "cisco-catalyst-2960-24";
const hap = "mikrotik-hap-lite";
const pcTemplate = "generic-pc";
const serverTemplate = "generic-server";

beforeEach(() => {
  NetworkRuntime.reset();
});

function session(store: ProjectStore, hostname: string): CLISession {
  return new CLISession(store, device(store, hostname).id);
}

function ping(store: ProjectStore, from: string, target: string): PingResult {
  const simulator = new NetworkSimulator(store.project);
  return simulator.ping(device(store, from).id, IPv4.parse(target) as IPv4);
}

function setHostAddress(store: ProjectStore, hostname: string, address: string, gateway: string): void {
  session(store, hostname).execute(`netsh interface ip set address eth0 static ${address} 255.255.255.0 ${gateway}`);
}

/** `ip access-list`-less standard/extended lists written straight into the device, as the ACL feature stores them. */
function setLists(store: ProjectStore, hostname: string, lists: AccessList[]): void {
  const target = device(store, hostname);
  store.setProtocols(target.id, { ...(target.protocols ?? {}), acl: { lists, bindings: [], firewall: [] } });
}

function permitList(name: string, source: string): AccessList {
  return {
    name,
    type: "standard",
    entries: [
      { sequence: 10, action: "permit", protocol: "ip", source, destination: "", destinationPort: "", sourcePort: "", icmpType: "", remark: "" },
    ],
  };
}

/**
 * PC1 (.10) and PC2 (.11) and the inside server SRV (.50) on SW1, SW1 - R1 Gi0/0/0 (inside,
 * 192.168.1.1/24), R1 Gi0/0/1 (outside, 203.0.113.1/24) - WEB (203.0.113.100).
 */
function ciscoLab(options: { nat?: boolean } = {}) {
  const store = makeStore();
  store.addDevice(isr, { x: 300, y: 0 }, "R1");
  store.addDevice(c2960, { x: 100, y: 0 }, "SW1");
  store.addDevice(pcTemplate, { x: 0, y: 100 }, "PC1");
  store.addDevice(pcTemplate, { x: 100, y: 100 }, "PC2");
  store.addDevice(serverTemplate, { x: 200, y: 100 }, "SRV");
  store.addDevice(serverTemplate, { x: 500, y: 0 }, "WEB");
  store.connect(ref(store, "SW1", "Gi0/1"), ref(store, "R1", "Gi0/0/0"));
  store.connect(ref(store, "PC1", "eth0"), ref(store, "SW1", "Fa0/1"));
  store.connect(ref(store, "PC2", "eth0"), ref(store, "SW1", "Fa0/2"));
  store.connect(ref(store, "SRV", "eth0"), ref(store, "SW1", "Fa0/3"));
  store.connect(ref(store, "WEB", "eth0"), ref(store, "R1", "Gi0/0/1"));
  setHostAddress(store, "PC1", "192.168.1.10", "192.168.1.1");
  setHostAddress(store, "PC2", "192.168.1.11", "192.168.1.1");
  setHostAddress(store, "SRV", "192.168.1.50", "192.168.1.1");
  setHostAddress(store, "WEB", "203.0.113.100", "203.0.113.1");
  const r1 = session(store, "R1");
  run(r1, "enable", "configure terminal", "interface gi0/0/0", "ip address 192.168.1.1 255.255.255.0");
  if (options.nat !== false) run(r1, "ip nat inside");
  run(r1, "exit", "interface gi0/0/1", "ip address 203.0.113.1 255.255.255.0");
  if (options.nat !== false) run(r1, "ip nat outside");
  run(r1, "exit");
  return { store, r1 };
}

describe("Cisco IOS: configuration", () => {
  test("interface sides, pools and rules are stored and shown in running-config", () => {
    const { store, r1 } = ciscoLab();
    expect(run(r1, "ip nat pool OUT 203.0.113.10 203.0.113.20 netmask 255.255.255.0")).toBe("");
    expect(run(r1, "ip nat inside source list 1 pool OUT overload")).toBe("");
    expect(run(r1, "ip nat inside source static 192.168.1.50 203.0.113.50")).toBe("");
    const nat = device(store, "R1").protocols?.nat;
    expect(nat?.pools).toEqual([{ name: "OUT", start: "203.0.113.10", end: "203.0.113.20", prefixLength: 24 }]);
    expect(nat?.rules).toEqual([
      { kind: "dynamic", list: "1", pool: "OUT", overload: true },
      { kind: "static", local: "192.168.1.50", global: "203.0.113.50" },
    ]);
    expect(nat?.inside.length).toBe(1);
    expect(nat?.outside.length).toBe(1);

    run(r1, "end");
    const config = r1.execute("show running-config");
    expect(config).toContain("interface GigabitEthernet0/0/0\n ip address 192.168.1.1 255.255.255.0\n ip nat inside");
    expect(config).toContain("interface GigabitEthernet0/0/1\n ip address 203.0.113.1 255.255.255.0\n ip nat outside");
    expect(config).toContain(
      "ip nat pool OUT 203.0.113.10 203.0.113.20 netmask 255.255.255.0\n" +
        "ip nat inside source list 1 pool OUT overload\n" +
        "ip nat inside source static 192.168.1.50 203.0.113.50",
    );
  });

  test("prefix-length, interface overload and abbreviations", () => {
    const { store, r1 } = ciscoLab();
    run(r1, "configure terminal");
    expect(run(r1, "ip nat pool P 10.0.0.1 10.0.0.9 prefix-length 28")).toBe("");
    expect(device(store, "R1").protocols?.nat?.pools[0]?.prefixLength).toBe(28);
    expect(run(r1, "ip nat inside source list ACL1 interface gi0/0/1 over")).toBe("");
    const rule = device(store, "R1").protocols?.nat?.rules[0];
    expect(rule?.kind).toBe("dynamic");
    run(r1, "end");
    expect(r1.execute("show running-config")).toContain(
      "ip nat inside source list ACL1 interface GigabitEthernet0/0/1 overload",
    );
  });

  test("wrong values are refused with IOS-style messages", () => {
    const { r1 } = ciscoLab();
    run(r1, "configure terminal");
    expect(run(r1, "ip nat pool P 10.0.0.9 10.0.0.1 netmask 255.255.255.0")).toBe("%End address less than start address");
    expect(run(r1, "ip nat pool P 10.0.0.1 10.0.1.9 netmask 255.255.255.0")).toBe(
      "%Start and end addresses on different subnets",
    );
    expect(run(r1, "ip nat pool P 10.0.0.1 10.0.0.9 netmask 255.0.255.0")).toContain("bad IP address or mask");
    expect(run(r1, "ip nat inside source static 192.168.1.50 999.1.1.1")).toContain("bad IP address");
    run(r1, "ip nat inside source static 192.168.1.50 203.0.113.50");
    expect(run(r1, "ip nat inside source static 192.168.1.50 203.0.113.51")).toBe(
      "%192.168.1.50 already mapped (192.168.1.50 -> 203.0.113.50)",
    );
    expect(run(r1, "ip nat inside source")).toBe("% Incomplete command.");
    expect(run(r1, "ip nat inside source list 1")).toBe("% Incomplete command.");
  });

  test("a pool that a rule uses cannot be removed or redefined", () => {
    const { store, r1 } = ciscoLab();
    run(r1, "configure terminal", "ip nat pool OUT 203.0.113.10 203.0.113.20 netmask 255.255.255.0");
    run(r1, "ip nat inside source list 1 pool OUT");
    expect(run(r1, "no ip nat pool OUT")).toBe("%Pool OUT in use, cannot destroy");
    expect(run(r1, "ip nat pool OUT 203.0.113.30 203.0.113.40 netmask 255.255.255.0")).toBe(
      "%Pool OUT in use, cannot redefine",
    );
    expect(run(r1, "no ip nat inside source list 1 pool OUT")).toBe("");
    expect(run(r1, "no ip nat pool OUT")).toBe("");
    expect(device(store, "R1").protocols?.nat?.pools).toEqual([]);
    expect(run(r1, "no ip nat pool OUT")).toBe("%Pool OUT not found");
  });

  test("no forms undo every setting and the key disappears when nothing is left", () => {
    const { store, r1 } = ciscoLab();
    run(r1, "configure terminal", "ip nat pool OUT 203.0.113.10 203.0.113.20 netmask 255.255.255.0");
    run(r1, "ip nat inside source list 1 pool OUT overload", "ip nat inside source static 192.168.1.50 203.0.113.50");
    run(r1, "no ip nat inside source static 192.168.1.50 203.0.113.50");
    run(r1, "no ip nat inside source list 1 pool OUT overload", "no ip nat pool OUT");
    run(r1, "interface gi0/0/0", "no ip nat inside", "exit", "interface gi0/0/1", "no ip nat outside", "end");
    expect(device(store, "R1").protocols).toBeUndefined();
    expect(r1.execute("show running-config")).not.toContain("ip nat");
  });

  test("an interface is inside or outside, never both; every command is one undo step", () => {
    const { store, r1 } = ciscoLab();
    run(r1, "configure terminal", "interface gi0/0/0", "ip nat outside");
    const nat = device(store, "R1").protocols?.nat;
    expect(nat?.inside).toEqual([]);
    expect(nat?.outside.length).toBe(2);
    expect(store.undo()).toBe(true);
    expect(device(store, "R1").protocols?.nat?.inside.length).toBe(1);
    expect(device(store, "R1").protocols?.nat?.outside.length).toBe(1);

    run(r1, "ip nat inside source static 192.168.1.50 203.0.113.50");
    expect(device(store, "R1").protocols?.nat?.rules.length).toBe(1);
    store.undo();
    expect(device(store, "R1").protocols?.nat?.rules.length).toBe(0);
  });

  test("ip nat on an L3 switch SVI and on a switch port", () => {
    const store = makeStore();
    store.addDevice("cisco-catalyst-3650-24ps", { x: 0, y: 0 }, "L3");
    const l3 = session(store, "L3");
    run(l3, "enable", "configure terminal", "interface vlan 10", "ip address 10.0.10.1 255.255.255.0");
    expect(run(l3, "ip nat inside")).toBe("");
    run(l3, "exit", "interface gi1/0/1");
    expect(run(l3, "ip nat outside")).toContain("L2");
    expect(device(store, "L3").protocols?.nat?.inside).toEqual(["vlan:10"]);
    run(l3, "end");
    expect(l3.execute("show running-config")).toContain("interface Vlan10\n ip address 10.0.10.1 255.255.255.0\n ip nat inside");
  });

  test("help lists the NAT keywords and other clear commands keep working", () => {
    const { r1 } = ciscoLab();
    run(r1, "end");
    expect(r1.help("show ip nat ")).toContain("translations");
    expect(r1.help("show ip nat ")).toContain("statistics");
    expect(r1.help("clear ip nat translation ")).toContain("*");
    expect(r1.execute("clear arp-cache")).toBe("");
    run(r1, "configure terminal");
    expect(r1.help("ip nat ")).toContain("pool");
    expect(r1.help("ip nat inside source ")).toContain("static");
  });
});

describe("Cisco IOS: PAT with an interface", () => {
  function patLab() {
    const lab = ciscoLab();
    setLists(lab.store, "R1", [permitList("1", "192.168.1.0 0.0.0.255")]);
    run(lab.r1, "configure terminal", "ip nat inside source list 1 interface gi0/0/1 overload", "end");
    return lab;
  }

  test("two PCs ping the outside server and it sees the global address", () => {
    const { store } = patLab();
    for (const pc of ["PC1", "PC2"]) {
      const result = ping(store, pc, "203.0.113.100");
      expect(result.success).toBe(true);
      expect(result.forward.packet?.source.description).toBe("203.0.113.1");
      expect(result.forward.packet?.destination.description).toBe("203.0.113.100");
      // The reply is translated back to the PC.
      expect(result.back?.packet?.destination.description).toBe(pc === "PC1" ? "192.168.1.10" : "192.168.1.11");
    }
    expect(session(store, "PC1").execute("ping 203.0.113.100")).toContain("Reply from 203.0.113.100");
  });

  test("without NAT the server would see the private address", () => {
    const { store } = ciscoLab();
    const result = ping(store, "PC1", "203.0.113.100");
    expect(result.forward.packet?.source.description).toBe("192.168.1.10");
  });

  test("show ip nat translations and statistics after pings, clear empties the table", () => {
    const { store, r1 } = patLab();
    expect(run(r1, "show ip nat translations")).toBe(
      "Pro Inside global      Inside local       Outside local      Outside global",
    );
    session(store, "PC1").execute("ping 203.0.113.100");
    session(store, "PC2").execute("ping 203.0.113.100");
    const table = run(r1, "show ip nat translations");
    expect(table).toContain("icmp 203.0.113.1:1      192.168.1.10:1     203.0.113.100:1    203.0.113.100:1");
    expect(table).toContain("icmp 203.0.113.1:2      192.168.1.11:2     203.0.113.100:2    203.0.113.100:2");

    const statistics = run(r1, "show ip nat statistics");
    expect(statistics).toContain("Total active translations: 2 (0 static, 2 dynamic; 2 extended)");
    expect(statistics).toContain("Outside interfaces:\n  GigabitEthernet0/0/1");
    expect(statistics).toContain("Inside interfaces:\n  GigabitEthernet0/0/0");
    expect(statistics).toContain("Misses: 2");
    expect(statistics).toContain("[Id: 1] access-list 1 interface GigabitEthernet0/0/1 refcount 2");

    expect(run(r1, "clear ip nat translation *")).toBe("");
    expect(run(r1, "show ip nat translations")).not.toContain("icmp");
    // The table is built again by the next ping.
    session(store, "PC1").execute("ping 203.0.113.100");
    expect(run(r1, "show ip nat translations")).toContain("192.168.1.10");
  });

  test("a second ping from the same PC reuses its translation", () => {
    const { store, r1 } = patLab();
    session(store, "PC1").execute("ping 203.0.113.100");
    session(store, "PC1").execute("ping 203.0.113.100");
    expect(run(r1, "show ip nat translations").split("\n").filter((row) => row.startsWith("icmp")).length).toBe(1);
  });

  test("the router's own ping of the server is not taken for a reply to a translated PC", () => {
    const { store, r1 } = patLab();
    session(store, "PC1").execute("ping 203.0.113.100");
    const own = ping(store, "R1", "203.0.113.100");
    expect(own.success).toBe(true);
    expect(own.back?.lastDevice).toBe(device(store, "R1").id);
    expect(run(r1, "ping 203.0.113.100")).toContain("!!!!!");
  });

  test("a list that does not permit the host leaves it untranslated", () => {
    const { store, r1 } = patLab();
    setLists(store, "R1", [permitList("1", "host 192.168.1.10")]);
    expect(ping(store, "PC1", "203.0.113.100").forward.packet?.source.description).toBe("203.0.113.1");
    expect(ping(store, "PC2", "203.0.113.100").forward.packet?.source.description).toBe("192.168.1.11");
    // A missing list permits nothing, but translations that exist stay until they are cleared.
    setLists(store, "R1", []);
    expect(ping(store, "PC1", "203.0.113.100").forward.packet?.source.description).toBe("203.0.113.1");
    run(r1, "enable", "clear ip nat translation *");
    expect(ping(store, "PC1", "203.0.113.100").forward.packet?.source.description).toBe("192.168.1.10");
  });

  test("wildcard masks of the list decide", () => {
    const { store } = patLab();
    setLists(store, "R1", [permitList("1", "192.168.1.8 0.0.0.3")]);
    expect(ping(store, "PC1", "203.0.113.100").forward.packet?.source.description).toBe("203.0.113.1");
    expect(ping(store, "PC2", "203.0.113.100").forward.packet?.source.description).toBe("203.0.113.1");
    expect(ping(store, "SRV", "203.0.113.100").forward.packet?.source.description).toBe("192.168.1.50");
  });

  test("an extended list can match the destination and the protocol", () => {
    const { store } = patLab();
    const extended: AccessList = {
      name: "1",
      type: "extended",
      entries: [
        { sequence: 10, action: "deny", protocol: "icmp", source: "host 192.168.1.11", destination: "any", destinationPort: "", sourcePort: "", icmpType: "", remark: "" },
        { sequence: 20, action: "permit", protocol: "ip", source: "192.168.1.0 0.0.0.255", destination: "host 203.0.113.100", destinationPort: "", sourcePort: "", icmpType: "", remark: "" },
      ],
    };
    setLists(store, "R1", [extended]);
    expect(ping(store, "PC1", "203.0.113.100").forward.packet?.source.description).toBe("203.0.113.1");
    expect(ping(store, "PC2", "203.0.113.100").forward.packet?.source.description).toBe("192.168.1.11");
  });

  test("without ip nat outside nothing is translated; without ip nat inside neither", () => {
    const { store, r1 } = patLab();
    run(r1, "configure terminal", "interface gi0/0/1", "no ip nat outside", "end");
    expect(ping(store, "PC1", "203.0.113.100").forward.packet?.source.description).toBe("192.168.1.10");
    run(r1, "configure terminal", "interface gi0/0/1", "ip nat outside", "interface gi0/0/0", "no ip nat inside", "end");
    expect(ping(store, "PC1", "203.0.113.100").forward.packet?.source.description).toBe("192.168.1.10");
    run(r1, "configure terminal", "interface gi0/0/0", "ip nat inside", "end");
    expect(ping(store, "PC1", "203.0.113.100").forward.packet?.source.description).toBe("203.0.113.1");
  });

  test("a disabled-looking setup: undo of the rule stops the translation", () => {
    const { store } = patLab();
    expect(store.undo()).toBe(true);
    expect(ping(store, "PC1", "203.0.113.100").forward.packet?.source.description).toBe("192.168.1.10");
  });

  test("TCP flows with the same source port get different global ports", () => {
    const { store } = patLab();
    const simulator = new NetworkSimulator(store.project);
    const tcp = (source: string): Packet => ({
      source: IPv4.parse(source) as IPv4,
      destination: IPv4.parse("203.0.113.100") as IPv4,
      protocol: "tcp",
      icmpType: "",
      sourcePort: 40000,
      destinationPort: 80,
      ttl: 255,
    });
    const first = simulator.deliverPacket(device(store, "PC1").id, tcp("192.168.1.10"));
    const second = simulator.deliverPacket(device(store, "PC2").id, tcp("192.168.1.11"));
    expect(first.packet?.source.description).toBe("203.0.113.1");
    expect(second.packet?.source.description).toBe("203.0.113.1");
    expect(first.packet?.sourcePort).toBe(40000);
    expect(second.packet?.sourcePort).toBe(1024);

    // The reply of the second flow goes back to PC2 only.
    const reply = simulator.deliverPacket(device(store, "WEB").id, {
      source: IPv4.parse("203.0.113.100") as IPv4,
      destination: IPv4.parse("203.0.113.1") as IPv4,
      protocol: "tcp",
      icmpType: "",
      sourcePort: 80,
      destinationPort: 1024,
      ttl: 255,
    });
    expect(reply.packet?.destination.description).toBe("192.168.1.11");
    expect(reply.packet?.destinationPort).toBe(40000);
    expect(reply.lastDevice).toBe(device(store, "PC2").id);
  });
});

describe("Cisco IOS: dynamic pools", () => {
  function poolLab(overload: boolean) {
    const lab = ciscoLab();
    setLists(lab.store, "R1", [permitList("1", "192.168.1.0 0.0.0.255")]);
    run(
      lab.r1,
      "configure terminal",
      "ip nat pool OUT 203.0.113.10 203.0.113.11 netmask 255.255.255.0",
      `ip nat inside source list 1 pool OUT${overload ? " overload" : ""}`,
      "end",
    );
    return lab;
  }

  test("each host gets its own address from the pool", () => {
    const { store, r1 } = poolLab(false);
    expect(ping(store, "PC1", "203.0.113.100").forward.packet?.source.description).toBe("203.0.113.10");
    expect(ping(store, "PC2", "203.0.113.100").forward.packet?.source.description).toBe("203.0.113.11");
    // The same host keeps its address.
    expect(ping(store, "PC1", "203.0.113.100").forward.packet?.source.description).toBe("203.0.113.10");
    expect(ping(store, "PC1", "203.0.113.100").success).toBe(true);
    expect(ping(store, "PC2", "203.0.113.100").success).toBe(true);

    const table = run(r1, "show ip nat translations");
    expect(table).toContain("--- 203.0.113.10       192.168.1.10       ---                ---");
    expect(table).toContain("--- 203.0.113.11       192.168.1.11       ---                ---");
    expect(table).toContain("icmp 203.0.113.10:");
    const statistics = run(r1, "show ip nat statistics");
    expect(statistics).toContain("pool OUT: netmask 255.255.255.0");
    expect(statistics).toContain("start 203.0.113.10 end 203.0.113.11");
    expect(statistics).toContain("total addresses 2, allocated 2 (100%)");
  });

  test("a pool without overload runs out and the packet is dropped with a reason", () => {
    const { store, r1 } = poolLab(false);
    ping(store, "PC1", "203.0.113.100");
    ping(store, "PC2", "203.0.113.100");
    const third = ping(store, "SRV", "203.0.113.100");
    expect(third.success).toBe(false);
    expect(third.forward.failure?.kind).toBe("dropped");
    const text = new NetworkSimulator(store.project).explain(third);
    expect(text).toContain("R1");
    expect(text).toContain("pool OUT");
    expect(text).toContain("192.168.1.50");
    expect(text).toContain("ip nat inside source list 1 pool OUT");
    expect(session(store, "SRV").execute("ping 203.0.113.100")).toContain("Request timed out.");
    // Clearing the table frees the addresses.
    run(r1, "clear ip nat translation *");
    expect(ping(store, "SRV", "203.0.113.100").forward.packet?.source.description).toBe("203.0.113.10");
  });

  test("with overload all hosts share the first pool address", () => {
    const { store } = poolLab(true);
    for (const pc of ["PC1", "PC2", "SRV"]) {
      const result = ping(store, pc, "203.0.113.100");
      expect(result.success).toBe(true);
      expect(result.forward.packet?.source.description).toBe("203.0.113.10");
    }
  });

  test("the router answers ARP for pool addresses on the outside", () => {
    // A server in the pool's network sends its reply to the pool address: it has to be found.
    const { store } = poolLab(true);
    expect(ping(store, "PC1", "203.0.113.100").back?.delivered).toBe(true);
    // Not for hosts that ask on another router's network.
    const simulator = new NetworkSimulator(store.project);
    const domain = simulator.interfacesOf(device(store, "R1").id).find((iface) => iface.prefix.address.description === "203.0.113.1")?.domain;
    expect(domain).toBeDefined();
    expect(simulator.owner(IPv4.parse("203.0.113.10") as IPv4, domain as number)?.deviceID).toBe(device(store, "R1").id);
    expect(simulator.owner(IPv4.parse("203.0.113.12") as IPv4, domain as number)).toBeNull();
  });
});

describe("Cisco IOS: static NAT", () => {
  function staticLab() {
    const lab = ciscoLab();
    run(lab.r1, "configure terminal", "ip nat inside source static 192.168.1.50 203.0.113.50", "end");
    return lab;
  }

  test("the outside reaches the inside server through its global address", () => {
    const { store } = staticLab();
    const result = ping(store, "WEB", "203.0.113.50");
    expect(result.success).toBe(true);
    expect(result.forward.lastDevice).toBe(device(store, "SRV").id);
    expect(result.forward.packet?.destination.description).toBe("192.168.1.50");
    expect(result.forward.packet?.source.description).toBe("203.0.113.100");
    // The reply leaves with the global address.
    expect(result.back?.packet?.source.description).toBe("203.0.113.50");
    expect(session(store, "WEB").execute("ping 203.0.113.50")).toContain("Reply from 203.0.113.50");
  });

  test("the inside server's own traffic leaves with the static global address", () => {
    const { store } = staticLab();
    const result = ping(store, "SRV", "203.0.113.100");
    expect(result.success).toBe(true);
    expect(result.forward.packet?.source.description).toBe("203.0.113.50");
  });

  test("the static entry is always in the table, the traffic as well", () => {
    const { store, r1 } = staticLab();
    expect(run(r1, "show ip nat translations")).toContain(
      "--- 203.0.113.50       192.168.1.50       ---                ---",
    );
    ping(store, "WEB", "203.0.113.50");
    const table = run(r1, "show ip nat translations");
    expect(table).toContain("icmp 203.0.113.50:1");
    expect(table).toContain("--- 203.0.113.50");
    expect(run(r1, "show ip nat statistics")).toContain("Total active translations: 2 (1 static, 1 dynamic; 1 extended)");
    // clear leaves the static mapping.
    run(r1, "clear ip nat translation *");
    const cleared = run(r1, "show ip nat translations");
    expect(cleared).toContain("--- 203.0.113.50");
    expect(cleared).not.toContain("icmp");
    expect(ping(store, "WEB", "203.0.113.50").success).toBe(true);
  });

  test("without the static rule the global address is not reachable", () => {
    const { store, r1 } = staticLab();
    run(r1, "enable", "configure terminal", "no ip nat inside source static 192.168.1.50 203.0.113.50");
    expect(ping(store, "WEB", "203.0.113.50").success).toBe(false);
  });

  test("without ip nat outside the static global is not answered", () => {
    const { store, r1 } = staticLab();
    run(r1, "configure terminal", "interface gi0/0/1", "no ip nat outside", "end");
    expect(ping(store, "WEB", "203.0.113.50").success).toBe(false);
  });

  test("a static mapping beats a dynamic rule for the same host", () => {
    const { store, r1 } = staticLab();
    setLists(store, "R1", [permitList("1", "192.168.1.0 0.0.0.255")]);
    run(r1, "configure terminal", "ip nat inside source list 1 interface gi0/0/1 overload", "end");
    expect(ping(store, "SRV", "203.0.113.100").forward.packet?.source.description).toBe("203.0.113.50");
    expect(ping(store, "PC1", "203.0.113.100").forward.packet?.source.description).toBe("203.0.113.1");
  });
});

// MARK: MikroTik

/** PC1 and SRV behind R1 (hAP lite): ether2 inside, ether1 outside, WEB outside. */
function routerOSLab() {
  const store = makeStore();
  store.addDevice(hap, { x: 300, y: 0 }, "R1");
  store.addDevice(c2960, { x: 100, y: 0 }, "SW1");
  store.addDevice(pcTemplate, { x: 0, y: 100 }, "PC1");
  store.addDevice(serverTemplate, { x: 200, y: 100 }, "SRV");
  store.addDevice(serverTemplate, { x: 500, y: 0 }, "WEB");
  store.connect(ref(store, "SW1", "Gi0/1"), ref(store, "R1", "ether2"));
  store.connect(ref(store, "PC1", "eth0"), ref(store, "SW1", "Fa0/1"));
  store.connect(ref(store, "SRV", "eth0"), ref(store, "SW1", "Fa0/3"));
  store.connect(ref(store, "WEB", "eth0"), ref(store, "R1", "ether1"));
  setHostAddress(store, "PC1", "192.168.1.10", "192.168.1.1");
  setHostAddress(store, "SRV", "192.168.1.50", "192.168.1.1");
  setHostAddress(store, "WEB", "203.0.113.100", "203.0.113.1");
  const r1 = session(store, "R1");
  run(r1, "/ip address add address=192.168.1.1/24 interface=ether2", "/ip address add address=203.0.113.1/24 interface=ether1");
  return { store, r1 };
}

describe("MikroTik RouterOS: /ip firewall nat", () => {
  test("masquerade on the out-interface translates to its address", () => {
    const { store, r1 } = routerOSLab();
    expect(run(r1, "/ip firewall nat add chain=srcnat action=masquerade out-interface=ether1")).toBe("");
    const result = ping(store, "PC1", "203.0.113.100");
    expect(result.success).toBe(true);
    expect(result.forward.packet?.source.description).toBe("203.0.113.1");
    expect(result.back?.packet?.destination.description).toBe("192.168.1.10");
    expect(session(store, "PC1").execute("ping 203.0.113.100")).toContain("Reply from 203.0.113.100");
  });

  test("without a rule the private address is not translated; src-address limits the rule", () => {
    const { store, r1 } = routerOSLab();
    expect(ping(store, "PC1", "203.0.113.100").forward.packet?.source.description).toBe("192.168.1.10");
    run(r1, "/ip firewall nat add chain=srcnat action=masquerade out-interface=ether1 src-address=192.168.1.0/28");
    expect(ping(store, "PC1", "203.0.113.100").forward.packet?.source.description).toBe("203.0.113.1");
    expect(ping(store, "SRV", "203.0.113.100").forward.packet?.source.description).toBe("192.168.1.50");
  });

  test("a masquerade rule on the wrong interface does not apply", () => {
    const { store, r1 } = routerOSLab();
    run(r1, "/ip firewall nat add chain=srcnat action=masquerade out-interface=ether2");
    expect(ping(store, "PC1", "203.0.113.100").forward.packet?.source.description).toBe("192.168.1.10");
  });

  test("src-nat translates to the given address", () => {
    const { store, r1 } = routerOSLab();
    run(r1, "/ip address add address=203.0.113.9/24 interface=ether1");
    // One address per interface in NetSketch: the second add replaced the first, so use the new one.
    run(r1, "/ip firewall nat add chain=srcnat action=src-nat to-addresses=203.0.113.9 src-address=192.168.1.10");
    const result = ping(store, "PC1", "203.0.113.100");
    expect(result.forward.packet?.source.description).toBe("203.0.113.9");
    expect(result.success).toBe(true);
  });

  test("dst-nat sends traffic for the router's address to an inside server", () => {
    const { store, r1 } = routerOSLab();
    run(r1, "/ip firewall nat add chain=dstnat action=dst-nat dst-address=203.0.113.1 to-addresses=192.168.1.50");
    const result = ping(store, "WEB", "203.0.113.1");
    expect(result.success).toBe(true);
    expect(result.forward.lastDevice).toBe(device(store, "SRV").id);
    expect(result.forward.packet?.destination.description).toBe("192.168.1.50");
    // The reply is translated back by the connection, no src-nat rule needed.
    expect(result.back?.packet?.source.description).toBe("203.0.113.1");
    expect(result.back?.delivered).toBe(true);
  });

  test("dst-nat with protocol and port forwards TCP only; ping still reaches the router", () => {
    const { store, r1 } = routerOSLab();
    run(r1, "/ip firewall nat add chain=dstnat action=dst-nat dst-address=203.0.113.1 protocol=tcp dst-port=80 to-addresses=192.168.1.50 to-ports=8080");
    expect(ping(store, "WEB", "203.0.113.1").forward.lastDevice).toBe(device(store, "R1").id);
    const simulator = new NetworkSimulator(store.project);
    const tcp = (port: number): Packet => ({
      source: IPv4.parse("203.0.113.100") as IPv4,
      destination: IPv4.parse("203.0.113.1") as IPv4,
      protocol: "tcp",
      icmpType: "",
      sourcePort: 50000,
      destinationPort: port,
      ttl: 255,
    });
    const web = simulator.deliverPacket(device(store, "WEB").id, tcp(80));
    expect(web.lastDevice).toBe(device(store, "SRV").id);
    expect(web.packet?.destination.description).toBe("192.168.1.50");
    expect(web.packet?.destinationPort).toBe(8080);
    const other = simulator.deliverPacket(device(store, "WEB").id, tcp(22));
    expect(other.lastDevice).toBe(device(store, "R1").id);
    // The reply of the forwarded flow leaves with the address and port that were asked for.
    const reply = simulator.deliverPacket(device(store, "SRV").id, {
      source: IPv4.parse("192.168.1.50") as IPv4,
      destination: IPv4.parse("203.0.113.100") as IPv4,
      protocol: "tcp",
      icmpType: "",
      sourcePort: 8080,
      destinationPort: 50000,
      ttl: 255,
    });
    expect(reply.packet?.source.description).toBe("203.0.113.1");
    expect(reply.packet?.sourcePort).toBe(80);
  });

  test("print, disable, enable, remove and export", () => {
    const { store, r1 } = routerOSLab();
    run(r1, "/ip firewall nat add chain=srcnat action=masquerade out-interface=ether1 comment=WAN");
    run(r1, "/ip firewall nat add chain=dstnat action=dst-nat dst-address=203.0.113.1 protocol=tcp dst-port=80,443 to-addresses=192.168.1.50");
    const printed = run(r1, "/ip firewall nat print");
    expect(printed).toBe(
      [
        "Flags: X - disabled, I - invalid; D - dynamic",
        ";;; WAN",
        ' 0    chain=srcnat action=masquerade out-interface=ether1 log=no log-prefix=""',
        "",
        ' 1    chain=dstnat action=dst-nat to-addresses=192.168.1.50 protocol=tcp dst-address=203.0.113.1 dst-port=80,443 log=no log-prefix=""',
      ].join("\n"),
    );
    expect(run(r1, "/ip firewall nat disable 0")).toBe("");
    expect(run(r1, "/ip firewall nat print")).toContain(' 0 X  chain=srcnat action=masquerade');
    // A disabled rule translates nothing.
    expect(ping(store, "PC1", "203.0.113.100").forward.packet?.source.description).toBe("192.168.1.10");
    run(r1, "/ip firewall nat enable 0");
    expect(ping(store, "PC1", "203.0.113.100").forward.packet?.source.description).toBe("203.0.113.1");

    const exported = run(r1, "/export");
    expect(exported).toContain(
      "/ip firewall nat\n" +
        'add action=masquerade chain=srcnat comment=WAN out-interface=ether1\n' +
        "add action=dst-nat chain=dstnat dst-address=203.0.113.1 dst-port=80,443 protocol=tcp to-addresses=192.168.1.50",
    );
    expect(run(r1, "/ip firewall nat export")).toContain("add action=masquerade chain=srcnat");

    expect(run(r1, "/ip firewall nat remove 0")).toBe("");
    expect(run(r1, "/ip firewall nat print")).toContain(" 0    chain=dstnat");
    expect(run(r1, "/ip firewall nat remove 5")).toBe("no such item");
    run(r1, "/ip firewall nat remove 0");
    expect(device(store, "R1").protocols).toBeUndefined();
    expect(ping(store, "PC1", "203.0.113.100").forward.packet?.source.description).toBe("192.168.1.10");
  });

  test("wrong arguments are refused", () => {
    const { r1 } = routerOSLab();
    expect(run(r1, "/ip firewall nat add action=masquerade")).toBe("missing value(s) of argument(s) chain");
    expect(run(r1, "/ip firewall nat add chain=srcnat")).toBe("missing value(s) of argument(s) action");
    expect(run(r1, "/ip firewall nat add chain=foo action=masquerade")).toBe("invalid value for argument chain");
    expect(run(r1, "/ip firewall nat add chain=srcnat action=masquerade out-interface=ether9")).toBe(
      "input does not match any value of interface",
    );
    expect(run(r1, "/ip firewall nat add chain=srcnat action=src-nat")).toBe("missing value(s) of argument(s) to-addresses");
    expect(run(r1, "/ip firewall nat add chain=dstnat action=dst-nat to-addresses=300.1.1.1")).toBe(
      "invalid value for argument to-addresses",
    );
    expect(run(r1, "/ip firewall nat add chain=dstnat action=dst-nat to-addresses=1.1.1.1 dst-port=80")).toContain("failure");
    expect(run(r1, "/ip firewall nat add chain=dstnat action=redirect")).toContain("NetSketch:");
    expect(run(r1, "/ip firewall nat add chain=srcnat action=masquerade bogus=1")).toContain("expected end of command");
    expect(run(r1, "/ip firewall nat print")).toBe("Flags: X - disabled, I - invalid; D - dynamic");
  });

  test("a rule whose interface is gone is flagged invalid", () => {
    const { store, r1 } = routerOSLab();
    run(r1, "/ip firewall nat add chain=srcnat action=masquerade out-interface=ether1");
    const hapDevice = device(store, "R1");
    const protocols = structuredClone(hapDevice.protocols as NonNullable<Device["protocols"]>);
    const nat = protocols.nat as NonNullable<typeof protocols.nat>;
    nat.rules[0] = { kind: "masquerade", srcAddress: "", outInterface: "port:00000000-0000-0000-0000-000000000000" };
    store.setProtocols(hapDevice.id, protocols);
    expect(run(r1, "/ip firewall nat print")).toContain(" 0 I  chain=srcnat action=masquerade out-interface=unknown");
  });
});

describe("sharing keywords with other features", () => {
  test("two features that both add `clear` keep each other's subcommands", () => {
    const first = kw("clear", "Reset functions", [kw("ip", "IP", [kw("nat", "NAT")])]);
    const second = kw("clear", "Reset functions", [kw("ip", "IP", [kw("dhcp", "DHCP")]), kw("counters", "Counters")]);
    const merged = mergeNodes([kw("clear", "placeholder"), kw("show", "Show")], [first, second]);
    expect(merged.map((node) => node.keyword)).toEqual(["show", "clear"]);
    const clear = merged[1];
    expect(clear.children.map((node) => node.keyword)).toEqual(["ip", "counters"]);
    expect(clear.children[0].children.map((node) => node.keyword)).toEqual(["nat", "dhcp"]);
  });
});

describe("NAT configuration data", () => {
  test("the reader drops malformed pieces and keeps the rest", async () => {
    const { readProtocols } = await import("../../src/core/protocols");
    const protocols = readProtocols({
      nat: {
        inside: ["port:1", 5],
        outside: "x",
        pools: [{ name: "P", start: "1.1.1.1", end: "1.1.1.9", prefixLength: 24 }, { name: 1 }],
        rules: [
          { kind: "static", local: "a", global: "b" },
          { kind: "dynamic", list: "1", pool: "P", overload: true, disabled: true },
          { kind: "bogus" },
          7,
        ],
      },
    });
    expect(protocols.nat?.inside).toEqual(["port:1"]);
    expect(protocols.nat?.outside).toEqual([]);
    expect(protocols.nat?.pools.length).toBe(1);
    expect(protocols.nat?.rules).toEqual([
      { kind: "static", local: "a", global: "b" },
      { kind: "dynamic", list: "1", pool: "P", overload: true, disabled: true },
    ]);
  });

  test("projects without NAT stay without the protocols field", () => {
    const { store, r1 } = ciscoLab({ nat: false });
    run(r1, "end");
    expect(device(store, "R1").protocols).toBeUndefined();
    expect(r1.execute("show running-config")).not.toContain("nat");
  });
});
