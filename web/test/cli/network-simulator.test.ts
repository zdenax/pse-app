// The network simulation on projects built through the store only (no consoles): layer 2
// (VLANs, trunks, shutdown), layer 3 (routes, gateways, forwarding) and the explanations.

import type { Device, Port, PortRef } from "../../src/core/model";
import { PortNaming } from "../../src/core/port-naming";
import { ProjectStore } from "../../src/core/store";
import { IPv4 } from "../../src/cli/sim/ipv4";
import { NetworkSimulator } from "../../src/cli/sim/network-simulator";

const c2960 = "cisco-catalyst-2960-24";
const c3650 = "cisco-catalyst-3650-24ps";
const isr4321 = "cisco-isr-4321";
const pcTemplate = "generic-pc";
const server = "generic-server";

function makeStore(): ProjectStore {
  const store = new ProjectStore();
  store.snapToGrid = false;
  return store;
}

function device(store: ProjectStore, hostname: string): Device {
  const found = store.project.devices.find((item) => item.hostname === hostname);
  if (!found) throw new Error(`missing device ${hostname}`);
  return found;
}

function port(store: ProjectStore, hostname: string, name: string): Port {
  const owner = device(store, hostname);
  const found =
    owner.ports.find((item) => item.name === name) ??
    owner.ports.find((item) => PortNaming.shortName(item.name) === name);
  if (!found) throw new Error(`missing port ${hostname} ${name}`);
  return found;
}

function ref(store: ProjectStore, hostname: string, name: string): PortRef {
  return { deviceID: device(store, hostname).id, portID: port(store, hostname, name).id };
}

function cable(store: ProjectStore, a: string, portA: string, b: string, portB: string): void {
  store.connect(ref(store, a, portA), ref(store, b, portB));
}

function address(store: ProjectStore, hostname: string, interfaceID: string, cidr: string): void {
  store.setAddress(device(store, hostname).id, interfaceID, cidr);
}

function portAddress(store: ProjectStore, hostname: string, portName: string, cidr: string): void {
  address(store, hostname, `port:${port(store, hostname, portName).id}`, cidr);
}

function ping(store: ProjectStore, from: string, to: string) {
  const simulator = new NetworkSimulator(store.project);
  const result = simulator.ping(device(store, from).id, IPv4.parse(to)!);
  return { result, simulator, explanation: simulator.explain(result) };
}

/** PC1 and PC2 on SW1 Fa0/1 and Fa0/2, in 10.0.0.0/24. */
function lan() {
  const store = makeStore();
  store.addDevice(c2960, { x: 0, y: 0 }, "SW1");
  store.addDevice(pcTemplate, { x: 0, y: 300 }, "PC1");
  store.addDevice(pcTemplate, { x: 300, y: 300 }, "PC2");
  cable(store, "PC1", "eth0", "SW1", "Fa0/1");
  cable(store, "PC2", "eth0", "SW1", "Fa0/2");
  portAddress(store, "PC1", "eth0", "10.0.0.1/24");
  portAddress(store, "PC2", "eth0", "10.0.0.2/24");
  return store;
}

describe("layer 2", () => {
  test("a switch bridges its ports in VLAN 1", () => {
    const store = lan();
    const { result } = ping(store, "PC1", "10.0.0.2");
    expect(result.success).toBe(true);
    expect(result.hopCount).toBe(1);
    expect(result.source?.description).toBe("10.0.0.1");
    expect(result.forward.hops.map((hop) => hop.description)).toEqual(["10.0.0.2"]);
    expect(result.back?.hops.map((hop) => hop.description)).toEqual(["10.0.0.1"]);
  });

  test("access VLANs separate the ports", () => {
    const store = lan();
    store.setPortVLAN(ref(store, "SW1", "Fa0/1"), "access 10");
    const failed = ping(store, "PC1", "10.0.0.2");
    expect(failed.result.success).toBe(false);
    expect(failed.result.forward.failure).toEqual({
      kind: "unreachableNextHop",
      deviceID: device(store, "PC1").id,
      nextHop: IPv4.parse("10.0.0.2"),
    });
    expect(failed.explanation).toBe(
      "NetSketch: požadavek nedošel – PC1 nenašel 10.0.0.2 ve své síti (zkontrolujte kabel, shutdown, VLAN a adresy).",
    );
    // A bare number is the access VLAN without a mode.
    store.setPortVLAN(ref(store, "SW1", "Fa0/2"), "10");
    expect(ping(store, "PC1", "10.0.0.2").result.success).toBe(true);
  });

  test("a hand-typed VLAN text counts as VLAN 1", () => {
    const store = lan();
    store.setPortVLAN(ref(store, "SW1", "Fa0/1"), "uplink to the lab");
    expect(ping(store, "PC1", "10.0.0.2").result.success).toBe(true);
  });

  test("trunks carry the allowed VLANs tagged and the native VLAN untagged", () => {
    const store = makeStore();
    store.addDevice(c2960, { x: 0, y: 0 }, "SW1");
    store.addDevice(c2960, { x: 600, y: 0 }, "SW2");
    store.addDevice(pcTemplate, { x: 0, y: 300 }, "PC1");
    store.addDevice(pcTemplate, { x: 600, y: 300 }, "PC2");
    cable(store, "SW1", "Gi0/1", "SW2", "Gi0/1");
    cable(store, "PC1", "eth0", "SW1", "Fa0/1");
    cable(store, "PC2", "eth0", "SW2", "Fa0/1");
    portAddress(store, "PC1", "eth0", "10.0.0.1/24");
    portAddress(store, "PC2", "eth0", "10.0.0.2/24");
    store.setPortVLAN(ref(store, "SW1", "Fa0/1"), "access 10");
    store.setPortVLAN(ref(store, "SW2", "Fa0/1"), "access 10");
    // Access uplinks in VLAN 1 do not carry VLAN 10.
    expect(ping(store, "PC1", "10.0.0.2").result.success).toBe(false);
    store.setPortVLAN(ref(store, "SW1", "Gi0/1"), "trunk");
    store.setPortVLAN(ref(store, "SW2", "Gi0/1"), "trunk");
    expect(ping(store, "PC1", "10.0.0.2").result.success).toBe(true);
    // Only one end restricts the trunk: the VLAN no longer crosses.
    store.setPortVLAN(ref(store, "SW2", "Gi0/1"), "trunk 20,30");
    expect(ping(store, "PC1", "10.0.0.2").result.success).toBe(false);
    store.setPortVLAN(ref(store, "SW2", "Gi0/1"), "trunk 10,20");
    expect(ping(store, "PC1", "10.0.0.2").result.success).toBe(true);
    // A native VLAN 10 on both ends carries it untagged.
    store.setPortVLAN(ref(store, "SW1", "Gi0/1"), "trunk none native 10");
    store.setPortVLAN(ref(store, "SW2", "Gi0/1"), "trunk none native 10");
    expect(ping(store, "PC1", "10.0.0.2").result.success).toBe(false);
    store.setPortVLAN(ref(store, "SW1", "Gi0/1"), "trunk 10 native 10");
    store.setPortVLAN(ref(store, "SW2", "Gi0/1"), "trunk 10 native 10");
    expect(ping(store, "PC1", "10.0.0.2").result.success).toBe(true);
    // An untagged native VLAN 10 meets an access port in VLAN 10.
    store.setPortVLAN(ref(store, "SW2", "Gi0/1"), "access 10");
    expect(ping(store, "PC1", "10.0.0.2").result.success).toBe(true);
  });

  test("a shut-down port or a missing cable breaks the path", () => {
    const store = lan();
    store.setPortAdminDown(ref(store, "SW1", "Fa0/2"), true);
    const failed = ping(store, "PC1", "10.0.0.2");
    expect(failed.result.success).toBe(false);
    // PC2's interface is down (the far end is shut down), so it owns no working address.
    expect(new NetworkSimulator(store.project).interfacesOf(device(store, "PC2").id)).toEqual([]);
    store.setPortAdminDown(ref(store, "SW1", "Fa0/2"), false);
    expect(ping(store, "PC1", "10.0.0.2").result.success).toBe(true);
  });

  test("an address on an unplugged port does not work", () => {
    const store = makeStore();
    store.addDevice(pcTemplate, { x: 0, y: 0 }, "PC1");
    portAddress(store, "PC1", "eth0", "10.0.0.1/24");
    const failed = ping(store, "PC1", "10.0.0.2");
    expect(failed.result.noSource).toBe(true);
    expect(failed.result.back).toBeNull();
    expect(failed.explanation).toBe(
      "NetSketch: zařízení nemá IP adresu na funkčním rozhraní ani trasu do 10.0.0.2 " +
        "(chybí adresa, kabel, výchozí brána nebo statická trasa).",
    );
  });

  test("a switch VLAN interface is up while a cabled port carries the VLAN", () => {
    const store = lan();
    address(store, "SW1", "vlan:1", "10.0.0.254/24");
    address(store, "SW1", "vlan:20", "10.0.20.254/24");
    const simulator = new NetworkSimulator(store.project);
    const names = simulator.interfacesOf(device(store, "SW1").id).map((item) => item.name);
    expect(names).toEqual(["Vlan1"]);
    expect(ping(store, "PC1", "10.0.0.254").result.success).toBe(true);
    // A PC ignores a VLAN address: only switches have VLAN interfaces.
    address(store, "PC1", "vlan:1", "10.0.0.9/24");
    expect(ping(store, "PC2", "10.0.0.9").result.success).toBe(false);
  });

  test("management ports of switches and servers are routed ports", () => {
    const store = makeStore();
    store.addDevice(c3650, { x: 0, y: 0 }, "SW1");
    store.addDevice(server, { x: 300, y: 0 }, "SRV");
    cable(store, "SW1", "Gi0/0", "SRV", "mgmt0");
    portAddress(store, "SW1", "Gi0/0", "192.168.0.1/24");
    portAddress(store, "SRV", "mgmt0", "192.168.0.2/24");
    // Even with an access VLAN text the management port is not bridged.
    store.setPortVLAN(ref(store, "SW1", "Gi0/0"), "access 30");
    expect(ping(store, "SRV", "192.168.0.1").result.success).toBe(true);
    const iface = new NetworkSimulator(store.project).interfacesOf(device(store, "SW1").id)[0];
    expect(iface.name).toBe("Gi0/0");
    expect(iface.id).toBe(`port:${port(store, "SW1", "Gi0/0").id}`);
  });
});

describe("layer 3", () => {
  /** PC1 - R1 - R2 - PC2 with addresses but without routes. */
  function routed() {
    const store = makeStore();
    store.addDevice(isr4321, { x: 0, y: 0 }, "R1");
    store.addDevice(isr4321, { x: 600, y: 0 }, "R2");
    store.addDevice(pcTemplate, { x: 0, y: 300 }, "PC1");
    store.addDevice(pcTemplate, { x: 600, y: 300 }, "PC2");
    cable(store, "R1", "Gi0/0/1", "R2", "Gi0/0/1");
    cable(store, "PC1", "eth0", "R1", "Gi0/0/0");
    cable(store, "PC2", "eth0", "R2", "Gi0/0/0");
    portAddress(store, "R1", "Gi0/0/0", "192.168.1.1/24");
    portAddress(store, "R1", "Gi0/0/1", "10.0.12.1/30");
    portAddress(store, "R2", "Gi0/0/1", "10.0.12.2/30");
    portAddress(store, "R2", "Gi0/0/0", "192.168.2.1/24");
    portAddress(store, "PC1", "eth0", "192.168.1.10/24");
    portAddress(store, "PC2", "eth0", "192.168.2.10/24");
    return store;
  }

  test("routes, gateways and static routes", () => {
    const store = routed();
    const failed = ping(store, "PC1", "192.168.2.10");
    expect(failed.result.noSource).toBe(true);

    store.setDefaultGateway(device(store, "PC1").id, "192.168.1.1");
    store.setDefaultGateway(device(store, "PC2").id, "192.168.2.1");
    const noRoute = ping(store, "PC1", "192.168.2.10");
    expect(noRoute.result.forward.failure).toEqual({ kind: "noRoute", deviceID: device(store, "R1").id });
    expect(noRoute.result.forward.hops.map((hop) => hop.description)).toEqual(["192.168.1.1"]);
    expect(noRoute.explanation).toBe(
      "NetSketch: požadavek nedošel – R1 nemá trasu do sítě s adresou 192.168.2.10 (chybí statická trasa nebo výchozí brána).",
    );

    store.setStaticRoutes(device(store, "R1").id, [{ destination: "192.168.2.0/24", nextHop: "10.0.12.2" }]);
    const noWayBack = ping(store, "PC1", "192.168.2.10");
    expect(noWayBack.result.forward.delivered).toBe(true);
    expect(noWayBack.result.success).toBe(false);
    expect(noWayBack.explanation).toBe(
      "NetSketch: požadavek došel, ale odpověď ne – R2 nemá trasu do sítě s adresou 192.168.1.10 (chybí statická trasa nebo výchozí brána).",
    );

    store.setStaticRoutes(device(store, "R2").id, [{ destination: "192.168.1.0/24", nextHop: "10.0.12.1" }]);
    const done = ping(store, "PC1", "192.168.2.10");
    expect(done.result.success).toBe(true);
    expect(done.result.forward.hops.map((hop) => hop.description)).toEqual([
      "192.168.1.1",
      "10.0.12.2",
      "192.168.2.10",
    ]);
    expect(done.explanation).toBe("");

    const simulator = new NetworkSimulator(store.project);
    const table = simulator.routes(device(store, "R1").id).map((route) => [
      route.kind,
      route.destination.description,
      route.nextHop?.description ?? null,
      route.interface.name,
    ]);
    expect(table).toEqual([
      ["connected", "192.168.1.0/24", null, "Gi0/0/0"],
      ["local", "192.168.1.1/32", null, "Gi0/0/0"],
      ["connected", "10.0.12.0/30", null, "Gi0/0/1"],
      ["local", "10.0.12.1/32", null, "Gi0/0/1"],
      ["staticRoute", "192.168.2.0/24", "10.0.12.2", "Gi0/0/1"],
    ]);
    const pcRoutes = simulator.routes(device(store, "PC1").id);
    expect(pcRoutes[pcRoutes.length - 1].destination.description).toBe("0.0.0.0/0");
    expect(simulator.lookup(IPv4.parse("192.168.2.77")!, device(store, "R1").id)?.nextHop?.description).toBe(
      "10.0.12.2",
    );
    expect(simulator.sourceAddress(device(store, "R1").id, IPv4.parse("192.168.2.10")!)?.description).toBe(
      "10.0.12.1",
    );
    expect(simulator.deliver(device(store, "PC1").id, IPv4.parse("192.168.1.10")!).hops).toEqual([]);
  });

  test("a static route whose next hop is not connected is inactive", () => {
    const store = routed();
    store.setStaticRoutes(device(store, "R1").id, [{ destination: "172.16.0.0/16", nextHop: "10.9.9.9" }]);
    const simulator = new NetworkSimulator(store.project);
    expect(simulator.routes(device(store, "R1").id).some((route) => route.kind === "staticRoute")).toBe(false);
  });

  test("a static default route wins over the default gateway", () => {
    const store = routed();
    const r1 = device(store, "R1").id;
    store.setDefaultGateway(r1, "192.168.1.10");
    store.setStaticRoutes(r1, [{ destination: "0.0.0.0/0", nextHop: "10.0.12.2" }]);
    const defaults = new NetworkSimulator(store.project).routes(r1).filter((route) => route.destination.length === 0);
    expect(defaults.map((route) => route.nextHop?.description)).toEqual(["10.0.12.2"]);
  });

  test("a PC does not forward packets", () => {
    const store = lan();
    portAddress(store, "PC2", "eth0", "10.0.0.2/24");
    store.setStaticRoutes(device(store, "PC1").id, [{ destination: "10.9.0.0/16", nextHop: "10.0.0.2" }]);
    const failed = ping(store, "PC1", "10.9.0.1");
    expect(failed.result.forward.failure).toEqual({ kind: "notForwarding", deviceID: device(store, "PC2").id });
    expect(failed.explanation).toBe(
      "NetSketch: požadavek nedošel – PC2 nesměruje pakety (není router), ale dostal paket pro 10.9.0.1.",
    );
  });

  test("a routing loop ends with an exceeded TTL", () => {
    const store = routed();
    store.setStaticRoutes(device(store, "R1").id, [{ destination: "0.0.0.0/0", nextHop: "10.0.12.2" }]);
    store.setStaticRoutes(device(store, "R2").id, [{ destination: "0.0.0.0/0", nextHop: "10.0.12.1" }]);
    const failed = ping(store, "R1", "8.8.8.8");
    expect(failed.result.forward.failure).toEqual({ kind: "ttlExceeded" });
    expect(failed.result.forward.hops.length).toBe(32);
    expect(failed.explanation).toBe("NetSketch: požadavek nedošel – paket koloval ve smyčce tras (TTL vypršelo).");
  });

  test("a layer-3 switch routes between its VLANs", () => {
    const store = makeStore();
    store.addDevice(c3650, { x: 0, y: 0 }, "L3");
    store.addDevice(pcTemplate, { x: 0, y: 300 }, "PC1");
    store.addDevice(pcTemplate, { x: 300, y: 300 }, "PC2");
    cable(store, "PC1", "eth0", "L3", "Gi1/0/1");
    cable(store, "PC2", "eth0", "L3", "Gi1/0/2");
    store.setPortVLAN(ref(store, "L3", "Gi1/0/1"), "access 10");
    store.setPortVLAN(ref(store, "L3", "Gi1/0/2"), "access 20");
    address(store, "L3", "vlan:10", "10.0.10.1/24");
    address(store, "L3", "vlan:20", "10.0.20.1/24");
    portAddress(store, "PC1", "eth0", "10.0.10.5/24");
    portAddress(store, "PC2", "eth0", "10.0.20.5/24");
    store.setDefaultGateway(device(store, "PC1").id, "10.0.10.1");
    store.setDefaultGateway(device(store, "PC2").id, "10.0.20.1");
    const { result } = ping(store, "PC1", "10.0.20.5");
    expect(result.success).toBe(true);
    expect(result.forward.hops.map((hop) => hop.description)).toEqual(["10.0.10.1", "10.0.20.5"]);
    expect(NetworkSimulator.isForwarding("L3 switch")).toBe(true);
    expect(NetworkSimulator.isSwitching("L3 switch")).toBe(true);
    expect(NetworkSimulator.isForwarding("switch")).toBe(false);
    expect(NetworkSimulator.isSwitching("AP")).toBe(true);
    expect(NetworkSimulator.isSwitching("router")).toBe(false);
  });
});
