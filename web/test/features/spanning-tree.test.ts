// Spanning tree commands: Cisco IOS, Dell OS9 and MikroTik RouterOS configuration, the show
// output of the lab (Cisco SW1 MST 8192, Dell root 4096, UniFi 12288), persistence and undo.

import { describe, expect, test } from "vitest";
import type { Device, PortRef } from "../../src/core/model";
import { decodeProject, encodeProject } from "../../src/core/project-io";
import { PortNaming } from "../../src/core/port-naming";
import { CLISession } from "../../src/cli/session";
import { makeStore } from "../cli/support";

const c2960 = "cisco-catalyst-2960-24";
const dellS3048 = "dell-s3048-on";
const unifi = "ubiquiti-unifi-switch-24";
const crs = "mikrotik-crs-generic";

function build(...devices: [template: string, hostname: string][]) {
  const store = makeStore();
  const sessions = new Map<string, CLISession>();
  for (const [template, hostname] of devices) {
    const device = store.addDevice(template, { x: sessions.size * 100, y: 0 }, hostname);
    sessions.set(hostname, new CLISession(store, device.id));
  }
  const deviceOf = (hostname: string): Device => {
    const found = store.project.devices.find((item) => item.hostname === hostname);
    if (!found) throw new Error(`missing device ${hostname}`);
    return found;
  };
  const ref = (hostname: string, name: string): PortRef => {
    const owner = deviceOf(hostname);
    const found =
      owner.ports.find((item) => item.name === name) ??
      owner.ports.find((item) => PortNaming.shortName(item.name) === name);
    if (!found) throw new Error(`missing port ${hostname} ${name}`);
    return { deviceID: owner.id, portID: found.id };
  };
  return { store, session: (hostname: string) => sessions.get(hostname) as CLISession, deviceOf, ref };
}

function run(cli: CLISession, ...lines: string[]): string {
  let output = "";
  for (const line of lines) output = cli.execute(line);
  return output;
}

/** Bridge MACs derive from random ids: they are numbered in order of appearance. */
function shown(text: string): string {
  const seen = new Map<string, string>();
  return text.replace(/\b[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}\b/g, (mac) => {
    if (!seen.has(mac)) seen.set(mac, `0000.0000.000${seen.size + 1}`);
    return seen.get(mac) as string;
  });
}

/** Runs the lines in global configuration mode and returns the output of the last one. */
function config(cli: CLISession, ...lines: string[]): string {
  run(cli, "enable", "configure terminal");
  const output = run(cli, ...lines);
  run(cli, "end");
  return output;
}

function lab() {
  const world = build([c2960, "SW1"], [dellS3048, "DELL"], [unifi, "UNI"]);
  const { store, ref } = world;
  store.connect(ref("SW1", "Fa0/1"), ref("DELL", "GigabitEthernet 1/1"));
  store.connect(ref("SW1", "Fa0/2"), ref("UNI", "Port 1"));
  store.connect(ref("DELL", "GigabitEthernet 1/2"), ref("UNI", "Port 2"));
  config(world.session("SW1"), "spanning-tree mode mst", "spanning-tree mst 0 priority 8192");
  config(world.session("DELL"), "protocol spanning-tree rstp", "no disable", "bridge-priority 4096");
  // The UniFi switch has no console commands; its 12288 comes from the controller (the data).
  store.setProtocols(world.deviceOf("UNI").id, {
    stp: { mode: "rstp", disabledVLANs: [], priorities: [{ vlan: 0, priority: 12288 }], portfast: [], bpduGuard: [], costs: [], portPriorities: [] },
  });
  return world;
}

describe("Cisco IOS configuration", () => {
  test("mode, VLAN priorities and root primary/secondary are stored", () => {
    const { session, deviceOf } = build([c2960, "SW1"]);
    const cli = session("SW1");
    config(cli, "spanning-tree mode rapid-pvst", "spanning-tree vlan 1,10-11 priority 4096", "spanning-tree vlan 20 root primary", "spanning-tree vlan 30 root secondary");
    expect(deviceOf("SW1").protocols?.stp).toEqual({
      mode: "rapid-pvst",
      disabledVLANs: [],
      priorities: [
        { vlan: 1, priority: 4096 },
        { vlan: 10, priority: 4096 },
        { vlan: 11, priority: 4096 },
        { vlan: 20, priority: 24576 },
        { vlan: 30, priority: 28672 },
      ],
      portfast: [],
      bpduGuard: [],
      costs: [],
      portPriorities: [],
    });
    config(cli, "spanning-tree mst 0 priority 8192");
    expect(deviceOf("SW1").protocols?.stp?.priorities).toContainEqual({ vlan: 0, priority: 8192 });
  });

  test("a priority that is not a multiple of 4096 is refused with the IOS text", () => {
    const { session, deviceOf } = build([c2960, "SW1"]);
    const output = config(session("SW1"), "spanning-tree vlan 1 priority 5000");
    expect(output).toBe(
      [
        "% Bridge Priority must be in increments of 4096.",
        "% Allowed values are:",
        "  0     4096  8192  12288 16384 20480 24576 28672",
        "  32768 36864 40960 45056 49152 53248 57344 61440",
      ].join("\n"),
    );
    expect(deviceOf("SW1").protocols?.stp).toBeUndefined();
    expect(config(session("SW1"), "spanning-tree mst 0 priority 100")).toContain("increments of 4096");
    // Out of the parser's range is an ordinary parse error.
    expect(config(session("SW1"), "spanning-tree vlan 1 priority 70000")).toContain("Invalid input");
  });

  test("no spanning-tree vlan switches the VLAN off, the plain form switches it on", () => {
    const { session, deviceOf } = build([c2960, "SW1"]);
    const cli = session("SW1");
    config(cli, "no spanning-tree vlan 10,12");
    expect(deviceOf("SW1").protocols?.stp?.disabledVLANs).toEqual([10, 12]);
    config(cli, "spanning-tree vlan 10");
    expect(deviceOf("SW1").protocols?.stp?.disabledVLANs).toEqual([12]);
    config(cli, "spanning-tree vlan 12 priority 8192", "no spanning-tree vlan 12 priority");
    expect(deviceOf("SW1").protocols?.stp?.priorities).toEqual([]);
  });

  test("interface commands apply to every port of a range", () => {
    const { session, deviceOf } = build([c2960, "SW1"]);
    const cli = session("SW1");
    const output = config(
      cli,
      "interface range fa0/1-2",
      "spanning-tree portfast",
      "spanning-tree bpduguard enable",
      "spanning-tree cost 100",
      "spanning-tree port-priority 64",
      "spanning-tree vlan 10 cost 50",
    );
    expect(output).toBe("");
    const stp = deviceOf("SW1").protocols?.stp;
    const [one, two] = deviceOf("SW1").ports.slice(0, 2).map((item) => item.id);
    expect(stp?.portfast).toEqual([one, two]);
    expect(stp?.bpduGuard).toEqual([one, two]);
    expect(stp?.costs).toEqual([
      { port: one, vlan: 0, cost: 100 },
      { port: two, vlan: 0, cost: 100 },
      { port: one, vlan: 10, cost: 50 },
      { port: two, vlan: 10, cost: 50 },
    ]);
    expect(stp?.portPriorities).toEqual([
      { port: one, vlan: 0, priority: 64 },
      { port: two, vlan: 0, priority: 64 },
    ]);
    expect(config(cli, "interface fa0/1", "spanning-tree port-priority 100")).toContain("multiple of 16");
    config(cli, "interface fa0/1", "no spanning-tree portfast", "no spanning-tree bpduguard", "no spanning-tree cost", "no spanning-tree port-priority");
    expect(deviceOf("SW1").protocols?.stp?.portfast).toEqual([two]);
    expect(deviceOf("SW1").protocols?.stp?.costs.filter((item) => item.port === one)).toEqual([{ port: one, vlan: 10, cost: 50 }]);
  });

  test("portfast prints the IOS warning", () => {
    const { session } = build([c2960, "SW1"]);
    const output = config(session("SW1"), "interface fa0/3", "spanning-tree portfast");
    expect(output).toContain("%Warning: portfast should only be enabled on ports connected to a single");
    expect(output).toContain("%Portfast has been configured on FastEthernet0/3");
  });

  test("the configuration is in show running-config and survives saving the project", () => {
    const { store, session } = build([c2960, "SW1"]);
    const cli = session("SW1");
    config(cli, "spanning-tree mode rapid-pvst", "spanning-tree vlan 1,10 priority 4096", "no spanning-tree vlan 99", "interface fa0/3", "spanning-tree portfast", "spanning-tree bpduguard enable", "spanning-tree vlan 10 cost 77");
    const text = run(cli, "enable", "show running-config");
    expect(text).toContain("spanning-tree mode rapid-pvst\nspanning-tree vlan 1,10 priority 4096\nno spanning-tree vlan 99");
    expect(text).toContain("interface FastEthernet0/3\n spanning-tree portfast\n spanning-tree bpduguard enable\n spanning-tree vlan 10 cost 77");
    const reloaded = decodeProject(encodeProject(store.project));
    expect(reloaded.devices[0].protocols?.stp).toEqual(store.project.devices[0].protocols?.stp);
  });

  test("a configuration that equals the default leaves no trace, every command is one undo step", () => {
    const { store, session, deviceOf } = build([c2960, "SW1"]);
    const cli = session("SW1");
    config(cli, "spanning-tree vlan 1 priority 4096");
    expect(deviceOf("SW1").protocols?.stp).toBeDefined();
    config(cli, "no spanning-tree vlan 1 priority");
    expect(deviceOf("SW1").protocols?.stp).toBeUndefined();
    config(cli, "spanning-tree mode mst");
    expect(store.undo()).toBe(true);
    expect(deviceOf("SW1").protocols?.stp).toBeUndefined();
  });

  test("other spanning-tree subcommands are accepted and say they are not stored", () => {
    const { session, deviceOf } = build([c2960, "SW1"]);
    const output = config(session("SW1"), "spanning-tree extend system-id");
    expect(output).toContain("neukládá");
    expect(deviceOf("SW1").protocols?.stp).toBeUndefined();
  });
});

describe("Cisco IOS show spanning-tree of the lab", () => {
  test("MST mode prints the MST0 section", () => {
    const { session } = lab();
    expect(shown(run(session("SW1"), "enable", "show spanning-tree"))).toMatchInlineSnapshot(`
      "MST0
        Spanning tree enabled protocol mstp
        Root ID    Priority    4096
                   Address     0000.0000.0001
                   Cost        200000
                   Port        1(FastEthernet0/1)
                   Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec

        Bridge ID  Priority    8192  (priority 8192 sys-id-ext 0)
                   Address     0000.0000.0002
                   Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec
                   Aging Time  300 sec

      Interface           Role Sts Cost      Prio.Nbr Type
      ------------------- ---- --- --------- -------- --------------------------------
      Fa0/1               Root FWD 200000    128.1    P2p
      Fa0/2               Altn BLK 200000    128.2    P2p"
    `);
  });

  test("show spanning-tree mst 0", () => {
    const { session } = lab();
    expect(shown(run(session("SW1"), "enable", "show spanning-tree mst 0"))).toMatchInlineSnapshot(`
      "
      ##### MST0    vlans mapped:   1-4094
      Bridge        address 0000.0000.0001  priority      8192  (8192 sys-id-ext 0)
      Root          address 0000.0000.0002  priority      4096  (4096 sys-id-ext 0)
                    port    Fa0/1          path cost   200000
      Regional Root this switch
      Operational   hello time 2 , forward delay 15, max age 20, txholdcount 6
      Configured    hello time 2 , forward delay 15, max age 20, max hops    20

      Interface           Role Sts Cost      Prio.Nbr Type
      ------------------- ---- --- --------- -------- --------------------------------
      Fa0/1               Root FWD 200000    128.1    P2p
      Fa0/2               Altn BLK 200000    128.2    P2p"
    `);
  });

  test("show spanning-tree summary and interface", () => {
    const { session } = lab();
    const cli = session("SW1");
    expect(shown(run(cli, "enable", "show spanning-tree summary"))).toMatchInlineSnapshot(`
      "Switch is in mst mode
      Extended system ID           is enabled
      Portfast Default             is disabled
      PortFast BPDU Guard Default  is disabled
      Portfast BPDU Filter Default is disabled
      Loopguard Default            is disabled
      EtherChannel misconfig guard is enabled
      UplinkFast                   is disabled
      BackboneFast                 is disabled
      Configured Pathcost method used is short

      Name                   Blocking Listening Learning Forwarding STP Active
      ---------------------- -------- --------- -------- ---------- ----------
      MST0                          1         0        0          1          2
      ---------------------- -------- --------- -------- ---------- ----------
      1 vlan                        1         0        0          1          2"
    `);
    expect(shown(run(cli, "show spanning-tree interface fa0/2"))).toMatchInlineSnapshot(`
      "Vlan             Role Sts Cost      Prio.Nbr Type
      ---------------- ---- --- --------- -------- --------------------------------
      MST0             Altn BLK 200000    128.2    P2p"
    `);
  });

  test("rapid-pvst prints one section per VLAN with the VLAN in the priority", () => {
    const { session, store } = lab();
    const cli = session("SW1");
    config(cli, "vlan 10", "exit", "interface fa0/3", "switchport access vlan 10", "exit", "spanning-tree mode rapid-pvst", "spanning-tree vlan 1 priority 8192");
    void store;
    expect(shown(run(cli, "enable", "show spanning-tree vlan 1"))).toMatchInlineSnapshot(`
      "VLAN0001
        Spanning tree enabled protocol rstp
        Root ID    Priority    4097
                   Address     0000.0000.0001
                   Cost        200000
                   Port        1(FastEthernet0/1)
                   Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec

        Bridge ID  Priority    8193  (priority 8192 sys-id-ext 1)
                   Address     0000.0000.0002
                   Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec
                   Aging Time  300 sec

      Interface           Role Sts Cost      Prio.Nbr Type
      ------------------- ---- --- --------- -------- --------------------------------
      Fa0/1               Root FWD 200000    128.1    P2p
      Fa0/2               Altn BLK 200000    128.2    P2p"
    `);
    expect(run(cli, "show spanning-tree vlan 77")).toBe("Spanning tree instance(s) for vlan 77 does not exist.");
    expect(run(cli, "show spanning-tree mst")).toBe("% Switch is not in mst mode");
  });

  test("the root bridge says so", () => {
    const { session } = lab();
    config(session("SW1"), "spanning-tree mst 0 priority 0");
    const output = run(session("SW1"), "enable", "show spanning-tree");
    expect(output).toContain("This bridge is the root");
    expect(output).toContain("Priority    0");
  });
});

describe("Dell OS9", () => {
  test("protocol spanning-tree enters the protocol mode, no disable switches it on", () => {
    const { session, deviceOf } = build([dellS3048, "DELL"]);
    const cli = session("DELL");
    run(cli, "enable", "configure terminal", "protocol spanning-tree rstp");
    expect(cli.prompt).toBe("DELL(conf-rstp)#");
    run(cli, "bridge-priority 8192");
    expect(deviceOf("DELL").protocols?.stp?.mode).toBe("pvst");
    run(cli, "disable");
    expect(deviceOf("DELL").protocols?.stp?.mode).toBe("none");
    run(cli, "no disable");
    expect(deviceOf("DELL").protocols?.stp?.mode).toBe("rstp");
    expect(deviceOf("DELL").protocols?.stp?.priorities).toEqual([{ vlan: 0, priority: 8192 }]);
    run(cli, "exit", "protocol spanning-tree mstp", "no disable", "end");
    expect(deviceOf("DELL").protocols?.stp?.mode).toBe("mst");
  });

  test("bridge-priority must be a multiple of 4096", () => {
    const { session, deviceOf } = build([dellS3048, "DELL"]);
    const output = config(session("DELL"), "protocol spanning-tree rstp", "bridge-priority 1000");
    expect(output).toBe("% Error: Bridge priority must be in increments of 4096.");
    expect(deviceOf("DELL").protocols?.stp).toBeUndefined();
  });

  test("interface edge-port, cost and priority, and the running-config", () => {
    const { session, deviceOf } = build([dellS3048, "DELL"]);
    const cli = session("DELL");
    config(
      cli,
      "protocol spanning-tree rstp",
      "no disable",
      "bridge-priority 4096",
      "exit",
      "interface gigabitethernet 1/3",
      "spanning-tree rstp edge-port bpduguard",
      "spanning-tree rstp cost 500",
      "spanning-tree rstp priority 32",
    );
    const port = deviceOf("DELL").ports.find((item) => item.name === "GigabitEthernet 1/3")?.id;
    const stp = deviceOf("DELL").protocols?.stp;
    expect(stp?.portfast).toEqual([port]);
    expect(stp?.bpduGuard).toEqual([port]);
    expect(stp?.costs).toEqual([{ port, vlan: 0, cost: 500 }]);
    expect(stp?.portPriorities).toEqual([{ port, vlan: 0, priority: 32 }]);
    const text = run(cli, "enable", "show running-config");
    expect(text).toContain("protocol spanning-tree rstp\n no disable\n bridge-priority 4096");
    expect(text).toContain(
      "interface GigabitEthernet 1/3\n switchport\n spanning-tree rstp edge-port bpduguard\n spanning-tree rstp cost 500\n spanning-tree rstp priority 32\n no shutdown",
    );
    config(cli, "interface gigabitethernet 1/3", "no spanning-tree rstp edge-port");
    expect(deviceOf("DELL").protocols?.stp?.portfast).toEqual([]);
    expect(deviceOf("DELL").protocols?.stp?.bpduGuard).toEqual([]);
    config(cli, "interface gigabitethernet 1/4", "spanning-tree portfast");
    expect(deviceOf("DELL").protocols?.stp?.portfast).toHaveLength(1);
  });

  test("show spanning-tree rstp of the lab: the Dell switch is the root", () => {
    const { session } = lab();
    const cli = session("DELL");
    expect(shown(run(cli, "enable", "show spanning-tree rstp"))).toMatchInlineSnapshot(`
      "Executing IEEE compatible Spanning Tree Protocol
      Root ID Priority 4096, Address 0000.0000.0001
      Root Bridge hello time 2, max age 20, forward delay 15
      Bridge ID Priority 4096, Address 0000.0000.0001
      Configured hello time 2, max age 20, forward delay 15
      We are the root of the spanning tree

      Interface                                  Designated
      Name       PortID  Prio Cost     Sts   Cost  Bridge ID             PortID
      ---------- ------- ---- -------- ----- ----- --------------------- -------
      Gi 1/1     128.1   128  200000   FWD   0     4096 0000.0000.0001   128.1
      Gi 1/2     128.2   128  20000    FWD   0     4096 0000.0000.0001   128.2

      Interface
      Name       Role   PortID  Prio Cost     Sts   Cost  Link-type Edge Boundary
      ---------- ------ ------- ---- -------- ----- ----- --------- ---- --------
      Gi 1/1     Desg   128.1   128  200000   FWD   0     P2P       No   No
      Gi 1/2     Desg   128.2   128  20000    FWD   0     P2P       No   No"
    `);
    expect(run(cli, "show spanning-tree 0")).toContain("We are the root of the spanning tree");
    expect(run(cli, "show spanning-tree mstp")).toBe("% Error: MSTP is not enabled.");
  });
});

describe("UniFi in the lab", () => {
  test("the others see the UniFi bridge behind the root", () => {
    const { session } = lab();
    // 12288 loses to the Dell 4096 and wins against the Cisco 8192 only when that is changed.
    const output = run(session("SW1"), "enable", "show spanning-tree");
    expect(output).toContain("Address     ");
    config(session("SW1"), "spanning-tree mst 0 priority 16384");
    expect(run(session("SW1"), "show spanning-tree mst 0")).toContain("Regional Root this switch");
  });
});

describe("MikroTik RouterOS", () => {
  test("bridge set protocol-mode and priority", () => {
    const { session, deviceOf } = build([crs, "CRS"]);
    const cli = session("CRS");
    expect(run(cli, "/interface bridge print")).toContain("rstp");
    expect(run(cli, "/interface bridge set [find] protocol-mode=mstp priority=0x1000")).toBe("");
    expect(deviceOf("CRS").protocols?.stp?.mode).toBe("mst");
    expect(deviceOf("CRS").protocols?.stp?.priorities).toEqual([{ vlan: 0, priority: 4096 }]);
    expect(run(cli, "/interface bridge print")).toContain("mstp");
    expect(run(cli, "/interface bridge print")).toContain("0x1000");
    run(cli, "/interface bridge set bridge priority=8192");
    expect(deviceOf("CRS").protocols?.stp?.priorities).toEqual([{ vlan: 0, priority: 8192 }]);
  });

  test("errors in the RouterOS style", () => {
    const { session, deviceOf } = build([crs, "CRS"]);
    const cli = session("CRS");
    expect(run(cli, "/interface bridge set [find] priority=5000")).toBe("invalid value for argument priority");
    expect(run(cli, "/interface bridge set [find] protocol-mode=fast")).toBe("input does not match any value of protocol-mode");
    expect(run(cli, "/interface bridge set")).toBe("missing value(s) of argument(s) numbers");
    expect(deviceOf("CRS").protocols?.stp).toBeUndefined();
  });

  test("bridge port set edge, path-cost and priority, print shows role and status", () => {
    const { store, session, deviceOf, ref } = build([crs, "CRS"], [c2960, "SW1"]);
    store.connect(ref("CRS", "ether1"), ref("SW1", "Fa0/1"));
    const cli = session("CRS");
    expect(run(cli, "/interface bridge port set ether2 edge=yes path-cost=100 priority=0x20")).toBe("");
    const ether2 = deviceOf("CRS").ports.find((item) => item.name === "ether2")?.id;
    const stp = deviceOf("CRS").protocols?.stp;
    expect(stp?.portfast).toEqual([ether2]);
    expect(stp?.costs).toEqual([{ port: ether2, vlan: 0, cost: 100 }]);
    expect(stp?.portPriorities).toEqual([{ port: ether2, vlan: 0, priority: 32 }]);
    const print = run(cli, "/interface bridge port print");
    expect(print).toContain("ether1");
    expect(print).toMatch(/ether1 .*(designated-port|root-port).*forwarding/);
    expect(print).toMatch(/ether2 +bridge +yes +0x20 +100/);
    expect(run(cli, "/interface bridge port set ether2 priority=0x25")).toBe("invalid value for argument priority");
    expect(run(cli, "/interface bridge port set nothing edge=yes")).toBe("input does not match any value of numbers");
    expect(run(cli, "/interface bridge monitor bridge once")).toContain("root-bridge");
    expect(run(cli, "/interface bridge export")).toContain("protocol-mode=rstp");
  });
});
