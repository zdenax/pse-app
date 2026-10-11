// DHCP: server (Cisco, MikroTik, Dell), relay, client (PC, router, SVI, MikroTik), bindings,
// running-config, undo.

import type { PortRef } from "../../src/core/model";
import { PortNaming } from "../../src/core/port-naming";
import { readProtocols } from "../../src/core/protocols";
import { ProjectStore } from "../../src/core/store";
import { CLISession } from "../../src/cli/session";
import { onPacketTrace, type PacketTrace } from "../../src/cli/sim/trace-events";

const c2960 = "cisco-catalyst-2960-24";
const isr4321 = "cisco-isr-4321";
const hap = "mikrotik-hap-lite";
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

/** Runs the lines in global configuration mode and returns the output of the last one. */
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

/** PC1 and PC2 - SW - R1 (192.168.10.1/24 on Gi0/0/0, pool LAN10, .1-.10 excluded). */
function lan() {
  const store = makeStore();
  const r1 = add(store, isr4321, "R1");
  const sw = add(store, c2960, "SW");
  const pc1 = add(store, pcTemplate, "PC1");
  const pc2 = add(store, pcTemplate, "PC2");
  connect(store, "R1", "Gi0/0/0", "SW", "Fa0/24");
  connect(store, "PC1", "eth0", "SW", "Fa0/1");
  connect(store, "PC2", "eth0", "SW", "Fa0/2");
  ios(
    r1,
    "interface gi0/0/0",
    "ip address 192.168.10.1 255.255.255.0",
    "no shutdown",
    "exit",
    "ip dhcp excluded-address 192.168.10.1 192.168.10.10",
    "ip dhcp pool LAN10",
    "network 192.168.10.0 255.255.255.0",
    "default-router 192.168.10.1",
    "dns-server 8.8.8.8",
  );
  return { store, r1, sw, pc1, pc2 };
}

const noAdapter = "The operation failed as no adapter is in the state permissible for this operation.";

describe("DHCP server on a Cisco router", () => {
  test("a PC renews and gets the first address after the excluded range and the gateway", () => {
    const { store, pc1 } = lan();
    const output = pc1.execute("ipconfig /renew");
    expect(output).toContain("Windows IP Configuration");
    expect(output).toContain("192.168.10.11");
    const pc = deviceOf(store, "PC1");
    expect(pc.addresses.map((entry) => entry.address)).toEqual(["192.168.10.11/24"]);
    expect(pc.defaultGateway).toBe("192.168.10.1");
    expect(pc1.execute("ping 192.168.10.1")).toContain("Reply from 192.168.10.1");
  });

  test("two PCs get different addresses and a repeated renew keeps the address", () => {
    const { store, pc1, pc2 } = lan();
    pc1.execute("ipconfig /renew");
    pc2.execute("ipconfig /renew");
    expect(deviceOf(store, "PC1").addresses[0].address).toBe("192.168.10.11/24");
    expect(deviceOf(store, "PC2").addresses[0].address).toBe("192.168.10.12/24");
    pc1.execute("ipconfig /renew");
    expect(deviceOf(store, "PC1").addresses[0].address).toBe("192.168.10.11/24");
    expect(pc2.execute("ping 192.168.10.11")).toContain("Reply from 192.168.10.11");
  });

  test("ipconfig /all shows the DHCP state, the MAC and what the server told", () => {
    const { pc1 } = lan();
    expect(pc1.execute("ipconfig /all")).toContain("DHCP Enabled . . . . . . . . . .  : No");
    pc1.execute("ipconfig /renew");
    const all = pc1.execute("ipconfig /all");
    expect(all).toContain("DHCP Enabled . . . . . . . . . .  : Yes");
    expect(all).toMatch(/Physical Address \. .*: 02-[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}/);
    expect(all).toContain("DHCP Server . . . . . . . . . . . : 192.168.10.1");
    expect(all).toContain("DNS Servers . . . . . . . . . . . : 8.8.8.8");
  });

  test("release gives the address back, the next client can have it", () => {
    const { store, pc1, pc2 } = lan();
    pc1.execute("ipconfig /renew");
    expect(deviceOf(store, "PC1").addresses).toHaveLength(1);
    const released = pc1.execute("ipconfig /release");
    expect(released).toContain("0.0.0.0");
    expect(deviceOf(store, "PC1").addresses).toHaveLength(0);
    expect(deviceOf(store, "PC1").defaultGateway).toBe("");
    pc2.execute("ipconfig /renew");
    expect(deviceOf(store, "PC2").addresses[0].address).toBe("192.168.10.11/24");
    // Nothing to release a second time.
    expect(pc1.execute("ipconfig /release")).toBe(noAdapter);
  });

  test("an address used by another device is not handed out", () => {
    const { store, pc1, pc2 } = lan();
    pc2.execute("netsh interface ip set address eth0 static 192.168.10.11 255.255.255.0 192.168.10.1");
    pc1.execute("ipconfig /renew");
    expect(deviceOf(store, "PC1").addresses[0].address).toBe("192.168.10.12/24");
  });

  test("an exhausted pool is explained", () => {
    const { store, r1, pc1, pc2 } = lan();
    ios(r1, "ip dhcp excluded-address 192.168.10.11 192.168.10.253");
    pc1.execute("ipconfig /renew");
    expect(deviceOf(store, "PC1").addresses[0].address).toBe("192.168.10.254/24");
    const output = pc2.execute("ipconfig /renew");
    expect(output).toContain(
      "An error occurred while renewing interface eth0 : unable to contact your DHCP server. Request has timed out.",
    );
    expect(output).toContain("NetSketch: DHCP neuspělo – pool LAN10 na R1 (192.168.10.0/24) je vyčerpaný");
    expect(deviceOf(store, "PC2").addresses).toHaveLength(0);
  });

  test("without a server the renew fails with a Czech explanation", () => {
    const store = makeStore();
    add(store, c2960, "SW");
    const pc = add(store, pcTemplate, "PC1");
    connect(store, "PC1", "eth0", "SW", "Fa0/1");
    const output = pc.execute("ipconfig /renew");
    expect(output.split("\n")[0]).toBe(
      "An error occurred while renewing interface eth0 : unable to contact your DHCP server. Request has timed out.",
    );
    expect(output).toContain("NetSketch: DHCP neuspělo – v síti rozhraní eth0");
    expect(output).toContain("není žádné zařízení s DHCP poolem");
    expect(deviceOf(store, "PC1").addresses).toHaveLength(0);
  });

  test("a shut down port or a missing cable is reported", () => {
    const { store, sw, pc1 } = lan();
    ios(sw, "interface fa0/1", "shutdown");
    const down = pc1.execute("ipconfig /renew");
    expect(down).toContain("No operation can be performed on eth0 while it has its media disconnected.");
    expect(down).toContain("protější konec kabelu (SW Fa0/1) je vypnutý");
    const lonely = makeStore();
    const pc = add(lonely, pcTemplate, "PC");
    expect(pc.execute("ipconfig /renew")).toContain("není připojen kabel");
    expect(deviceOf(store, "PC1").addresses).toHaveLength(0);
  });

  test("a server whose pool belongs to another network is named in the explanation", () => {
    const { r1, pc1 } = lan();
    ios(r1, "ip dhcp pool LAN10", "network 172.16.0.0 255.255.0.0");
    const output = pc1.execute("ipconfig /renew");
    expect(output).toContain("pool LAN10 obsluhuje jinou síť (172.16.0.0/16)");
  });

  test("a pool without a network says so", () => {
    const { r1, pc1 } = lan();
    ios(r1, "ip dhcp pool LAN10", "no network");
    expect(pc1.execute("ipconfig /renew")).toContain("na R1: pool LAN10 nemá příkaz network.");
  });

  test("renew and release take an adapter name; static adapters are left alone", () => {
    const { store, pc1 } = lan();
    expect(pc1.execute("ipconfig /renew eth9")).toBe(noAdapter);
    expect(pc1.execute("ipconfig /renew ETH*")).toContain("192.168.10.11");
    pc1.execute("netsh interface ip set address eth0 static 10.9.9.9 255.255.255.0");
    expect(pc1.execute("ipconfig /renew eth0")).toBe(noAdapter);
    expect(deviceOf(store, "PC1").addresses[0].address).toBe("10.9.9.9/24");
    expect(deviceOf(store, "PC1").protocols).toBeUndefined();
  });

  test("netsh switches an adapter to DHCP and back to a static address", () => {
    const { store, pc1 } = lan();
    pc1.execute("netsh interface ip set address eth0 static 10.9.9.9 255.255.255.0 10.9.9.1");
    expect(pc1.execute("netsh interface ip set address eth0 dhcp")).toBe("Ok.");
    expect(deviceOf(store, "PC1").addresses.map((entry) => entry.address)).toEqual(["192.168.10.11/24"]);
    expect(deviceOf(store, "PC1").defaultGateway).toBe("192.168.10.1");
    expect(deviceOf(store, "PC1").protocols?.dhcp?.clients).toHaveLength(1);
    pc1.execute("netsh interface ip set address eth0 static 10.9.9.9 255.255.255.0");
    expect(deviceOf(store, "PC1").protocols).toBeUndefined();
    expect(pc1.execute("ipconfig /all")).toContain("DHCP Enabled . . . . . . . . . .  : No");
  });

  test("the whole renew is one undo step", () => {
    const { store, pc1 } = lan();
    const before = JSON.stringify(deviceOf(store, "PC1"));
    pc1.execute("ipconfig /renew");
    expect(deviceOf(store, "PC1").addresses).toHaveLength(1);
    expect(store.undo()).toBe(true);
    expect(JSON.stringify(deviceOf(store, "PC1"))).toBe(before);
  });

  test("the exchange is announced as a dhcp packet trace", () => {
    const { pc1 } = lan();
    const traces: PacketTrace[] = [];
    const stop = onPacketTrace((trace) => traces.push(trace));
    pc1.execute("ipconfig /renew");
    stop();
    expect(traces).toHaveLength(1);
    expect(traces[0].kind).toBe("dhcp");
    expect(traces[0].success).toBe(true);
    expect(traces[0].forward.length).toBeGreaterThan(0);
    expect(traces[0].back.length).toBeGreaterThan(0);
    expect(traces[0].forward[0].fromDevice).toBe(traces[0].deviceID);
  });
});

describe("Cisco show commands and configuration", () => {
  test("show ip dhcp binding lists the clients with their MAC addresses", () => {
    const { r1, pc1, pc2 } = lan();
    expect(run(r1, "enable", "show ip dhcp binding").split("\n")).toHaveLength(4);
    pc1.execute("ipconfig /renew");
    pc2.execute("ipconfig /renew");
    const lines = run(r1, "show ip dhcp binding").split("\n");
    expect(lines[0]).toBe("Bindings from all pools not associated with VRF:");
    expect(lines).toHaveLength(6);
    expect(lines[4]).toMatch(
      /^192\.168\.10\.11 +0102\.[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{2} +Jan 02 2026 12:00 AM +Automatic +Active +GigabitEthernet0\/0\/0$/,
    );
    expect(lines[5].startsWith("192.168.10.12 ")).toBe(true);
    expect(run(r1, "show ip dhcp binding 192.168.10.12").split("\n")).toHaveLength(5);
  });

  test("show ip dhcp pool counts the leases", () => {
    const { r1, pc1 } = lan();
    pc1.execute("ipconfig /renew");
    const output = run(r1, "enable", "show ip dhcp pool");
    expect(output).toContain("Pool LAN10 :");
    expect(output).toContain("Total addresses                : 254");
    expect(output).toContain("Leased addresses               : 1");
    expect(output).toContain("192.168.10.12");
    expect(run(r1, "show ip dhcp pool NOPE")).toBe("");
  });

  test("show running-config lists the excluded addresses, the pool and the helper address", () => {
    const { r1 } = lan();
    ios(r1, "interface gi0/0/1", "ip helper-address 10.9.9.9", "exit", "ip dhcp pool LAN10", "domain-name example.com", "lease 7");
    const config = run(r1, "enable", "show running-config");
    expect(config).toContain("\nip dhcp excluded-address 192.168.10.1 192.168.10.10\n!\n");
    expect(config).toContain(
      "ip dhcp pool LAN10\n network 192.168.10.0 255.255.255.0\n default-router 192.168.10.1\n dns-server 8.8.8.8\n domain-name example.com\n lease 7\n!",
    );
    expect(config).toContain("interface GigabitEthernet0/0/1\n no ip address\n ip helper-address 10.9.9.9\n");
  });

  test("the pool mode has its prompt, help and error handling", () => {
    const { r1 } = lan();
    run(r1, "enable", "configure terminal", "ip dhcp pool LAN10");
    expect(r1.prompt).toBe("R1(dhcp-config)#");
    expect(r1.execute("network 10.0.0.0 255.0.255.0")).toBe("% Invalid input detected: bad IP address or mask.");
    expect(r1.execute("default-router 10.0.0.1 nonsense")).toBe("% Invalid input detected: bad IP address or mask.");
    expect(r1.execute("lease 400")).toContain("% Invalid lease time");
    expect(r1.execute("lease infinite")).toBe("");
    expect(r1.execute("option 150 ip 10.0.0.1")).toContain("NetSketch:");
    expect(r1.help("")).toContain("default-router");
    expect(r1.execute("exit")).toBe("");
    expect(r1.prompt).toBe("R1(config)#");
    expect(r1.execute("ip dhcp excluded-address 192.168.10.5 192.168.10.2")).toContain("% Invalid IP address range");
    expect(r1.execute("ip dhcp excluded-address 192.168.10.300")).toContain("% Invalid input detected at '^' marker.");
    expect(r1.execute("ip dhcp conflict logging")).toContain("NetSketch:");
  });

  test("the no forms undo the configuration, an empty configuration leaves no trace", () => {
    const store = makeStore();
    const r1 = add(store, isr4321, "R1");
    expect(deviceOf(store, "R1").protocols).toBeUndefined();
    ios(
      r1,
      "ip dhcp excluded-address 10.0.0.1 10.0.0.9",
      "ip dhcp excluded-address 10.0.0.20",
      "ip dhcp pool P",
      "network 10.0.0.0/24",
      "default-router 10.0.0.1",
      "dns-server 1.1.1.1",
    );
    expect(deviceOf(store, "R1").protocols?.dhcp?.excluded).toEqual(["10.0.0.1-10.0.0.9", "10.0.0.20"]);
    expect(deviceOf(store, "R1").protocols?.dhcp?.pools[0].network).toBe("10.0.0.0/24");
    run(r1, "enable", "configure terminal", "ip dhcp pool P", "no default-router", "no dns-server", "no network", "exit");
    expect(deviceOf(store, "R1").protocols?.dhcp?.pools[0]).toEqual({
      name: "P",
      network: "",
      defaultRouter: "",
      dnsServer: "",
      range: "",
    });
    expect(r1.execute("no ip dhcp excluded-address 10.0.0.1 10.0.0.9")).toBe("");
    expect(r1.execute("no ip dhcp excluded-address 10.0.0.1 10.0.0.9")).toContain("not found");
    run(r1, "no ip dhcp excluded-address 10.0.0.20");
    expect(r1.execute("no ip dhcp pool Q")).toContain("not found");
    expect(r1.execute("no ip dhcp pool P")).toBe("");
    expect(deviceOf(store, "R1").protocols).toBeUndefined();
  });

  test("every configuration command is one undo step", () => {
    const store = makeStore();
    const r1 = add(store, isr4321, "R1");
    run(r1, "enable", "configure terminal", "ip dhcp pool P");
    expect(deviceOf(store, "R1").protocols?.dhcp?.pools).toHaveLength(1);
    expect(store.undo()).toBe(true);
    expect(deviceOf(store, "R1").protocols).toBeUndefined();
    // The pool mode survives its pool being undone and says so.
    expect(r1.execute("network 10.0.0.0/24")).toContain("DHCP pool už v konfiguraci neexistuje");
    expect(r1.prompt).toBe("R1(config)#");
  });
});

describe("DHCP relay", () => {
  /** PC1 - SW - R1 (relay 192.168.10.1/24, 10.0.0.1/30) - R2 (server 10.0.0.2/30). */
  function relayed(route: boolean) {
    const store = makeStore();
    const r1 = add(store, isr4321, "R1");
    const r2 = add(store, isr4321, "R2");
    add(store, c2960, "SW");
    const pc1 = add(store, pcTemplate, "PC1");
    connect(store, "R1", "Gi0/0/0", "SW", "Fa0/24");
    connect(store, "PC1", "eth0", "SW", "Fa0/1");
    connect(store, "R1", "Gi0/0/1", "R2", "Gi0/0/0");
    ios(
      r1,
      "interface gi0/0/0",
      "ip address 192.168.10.1 255.255.255.0",
      "ip helper-address 10.0.0.2",
      "no shutdown",
      "exit",
      "interface gi0/0/1",
      "ip address 10.0.0.1 255.255.255.252",
      "no shutdown",
    );
    ios(
      r2,
      "interface gi0/0/0",
      "ip address 10.0.0.2 255.255.255.252",
      "no shutdown",
      "exit",
      "ip dhcp excluded-address 192.168.10.1",
      "ip dhcp pool LAN10",
      "network 192.168.10.0 255.255.255.0",
      "default-router 192.168.10.1",
    );
    if (route) ios(r2, "ip route 192.168.10.0 255.255.255.0 10.0.0.1");
    return { store, r1, r2, pc1 };
  }

  test("a relay across a router forwards the request to the server", () => {
    const { store, r2, pc1 } = relayed(true);
    const output = pc1.execute("ipconfig /renew");
    expect(output).toContain("192.168.10.2");
    expect(deviceOf(store, "PC1").defaultGateway).toBe("192.168.10.1");
    expect(deviceOf(store, "PC1").protocols?.dhcp?.leases?.[0].server).toBe("10.0.0.2");
    expect(pc1.execute("ping 10.0.0.2")).toContain("Reply from 10.0.0.2");
    // The server lists the client although it sits behind the relay.
    const binding = run(r2, "enable", "show ip dhcp binding");
    expect(binding).toMatch(/192\.168\.10\.2 .*GigabitEthernet0\/0\/0/);
  });

  test("the server needs a way back to the relay network", () => {
    const { pc1 } = relayed(false);
    const output = pc1.execute("ipconfig /renew");
    expect(output).toContain("unable to contact your DHCP server");
    expect(output).toContain("odpověď serveru R2 se nedostane zpět k relay R1");
    expect(output).toContain("R2 nemá trasu");
  });

  test("a helper address nobody can reach is explained", () => {
    const { r1, pc1 } = relayed(true);
    ios(r1, "interface gi0/0/0", "no ip helper-address", "ip helper-address 10.0.0.99");
    const output = pc1.execute("ipconfig /renew");
    expect(output).toContain("relay R1 (Gi0/0/0) nedoručí požadavek DHCP serveru 10.0.0.99");
  });

  test("a server without a pool for the relay network is named", () => {
    const { r2, pc1 } = relayed(true);
    ios(r2, "no ip dhcp pool LAN10");
    expect(pc1.execute("ipconfig /renew")).toContain("R2 (10.0.0.2) nemá DHCP pool pro síť 192.168.10.0/24");
  });

  test("no ip helper-address removes the relay", () => {
    const { store, r1, pc1 } = relayed(true);
    ios(r1, "interface gi0/0/0", "no ip helper-address");
    expect(deviceOf(store, "R1").protocols).toBeUndefined();
    expect(pc1.execute("ipconfig /renew")).toContain("není žádné zařízení s DHCP poolem");
  });

  test("the pool is chosen by the network of the relay interface", () => {
    const store = makeStore();
    const l3 = add(store, "cisco-catalyst-3650-24ps", "L3");
    const r2 = add(store, isr4321, "R2");
    const pc1 = add(store, pcTemplate, "PC1");
    const pc2 = add(store, pcTemplate, "PC2");
    connect(store, "PC1", "eth0", "L3", "Gi1/0/1");
    connect(store, "PC2", "eth0", "L3", "Gi1/0/2");
    connect(store, "L3", "Gi1/0/24", "R2", "Gi0/0/0");
    ios(
      l3,
      "vlan 10",
      "vlan 20",
      "vlan 99",
      "interface gi1/0/1",
      "switchport mode access",
      "switchport access vlan 10",
      "interface gi1/0/2",
      "switchport mode access",
      "switchport access vlan 20",
      "interface gi1/0/24",
      "switchport mode access",
      "switchport access vlan 99",
      "interface vlan 10",
      "ip address 192.168.10.1 255.255.255.0",
      "ip helper-address 10.0.0.2",
      "interface vlan 20",
      "ip address 192.168.20.1 255.255.255.0",
      "ip helper-address 10.0.0.2",
      "interface vlan 99",
      "ip address 10.0.0.1 255.255.255.252",
    );
    ios(
      r2,
      "interface gi0/0/0",
      "ip address 10.0.0.2 255.255.255.252",
      "no shutdown",
      "exit",
      "ip route 192.168.10.0 255.255.255.0 10.0.0.1",
      "ip route 192.168.20.0 255.255.255.0 10.0.0.1",
      "ip dhcp excluded-address 192.168.10.1",
      "ip dhcp excluded-address 192.168.20.1",
      "ip dhcp pool LAN10",
      "network 192.168.10.0 255.255.255.0",
      "default-router 192.168.10.1",
      "ip dhcp pool LAN20",
      "network 192.168.20.0 255.255.255.0",
      "default-router 192.168.20.1",
    );
    pc1.execute("ipconfig /renew");
    pc2.execute("ipconfig /renew");
    expect(deviceOf(store, "PC1").addresses[0].address).toBe("192.168.10.2/24");
    expect(deviceOf(store, "PC2").addresses[0].address).toBe("192.168.20.2/24");
    expect(deviceOf(store, "PC2").defaultGateway).toBe("192.168.20.1");
    expect(pc2.execute("ping 192.168.10.2")).toContain("Reply from 192.168.10.2");
    const pools = run(r2, "enable", "show ip dhcp pool");
    expect(pools).toContain("Pool LAN10 :");
    expect(pools).toContain("Pool LAN20 :");
  });
});

describe("DHCP client on routers and switches", () => {
  test("ip address dhcp on a router interface leases an address and shows in the config", () => {
    const { store, r1 } = lan();
    const r2 = add(store, isr4321, "R2");
    connect(store, "R2", "Gi0/0/0", "SW", "Fa0/3");
    const log = run(r2, "enable", "configure terminal", "interface gi0/0/0", "ip address dhcp");
    expect(log).toBe(
      "%DHCP-6-ADDRESS_ASSIGN: Interface GigabitEthernet0/0/0 assigned DHCP address 192.168.10.11, mask 255.255.255.0, hostname R2",
    );
    run(r2, "end");
    expect(deviceOf(store, "R2").addresses.map((entry) => entry.address)).toEqual(["192.168.10.11/24"]);
    expect(deviceOf(store, "R2").defaultGateway).toBe("");
    expect(run(r2, "show running-config interface gi0/0/0")).toContain(" ip address dhcp");
    expect(run(r2, "ping 192.168.10.1")).toContain("Success rate is 100 percent");
    expect(run(r1, "enable", "show ip dhcp binding")).toContain("192.168.10.11");
  });

  test("a failed ip address dhcp keeps the interface a client and renew dhcp retries", () => {
    const store = makeStore();
    const r2 = add(store, isr4321, "R2");
    const r1 = add(store, isr4321, "R1");
    connect(store, "R1", "Gi0/0/0", "R2", "Gi0/0/0");
    const failed = ios(r2, "interface gi0/0/0", "ip address dhcp");
    expect(failed).toContain("NetSketch: DHCP neuspělo – ");
    expect(failed).toContain("renew dhcp");
    expect(run(r2, "enable", "show running-config")).toContain("interface GigabitEthernet0/0/0\n ip address dhcp");
    ios(
      r1,
      "interface gi0/0/0",
      "ip address 10.5.5.1 255.255.255.0",
      "no shutdown",
      "exit",
      "ip dhcp pool P",
      "network 10.5.5.0 255.255.255.0",
    );
    expect(run(r2, "renew dhcp gi0/0/0")).toContain("assigned DHCP address 10.5.5.2");
    expect(r2.execute("renew dhcp gi0/0/1")).toContain("is not configured");
    run(r2, "release dhcp gi0/0/0");
    expect(deviceOf(store, "R2").addresses).toHaveLength(0);
    expect(run(r2, "show running-config interface gi0/0/0")).toContain(" ip address dhcp");
    expect(r2.help("renew dhcp ")).toContain("Gi");
  });

  test("a manual address or no ip address ends DHCP on the interface", () => {
    const { store, r1 } = lan();
    const r2 = add(store, isr4321, "R2");
    connect(store, "R2", "Gi0/0/0", "SW", "Fa0/3");
    ios(r2, "interface gi0/0/0", "ip address dhcp");
    expect(deviceOf(store, "R2").protocols?.dhcp?.clients).toHaveLength(1);
    ios(r2, "interface gi0/0/0", "ip address 192.168.10.50 255.255.255.0");
    expect(deviceOf(store, "R2").protocols).toBeUndefined();
    ios(r2, "interface gi0/0/0", "ip address dhcp");
    ios(r2, "interface gi0/0/0", "no ip address dhcp");
    expect(deviceOf(store, "R2").addresses).toHaveLength(0);
    expect(deviceOf(store, "R2").protocols).toBeUndefined();
    expect(run(r1, "enable", "show ip dhcp binding").split("\n")).toHaveLength(4);
  });

  test("a switch SVI takes its address and default gateway from DHCP", () => {
    const { store, sw } = lan();
    const output = ios(sw, "interface vlan 1", "ip address dhcp");
    expect(output).toContain("%DHCP-6-ADDRESS_ASSIGN: Interface Vlan1 assigned DHCP address 192.168.10.11");
    expect(deviceOf(store, "SW").addresses.map((entry) => entry.address)).toEqual(["192.168.10.11/24"]);
    expect(deviceOf(store, "SW").defaultGateway).toBe("192.168.10.1");
    expect(run(sw, "enable", "show running-config")).toContain("interface Vlan1\n ip address dhcp\n");
  });

  test("an SVI that found no server is still listed as a DHCP client", () => {
    const store = makeStore();
    const sw = add(store, "cisco-catalyst-3650-24ps", "L3");
    ios(sw, "interface vlan 10", "ip address dhcp");
    expect(run(sw, "enable", "show running-config")).toContain("interface Vlan10\n ip address dhcp\n");
  });
});

describe("DHCP on MikroTik RouterOS", () => {
  /** PC1, PC2 on ether2 and ether3 of a hAP lite with 192.168.88.1/24 on ether2. */
  function mikrotik() {
    const store = makeStore();
    const m1 = add(store, hap, "M1");
    const pc1 = add(store, pcTemplate, "PC1");
    const pc2 = add(store, pcTemplate, "PC2");
    connect(store, "M1", "ether2", "PC1", "eth0");
    connect(store, "M1", "ether3", "PC2", "eth0");
    run(m1, "/ip address add address=192.168.88.1/24 interface=ether2");
    run(m1, "/ip address add address=192.168.89.1/24 interface=ether3");
    return { store, m1, pc1, pc2 };
  }

  test("pool, server and network give a PC an address, the gateway and a lease entry", () => {
    const { store, m1, pc1 } = mikrotik();
    expect(run(m1, "/ip pool add name=p1 ranges=192.168.88.10-192.168.88.50")).toBe("");
    const added = run(m1, "/ip dhcp-server add name=dhcp1 interface=ether2 address-pool=p1");
    expect(added).toContain("vypnutý");
    expect(pc1.execute("ipconfig /renew")).toContain("DHCP server dhcp1 je vypnutý");
    run(m1, "/ip dhcp-server enable dhcp1");
    expect(pc1.execute("ipconfig /renew")).toContain("chybí záznam v /ip dhcp-server network");
    expect(
      run(m1, "/ip dhcp-server network add address=192.168.88.0/24 gateway=192.168.88.1 dns-server=8.8.8.8,1.1.1.1"),
    ).toBe("");
    const renewed = pc1.execute("ipconfig /renew");
    expect(renewed).toContain("192.168.88.10");
    expect(deviceOf(store, "PC1").defaultGateway).toBe("192.168.88.1");
    expect(pc1.execute("ipconfig /all")).toContain("DNS Servers . . . . . . . . . . . : 8.8.8.8, 1.1.1.1");
    const leases = run(m1, "/ip dhcp-server lease print");
    expect(leases).toContain("Flags: X - disabled, R - radius, D - dynamic, B - blocked");
    expect(leases).toMatch(/ 0 D 192\.168\.88\.10 +02:[0-9A-F:]{14} +PC1 +dhcp1 +bound/);
    expect(pc1.execute("ping 192.168.88.1")).toContain("Reply from 192.168.88.1");
  });

  test("print and export show the three tables", () => {
    const { m1 } = mikrotik();
    run(m1, "/ip pool add name=p1 ranges=192.168.88.10-192.168.88.50,192.168.88.60");
    run(m1, "/ip dhcp-server add name=dhcp1 interface=ether2 address-pool=p1 disabled=no lease-time=1h");
    run(m1, "/ip dhcp-server network add address=192.168.88.0/24 gateway=192.168.88.1 dns-server=8.8.8.8");
    expect(run(m1, "/ip pool print")).toContain("0   p1");
    expect(run(m1, "/ip dhcp-server print")).toMatch(/ 0 {3}dhcp1 +ether2 +p1 +1h/);
    expect(run(m1, "/ip dhcp-server network print")).toContain("192.168.88.0/24");
    const exported = run(m1, "/export");
    expect(exported).toContain('/ip pool\nadd name=p1 ranges="192.168.88.10-192.168.88.50,192.168.88.60"');
    expect(exported).toContain("/ip dhcp-server\nadd address-pool=p1 disabled=no interface=ether2 lease-time=1h name=dhcp1");
    expect(exported).toContain("/ip dhcp-server network\nadd address=192.168.88.0/24 dns-server=8.8.8.8 gateway=192.168.88.1");
  });

  test("the pool ranges are used, the server serves only its interface", () => {
    const { store, m1, pc1, pc2 } = mikrotik();
    run(m1, "/ip pool add name=p1 ranges=192.168.88.100-192.168.88.101");
    run(m1, "/ip dhcp-server add name=dhcp1 interface=ether2 address-pool=p1 disabled=no");
    run(m1, "/ip dhcp-server network add address=192.168.88.0/24 gateway=192.168.88.1");
    pc1.execute("ipconfig /renew");
    expect(deviceOf(store, "PC1").addresses[0].address).toBe("192.168.88.100/24");
    // PC2 sits on ether3, where no server runs.
    expect(pc2.execute("ipconfig /renew")).toContain("není žádné zařízení s DHCP poolem");
  });

  test("errors use RouterOS wording and removing everything leaves no trace", () => {
    const { store, m1 } = mikrotik();
    expect(run(m1, "/ip pool add name=p1")).toBe("missing value(s) of argument(s) ranges");
    expect(run(m1, "/ip pool add name=p1 ranges=nonsense")).toBe("invalid value for argument ranges");
    run(m1, "/ip pool add name=p1 ranges=192.168.88.10-192.168.88.20");
    expect(run(m1, "/ip pool add name=p1 ranges=192.168.88.30-192.168.88.40")).toContain("failure:");
    expect(run(m1, "/ip dhcp-server add name=x address-pool=p1")).toBe("missing value(s) of argument(s) interface");
    expect(run(m1, "/ip dhcp-server add name=x interface=ether2 address-pool=nope")).toBe(
      "input does not match any value of address-pool",
    );
    run(m1, "/ip dhcp-server add name=dhcp1 interface=ether2 address-pool=p1");
    expect(run(m1, "/ip pool remove p1")).toContain("failure: pool is used");
    expect(run(m1, "/ip dhcp-server network add address=bogus")).toBe("invalid value for argument address");
    expect(run(m1, "/ip dhcp-server remove 7")).toBe("no such item");
    run(m1, "/ip dhcp-server remove dhcp1");
    expect(run(m1, "/ip pool remove 0")).toBe("");
    expect(deviceOf(store, "M1").protocols).toBeUndefined();
  });

  test("a MikroTik router is a DHCP client of a Cisco router", () => {
    const store = makeStore();
    const r1 = add(store, isr4321, "R1");
    const m1 = add(store, hap, "M1");
    connect(store, "R1", "Gi0/0/0", "M1", "ether1");
    ios(
      r1,
      "interface gi0/0/0",
      "ip address 203.0.113.1 255.255.255.0",
      "no shutdown",
      "exit",
      "ip dhcp excluded-address 203.0.113.1 203.0.113.9",
      "ip dhcp pool WAN",
      "network 203.0.113.0 255.255.255.0",
      "default-router 203.0.113.1",
    );
    expect(run(m1, "/ip dhcp-client add interface=ether1")).toBe("");
    expect(deviceOf(store, "M1").addresses.map((entry) => entry.address)).toEqual(["203.0.113.10/24"]);
    expect(run(m1, "/ip dhcp-client print")).toMatch(/ 0 +ether1 +yes +yes +bound +203\.0\.113\.10\/24/);
    expect(run(m1, "/ip dhcp-client add interface=ether1")).toContain("failure:");
    expect(run(m1, "/export")).toContain("/ip dhcp-client\nadd disabled=no interface=ether1");
    expect(run(m1, "/ping 203.0.113.1 count=1")).toContain("received=1");
    expect(run(m1, "/ip dhcp-client release 0")).toBe("");
    expect(deviceOf(store, "M1").addresses).toHaveLength(0);
    expect(run(m1, "/ip dhcp-client print")).toContain("searching...");
    expect(run(m1, "/ip dhcp-client renew 0")).toBe("");
    expect(deviceOf(store, "M1").addresses).toHaveLength(1);
    expect(run(m1, "/ip dhcp-client remove 0")).toBe("");
    expect(deviceOf(store, "M1").addresses).toHaveLength(0);
    expect(deviceOf(store, "M1").protocols).toBeUndefined();
  });

  test("a client without a server gets a notice instead of an address", () => {
    const store = makeStore();
    const m1 = add(store, hap, "M1");
    add(store, hap, "M2");
    connect(store, "M1", "ether1", "M2", "ether1");
    const output = run(m1, "/ip dhcp-client add interface=ether1");
    expect(output).toContain("NetSketch: DHCP klient na ether1 zatím nemá adresu (status searching...)");
  });

  test("a MikroTik relay forwards the request to the server", () => {
    const store = makeStore();
    const m1 = add(store, hap, "M1");
    const r2 = add(store, isr4321, "R2");
    const pc1 = add(store, pcTemplate, "PC1");
    connect(store, "PC1", "eth0", "M1", "ether2");
    connect(store, "M1", "ether1", "R2", "Gi0/0/0");
    run(m1, "/ip address add address=192.168.88.1/24 interface=ether2");
    run(m1, "/ip address add address=10.0.0.1/30 interface=ether1");
    ios(
      r2,
      "interface gi0/0/0",
      "ip address 10.0.0.2 255.255.255.252",
      "no shutdown",
      "exit",
      "ip route 192.168.88.0 255.255.255.0 10.0.0.1",
      "ip dhcp excluded-address 192.168.88.1",
      "ip dhcp pool LAN",
      "network 192.168.88.0 255.255.255.0",
      "default-router 192.168.88.1",
    );
    const added = run(m1, "/ip dhcp-relay add name=relay1 interface=ether2 dhcp-server=10.0.0.2");
    expect(added).toContain("vypnutý");
    expect(pc1.execute("ipconfig /renew")).toContain("unable to contact");
    run(m1, "/ip dhcp-relay enable relay1");
    expect(pc1.execute("ipconfig /renew")).toContain("192.168.88.2");
    expect(run(m1, "/ip dhcp-relay print")).toMatch(/ 0 {3}relay1 +ether2 +10\.0\.0\.2/);
    expect(run(m1, "/export")).toContain("/ip dhcp-relay\nadd dhcp-server=10.0.0.2 disabled=no interface=ether2 name=relay1");
  });
});

describe("DHCP on Dell OS9", () => {
  test("ip dhcp server with a pool serves a PC on a VLAN interface", () => {
    const store = makeStore();
    const d1 = add(store, "dell-s3048-on", "D1");
    const pc1 = add(store, pcTemplate, "PC1");
    connect(store, "D1", "GigabitEthernet 1/1", "PC1", "eth0");
    run(
      d1,
      "enable",
      "configure",
      "interface vlan 10",
      "untagged gigabitethernet 1/1",
      "ip address 10.0.10.1/24",
      "exit",
      "ip dhcp server",
    );
    expect(d1.prompt).toBe("D1(conf-dhcp)#");
    run(d1, "excluded-address 10.0.10.1 10.0.10.9", "pool LAN");
    expect(d1.prompt).toBe("D1(conf-dhcp-LAN)#");
    run(d1, "network 10.0.10.0/24", "default-router 10.0.10.1", "dns-server 1.1.1.1", "lease 0 8", "end");
    pc1.execute("ipconfig /renew");
    expect(deviceOf(store, "PC1").addresses[0].address).toBe("10.0.10.10/24");
    expect(run(d1, "show ip dhcp binding")).toMatch(/10\.0\.10\.10 +02:[0-9a-f:]{14} +Jan 01 2026 08:00 AM +Dynamic/);
    const config = run(d1, "show running-config");
    expect(config).toContain(
      "ip dhcp server\n excluded-address 10.0.10.1 10.0.10.9\n pool LAN\n  network 10.0.10.0/24\n  default-router 10.0.10.1\n  dns-server 1.1.1.1\n  lease 0 8",
    );
    run(d1, "configure", "no ip dhcp server");
    expect(deviceOf(store, "D1").protocols).toBeUndefined();
  });
});

describe("DHCP data", () => {
  test("the reader drops malformed entries and keeps the rest", () => {
    const parsed = readProtocols({
      dhcp: {
        pools: [{ name: "A", network: "10.0.0.0/24" }, { network: "nameless" }, 7],
        excluded: ["10.0.0.1", 5],
        relays: [{ interface: "port:X", server: "1.2.3.4", name: "r", disabled: true }, { server: "x" }],
        clients: ["port:Y", null],
        leases: [{ interface: "port:Y", server: "10.0.0.1" }, "junk"],
        routerOS: {
          pools: [{ name: "p", ranges: "1.1.1.1-1.1.1.9" }, {}],
          servers: [{ name: "s", interface: "port:Z" }],
          networks: [],
        },
      },
    });
    expect(parsed.dhcp?.pools).toEqual([{ name: "A", network: "10.0.0.0/24", defaultRouter: "", dnsServer: "", range: "" }]);
    expect(parsed.dhcp?.excluded).toEqual(["10.0.0.1"]);
    expect(parsed.dhcp?.relays).toEqual([{ interface: "port:X", server: "1.2.3.4", name: "r", disabled: true }]);
    expect(parsed.dhcp?.clients).toEqual(["port:Y"]);
    expect(parsed.dhcp?.leases).toEqual([{ interface: "port:Y", server: "10.0.0.1", gateway: "", dnsServer: "" }]);
    expect(parsed.dhcp?.routerOS?.servers).toEqual([
      { name: "s", interface: "port:Z", addressPool: "static-only", leaseTime: "10m", disabled: true },
    ]);
    expect(readProtocols({ dhcp: "nonsense" })).toEqual({});
  });

  test("a project without DHCP is not touched by the consoles", () => {
    const { store, sw } = lan();
    const before = JSON.stringify(deviceOf(store, "SW"));
    run(sw, "enable", "show ip dhcp binding", "show ip dhcp pool");
    ios(sw, "interface vlan 1", "ip address 10.1.1.1 255.255.255.0", "no ip address");
    expect(JSON.stringify(deviceOf(store, "SW"))).toBe(before);
  });
});
