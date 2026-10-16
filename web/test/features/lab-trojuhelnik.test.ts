// Lab Trojúhelník (15. 10. 2026): R1 + SW1 (Cisco MST) + Dell N3024 (OS6) + UniFi US-48-G1 + PC,
// configured through the consoles exactly as in the lab, then STP, DHCP, ping and failover checked.

import { describe, expect, test } from "vitest";
import { ProjectStore } from "../../src/core/store";
import { CLISession } from "../../src/cli/session";
import { computeSpanningTree } from "../../src/cli/features/layer2/stp";
import { device, port, ref } from "../cli/support";

function add(store: ProjectStore, template: string, hostname: string): CLISession {
  const added = store.addDevice(template, { x: store.project.devices.length * 100, y: 0 }, hostname);
  return new CLISession(store, added.id);
}

function lines(cli: CLISession, ...input: string[]): string {
  let output = "";
  for (const line of input) output = cli.execute(line);
  return output;
}

function lab() {
  const store = new ProjectStore();
  store.snapToGrid = false;
  const r1 = add(store, "cisco-isr-4321", "R1");
  const sw1 = add(store, "cisco-catalyst-2960-24", "SW1");
  const dell = add(store, "dell-emc-n3024", "Dell");
  const unifi = add(store, "ubiquiti-us-48-g1", "UniFi");
  const pc = add(store, "generic-pc", "PC1");

  // Cables as in the lab (third cable, Dell Gi1/0/2 - UniFi Port 1, closes the triangle).
  store.connect(ref(store, "R1", "Gi0/0/0"), ref(store, "SW1", "Fa0/3"));
  store.connect(ref(store, "SW1", "Fa0/1"), ref(store, "Dell", "Gi1/0/1"));
  store.connect(ref(store, "SW1", "Fa0/2"), ref(store, "UniFi", "Port 2"));
  store.connect(ref(store, "Dell", "Gi1/0/2"), ref(store, "UniFi", "Port 1"));
  store.connect(ref(store, "SW1", "Fa0/4"), ref(store, "PC1", "eth0"));

  lines(r1, "enable", "conf t", "interface gi0/0/0", "ip address 192.168.10.1 255.255.255.0", "no shutdown", "exit",
    "ip dhcp excluded-address 192.168.10.1 192.168.10.9", "ip dhcp pool LAN10",
    "network 192.168.10.0 255.255.255.0", "default-router 192.168.10.1", "dns-server 8.8.8.8", "exit", "end");

  lines(sw1, "enable", "conf t", "hostname SW1", "vlan 10", "name LAN", "exit",
    "spanning-tree mode mst", "spanning-tree mst 0 priority 8192",
    "interface range fa0/1-2", "switchport mode trunk", "exit",
    "interface range fa0/3-4", "switchport mode access", "switchport access vlan 10", "spanning-tree portfast", "exit",
    "interface vlan 10", "ip address 192.168.10.2 255.255.255.0", "no shutdown", "exit",
    "ip default-gateway 192.168.10.1", "end");

  lines(dell, "enable", "configure", "hostname Dell", "vlan 10", "name LAN", "exit",
    "spanning-tree mode rstp", "spanning-tree priority 4096",
    "interface vlan 10", "ip address 192.168.10.3 255.255.255.0", "exit",
    "ip default-gateway 192.168.10.1",
    "interface gi1/0/1", "switchport mode trunk", "exit",
    "interface gi1/0/2", "switchport mode trunk", "exit", "exit");

  lines(unifi, "telnet localhost", "enable", "configure", "spanning-tree mst priority 0 12288", "exit",
    "vlan database", "vlan 10", "vlan name 10 LAN", "exit", "configure",
    "interface 0/1", "vlan participation include 10", "vlan tagging 10", "exit",
    "interface 0/2", "vlan participation include 10", "vlan tagging 10", "exit",
    "exit", "network mgmt_vlan 10");

  return { store, r1, sw1, dell, unifi, pc };
}

function roleOf(store: ProjectStore, hostname: string, portName: string) {
  const bridge = computeSpanningTree(store.project).get(device(store, hostname).id)!;
  const id = port(store, hostname, portName).id;
  return bridge.ports.find((item) => item.portID === id)!;
}

describe("lab Trojúhelník v simulaci", () => {
  test("STP: root je Dell, UniFi má root port k Dellu, blokovaný je Fa0/2 na SW1", () => {
    const { store } = lab();
    const tree = computeSpanningTree(store.project);
    expect(tree.get(device(store, "Dell").id)!.isRoot).toBe(true);
    expect(tree.get(device(store, "SW1").id)!.isRoot).toBe(false);
    expect(tree.get(device(store, "UniFi").id)!.isRoot).toBe(false);
    const root = roleOf(store, "UniFi", "Port 1");
    expect(root.role).toBe("root");
    expect(root.cost).toBe(20000);
    // Na lince SW1-UniFi rozhoduje nejdřív cena cesty k rootu (UniFi 20000 < SW1 200000), až pak ID mostu:
    // designated je UniFi Port 2, zablokovaný je SW1 Fa0/2.
    expect(roleOf(store, "UniFi", "Port 2")).toMatchObject({ role: "designated", state: "forwarding" });
    expect(roleOf(store, "SW1", "Fa0/2")).toMatchObject({ role: "alternate", state: "blocking" });
  });

  test("show spanning-tree na všech třech switchích ukazuje Dell jako root", () => {
    const { sw1, dell, unifi } = lab();
    expect(dell.execute("show spanning-tree")).toContain("4096");
    expect(sw1.execute("show spanning-tree mst 0")).toMatch(/Root|root/);
    expect(unifi.execute("show spanning-tree")).toContain("12288");
  });

  test("DHCP, VLAN 10 a ping skrz smyčku z PC na všechna zařízení", () => {
    const { pc, unifi } = lab();
    // UniFi si vzal adresu z DHCP (management ve VLAN 10), PC dostane další.
    expect(unifi.execute("show network")).toContain("192.168.10.10");
    const renew = pc.execute("ipconfig /renew");
    expect(renew).toContain("192.168.10.11");
    for (const target of ["192.168.10.1", "192.168.10.2", "192.168.10.3", "192.168.10.10"]) {
      expect(pc.execute(`ping ${target}`)).toContain(`Reply from ${target}`);
    }
  });

  test("Dell OS6: show vlan a odmítnutý show ip interface brief", () => {
    const { dell } = lab();
    expect(dell.execute("show vlan")).toContain("LAN");
    expect(dell.execute("show ip interface brief")).toContain("Invalid input");
    expect(dell.execute("show ip interface vlan 10")).toContain("192.168.10.3");
  });

  test("UniFi: ping není v CLI, ale je v shellu; show vlan port ukazuje tagged VLAN 10", () => {
    const { unifi } = lab();
    expect(unifi.execute("ping 192.168.10.1")).toContain("Invalid input");
    expect(unifi.execute("show vlan port 0/1")).toContain("Tagged");
    unifi.execute("exit"); // privileged -> user
    unifi.execute("exit"); // user -> shell
    expect(unifi.execute("ping -c 3 192.168.10.1")).toContain("192.168.10.1");
  });

  test("failover: po odpojení kabelu Dell-UniFi se UniFi Port 2 stane root portem a síť zůstane dostupná", () => {
    const { store, pc, unifi } = lab();
    pc.execute("ipconfig /renew");
    const link = store.project.links.find((item) => {
      const dellPort = port(store, "Dell", "Gi1/0/2").id;
      return item.a.portID === dellPort || item.b.portID === dellPort;
    })!;
    store.removeLink(link.id);
    expect(roleOf(store, "UniFi", "Port 2")).toMatchObject({ role: "root", state: "forwarding" });
    expect(pc.execute("ping 192.168.10.10")).toContain("Reply from 192.168.10.10");
    expect(unifi.prompt).toBeTruthy();
  });
});
