// EtherChannel: interface port-channel, channel-group, show etherchannel / show interfaces
// port-channel, the channel as one logical link (members, failover), mode compatibility and
// the spanning tree counting a bundle as one link.

import { ProjectStore } from "../../src/core/store";
import { CLISession } from "../../src/cli/session";
import { computeSpanningTree } from "../../src/cli/features/layer2/stp";
import { modesCompatible, computeChannels } from "../../src/cli/features/layer2/etherchannel";
import type { ChannelMode } from "../../src/core/protocols";
import { device, makeStore, port, ref } from "../cli/support";

const c2960 = "cisco-catalyst-2960-24";
const isr4321 = "cisco-isr-4321";
const pc = "generic-pc";

/** SW1 and SW2 cabled with two cables Gi0/1-Gi0/1 and Gi0/2-Gi0/2, a console on each. */
function twoSwitches(): { store: ProjectStore; sw1: CLISession; sw2: CLISession } {
  const store = makeStore();
  store.addDevice(c2960, { x: 0, y: 0 }, "SW1");
  store.addDevice(c2960, { x: 300, y: 0 }, "SW2");
  store.connect(ref(store, "SW1", "Gi0/1"), ref(store, "SW2", "Gi0/1"));
  store.connect(ref(store, "SW1", "Gi0/2"), ref(store, "SW2", "Gi0/2"));
  return { store, sw1: new CLISession(store, device(store, "SW1").id), sw2: new CLISession(store, device(store, "SW2").id) };
}

function ios(cli: CLISession, ...lines: string[]): string {
  cli.execute("enable");
  cli.execute("configure terminal");
  let output = "";
  for (const line of lines) output = cli.execute(line);
  cli.execute("end");
  return output;
}

function bundle(cli: CLISession, group: number, mode: ChannelMode, ...ports: string[]): void {
  ios(cli, `interface range ${ports.join(", ")}`, `channel-group ${group} mode ${mode}`);
}

function show(cli: CLISession, command: string): string {
  cli.execute("enable");
  return cli.execute(command);
}

describe("mode compatibility", () => {
  const modes: ChannelMode[] = ["active", "passive", "on", "desirable", "auto"];
  const compatible = new Set([
    "active/active",
    "active/passive",
    "passive/active",
    "on/on",
    "desirable/desirable",
    "desirable/auto",
    "auto/desirable",
  ]);
  test.each(modes.flatMap((a) => modes.map((b) => [a, b] as const)))("%s with %s", (a, b) => {
    expect(modesCompatible(a, b)).toBe(compatible.has(`${a}/${b}`));
  });
});

describe("commands", () => {
  test("interface port-channel creates the interface; channel-group says so", () => {
    const { store, sw1 } = twoSwitches();
    sw1.execute("enable");
    sw1.execute("configure terminal");
    expect(sw1.execute("interface port-channel 5")).toBe("");
    expect(sw1.prompt).toBe("SW1(config-if)#");
    sw1.execute("exit");
    sw1.execute("interface gi0/1");
    expect(sw1.execute("channel-group 1 mode active")).toBe("Creating a port-channel interface Port-channel 1");
    expect(sw1.execute("channel-group 1 mode active")).toBe("");
    expect(device(store, "SW1").protocols?.lacp?.members).toEqual([
      { port: port(store, "SW1", "Gi0/1").id, group: 1, mode: "active" },
    ]);
  });

  test("members of a group must use one protocol", () => {
    const { sw1 } = twoSwitches();
    bundle(sw1, 1, "active", "gi0/1");
    const output = ios(sw1, "interface gi0/2", "channel-group 1 mode desirable");
    expect(output).toContain("musí mít stejný protokol");
    expect(show(sw1, "show etherchannel summary")).not.toContain("Gi0/2");
  });

  test("channel-group is refused on the port-channel itself, no channel-group removes", () => {
    const { store, sw1 } = twoSwitches();
    expect(ios(sw1, "interface port-channel 1", "channel-group 1 mode on")).toContain("patří na fyzický port");
    bundle(sw1, 1, "active", "gi0/1", "gi0/2");
    ios(sw1, "interface gi0/2", "no channel-group");
    expect(device(store, "SW1").protocols?.lacp?.members).toHaveLength(1);
  });

  test("no interface port-channel removes the channel and its members' lines", () => {
    const { store, sw1 } = twoSwitches();
    bundle(sw1, 1, "active", "gi0/1", "gi0/2");
    ios(sw1, "no interface port-channel 1");
    expect(device(store, "SW1").protocols?.lacp).toBeUndefined();
    expect(ios(sw1, "no interface port-channel 1")).toContain("neexistuje");
  });

  test("running-config shows channel-group on members and the port-channel block", () => {
    const { sw1 } = twoSwitches();
    bundle(sw1, 3, "active", "gi0/1", "gi0/2");
    ios(sw1, "interface port-channel 3", "switchport mode trunk", "description UPLINK");
    const config = show(sw1, "show running-config");
    expect(config).toContain("interface Port-channel3\n description UPLINK\n switchport mode trunk");
    expect(config).toMatch(/interface GigabitEthernet0\/1\n[^!]* channel-group 3 mode active/);
  });

  test("the port-channel's settings are written through to the members", () => {
    const { store, sw1 } = twoSwitches();
    bundle(sw1, 1, "active", "gi0/1", "gi0/2");
    ios(sw1, "interface port-channel 1", "switchport mode trunk", "switchport trunk allowed vlan 10,20");
    for (const name of ["Gi0/1", "Gi0/2"]) expect(port(store, "SW1", name).vlan).toBe("trunk 10,20");
    const text = show(sw1, "show interfaces port-channel 1 switchport");
    expect(text).toContain("Administrative Mode: trunk");
    expect(text).toContain("Trunking VLANs Enabled: 10,20");
    // A port that joins later takes over the channel's text.
    ios(sw1, "interface fa0/3", "channel-group 1 mode active");
    expect(port(store, "SW1", "Fa0/3").vlan).toBe("trunk 10,20");
    // The first member defines a new channel.
    ios(sw1, "interface fa0/4", "switchport access vlan 7", "channel-group 2 mode active");
    ios(sw1, "interface fa0/5", "channel-group 2 mode active");
    expect(port(store, "SW1", "Fa0/5").vlan).toBe(port(store, "SW1", "Fa0/4").vlan);
  });

  test("shutdown on the port-channel shuts the members", () => {
    const { store, sw1 } = twoSwitches();
    bundle(sw1, 1, "active", "gi0/1", "gi0/2");
    ios(sw1, "interface port-channel 1", "shutdown");
    expect(port(store, "SW1", "Gi0/1").adminDown).toBe(true);
    expect(show(sw1, "show interfaces port-channel 1")).toContain("Port-channel1 is administratively down");
    ios(sw1, "interface port-channel 1", "no shutdown");
    expect(port(store, "SW1", "Gi0/2").adminDown).toBe(false);
  });

  test("show interfaces of a missing port-channel", () => {
    const { sw1 } = twoSwitches();
    expect(show(sw1, "show interfaces port-channel 9")).toContain("neexistuje");
  });

  test("one undo step per channel-group on a range", () => {
    const { store, sw1 } = twoSwitches();
    bundle(sw1, 1, "active", "gi0/1", "gi0/2");
    expect(device(store, "SW1").protocols?.lacp?.members).toHaveLength(2);
    store.undo();
    expect(device(store, "SW1").protocols?.lacp).toBeUndefined();
  });

  test("the configuration survives saving", () => {
    const { store, sw1 } = twoSwitches();
    bundle(sw1, 1, "active", "gi0/1", "gi0/2");
    ios(sw1, "interface port-channel 1", "description UPLINK");
    const copy = makeStore();
    copy.openText(store.serialize());
    expect(device(copy, "SW1").protocols?.lacp?.channels).toEqual([
      { group: 1, vlan: "", description: "UPLINK", adminDown: false },
    ]);
  });
});

describe("bundle states", () => {
  test("matching ends form the bundle: Po1(SU), both members P", () => {
    const { sw1, sw2 } = twoSwitches();
    bundle(sw1, 1, "active", "gi0/1", "gi0/2");
    bundle(sw2, 4, "passive", "gi0/1", "gi0/2");
    const summary = show(sw1, "show etherchannel summary");
    expect(summary).toContain("Number of channel-groups in use: 1");
    expect(summary).toMatch(/1\s+Po1\(SU\)\s+LACP\s+Gi0\/1\(P\)\s+Gi0\/2\(P\)/);
    expect(show(sw2, "show etherchannel summary")).toMatch(/4\s+Po4\(SU\)\s+LACP\s+Gi0\/1\(P\)\s+Gi0\/2\(P\)/);
    const status = show(sw1, "show interfaces port-channel 1");
    expect(status).toContain("Port-channel1 is up, line protocol is up");
    expect(status).toContain("Members in this channel: Gi0/1 Gi0/2");
  });

  test("passive against passive does not form: members stand alone, mismatch is reported", () => {
    const { store, sw1, sw2 } = twoSwitches();
    bundle(sw1, 1, "passive", "gi0/1", "gi0/2");
    const note = ios(sw2, "interface range gi0/1 - 2", "channel-group 1 mode passive");
    expect(note).toContain("NetSketch: Gi0/1 nevytvoří svazek: nesoulad módů: zde passive, na druhém konci passive");
    expect(note).toContain("samostatný (I)");
    expect(show(sw2, "show etherchannel summary")).toMatch(/Po1\(SD\)\s+LACP\s+Gi0\/1\(I\)\s+Gi0\/2\(I\)/);
    expect(computeChannels(store.project).every((info) => !info.up)).toBe(true);
    expect(show(sw2, "show interfaces port-channel 1")).toContain("Port-channel1 is down");
  });

  test("on against active: the static member is suspended and carries nothing", () => {
    const { store, sw1, sw2 } = twoSwitches();
    store.addDevice(pc, { x: 0, y: 200 }, "PC1");
    store.addDevice(pc, { x: 300, y: 200 }, "PC2");
    store.connect(ref(store, "PC1", "eth0"), ref(store, "SW1", "Fa0/1"));
    store.connect(ref(store, "PC2", "eth0"), ref(store, "SW2", "Fa0/1"));
    const pc1 = new CLISession(store, device(store, "PC1").id);
    new CLISession(store, device(store, "PC2").id).execute("netsh interface ip set address eth0 static 10.0.0.2 255.255.255.0");
    pc1.execute("netsh interface ip set address eth0 static 10.0.0.1 255.255.255.0");
    expect(pc1.execute("ping 10.0.0.2")).toContain("Reply from 10.0.0.2");
    bundle(sw1, 1, "on", "gi0/1", "gi0/2");
    bundle(sw2, 1, "active", "gi0/1", "gi0/2");
    expect(show(sw1, "show etherchannel summary")).toMatch(/Po1\(SD\)\s+-\s+Gi0\/1\(s\)\s+Gi0\/2\(s\)/);
    expect(show(sw2, "show etherchannel summary")).toMatch(/Po1\(SD\)\s+LACP\s+Gi0\/1\(I\)\s+Gi0\/2\(I\)/);
    // SW1 sends nothing over the suspended ports, so the PCs are cut off from each other.
    expect(pc1.execute("ping 10.0.0.2")).not.toContain("Reply from 10.0.0.2");
  });

  test("a neighbour without channel-group: the member stands alone (LACP) and the problem is listed", () => {
    const { sw1 } = twoSwitches();
    bundle(sw1, 1, "active", "gi0/1", "gi0/2");
    const summary = show(sw1, "show etherchannel summary");
    expect(summary).toContain("Gi0/1(I)");
    expect(summary).toContain("druhý konec nemá channel-group");
  });

  test("members to two different neighbours: the later one is not bundled", () => {
    const store = makeStore();
    for (const name of ["SW1", "SW2", "SW3"]) store.addDevice(c2960, { x: store.project.devices.length * 200, y: 0 }, name);
    store.connect(ref(store, "SW1", "Gi0/1"), ref(store, "SW2", "Gi0/1"));
    store.connect(ref(store, "SW1", "Gi0/2"), ref(store, "SW3", "Gi0/1"));
    const [sw1, sw2, sw3] = ["SW1", "SW2", "SW3"].map((name) => new CLISession(store, device(store, name).id));
    bundle(sw1, 1, "active", "gi0/1", "gi0/2");
    bundle(sw2, 1, "active", "gi0/1");
    bundle(sw3, 1, "active", "gi0/1");
    expect(show(sw1, "show etherchannel summary")).toMatch(/Gi0\/1\(P\)\s+Gi0\/2\(I\)/);
    expect(show(sw1, "show etherchannel summary")).toContain("jinému sousedovi");
  });
});

describe("the bundle carries traffic as one link", () => {
  /** SW1 - SW2 over a trunk port-channel of two cables, a PC in VLAN 10 on each switch. */
  function lab() {
    const { store, sw1, sw2 } = twoSwitches();
    store.addDevice(pc, { x: 0, y: 200 }, "PC1");
    store.addDevice(pc, { x: 300, y: 200 }, "PC2");
    store.connect(ref(store, "PC1", "eth0"), ref(store, "SW1", "Fa0/1"));
    store.connect(ref(store, "PC2", "eth0"), ref(store, "SW2", "Fa0/1"));
    for (const [cli, mode] of [[sw1, "active"], [sw2, "passive"]] as const) {
      ios(cli, "vlan 10", "exit", "interface fa0/1", "switchport mode access", "switchport access vlan 10");
      bundle(cli, 1, mode, "gi0/1", "gi0/2");
      ios(cli, "interface port-channel 1", "switchport mode trunk", "switchport trunk allowed vlan 10");
    }
    const pc1 = new CLISession(store, device(store, "PC1").id);
    const pc2 = new CLISession(store, device(store, "PC2").id);
    pc1.execute("netsh interface ip set address eth0 static 10.0.10.1 255.255.255.0");
    pc2.execute("netsh interface ip set address eth0 static 10.0.10.2 255.255.255.0");
    return { store, sw1, sw2, pc1 };
  }

  test("VLAN traffic crosses; a shut-down member leaves the rest carrying", () => {
    const { sw1, sw2, pc1 } = lab();
    expect(pc1.execute("ping 10.0.10.2")).toContain("Reply from 10.0.10.2");
    ios(sw1, "interface gi0/1", "shutdown");
    expect(pc1.execute("ping 10.0.10.2")).toContain("Reply from 10.0.10.2");
    expect(show(sw1, "show etherchannel summary")).toMatch(/Po1\(SU\)\s+LACP\s+Gi0\/1\(D\)\s+Gi0\/2\(P\)/);
    // The far end sees the same: its Gi0/1 is down, its bundle still up.
    expect(show(sw2, "show etherchannel summary")).toMatch(/Po1\(SU\)\s+LACP\s+Gi0\/1\(D\)\s+Gi0\/2\(P\)/);
    expect(show(sw1, "show interfaces port-channel 1")).toContain("Port-channel1 is up, line protocol is up");
  });

  test("an unplugged cable is the same as a shut-down member", () => {
    const { store, pc1 } = lab();
    const link = store.project.links.find(
      (item) => item.a.portID === port(store, "SW1", "Gi0/2").id || item.b.portID === port(store, "SW1", "Gi0/2").id,
    )!;
    store.removeLink(link.id);
    expect(pc1.execute("ping 10.0.10.2")).toContain("Reply from 10.0.10.2");
  });

  test("all members down: the bundle is down and the traffic stops", () => {
    const { sw1, pc1 } = lab();
    ios(sw1, "interface range gi0/1 - 2", "shutdown");
    expect(pc1.execute("ping 10.0.10.2")).not.toContain("Reply from 10.0.10.2");
    expect(show(sw1, "show etherchannel summary")).toMatch(/Po1\(SD\)\s+LACP\s+Gi0\/1\(D\)\s+Gi0\/2\(D\)/);
    expect(show(sw1, "show interfaces port-channel 1")).toContain("Port-channel1 is down, line protocol is down");
  });

  test("the trunk configuration of the channel is what the members carry", () => {
    const { sw1, pc1 } = lab();
    ios(sw1, "interface port-channel 1", "switchport trunk allowed vlan 20");
    expect(pc1.execute("ping 10.0.10.2")).not.toContain("Reply from 10.0.10.2");
    ios(sw1, "interface port-channel 1", "switchport trunk allowed vlan 10,20");
    expect(pc1.execute("ping 10.0.10.2")).toContain("Reply from 10.0.10.2");
  });
});

describe("routed port-channel", () => {
  test("ip address of a router's port-channel is kept on its first member", () => {
    const store = makeStore();
    store.addDevice(isr4321, { x: 0, y: 0 }, "R1");
    store.addDevice(c2960, { x: 300, y: 0 }, "SW1");
    store.addDevice(pc, { x: 300, y: 200 }, "PC1");
    store.connect(ref(store, "R1", "Gi0/0/0"), ref(store, "SW1", "Gi0/1"));
    store.connect(ref(store, "R1", "Gi0/0/1"), ref(store, "SW1", "Gi0/2"));
    store.connect(ref(store, "PC1", "eth0"), ref(store, "SW1", "Fa0/1"));
    const r1 = new CLISession(store, device(store, "R1").id);
    const sw1 = new CLISession(store, device(store, "SW1").id);
    const pc1 = new CLISession(store, device(store, "PC1").id);
    // No member yet: nothing to keep the address on.
    expect(ios(r1, "interface port-channel 1", "ip address 10.0.0.1 255.255.255.0")).toContain("zatím nemá žádný člen");
    bundle(r1, 1, "active", "gi0/0/0", "gi0/0/1");
    bundle(sw1, 1, "passive", "gi0/1", "gi0/2");
    expect(ios(r1, "interface port-channel 1", "ip address 10.0.0.1 255.255.255.0")).toBe("");
    pc1.execute("netsh interface ip set address eth0 static 10.0.0.2 255.255.255.0");
    expect(pc1.execute("ping 10.0.0.1")).toContain("Reply from 10.0.0.1");
    expect(show(r1, "show running-config")).toContain("interface Port-channel1\n ip address 10.0.0.1 255.255.255.0");
    // A switch's port-channel is a layer-2 interface.
    expect(ios(sw1, "interface port-channel 1", "ip address 10.0.1.1 255.255.255.0")).toContain("přepínaný (L2)");
  });
});

describe("spanning tree counts a bundle as one link", () => {
  function triangle(): ReturnType<typeof twoSwitches> {
    return twoSwitches();
  }

  test("two parallel cables without a bundle block one, a bundle blocks none", () => {
    const { store, sw1, sw2 } = triangle();
    const blocked = () =>
      [...computeSpanningTree(store.project).values()].flatMap((bridge) => bridge.ports).filter((p) => p.state === "blocking");
    expect(blocked()).toHaveLength(1);
    bundle(sw1, 1, "active", "gi0/1", "gi0/2");
    bundle(sw2, 1, "active", "gi0/1", "gi0/2");
    expect(blocked()).toHaveLength(0);
    const ports = [...computeSpanningTree(store.project).values()].flatMap((bridge) => bridge.ports);
    expect(ports).toHaveLength(4);
    expect(ports.every((p) => p.channel === 1)).toBe(true);
  });

  test("the bundle costs as the summed speed and the members share role and state", () => {
    const { store, sw1, sw2 } = triangle();
    bundle(sw1, 1, "active", "gi0/1", "gi0/2");
    bundle(sw2, 1, "active", "gi0/1", "gi0/2");
    const tree = computeSpanningTree(store.project);
    const nonRoot = [...tree.values()].find((bridge) => !bridge.isRoot)!;
    expect(nonRoot.rootCost).toBe(10000);
    expect(new Set(nonRoot.ports.map((p) => `${p.role}/${p.state}/${p.cost}`)).size).toBe(1);
    // A failed member lowers the bundle's speed, so the cost.
    port(store, "SW1", "Gi0/1").adminDown = true;
    const after = [...computeSpanningTree(store.project).values()].find((bridge) => !bridge.isRoot)!;
    expect(after.rootCost).toBe(20000);
    expect(after.ports.find((p) => p.portID === port(store, "SW1", "Gi0/2").id || p.portID === port(store, "SW2", "Gi0/2").id)?.state).toBe(
      "forwarding",
    );
  });

  test("show spanning-tree lists the bundle once, as Po1", () => {
    const { sw1, sw2 } = triangle();
    bundle(sw1, 1, "active", "gi0/1", "gi0/2");
    bundle(sw2, 1, "active", "gi0/1", "gi0/2");
    const text = show(sw1, "show spanning-tree");
    expect(text).toMatch(/^Po1\s+(Root|Desg)\s+FWD\s+10000\s/m);
    expect(text).not.toContain("Gi0/1 ");
  });

  test("a loop through a bundle: the redundant path still blocks", () => {
    const store = makeStore();
    for (const name of ["SW1", "SW2", "SW3"]) {
      const added = store.addDevice(c2960, { x: store.project.devices.length * 200, y: 0 }, name);
      store.setProtocols(added.id, {
        stp: {
          mode: "rapid-pvst",
          disabledVLANs: [],
          priorities: name === "SW1" ? [{ vlan: 0, priority: 4096 }] : [],
          portfast: [],
          bpduGuard: [],
          costs: [],
          portPriorities: [],
        },
      });
    }
    store.connect(ref(store, "SW1", "Gi0/1"), ref(store, "SW2", "Gi0/1"));
    store.connect(ref(store, "SW1", "Gi0/2"), ref(store, "SW2", "Gi0/2"));
    store.connect(ref(store, "SW2", "Fa0/3"), ref(store, "SW3", "Fa0/3"));
    store.connect(ref(store, "SW3", "Fa0/4"), ref(store, "SW1", "Fa0/4"));
    const [sw1, sw2] = ["SW1", "SW2"].map((name) => new CLISession(store, device(store, name).id));
    bundle(sw1, 1, "active", "gi0/1", "gi0/2");
    bundle(sw2, 1, "active", "gi0/1", "gi0/2");
    const blocked = [...computeSpanningTree(store.project).values()]
      .flatMap((bridge) => bridge.ports)
      .filter((p) => p.state === "blocking");
    // Exactly one tree port blocks (the link SW2-SW3 or SW3-SW1 side), not a bundle member.
    expect(blocked).toHaveLength(1);
    expect(blocked[0].channel).toBeUndefined();
  });

  test("a suspended static member is a cable that is down for the tree", () => {
    const { store, sw1, sw2 } = triangle();
    bundle(sw1, 1, "on", "gi0/1", "gi0/2");
    bundle(sw2, 1, "active", "gi0/1", "gi0/2");
    const states = [...computeSpanningTree(store.project).values()].flatMap((bridge) => bridge.ports.map((p) => p.state));
    expect(states).toEqual(["disabled", "disabled", "disabled", "disabled"]);
  });
});
