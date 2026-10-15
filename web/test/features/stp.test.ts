// Spanning tree: root election, port roles, costs, failover, and that a loop no longer matters.

import type { Project } from "../../src/core/model";
import type { STPMode } from "../../src/core/protocols";
import { ProjectStore } from "../../src/core/store";
import { CLISession } from "../../src/cli/session";
import { computeSpanningTree } from "../../src/cli/features/layer2/stp";
import { spanningTreePortStates } from "../../src/cli/features/layer2/sim";
import { device, makeStore, ref } from "../cli/support";

const switchTemplate = "cisco-catalyst-2960-24";

function addSwitch(store: ProjectStore, name: string, priority?: number, mode: STPMode = "rapid-pvst"): void {
  const added = store.addDevice(switchTemplate, { x: store.project.devices.length * 100, y: 0 }, name);
  store.setProtocols(added.id, {
    stp: {
      mode,
      disabledVLANs: [],
      priorities: priority === undefined ? [] : [{ vlan: 0, priority }],
      portfast: [],
      bpduGuard: [],
      costs: [],
      portPriorities: [],
    },
  });
}

function portNamed(project: Project, hostname: string, name: string) {
  const owner = project.devices.find((item) => item.hostname === hostname)!;
  return owner.ports.find((item) => item.name.toLowerCase().includes(name.toLowerCase()))!;
}

/** Cables two ports; `speed` (when given) is set on both ends. */
function cable(store: ProjectStore, a: string, portA: string, b: string, portB: string, speed?: string): void {
  store.connect(ref(store, a, portA), ref(store, b, portB));
  if (speed === undefined) return;
  portNamed(store.project, a, portA).speed = speed;
  portNamed(store.project, b, portB).speed = speed;
}

function infoOf(store: ProjectStore, hostname: string) {
  return computeSpanningTree(store.project).get(device(store, hostname).id)!;
}

function roleOf(store: ProjectStore, hostname: string, name: string) {
  const id = portNamed(store.project, hostname, name).id;
  return infoOf(store, hostname).ports.find((item) => item.portID === id)!;
}

function triangle(priorities: (number | undefined)[] = [], mode: STPMode = "rapid-pvst"): ProjectStore {
  const store = makeStore();
  addSwitch(store, "SW1", priorities[0], mode);
  addSwitch(store, "SW2", priorities[1], mode);
  addSwitch(store, "SW3", priorities[2], mode);
  cable(store, "SW1", "Gi0/1", "SW2", "Gi0/1");
  cable(store, "SW2", "Gi0/2", "SW3", "Gi0/1");
  cable(store, "SW3", "Gi0/2", "SW1", "Gi0/2");
  return store;
}

describe("spanning tree election", () => {
  test("a triangle has one root and exactly one blocked port", () => {
    const store = triangle([8192, 4096, 12288]);
    const tree = computeSpanningTree(store.project);
    expect(infoOf(store, "SW2").isRoot).toBe(true);
    expect(infoOf(store, "SW1").isRoot).toBe(false);
    expect(infoOf(store, "SW1").rootBridgeID).toBe(infoOf(store, "SW2").bridgeID);
    const blocked = [...tree.values()].flatMap((bridge) => bridge.ports).filter((port) => port.state === "blocking");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].role).toBe("alternate");
    expect(infoOf(store, "SW2").ports.every((port) => port.role === "designated")).toBe(true);
    expect(roleOf(store, "SW3", "Gi0/2").role).toBe("alternate");
    expect(roleOf(store, "SW1", "Gi0/2").role).toBe("designated");
  });

  test("equal priorities are decided by the MAC address, deterministically", () => {
    const store = triangle();
    const summary = () => [...computeSpanningTree(store.project).values()].map((b) => `${b.isRoot}${b.rootBridgeID}`);
    expect(summary()).toEqual(summary());
    const bridges = [...computeSpanningTree(store.project).values()];
    const lowest = bridges.map((bridge) => bridge.mac).sort()[0];
    expect(bridges.filter((bridge) => bridge.isRoot).map((bridge) => bridge.mac)).toEqual([lowest]);
  });

  test("lab: gigabit to the root wins, the slow link blocks on the far switch, failover unblocks it", () => {
    const store = makeStore();
    addSwitch(store, "Dell", 4096);
    addSwitch(store, "SW1", 8192);
    addSwitch(store, "UniFi", 12288);
    cable(store, "Dell", "Gi0/1", "SW1", "Gi0/1", "1G");
    cable(store, "SW1", "Gi0/2", "UniFi", "Gi0/1", "100M");
    cable(store, "Dell", "Gi0/2", "UniFi", "Gi0/2", "1G");
    expect(infoOf(store, "Dell").isRoot).toBe(true);
    expect(infoOf(store, "UniFi").rootPortID).toBe(portNamed(store.project, "UniFi", "Gi0/2").id);
    expect(infoOf(store, "UniFi").rootCost).toBe(20000);
    expect(roleOf(store, "UniFi", "Gi0/2")).toMatchObject({ role: "root", cost: 20000, state: "forwarding" });
    expect(roleOf(store, "UniFi", "Gi0/1")).toMatchObject({ role: "alternate", state: "blocking", cost: 200000 });
    expect(roleOf(store, "SW1", "Gi0/2")).toMatchObject({ role: "designated", state: "forwarding" });
    expect(infoOf(store, "SW1").rootCost).toBe(20000);

    const dell = device(store, "Dell").id;
    const unifi = device(store, "UniFi").id;
    const link = store.project.links.find((item) => item.a.deviceID === dell && item.b.deviceID === unifi)!;
    store.removeLink(link.id);
    expect(roleOf(store, "UniFi", "Gi0/1")).toMatchObject({ role: "root", state: "forwarding" });
    expect(infoOf(store, "UniFi").rootCost).toBe(20000 + 200000);
    expect([...spanningTreePortStates(store.project).values()]).not.toContain("blocking");
  });

  test("a cost override and a shut-down port change the tree", () => {
    const store = triangle([4096]);
    const toRoot = portNamed(store.project, "SW3", "Gi0/2");
    store.setProtocols(device(store, "SW3").id, {
      stp: {
        mode: "rapid-pvst",
        disabledVLANs: [],
        priorities: [],
        portfast: [],
        bpduGuard: [],
        costs: [{ port: toRoot.id, vlan: 0, cost: 90000 }],
        portPriorities: [],
      },
    });
    expect(roleOf(store, "SW3", "Gi0/1").role).toBe("root");
    expect(roleOf(store, "SW3", "Gi0/2").role).toBe("alternate");
    toRoot.adminDown = true;
    expect(roleOf(store, "SW3", "Gi0/2").state).toBe("disabled");
    expect(roleOf(store, "SW1", "Gi0/2").state).toBe("disabled");
  });

  test("mode none keeps the loop: nothing blocks", () => {
    const store = triangle([], "none");
    expect([...spanningTreePortStates(store.project).values()]).not.toContain("blocking");
  });

  test("PCs are leaves: designated edge ports", () => {
    const store = triangle();
    store.addDevice("generic-pc", { x: 0, y: 200 }, "PC1");
    cable(store, "PC1", "eth0", "SW1", "Fa0/1");
    expect(roleOf(store, "SW1", "Fa0/1")).toMatchObject({ role: "designated", edge: true, state: "forwarding" });
  });
});

describe("spanning tree in the simulation", () => {
  test("ping works across a looped topology and exactly one cable is blocked", () => {
    const store = triangle([4096, 8192, 12288]);
    store.addDevice("generic-pc", { x: 0, y: 200 }, "PC1");
    store.addDevice("generic-pc", { x: 100, y: 200 }, "PC2");
    cable(store, "PC1", "eth0", "SW2", "Fa0/1");
    cable(store, "PC2", "eth0", "SW3", "Fa0/1");
    const pc1 = new CLISession(store, device(store, "PC1").id);
    const pc2 = new CLISession(store, device(store, "PC2").id);
    pc1.execute("netsh interface ip set address eth0 static 10.0.0.1 255.255.255.0");
    pc2.execute("netsh interface ip set address eth0 static 10.0.0.2 255.255.255.0");
    expect(pc1.execute("ping 10.0.0.2")).toContain("Reply from 10.0.0.2");
    expect([...spanningTreePortStates(store.project).values()].filter((state) => state === "blocking")).toHaveLength(1);
  });
});
