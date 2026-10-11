// Port of HostConsoleTests (Tests/NetSketchCLITests/NetworkTests.swift), plus checks of the
// exact Windows-style output of the PC command prompt.

import type { Device, Port, PortRef } from "../../src/core/model";
import { PortNaming } from "../../src/core/port-naming";
import { ProjectStore } from "../../src/core/store";
import { CLISession } from "../../src/cli/session";

const pcTemplate = "generic-pc";
const c2960 = "cisco-catalyst-2960-24";
const isr4321 = "cisco-isr-4321";

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

/** Two devices named A and B, cabled `portA` - `portB`, with a console on each. */
function pair(templateA: string, portA: string, templateB: string, portB: string) {
  const store = makeStore();
  const a = store.addDevice(templateA, { x: 0, y: 0 }, "A");
  const b = store.addDevice(templateB, { x: 600, y: 0 }, "B");
  store.connect(ref(store, "A", portA), ref(store, "B", portB));
  return { store, a: new CLISession(store, a.id), b: new CLISession(store, b.id) };
}

describe("host console", () => {
  test("prompt and adapters", () => {
    const { store, a: pc } = pair(pcTemplate, "eth0", c2960, "Fa0/3");
    expect(pc.dialect).toBe("host");
    expect(pc.prompt).toBe("C:\\>");
    let ipconfig = pc.execute("ipconfig");
    expect(ipconfig).toContain("Ethernet adapter eth0:");
    expect(ipconfig).toContain("Media connected");
    expect(ipconfig).toContain("B Fa0/3");
    expect(ipconfig).toContain("0.0.0.0");

    expect(pc.execute("netsh interface ip set address eth0 static 10.1.1.5 255.255.255.0 10.1.1.1")).toBe("Ok.");
    const added = device(store, "A");
    expect(added.addresses[0]?.address).toBe("10.1.1.5/24");
    expect(added.defaultGateway).toBe("10.1.1.1");
    ipconfig = pc.execute("ipconfig");
    expect(ipconfig).toContain("10.1.1.5");
    expect(ipconfig).toContain("255.255.255.0");
    expect(ipconfig).toContain("10.1.1.1");
    expect(pc.execute("netsh interface ip set address eth0 static 10.1.1.6 255.255.255.0 10.2.2.2")).toContain(
      "not in the network",
    );
    expect(pc.execute("dir")).toBe("Invalid Command.");
    expect(pc.complete("ip")).toEqual(["ipconfig"]);
    expect(pc.help("")).toContain("ping");
    pc.execute("exit");
    expect(pc.isClosed).toBe(true);
  });

  test("ping without an address explains why", () => {
    const { a: pc } = pair(pcTemplate, "eth0", pcTemplate, "eth0");
    const output = pc.execute("ping 10.0.0.2");
    expect(output).toContain("Request timed out.");
    expect(output).toContain("NetSketch:");
  });

  test("ipconfig uses the dotted Windows layout", () => {
    const { a: pc } = pair(pcTemplate, "eth0", c2960, "Fa0/1");
    pc.execute("netsh interface ip set address eth0 static 192.168.10.101 255.255.255.0");
    expect(pc.execute("ipconfig")).toBe(
      [
        "",
        "Ethernet adapter eth0:",
        "",
        "   Media State . . . . . . . . . . . : Media connected",
        "   Cabled to . . . . . . . . . . . . : B Fa0/1",
        "   IPv4 Address . . . . . . . . . .  : 192.168.10.101",
        "   Subnet Mask . . . . . . . . . . . : 255.255.255.0",
        "   Default Gateway . . . . . . . . . : 0.0.0.0",
      ].join("\n"),
    );
    const all = pc.execute("ipconfig /all").split("\n");
    expect(all).toContain("   Connector . . . . . . . . . . . . : RJ45");
    expect(pc.execute("ipconfig /bogus")).toBe('Error: unrecognized or incomplete command line option "/bogus".');
  });

  test("ping output follows Windows", () => {
    const { a: pc, b: other } = pair(pcTemplate, "eth0", pcTemplate, "eth0");
    pc.execute("netsh interface ip set address eth0 static 10.0.0.1 255.255.255.0");
    other.execute("netsh interface ip set address eth0 static 10.0.0.2 255.255.255.0");
    expect(pc.execute("ping -n 2 10.0.0.2")).toBe("Ping request could not find host 2. Please check the name and try again.");
    expect(pc.execute("ping 10.0.0.2 -n 2")).toBe(
      [
        "",
        "Pinging 10.0.0.2 with 32 bytes of data:",
        "",
        "Reply from 10.0.0.2: bytes=32 time<1ms TTL=128",
        "Reply from 10.0.0.2: bytes=32 time<1ms TTL=128",
        "",
        "Ping statistics for 10.0.0.2:",
        "    Packets: Sent = 2, Received = 2, Lost = 0 (0% loss),",
        "Approximate round trip times in milli-seconds:",
        "    Minimum = 0ms, Maximum = 0ms, Average = 0ms",
      ].join("\n"),
    );
    const failed = pc.execute("ping 10.0.0.9 -n 1").split("\n");
    expect(failed.slice(3)).toEqual([
      "Request timed out.",
      "",
      "Ping statistics for 10.0.0.9:",
      "    Packets: Sent = 1, Received = 0, Lost = 1 (100% loss),",
      "NetSketch: požadavek nedošel – A nenašel 10.0.0.9 ve své síti (zkontrolujte kabel, shutdown, VLAN a adresy).",
    ]);
    expect(pc.execute("ping")).toBe("Usage: ping [-n count] target_name");
    expect(pc.execute("ping host")).toBe("Ping request could not find host host. Please check the name and try again.");
  });

  test("a router without a route answers destination host unreachable", () => {
    const { store, a: pc } = pair(pcTemplate, "eth0", isr4321, "Gi0/0/0");
    pc.execute("netsh interface ip set address eth0 static 192.168.1.10 255.255.255.0 192.168.1.1");
    store.setAddress(device(store, "B").id, `port:${port(store, "B", "Gi0/0/0").id}`, "192.168.1.1/24");
    expect(device(store, "B").addresses.map((entry) => entry.address)).toEqual(["192.168.1.1/24"]);
    const output = pc.execute("ping 10.9.9.9 -n 1").split("\n");
    expect(output[3]).toBe("Reply from 192.168.1.1: Destination host unreachable.");
    // A router is 255 hops away from its TTL, a PC 128.
    expect(pc.execute("ping 192.168.1.1 -n 1")).toContain("Reply from 192.168.1.1: bytes=32 time<1ms TTL=255");
    const trace = pc.execute("tracert 10.9.9.9").split("\n");
    expect(trace).toEqual([
      "",
      "Tracing route to 10.9.9.9 over a maximum of 30 hops:",
      "",
      "  1   0 ms      0 ms      0 ms      192.168.1.1",
      "  2   *         *         *         Request timed out.",
      "NetSketch: požadavek nedošel – B nemá trasu do sítě s adresou 10.9.9.9 (chybí statická trasa nebo výchozí brána).",
    ]);
  });

  test("netsh variants and errors", () => {
    const { store, a: pc } = pair(pcTemplate, "eth0", c2960, "Fa0/1");
    expect(pc.execute("netsh")).toBe(
      "Usage: netsh interface ip set address <adapter> static <address> <mask> [<gateway>]\n" +
        "       netsh interface ip set address <adapter> dhcp",
    );
    expect(pc.execute("netsh interface ip set address eth9 static 10.0.0.1 255.0.0.0")).toBe(
      'The interface "eth9" was not found. Adapters: eth0',
    );
    // DHCP is on, but no server answers in this network (see test/features/dhcp.test.ts).
    const dhcp = pc.execute("netsh interface ip set address eth0 dhcp");
    expect(dhcp.startsWith("Ok.\nNetSketch: DHCP je zapnuto")).toBe(true);
    expect(pc.execute("netsh interface ip set address eth0 static 10.0.0.0 255.255.255.0")).toBe(
      "The parameter is incorrect: 10.0.0.0 255.255.255.0",
    );
    expect(
      pc.execute('netsh interface ipv4 set address name="eth0" source=static address=10.0.0.5 mask=255.255.255.0 gateway=10.0.0.1'),
    ).toBe("Ok.");
    expect(device(store, "A").addresses.map((entry) => entry.address)).toEqual(["10.0.0.5/24"]);
    expect(device(store, "A").defaultGateway).toBe("10.0.0.1");
    // The CIDR form works too, without a gateway the old one stays.
    expect(pc.execute("netsh interface ip set address eth0 static 10.0.0.6/24 x")).toBe("Ok.");
    expect(device(store, "A").addresses.map((entry) => entry.address)).toEqual(["10.0.0.6/24"]);
    expect(device(store, "A").defaultGateway).toBe("10.0.0.1");
  });

  test("a duplicate address is reported", () => {
    const { a: pc, b: other } = pair(pcTemplate, "eth0", pcTemplate, "eth0");
    pc.execute("netsh interface ip set address eth0 static 10.0.0.1 255.255.255.0");
    expect(other.execute("netsh interface ip set address eth0 static 10.0.0.1 255.255.255.0")).toBe(
      "NetSketch: adresu 10.0.0.1 už používá i A. Ping na ni nemusí dojít tam, kam čekáte.",
    );
  });

  test("help, completion and small commands", () => {
    const { store, a: pc } = pair(pcTemplate, "eth0", c2960, "Fa0/1");
    expect(pc.help("p")).toBe("  ping  Send echo messages");
    expect(pc.help("ping ")).toBe("NetSketch: k parametrům příkazů není nápověda, zkuste „help“.");
    expect(pc.help("x")).toBe("Invalid Command.");
    expect(pc.execute("tr?")).toBe("  tracert  Trace the route to a destination");
    expect(pc.complete("")).toEqual([...pc.complete("")].sort());
    expect(pc.complete("n")).toEqual(["netsh", "netstat", "nslookup"]);
    expect(pc.complete("ping ")).toEqual([]);
    expect(pc.execute("hostname")).toBe("A");
    expect(pc.execute("hostname x")).toBe("hostname: too many arguments");
    expect(pc.execute("HOSTNAME")).toBe("A");
    expect(pc.execute("arp -a")).toBe(
      "NetSketch: tento příkaz vyžaduje simulaci sítě, kterou NetSketch zatím nemá. Konzole pracuje jen s daty diagramu, nic se nezměnilo.",
    );
    expect(pc.execute("ver")).toBe(
      "NetSketch Command Prompt (Generic PC)\nNetSketch: verze softwaru, sériová čísla ani uptime nejsou v diagramu uloženy.",
    );
    const help = pc.execute("help").split("\n");
    // The protocol features add commands (Test-NetConnection, ...): the layout adapts to the longest name.
    expect(help[0]).toMatch(/^help {2,}Display the available commands$/);
    expect(help.length).toBeGreaterThanOrEqual(16);
    expect(pc.execute("ipconfig\n\nhostname")).toContain("\nA");
    expect(pc.execute("x".repeat(1001))).toBe(
      "NetSketch: příliš dlouhý řádek (nejvýše 1000 znaků), příkaz nebyl proveden.",
    );
    expect(pc.banner).toBe(
      [
        "NetSketch – konzole zařízení A (Generic PC, dialekt příkazový řádek).",
        "Příkazy upravují data diagramu. Ping a traceroute sledují kabely, VLAN, IP adresy a statické trasy; dynamické protokoly (STP, OSPF, DHCP) se nesimulují.",
        "Nápověda: ?   Doplnění příkazu: Tab",
      ].join("\n"),
    );
    store.removeDevices([device(store, "A").id]);
    expect(pc.execute("ipconfig")).toBe("NetSketch: zařízení už v projektu neexistuje, konzole je ukončena.");
    expect(pc.isClosed).toBe(true);
  });
});
