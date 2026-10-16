// MAC and ARP tables on the Cisco IOS console: learning from ping, filters, clear commands,
// the shared model, stale entries.

import { beforeEach, describe, expect, test } from "vitest";
import type { PortRef } from "../../src/core/model";
import { PortNaming } from "../../src/core/port-naming";
import { ProjectStore } from "../../src/core/store";
import { CLISession } from "../../src/cli/session";
import { arpTable, clearArpCache, clearMacTable, formatMAC, macTable } from "../../src/cli/features/macarp/model";
import { macAddress } from "../../src/cli/sim/mac";
import { NetworkSimulator } from "../../src/cli/sim/network-simulator";
import { NetworkRuntime } from "../../src/cli/sim/runtime";

const c2960 = "cisco-catalyst-2960-24";
const isr4321 = "cisco-isr-4321";
const pcTemplate = "generic-pc";

function makeStore(): ProjectStore {
  const store = new ProjectStore();
  store.snapToGrid = false;
  return store;
}

function ref(store: ProjectStore, hostname: string, name: string): PortRef {
  const owner = store.project.devices.find((item) => item.hostname === hostname);
  if (!owner) throw new Error(`missing device ${hostname}`);
  const port =
    owner.ports.find((item) => item.name === name) ??
    owner.ports.find((item) => PortNaming.shortName(item.name) === name);
  if (!port) throw new Error(`missing port ${hostname} ${name}`);
  return { deviceID: owner.id, portID: port.id };
}

function add(store: ProjectStore, template: string, hostname: string): CLISession {
  const device = store.addDevice(template, { x: store.project.devices.length * 100, y: 0 }, hostname);
  return new CLISession(store, device.id);
}

function connect(store: ProjectStore, a: string, portA: string, b: string, portB: string): void {
  store.connect(ref(store, a, portA), ref(store, b, portB));
}

function run(cli: CLISession, ...lines: string[]): string {
  let output = "";
  for (const line of lines) output = cli.execute(line);
  return output;
}

function ios(cli: CLISession, ...lines: string[]): string {
  run(cli, "enable", "configure terminal");
  const output = run(cli, ...lines);
  cli.execute("end");
  return output;
}

function deviceOf(store: ProjectStore, hostname: string) {
  const found = store.project.devices.find((item) => item.hostname === hostname);
  if (!found) throw new Error(`missing device ${hostname}`);
  return found;
}

/** The PC command prompt reports the MAC in the Windows notation; the console prints Cisco's. */
function macOf(store: ProjectStore, hostname: string, portName: string): string {
  const portRef = ref(store, hostname, portName);
  return macAddress(portRef.portID, "cisco");
}


/**
 * PC1, PC2 - SW1 - SW2 - R1 (Gi0/0/0 192.168.10.1/24), PC3 on SW2. All in VLAN 1.
 * SW1: Fa0/1 PC1, Fa0/2 PC2, Fa0/24 -> SW2 Fa0/24. SW2: Fa0/1 PC3, Fa0/2 R1.
 */
function lab() {
  const store = makeStore();
  const r1 = add(store, isr4321, "R1");
  const sw1 = add(store, c2960, "SW1");
  const sw2 = add(store, c2960, "SW2");
  const pc1 = add(store, pcTemplate, "PC1");
  const pc2 = add(store, pcTemplate, "PC2");
  const pc3 = add(store, pcTemplate, "PC3");
  connect(store, "PC1", "eth0", "SW1", "Fa0/1");
  connect(store, "PC2", "eth0", "SW1", "Fa0/2");
  connect(store, "SW1", "Fa0/24", "SW2", "Fa0/24");
  connect(store, "PC3", "eth0", "SW2", "Fa0/1");
  connect(store, "R1", "Gi0/0/0", "SW2", "Fa0/2");
  ios(r1, "interface gi0/0/0", "ip address 192.168.10.1 255.255.255.0", "no shutdown");
  return { store, r1, sw1, sw2, pc1, pc2, pc3 };
}

function setHost(store: ProjectStore, hostname: string, ip: string): void {
  const device = deviceOf(store, hostname);
  const portID = device.ports[0].id;
  store.setAddress(device.id, `port:${portID}`, `${ip}/24`);
  store.setDefaultGateway(device.id, "192.168.10.1");
}

beforeEach(() => {
  NetworkRuntime.reset();
});

describe("Cisco IOS: MAC address table", () => {
  test("is empty until traffic, with the real header", () => {
    const { sw1 } = lab();
    const output = run(sw1, "enable", "show mac address-table");
    expect(output).toContain("Mac Address Table");
    expect(output).toContain("Vlan    Mac Address       Type        Ports");
    expect(output).toContain("Total Mac Addresses for this criterion: 0");
    expect(output).not.toContain("DYNAMIC");
  });

  test("a ping teaches the switches on the path and the broadcast the other ones", () => {
    const { store, sw1, sw2, pc1, r1 } = lab();
    setHost(store, "PC1", "192.168.10.11");
    const ping = run(pc1, "ping 192.168.10.1");
    expect(ping).not.toContain("NetSketch: požadavek nedošel");
    const pc1MAC = macOf(store, "PC1", "eth0");
    const r1MAC = macOf(store, "R1", "Gi0/0/0");

    const first = run(sw1, "enable", "show mac address-table");
    expect(first).toMatch(new RegExp(`\\s1\\s+${pc1MAC.replace(/\./g, "\\.")}\\s+DYNAMIC\\s+Fa0/1`));
    expect(first).toMatch(new RegExp(`${r1MAC.replace(/\./g, "\\.")}\\s+DYNAMIC\\s+Fa0/24`));
    expect(first).toContain("Total Mac Addresses for this criterion: 2");

    const second = run(sw2, "enable", "show mac address-table");
    expect(second).toMatch(new RegExp(`${pc1MAC.replace(/\./g, "\\.")}\\s+DYNAMIC\\s+Fa0/24`));
    expect(second).toMatch(new RegExp(`${r1MAC.replace(/\./g, "\\.")}\\s+DYNAMIC\\s+Fa0/2\\b`));
    void r1;
  });

  test("a host that has not sent anything is not in the table", () => {
    const { store, sw1, pc1 } = lab();
    setHost(store, "PC1", "192.168.10.11");
    setHost(store, "PC2", "192.168.10.12");
    run(pc1, "ping 192.168.10.1");
    const output = run(sw1, "enable", "show mac address-table");
    expect(output).not.toContain(macOf(store, "PC2", "eth0"));
  });

  test("dynamic, vlan and interface filters; the old spelling", () => {
    const { store, sw1, pc1 } = lab();
    setHost(store, "PC1", "192.168.10.11");
    run(pc1, "ping 192.168.10.1");
    run(sw1, "enable");
    expect(run(sw1, "show mac address-table dynamic")).toContain("Total Mac Addresses for this criterion: 2");
    expect(run(sw1, "show mac address-table vlan 1")).toContain("Total Mac Addresses for this criterion: 2");
    expect(run(sw1, "show mac address-table vlan 20")).toContain("Total Mac Addresses for this criterion: 0");
    const port = run(sw1, "show mac address-table interface fa0/1");
    expect(port).toContain("Total Mac Addresses for this criterion: 1");
    expect(port).toContain(macOf(store, "PC1", "eth0"));
    expect(run(sw1, "show mac address-table dynamic interface fa0/24")).toContain(
      "Total Mac Addresses for this criterion: 1",
    );
    expect(run(sw1, "show mac-address-table")).toContain("Total Mac Addresses for this criterion: 2");
    expect(run(sw1, "show mac address-table interface")).toContain("Incomplete");
  });

  test("VLANs: the entry is in the VLAN of the access port", () => {
    const { store, sw1, sw2, pc1, r1 } = lab();
    ios(sw1, "vlan 10", "name LAN", "exit", "interface fa0/1", "switchport mode access", "switchport access vlan 10");
    ios(sw1, "interface fa0/24", "switchport mode trunk");
    ios(sw2, "vlan 10", "name LAN", "exit", "interface fa0/24", "switchport mode trunk");
    ios(sw2, "interface fa0/2", "switchport mode access", "switchport access vlan 10");
    ios(sw2, "interface fa0/1", "switchport mode access", "switchport access vlan 10");
    setHost(store, "PC1", "192.168.10.11");
    expect(run(pc1, "ping 192.168.10.1")).not.toContain("NetSketch: požadavek nedošel");
    run(sw1, "enable");
    expect(run(sw1, "show mac address-table vlan 10")).toContain("Total Mac Addresses for this criterion: 2");
    expect(run(sw1, "show mac address-table vlan 1")).toContain("Total Mac Addresses for this criterion: 0");
    void r1;
  });

  test("clear mac address-table dynamic (all, by vlan, by interface)", () => {
    const { store, sw1, pc1 } = lab();
    setHost(store, "PC1", "192.168.10.11");
    run(pc1, "ping 192.168.10.1");
    run(sw1, "enable");
    expect(run(sw1, "clear mac address-table dynamic interface fa0/1")).toBe("");
    expect(run(sw1, "show mac address-table")).toContain("Total Mac Addresses for this criterion: 1");
    expect(run(sw1, "clear mac address-table dynamic vlan 20")).toBe("");
    expect(run(sw1, "show mac address-table")).toContain("Total Mac Addresses for this criterion: 1");
    expect(run(sw1, "clear mac address-table dynamic")).toBe("");
    expect(run(sw1, "show mac address-table")).toContain("Total Mac Addresses for this criterion: 0");
    expect(run(sw1, "show mac address-table")).not.toContain("DYNAMIC");
  });

  test("the table follows the diagram: an unplugged cable drops its entries", () => {
    const { store, sw1, pc1 } = lab();
    setHost(store, "PC1", "192.168.10.11");
    run(pc1, "ping 192.168.10.1");
    const link = store.project.links.find(
      (item) => item.a.deviceID === deviceOf(store, "PC1").id || item.b.deviceID === deviceOf(store, "PC1").id,
    );
    store.removeLink(link!.id);
    const output = run(sw1, "enable", "show mac address-table");
    expect(output).not.toContain(macOf(store, "PC1", "eth0"));
  });

  test("a router is not a switch", () => {
    const { r1 } = lab();
    expect(run(r1, "enable", "show mac address-table")).toContain("NetSketch: toto zařízení není přepínač");
    expect(run(r1, "clear mac address-table dynamic")).toContain("NetSketch: toto zařízení není přepínač");
  });

  test("clear is not available in user EXEC", () => {
    const { sw1 } = lab();
    expect(run(sw1, "clear mac address-table dynamic")).toContain("%");
  });

  test("help lists the keywords", () => {
    const { sw1 } = lab();
    run(sw1, "enable");
    expect(sw1.help("show mac address-table ")).toContain("dynamic");
    expect(sw1.help("show mac address-table ")).toContain("vlan");
    expect(sw1.help("clear mac address-table ")).toContain("dynamic");
    expect(sw1.help("show mac ")).toContain("address-table");
  });
});

describe("Cisco IOS: ARP table", () => {
  test("a router lists its own address with a dash and the hosts that talked to it", () => {
    const { store, r1, pc1 } = lab();
    setHost(store, "PC1", "192.168.10.11");
    run(pc1, "ping 192.168.10.1");
    const output = run(r1, "enable", "show ip arp");
    expect(output).toContain("Protocol  Address          Age (min)  Hardware Addr   Type   Interface");
    expect(output).toMatch(/Internet\s+192\.168\.10\.1\s+-\s+\S+\s+ARPA\s+GigabitEthernet0\/0\/0/);
    expect(output).toMatch(
      new RegExp(
        `Internet\\s+192\\.168\\.10\\.11\\s+0\\s+${macOf(store, "PC1", "eth0").replace(/\./g, "\\.")}\\s+ARPA\\s+GigabitEthernet0/0/0`,
      ),
    );
    expect(run(r1, "show arp")).toBe(output);
  });

  test("the pinging host learns the gateway; address and vlan filters", () => {
    const { store, r1, pc1 } = lab();
    setHost(store, "PC1", "192.168.10.11");
    run(pc1, "ping 192.168.10.1");
    run(r1, "enable");
    const one = run(r1, "show ip arp 192.168.10.11");
    expect(one).toContain("192.168.10.11");
    expect(one).not.toContain("192.168.10.1 ");
    expect(run(r1, "show ip arp 10.9.9.9")).toBe("");
    expect(run(r1, "show ip arp vlan 10")).toBe("");
    expect(run(r1, "show ip arp 999")).toContain("%");
  });

  test("clear arp-cache removes learned entries, not the own ones", () => {
    const { store, r1, pc1 } = lab();
    setHost(store, "PC1", "192.168.10.11");
    run(pc1, "ping 192.168.10.1");
    run(r1, "enable");
    expect(run(r1, "clear arp-cache")).toBe("");
    const output = run(r1, "show ip arp");
    expect(output).not.toContain("192.168.10.11");
    expect(output).toContain("192.168.10.1 ");
    run(pc1, "ping 192.168.10.1");
    expect(run(r1, "show ip arp")).toContain("192.168.10.11");
    expect(run(r1, "clear ip arp")).toBe("");
    expect(run(r1, "show ip arp")).not.toContain("192.168.10.11");
  });

  test("directly cabled routers know each other without a ping, until cleared", () => {
    const store = makeStore();
    const r1 = add(store, isr4321, "R1");
    const r2 = add(store, isr4321, "R2");
    connect(store, "R1", "Gi0/0/0", "R2", "Gi0/0/0");
    ios(r1, "interface gi0/0/0", "ip address 10.0.0.1 255.255.255.0", "no shutdown");
    ios(r2, "interface gi0/0/0", "ip address 10.0.0.2 255.255.255.0", "no shutdown");
    run(r1, "enable");
    expect(run(r1, "show ip arp")).toMatch(/10\.0\.0\.2\s+0\s+\S+\s+ARPA/);
    run(r1, "clear arp-cache");
    expect(run(r1, "show ip arp")).not.toContain("10.0.0.2");
    expect(run(r1, "show ip arp")).not.toContain("10.0.0.2");
    run(r1, "ping 10.0.0.2");
    expect(run(r1, "show ip arp")).toMatch(/10\.0\.0\.2\s+0\s+\S+\s+ARPA/);
  });

  test("do show works in configuration mode and the NAT clear keeps working", () => {
    const { r1 } = lab();
    run(r1, "enable", "configure terminal");
    expect(run(r1, "do show ip arp")).toContain("Protocol");
    expect(run(r1, "do clear arp-cache")).toBe("");
    expect(r1.help("do clear ")).toContain("arp-cache");
    run(r1, "end");
    expect(r1.help("clear ")).toContain("ip");
    expect(r1.help("clear ip ")).toContain("nat");
    expect(r1.help("clear ip ")).toContain("arp");
  });
});

describe("Shared model", () => {
  test("any console can read the tables through the model", () => {
    const { store, pc1, sw1, r1 } = lab();
    setHost(store, "PC1", "192.168.10.11");
    run(pc1, "ping 192.168.10.1");
    const sim = new NetworkSimulator(store.project);
    const switchID = deviceOf(store, "SW1").id;
    const rows = macTable(sim, switchID);
    expect(rows.map((row) => row.port.name.endsWith("0/1") || row.port.name.endsWith("0/24"))).toEqual([true, true]);
    expect(formatMAC(rows[0].mac, "colon")).toMatch(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
    expect(formatMAC(rows[0].mac, "windows")).toMatch(/^([0-9A-F]{2}-){5}[0-9A-F]{2}$/);
    const arp = arpTable(sim, deviceOf(store, "PC1").id);
    expect(arp.map((row) => row.address.description)).toEqual(["192.168.10.11", "192.168.10.1"]);
    expect(arp[1].mac).toBe(macOf(store, "R1", "Gi0/0/0"));
    clearMacTable(switchID);
    clearArpCache(deviceOf(store, "PC1").id);
    expect(macTable(sim, switchID)).toEqual([]);
    expect(arpTable(sim, deviceOf(store, "PC1").id)).toHaveLength(1);
    void sw1;
    void r1;
  });

  test("a failed ping teaches nothing", () => {
    const { store, pc1, sw1 } = lab();
    setHost(store, "PC1", "192.168.10.11");
    run(pc1, "ping 192.168.10.77");
    expect(run(sw1, "enable", "show mac address-table")).toContain("Total Mac Addresses for this criterion: 0");
  });
});
