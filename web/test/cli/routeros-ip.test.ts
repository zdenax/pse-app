// Port of Tests/NetSketchCLITests/RouterOSIPTests.swift.

import type { Device, Port, PortRef } from "../../src/core/model";
import { PortNaming } from "../../src/core/port-naming";
import { ProjectStore } from "../../src/core/store";
import { CLISession } from "../../src/cli/session";

const hapLite = "mikrotik-hap-lite";
const crs = "mikrotik-crs-generic";

function makeStore(): ProjectStore {
  const store = new ProjectStore();
  store.snapToGrid = false;
  return store;
}

function makeSession(templateID: string, hostname?: string) {
  const store = makeStore();
  const device = store.addDevice(templateID, { x: 100, y: 100 }, hostname);
  return { store, device, cli: new CLISession(store, device.id) };
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

function snapshot(store: ProjectStore) {
  return structuredClone(store.project);
}

/** hAP lite routers with the given hostnames, side by side, and a console on each. */
function makeRouters(hostnames: string[]) {
  const store = makeStore();
  const sessions = hostnames.map((hostname, index) => {
    const added = store.addDevice(hapLite, { x: 100 + 200 * index, y: 100 }, hostname);
    return new CLISession(store, added.id);
  });
  return { store, sessions };
}

describe("RouterOS /ip address", () => {
  test("add, print and remove addresses", () => {
    const { store, cli } = makeSession(hapLite);
    expect(cli.execute("/ip address add address=192.168.88.1/24 interface=ether2")).toBe("");
    const ether2 = port(store, "R1", "ether2");
    expect(device(store, "R1").addresses).toEqual([{ interface: `port:${ether2.id}`, address: "192.168.88.1/24" }]);

    // Interface names are matched case-insensitively, argument names may be abbreviated.
    expect(cli.execute("/ip address add addr=10.0.0.1/30 int=ETHER1")).toBe("");
    const listing = cli.execute("/ip address print");
    expect(
      listing.startsWith("Flags: X - disabled, I - invalid, D - dynamic\n #   ADDRESS            NETWORK         INTERFACE"),
    ).toBe(true);
    expect(listing).toContain("\n 0   192.168.88.1/24    192.168.88.0    ether2");
    expect(listing).toContain("\n 1   10.0.0.1/30        10.0.0.0        ether1");

    // One address per interface: a second add replaces the first one.
    const replaced = cli.execute("/ip address add address=192.168.88.5/24 interface=ether2");
    expect(replaced.startsWith("NetSketch:")).toBe(true);
    expect(device(store, "R1").addresses.map((entry) => entry.address)).toEqual(["192.168.88.5/24", "10.0.0.1/30"]);
    expect(cli.execute("/ip address add address=192.168.88.5/24 interface=ether2").startsWith("failure:")).toBe(true);

    const exported = cli.execute("/export");
    expect(exported).toContain(
      "/ip address\nadd address=192.168.88.5/24 interface=ether2\nadd address=10.0.0.1/30 interface=ether1",
    );
    expect(cli.execute("/ip address export")).toContain("add address=10.0.0.1/30 interface=ether1");
    expect(cli.execute("/ip route export")).not.toContain("/ip address");

    cli.execute("/ip address");
    expect(cli.execute("remove 0")).toBe("");
    expect(device(store, "R1").addresses.map((entry) => entry.address)).toEqual(["10.0.0.1/30"]);
    expect(cli.execute("remove numbers=0")).toBe("");
    expect(device(store, "R1").addresses).toEqual([]);
  });

  test("bad values are refused", () => {
    const { store, cli } = makeSession(hapLite);
    const before = snapshot(store);
    expect(cli.execute("/ip address add interface=ether2")).toBe("missing value(s) of argument(s) address");
    expect(cli.execute("/ip address add address=192.168.88.1/24")).toBe("missing value(s) of argument(s) interface");
    expect(cli.execute("/ip address add address=300.1.1.1/24 interface=ether2")).toBe("invalid value for argument address");
    expect(cli.execute("/ip address add address=192.168.88.1/33 interface=ether2")).toBe(
      "invalid value for argument address",
    );
    // The network and the broadcast address are not host addresses.
    expect(
      cli.execute("/ip address add address=192.168.88.0/24 interface=ether2").startsWith("invalid value for argument address"),
    ).toBe(true);
    expect(
      cli
        .execute("/ip address add address=192.168.88.255/24 interface=ether2")
        .startsWith("invalid value for argument address"),
    ).toBe(true);
    expect(cli.execute("/ip address add address=192.168.88.1/24 interface=ether9")).toBe(
      "input does not match any value of interface",
    );
    // A router has no bridge in NetSketch.
    expect(
      cli
        .execute("/ip address add address=192.168.88.1/24 interface=bridge")
        .startsWith("input does not match any value of interface"),
    ).toBe(true);
    expect(cli.execute("/ip address add address=192.168.88.1/24 interface=ether2 mtu=1500")).toBe(
      "expected end of command (line 1 column 58)",
    );
    expect(cli.execute("/ip address remove 0")).toBe("no such item");
    expect(cli.execute("/ip address remove x")).toBe("input does not match any value of numbers");
    expect(cli.execute("/ip address remove")).toBe("missing value(s) of argument(s) numbers");

    expect(cli.execute("/ip route add dst-address=10.0.2.0/24")).toBe("missing value(s) of argument(s) gateway");
    expect(cli.execute("/ip route add dst-address=10.0.2.0/33 gateway=10.0.0.2")).toBe(
      "invalid value for argument dst-address",
    );
    expect(cli.execute("/ip route add dst-address=10.0.2.0/24 gateway=10.0.0")).toBe("invalid value for argument gateway");
    expect(cli.execute("/ip route add gateway=ether1").startsWith("invalid value for argument gateway\nNetSketch:")).toBe(
      true,
    );
    expect(cli.execute("/ip route remove 0")).toBe("no such item");

    expect(cli.execute("/ping 10.0.0")).toBe("invalid value for argument address");
    expect(cli.execute("/ping")).toBe("missing value(s) of argument(s) address");
    expect(cli.execute("/ping 10.0.0.2 count=0")).toBe("invalid value for argument count");
    expect(cli.execute("/ping 10.0.0.2 count=many")).toBe("invalid value for argument count");
    expect(store.project).toEqual(before);
  });

  test("an address without prefix length is a host route", () => {
    const { store, cli } = makeSession(hapLite);
    expect(cli.execute("/ip address add address=10.1.1.1 interface=ether3").startsWith("NetSketch:")).toBe(true);
    expect(device(store, "R1").addresses.map((entry) => entry.address)).toEqual(["10.1.1.1/32"]);
  });

  test("a duplicate address is reported", () => {
    const { store, sessions } = makeRouters(["R1", "R2"]);
    sessions[0].execute("/ip address add address=10.0.0.1/30 interface=ether1");
    const output = sessions[1].execute("/ip address add address=10.0.0.1/30 interface=ether1");
    expect(output.startsWith("NetSketch:") && output.includes("R1")).toBe(true);
    // Stored all the same, as RouterOS does.
    expect(device(store, "R2").addresses.map((entry) => entry.address)).toEqual(["10.0.0.1/30"]);
  });

  test("a switch address belongs to the bridge", () => {
    const { store, cli } = makeSession(crs, "SW1");
    const before = snapshot(store);
    expect(cli.execute("/ip address add address=192.168.88.2/24 interface=ether1")).toBe(
      "NetSketch: na přepínači nastavte adresu na interface=bridge.",
    );
    expect(store.project).toEqual(before);

    expect(cli.execute("/ip address add address=192.168.88.2/24 interface=bridge")).toBe("");
    expect(device(store, "SW1").addresses).toEqual([{ interface: "vlan:1", address: "192.168.88.2/24" }]);
    expect(cli.execute("/ip address print")).toContain("\n 0   192.168.88.2/24    192.168.88.0    bridge");
    expect(cli.execute("/export")).toContain("add address=192.168.88.2/24 interface=bridge");
    // bridge1 is the same bridge.
    expect(cli.execute("/ip address add address=192.168.88.3/24 interface=bridge1").startsWith("NetSketch:")).toBe(true);
    expect(device(store, "SW1").addresses).toEqual([{ interface: "vlan:1", address: "192.168.88.3/24" }]);
  });

  test("a router pings the switch bridge", () => {
    const store = makeStore();
    const router = store.addDevice(hapLite, { x: 100, y: 100 }, "R1");
    const sw = store.addDevice(crs, { x: 300, y: 100 }, "SW1");
    store.connect(ref(store, "R1", "ether2"), ref(store, "SW1", "ether5"));
    new CLISession(store, sw.id).execute("/ip address add address=192.168.88.2/24 interface=bridge");
    const cli = new CLISession(store, router.id);
    cli.execute("/ip address add address=192.168.88.1/24 interface=ether2");
    expect(cli.execute("/ping 192.168.88.2 count=1")).toContain("sent=1 received=1 packet-loss=0%");
    const routes = new CLISession(store, sw.id).execute("/ip route print");
    expect(routes).toContain("ADC  192.168.88.0/24    192.168.88.2    bridge");
  });
});

describe("RouterOS /ip route", () => {
  test("add, print and remove routes", () => {
    const { store, sessions } = makeRouters(["R1", "R2"]);
    store.connect(ref(store, "R1", "ether1"), ref(store, "R2", "ether1"));
    const cli = sessions[0];
    cli.execute("/ip address add address=10.0.12.1/30 interface=ether1");
    sessions[1].execute("/ip address add address=10.0.12.2/30 interface=ether1");

    expect(cli.execute("/ip route add dst-address=10.0.2.0/24 gateway=10.0.12.2")).toBe("");
    expect(cli.execute("/ip route add gateway=10.0.12.2")).toBe("");
    // Stored even though the gateway is not on a connected network (yet).
    expect(cli.execute("/ip route add dst-address=172.16.0.0/16 gateway=192.168.5.1").startsWith("NetSketch:")).toBe(true);
    // Host bits of the destination are dropped.
    expect(cli.execute("/ip route add dst-address=10.0.3.7/24 gateway=10.0.12.2")).toBe("");
    expect(cli.execute("/ip route add dst-address=10.0.3.0/24 gateway=10.0.12.2")).toBe("failure: already have such route");
    expect(device(store, "R1").staticRoutes).toEqual([
      { destination: "10.0.2.0/24", nextHop: "10.0.12.2" },
      { destination: "0.0.0.0/0", nextHop: "10.0.12.2" },
      { destination: "172.16.0.0/16", nextHop: "192.168.5.1" },
      { destination: "10.0.3.0/24", nextHop: "10.0.12.2" },
    ]);

    const listing = cli.execute("/ip route print").split("\n");
    expect(listing.length).toBe(8);
    expect(listing[0]).toBe("Flags: X - disabled, A - active, D - dynamic, C - connect, S - static");
    expect(listing[1]).toBe(" #      DST-ADDRESS        PREF-SRC        GATEWAY            DISTANCE");
    expect(listing[2]).toBe(" 0 ADC  10.0.12.0/30       10.0.12.1       ether1                    0");
    expect(listing[3]).toBe(" 1 A S  10.0.2.0/24                        10.0.12.2                 1");
    expect(listing[4].startsWith(" 2 A S  0.0.0.0/0 ")).toBe(true);
    expect(listing[5].startsWith(" 3 A S  10.0.3.0/24 ")).toBe(true);
    // The inactive route comes last, without the A flag.
    expect(listing[6]).toBe(" 4   S  172.16.0.0/16                      192.168.5.1               1");
    expect(listing[7].startsWith("NetSketch:")).toBe(true);

    const exported = cli.execute("/ip route export");
    expect(exported).toContain(
      "/ip route\nadd dst-address=10.0.2.0/24 gateway=10.0.12.2\nadd dst-address=0.0.0.0/0 gateway=10.0.12.2",
    );
    expect(exported).not.toContain("/ip address");
    expect(cli.execute("/export")).toContain("add dst-address=172.16.0.0/16 gateway=192.168.5.1");

    // A connected route cannot be removed; nothing changes then.
    const before = snapshot(store);
    expect(cli.execute("/ip route remove 0,1").startsWith("failure: cannot remove dynamic route")).toBe(true);
    expect(store.project).toEqual(before);

    // Numbers as printed: 1 = 10.0.2.0/24, 4 = the inactive 172.16.0.0/16.
    expect(cli.execute("/ip route remove 1,4")).toBe("");
    expect(device(store, "R1").staticRoutes).toEqual([
      { destination: "0.0.0.0/0", nextHop: "10.0.12.2" },
      { destination: "10.0.3.0/24", nextHop: "10.0.12.2" },
    ]);
    expect(store.undo()).toBe(true);
    expect(store.project).toEqual(before);
  });

  test("a default gateway set outside RouterOS shows as a static default route", () => {
    const { store, sessions } = makeRouters(["R1", "R2"]);
    store.connect(ref(store, "R1", "ether1"), ref(store, "R2", "ether1"));
    const cli = sessions[0];
    cli.execute("/ip address add address=10.0.12.1/30 interface=ether1");
    store.setDefaultGateway(device(store, "R1").id, "10.0.12.2");
    const listing = cli.execute("/ip route print").split("\n");
    expect(listing[3]).toBe(" 1 A S  0.0.0.0/0                          10.0.12.2                 1");
    expect(cli.execute("/ip route export")).toContain("/ip route\nadd dst-address=0.0.0.0/0 gateway=10.0.12.2");
    expect(cli.execute("/ip route remove 1")).toBe("");
    expect(device(store, "R1").defaultGateway).toBe("");
  });
});

describe("RouterOS /ping", () => {
  test("ping between two cabled routers", () => {
    const { store, sessions } = makeRouters(["R1", "R2"]);
    store.connect(ref(store, "R1", "ether1"), ref(store, "R2", "ether1"));
    sessions[0].execute("/ip address add address=10.0.0.1/30 interface=ether1");
    sessions[1].execute("/ip address add address=10.0.0.2/30 interface=ether1");

    const lines = sessions[0].execute("/ping 10.0.0.2").split("\n");
    expect(lines).toEqual([
      "  SEQ HOST                                     SIZE TTL TIME       STATUS",
      "    0 10.0.0.2                                   56  64 0ms",
      "    1 10.0.0.2                                   56  64 0ms",
      "    2 10.0.0.2                                   56  64 0ms",
      "    3 10.0.0.2                                   56  64 0ms",
      "    sent=4 received=4 packet-loss=0% min-rtt=0ms avg-rtt=0ms max-rtt=0ms",
    ]);
    const back = sessions[1].execute("/ping address=10.0.0.1 count=2");
    expect(back).toContain("sent=2 received=2 packet-loss=0%");
    expect(back).not.toContain("NetSketch:");
    // At most 20 packets, with a notice.
    const many = sessions[1].execute("/ping 10.0.0.1 count=50");
    expect(many).toContain("sent=20 received=20");
    expect(many.endsWith(".") && many.includes("NetSketch:")).toBe(true);
  });

  test("ping without a cable fails with an explanation", () => {
    const { sessions } = makeRouters(["R1", "R2"]);
    sessions[0].execute("/ip address add address=10.0.0.1/30 interface=ether1");
    sessions[1].execute("/ip address add address=10.0.0.2/30 interface=ether1");

    const lines = sessions[0].execute("/ping 10.0.0.2 count=2").split("\n");
    expect(lines.length).toBe(5);
    expect(lines[1]).toBe("    0 10.0.0.2                                                   timeout");
    expect(lines[3]).toBe("    sent=2 received=0 packet-loss=100%");
    expect(lines[4].startsWith("NetSketch:")).toBe(true);
  });

  test("ping across a third router needs static routes", () => {
    const { store, sessions } = makeRouters(["R1", "R2", "R3"]);
    store.connect(ref(store, "R1", "ether1"), ref(store, "R2", "ether1"));
    store.connect(ref(store, "R2", "ether2"), ref(store, "R3", "ether1"));
    const [r1, r2, r3] = sessions;
    r1.execute("/ip address add address=10.0.12.1/30 interface=ether1");
    r2.execute("/ip address add address=10.0.12.2/30 interface=ether1");
    r2.execute("/ip address add address=10.0.23.1/30 interface=ether2");
    r3.execute("/ip address add address=10.0.23.2/30 interface=ether1");

    // Without routes R1 does not know the far network.
    const failed = r1.execute("/ping 10.0.23.2 count=1");
    expect(failed).toContain("packet-loss=100%");
    expect(failed).toContain("NetSketch:");

    expect(r1.execute("/ip route add dst-address=10.0.23.0/30 gateway=10.0.12.2")).toBe("");
    // The request arrives now, the reply does not: R3 has no way back yet.
    expect(r1.execute("/ping 10.0.23.2 count=1")).toContain("packet-loss=100%");
    expect(r3.execute("/ip route add dst-address=10.0.12.0/30 gateway=10.0.23.1")).toBe("");

    const output = r1.execute("/ping 10.0.23.2 count=1");
    expect(output).toContain("    0 10.0.23.2                                  56  63 0ms");
    expect(output).toContain("sent=1 received=1 packet-loss=0%");
    expect(r3.execute("/ping 10.0.12.1 count=1")).toContain("received=1");
  });
});

describe("RouterOS undo, help and completion", () => {
  test("each command is one undo step", () => {
    const { store, cli } = makeSession(hapLite);
    const before = snapshot(store);
    cli.execute("/ip address add address=192.168.88.1/24 interface=ether2");
    expect(store.project).not.toEqual(before);
    expect(store.undo()).toBe(true);
    expect(store.project).toEqual(before);

    cli.execute("/ip address add address=192.168.88.1/24 interface=ether2");
    cli.execute("/ip address add address=10.0.0.1/30 interface=ether1");
    const twoAddresses = snapshot(store);
    cli.execute("/ip address remove 0,1");
    expect(device(store, "R1").addresses).toEqual([]);
    expect(store.undo()).toBe(true);
    expect(store.project).toEqual(twoAddresses);
  });

  test("help and completion", () => {
    const { cli } = makeSession(hapLite);
    expect(cli.complete("/ip ad")).toEqual(["address"]);
    expect(cli.complete("/ip r")).toEqual(["route"]);
    expect(cli.complete("/pi")).toEqual(["ping"]);
    expect(cli.help("")).toContain("ip -- IP options");
    expect(cli.help("/ip address ")).toContain("add -- Create a new item");
    expect(cli.help("/ip address add ")).toContain("interface= -- Interface name");
    expect(cli.complete("/ip address add addr")).toEqual(["address="]);
    const names = cli.complete("/ip address add address=10.0.0.1/24 interface=eth");
    expect(names.includes("interface=ether1") && !names.includes("interface=wlan1")).toBe(true);
    expect(cli.complete("/ip route add g")).toEqual(["gateway="]);
    expect(cli.complete("/ip route add d")).toEqual(["dst-address="]);
    expect(cli.complete("/ping 10.0.0.1 c")).toEqual(["count="]);

    cli.execute("/ip address add address=192.168.88.1/24 interface=ether2");
    expect(cli.help("/ip address remove ")).toContain("0 -- 192.168.88.1/24 ether2");

    const switchSession = makeSession(crs, "SW1").cli;
    expect(switchSession.complete("/ip address add interface=")).toEqual(["interface=bridge"]);
  });
});
