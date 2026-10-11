// Realism: round-trip times, packet loss, TTL and the packet trace events of ping / traceroute.

import type { Device, Link, PortRef } from "../../src/core/model";
import { PortNaming } from "../../src/core/port-naming";
import { ProjectStore } from "../../src/core/store";
import { CLISession } from "../../src/cli/session";
import { unitHash } from "../../src/cli/features/realism/timing";
import { NetworkRuntime } from "../../src/cli/sim/runtime";
import { onPacketTrace, type PacketTrace } from "../../src/cli/sim/trace-events";

const isr = "cisco-isr-4321";
const hap = "mikrotik-hap-lite";
const pcTemplate = "generic-pc";

function device(store: ProjectStore, hostname: string): Device {
  const found = store.project.devices.find((item) => item.hostname === hostname);
  if (!found) throw new Error(`missing device ${hostname}`);
  return found;
}

function ref(store: ProjectStore, hostname: string, name: string): PortRef {
  const owner = device(store, hostname);
  const found =
    owner.ports.find((item) => item.name === name) ??
    owner.ports.find((item) => PortNaming.shortName(item.name) === name);
  if (!found) throw new Error(`missing port ${hostname} ${name}`);
  return { deviceID: owner.id, portID: found.id };
}

/** The cable between two devices (first one found). */
function cable(store: ProjectStore, a: string, b: string): Link {
  const ids = [device(store, a).id, device(store, b).id];
  const found = store.project.links.find((link) => ids.includes(link.a.deviceID) && ids.includes(link.b.deviceID));
  if (!found) throw new Error(`no cable ${a} - ${b}`);
  return found;
}

interface Lab {
  store: ProjectStore;
  pc1: CLISession;
  pc2: CLISession;
  r1: CLISession;
  r2: CLISession;
}

/** PC1 - R1 - R2 - PC2 with addresses and static routes; R1 and R2 are Cisco routers. */
function ciscoLab(): Lab {
  NetworkRuntime.reset();
  const store = new ProjectStore();
  store.snapToGrid = false;
  const sessions: Record<string, CLISession> = {};
  for (const [name, template] of [
    ["PC1", pcTemplate],
    ["R1", isr],
    ["R2", isr],
    ["PC2", pcTemplate],
  ] as const) {
    const added = store.addDevice(template, { x: 0, y: 0 }, name);
    sessions[name] = new CLISession(store, added.id);
  }
  store.connect(ref(store, "PC1", "eth0"), ref(store, "R1", "Gi0/0/0"));
  store.connect(ref(store, "R1", "Gi0/0/1"), ref(store, "R2", "Gi0/0/0"));
  store.connect(ref(store, "R2", "Gi0/0/1"), ref(store, "PC2", "eth0"));
  const configure = (cli: CLISession, ...lines: string[]) => {
    for (const line of ["enable", "configure terminal", ...lines, "end"]) cli.execute(line);
  };
  configure(
    sessions.R1,
    "interface gi0/0/0",
    "ip address 10.0.1.1 255.255.255.0",
    "interface gi0/0/1",
    "ip address 10.0.12.1 255.255.255.252",
    "exit",
    "ip route 10.0.2.0 255.255.255.0 10.0.12.2",
  );
  configure(
    sessions.R2,
    "interface gi0/0/0",
    "ip address 10.0.12.2 255.255.255.252",
    "interface gi0/0/1",
    "ip address 10.0.2.1 255.255.255.0",
    "exit",
    "ip route 10.0.1.0 255.255.255.0 10.0.12.1",
  );
  sessions.PC1.execute("netsh interface ip set address eth0 static 10.0.1.10 255.255.255.0 10.0.1.1");
  sessions.PC2.execute("netsh interface ip set address eth0 static 10.0.2.10 255.255.255.0 10.0.2.1");
  return { store, pc1: sessions.PC1, pc2: sessions.PC2, r1: sessions.R1, r2: sessions.R2 };
}

/** Two MikroTik routers on one cable, 10.0.0.1 and 10.0.0.2. */
function routerOSPair() {
  NetworkRuntime.reset();
  const store = new ProjectStore();
  store.snapToGrid = false;
  const a = store.addDevice(hap, { x: 0, y: 0 }, "M1");
  const b = store.addDevice(hap, { x: 300, y: 0 }, "M2");
  store.connect(ref(store, "M1", "ether1"), ref(store, "M2", "ether1"));
  const m1 = new CLISession(store, a.id);
  const m2 = new CLISession(store, b.id);
  m1.execute("/ip address add address=10.0.0.1/30 interface=ether1");
  m2.execute("/ip address add address=10.0.0.2/30 interface=ether1");
  return { store, m1, m2 };
}

/** All trace events announced while `body` runs. */
function traces(body: () => void): PacketTrace[] {
  const seen: PacketTrace[] = [];
  const stop = onPacketTrace((trace) => seen.push(trace));
  try {
    body();
  } finally {
    stop();
  }
  return seen;
}

function linkIDs(segments: PacketTrace["forward"]): string[] {
  return segments.flatMap((segment) => segment.links.map((step) => step.linkID));
}

describe("without delay or loss the outputs stay as they were", () => {
  test("IOS, Windows and RouterOS print the classic numbers", () => {
    const lab = ciscoLab();
    lab.r1.execute("enable");
    expect(lab.r1.execute("ping 10.0.2.10")).toContain(
      "Success rate is 100 percent (5/5), round-trip min/avg/max = 1/1/1 ms",
    );
    expect(lab.r1.execute("traceroute 10.0.2.10")).toContain("  1 10.0.12.2 0 msec 0 msec 0 msec");
    const windows = lab.pc1.execute("ping 10.0.2.10 -n 2").split("\n");
    expect(windows.slice(3, 5)).toEqual([
      "Reply from 10.0.2.10: bytes=32 time<1ms TTL=126",
      "Reply from 10.0.2.10: bytes=32 time<1ms TTL=126",
    ]);
    expect(windows[windows.length - 1]).toBe("    Minimum = 0ms, Maximum = 0ms, Average = 0ms");
    expect(lab.pc1.execute("tracert 10.0.2.10")).toContain("  1   0 ms      0 ms      0 ms      10.0.1.1");
    const { m1 } = routerOSPair();
    expect(m1.execute("/ping 10.0.0.2 count=2").split("\n")).toEqual([
      "  SEQ HOST                                     SIZE TTL TIME       STATUS",
      "    0 10.0.0.2                                   56  64 0ms",
      "    1 10.0.0.2                                   56  64 0ms",
      "    sent=2 received=2 packet-loss=0% min-rtt=0ms avg-rtt=0ms max-rtt=0ms",
    ]);
  });

  test("a cable setting that is cleared brings the classic output back", () => {
    const lab = ciscoLab();
    const link = cable(lab.store, "R1", "R2");
    lab.store.setLinkQuality(link.id, { delay: 20, loss: 10 });
    lab.store.setLinkQuality(link.id, {});
    lab.r1.execute("enable");
    expect(lab.r1.execute("ping 10.0.2.10")).toContain("min/avg/max = 1/1/1 ms");
  });
});

describe("delay", () => {
  test("a 20 ms cable gives about 40 ms on IOS", () => {
    const lab = ciscoLab();
    lab.store.setLinkQuality(cable(lab.store, "R1", "R2").id, { delay: 20 });
    lab.r1.execute("enable");
    const output = lab.r1.execute("ping 10.0.2.10");
    expect(output).toContain("!!!!!");
    const match = /round-trip min\/avg\/max = (\d+)\/(\d+)\/(\d+) ms/.exec(output);
    expect(match).not.toBeNull();
    const [min, avg, max] = [Number(match![1]), Number(match![2]), Number(match![3])];
    expect(min).toBeGreaterThanOrEqual(40);
    expect(max).toBeLessThanOrEqual(43);
    expect(min <= avg && avg <= max).toBe(true);
  });

  test("a 20 ms cable gives about 40 ms on Windows, and the first hop of tracert stays fast", () => {
    const lab = ciscoLab();
    lab.store.setLinkQuality(cable(lab.store, "R1", "R2").id, { delay: 20 });
    const lines = lab.pc1.execute("ping 10.0.2.10 -n 3").split("\n");
    for (const line of lines.slice(3, 6)) {
      expect(line).toMatch(/^Reply from 10\.0\.2\.10: bytes=32 time=4[0-3]ms TTL=126$/);
    }
    expect(lines[lines.length - 1]).toMatch(/^ {4}Minimum = 4[0-3]ms, Maximum = 4[0-3]ms, Average = 4[0-3]ms$/);

    const trace = lab.pc1.execute("tracert 10.0.2.10").split("\n");
    expect(trace[3]).toMatch(/^ {2}1 {3}<1 ms {5}<1 ms {5}<1 ms {5}10\.0\.1\.1$/);
    expect(trace[4]).toMatch(/^ {2}2 {3}4[0-3] ms {5}4[0-3] ms {5}4[0-3] ms {5}10\.0\.12\.2$/);
    expect(trace[5]).toMatch(/^ {2}3 {3}4[0-3] ms {5}4[0-3] ms {5}4[0-3] ms {5}10\.0\.2\.10$/);
    expect(trace[trace.length - 1]).toBe("Trace complete.");
  });

  test("IOS traceroute shows the time per hop", () => {
    const lab = ciscoLab();
    lab.store.setLinkQuality(cable(lab.store, "R1", "R2").id, { delay: 20 });
    lab.r1.execute("enable");
    const lines = lab.r1.execute("traceroute 10.0.2.10").split("\n");
    expect(lines[3]).toMatch(/^ {2}1 10\.0\.12\.2 4[0-3] msec 4[0-3] msec 4[0-3] msec$/);
    expect(lines[4]).toMatch(/^ {2}2 10\.0\.2\.10 4[0-3] msec 4[0-3] msec 4[0-3] msec$/);
  });

  test("RouterOS shows the time per row and in the summary", () => {
    const { store, m1 } = routerOSPair();
    store.setLinkQuality(store.project.links[0].id, { delay: 12 });
    const lines = m1.execute("/ping 10.0.0.2 count=3").split("\n");
    expect(lines.length).toBe(5);
    for (const row of lines.slice(1, 4)) expect(row).toMatch(/^ +\d 10\.0\.0\.2 +56 +64 2[4-5]ms(\d+us)?$/);
    expect(lines[4]).toMatch(
      /^ {4}sent=3 received=3 packet-loss=0% min-rtt=2[4-5]ms avg-rtt=2[4-5]ms max-rtt=2[4-5]ms$/,
    );
  });

  test("the same commands give the same numbers after a reset, and the next run differs", () => {
    const lab = ciscoLab();
    lab.store.setLinkQuality(cable(lab.store, "R1", "R2").id, { delay: 20 });
    const first = lab.pc1.execute("ping 10.0.2.10 -n 8");
    const second = lab.pc1.execute("ping 10.0.2.10 -n 8");
    NetworkRuntime.reset();
    expect(lab.pc1.execute("ping 10.0.2.10 -n 8")).toBe(first);
    expect(second).not.toBe(first);
  });

  test("a cable without a delay uses a tiny default: the ping stays under a millisecond", () => {
    const lab = ciscoLab();
    // Only a loss is set, so the timing is active but every time comes from the defaults.
    lab.store.setLinkQuality(cable(lab.store, "R1", "R2").id, { loss: 1 });
    const lines = lab.pc1.execute("ping 10.0.2.10 -n 3").split("\n");
    expect(lines.slice(3, 6).every((line) => line.includes("time<1ms") || line === "Request timed out.")).toBe(true);
  });
});

describe("loss", () => {
  test("100 % loss times out every echo on all three consoles", () => {
    const lab = ciscoLab();
    lab.store.setLinkQuality(cable(lab.store, "R1", "R2").id, { loss: 100 });
    lab.r1.execute("enable");
    const ios = lab.r1.execute("ping 10.0.2.10").split("\n");
    expect(ios[2]).toBe(".....");
    expect(ios[3]).toBe("Success rate is 0 percent (0/5)");
    expect(ios[4]).toBe("NetSketch: všechny pakety se ztratily na kabelu R1 Gi0/0/1 – R2 Gi0/0/0 (ztrátovost 100 %).");

    const windows = lab.pc1.execute("ping 10.0.2.10 -n 3").split("\n");
    expect(windows.slice(3, 6)).toEqual(["Request timed out.", "Request timed out.", "Request timed out."]);
    expect(windows).toContain("    Packets: Sent = 3, Received = 0, Lost = 3 (100% loss),");
    expect(windows.some((line) => line.startsWith("Approximate round trip times"))).toBe(false);

    const { store, m1 } = routerOSPair();
    store.setLinkQuality(store.project.links[0].id, { loss: 100 });
    const ros = m1.execute("/ping 10.0.0.2 count=2").split("\n");
    expect(ros[1]).toBe("    0 10.0.0.2                                                   timeout");
    expect(ros[2]).toBe("    1 10.0.0.2                                                   timeout");
    expect(ros[3]).toBe("    sent=2 received=0 packet-loss=100%");
  });

  test("50 % loss gives a repeatable pattern with a summary that counts the losses", () => {
    const lab = ciscoLab();
    lab.store.setLinkQuality(cable(lab.store, "R1", "R2").id, { loss: 50 });
    lab.r1.execute("enable");
    const first = lab.r1.execute("ping 10.0.2.10 repeat 100").split("\n");
    const marks = first[2];
    expect(marks).toHaveLength(100);
    // Both directions cross the lossy cable, so about a quarter of the echoes come back.
    const received = [...marks].filter((mark) => mark === "!").length;
    expect(received).toBeGreaterThan(4);
    expect(received).toBeLessThan(55);
    expect(first[3].startsWith(`Success rate is ${received} percent (${received}/100), round-trip`)).toBe(true);
    NetworkRuntime.reset();
    expect(lab.r1.execute("ping 10.0.2.10 repeat 100").split("\n")[2]).toBe(marks);
    // The next run of the same command draws different numbers.
    expect(lab.r1.execute("ping 10.0.2.10 repeat 100").split("\n")[2]).not.toBe(marks);
  });

  test("Windows and RouterOS show the lost echoes in place", () => {
    const lab = ciscoLab();
    lab.store.setLinkQuality(cable(lab.store, "R1", "R2").id, { loss: 50 });
    const lines = lab.pc1.execute("ping 10.0.2.10 -n 50").split("\n");
    const replies = lines.slice(3, 53);
    const timedOut = replies.filter((line) => line === "Request timed out.").length;
    expect(timedOut).toBeGreaterThan(0);
    expect(timedOut).toBeLessThan(50);
    expect(replies.filter((line) => line.startsWith("Reply from")).length).toBe(50 - timedOut);
    expect(lines).toContain(
      `    Packets: Sent = 50, Received = ${50 - timedOut}, Lost = ${timedOut} (${timedOut * 2}% loss),`,
    );

    const { store, m1 } = routerOSPair();
    store.setLinkQuality(store.project.links[0].id, { loss: 30 });
    const ros = m1.execute("/ping 10.0.0.2 count=20").split("\n");
    const rows = ros.slice(1, 21);
    const lost = rows.filter((row) => row.endsWith("timeout")).length;
    expect(lost).toBeGreaterThan(0);
    expect(lost).toBeLessThan(20);
    expect(ros[21].startsWith(`    sent=20 received=${20 - lost} packet-loss=${lost * 5}% min-rtt=`)).toBe(true);
  });

  test("a lost traceroute probe prints a star", () => {
    const lab = ciscoLab();
    lab.store.setLinkQuality(cable(lab.store, "R1", "R2").id, { loss: 100 });
    lab.r1.execute("enable");
    const lines = lab.r1.execute("traceroute 10.0.2.10").split("\n");
    expect(lines.slice(3)).toEqual([
      "  1  *  *  *",
      "  2  *  *  *",
      "NetSketch: všechny sondy se ztratily na kabelu R1 Gi0/0/1 – R2 Gi0/0/0 (ztrátovost 100 %).",
    ]);
    const windows = lab.pc1.execute("tracert 10.0.2.10").split("\n");
    expect(windows[3]).toMatch(/^ {2}1 {3}(<1|\d+) ms/);
    expect(windows[4]).toBe("  2   *         *         *         Request timed out.");
    expect(windows).not.toContain("Trace complete.");
  });
});

describe("TTL", () => {
  test("the TTL of a Windows reply drops by one per router when the timing is active", () => {
    const lab = ciscoLab();
    lab.store.setLinkQuality(cable(lab.store, "PC1", "R1").id, { delay: 5 });
    expect(lab.pc1.execute("ping 10.0.1.1 -n 1")).toContain("TTL=255");
    expect(lab.pc1.execute("ping 10.0.12.2 -n 1")).toContain("TTL=254");
    expect(lab.pc1.execute("ping 10.0.2.1 -n 1")).toContain("TTL=254");
    expect(lab.pc1.execute("ping 10.0.2.10 -n 1")).toContain("TTL=126");
    expect(lab.pc2.execute("ping 10.0.1.10 -n 1")).toContain("TTL=126");
  });

  test("the TTL of a RouterOS reply is 64 minus the routers crossed", () => {
    const { store, m1 } = routerOSPair();
    store.setLinkQuality(store.project.links[0].id, { delay: 3 });
    expect(m1.execute("/ping 10.0.0.2 count=1")).toMatch(/ 56 +64 /);
  });
});

describe("packet trace events", () => {
  test("a successful ping announces the way there and back", () => {
    const lab = ciscoLab();
    const events = traces(() => {
      lab.pc1.execute("ping 10.0.2.10 -n 3");
    });
    expect(events).toHaveLength(1);
    const trace = events[0];
    const links = {
      pc1r1: cable(lab.store, "PC1", "R1").id,
      r1r2: cable(lab.store, "R1", "R2").id,
      r2pc2: cable(lab.store, "R2", "PC2").id,
    };
    expect(trace.kind).toBe("ping");
    expect(trace.deviceID).toBe(device(lab.store, "PC1").id);
    expect(trace.success).toBe(true);
    expect(trace.failedAt).toBeNull();
    expect(trace.forward.map((segment) => [segment.fromDevice, segment.toDevice])).toEqual([
      [device(lab.store, "PC1").id, device(lab.store, "R1").id],
      [device(lab.store, "R1").id, device(lab.store, "R2").id],
      [device(lab.store, "R2").id, device(lab.store, "PC2").id],
    ]);
    expect(linkIDs(trace.forward)).toEqual([links.pc1r1, links.r1r2, links.r2pc2]);
    expect(linkIDs(trace.back)).toEqual([links.r2pc2, links.r1r2, links.pc1r1]);
    expect(trace.back[0].fromDevice).toBe(device(lab.store, "PC2").id);
  });

  test("every console announces its pings and traceroutes once per command", () => {
    const lab = ciscoLab();
    lab.r1.execute("enable");
    const { m1 } = routerOSPair();
    const events = traces(() => {
      lab.r1.execute("ping 10.0.2.10");
      lab.r1.execute("traceroute 10.0.2.10");
      lab.pc1.execute("tracert 10.0.2.10");
      lab.pc1.execute("ping 10.0.2.10");
      m1.execute("/ping 10.0.0.2 count=2");
    });
    expect(events.map((event) => event.kind)).toEqual(["ping", "traceroute", "traceroute", "ping", "ping"]);
    expect(events.every((event) => event.success)).toBe(true);
  });

  test("a ping that a router cannot route fails at that router", () => {
    const lab = ciscoLab();
    const events = traces(() => {
      lab.pc1.execute("ping 10.9.9.9 -n 1");
    });
    expect(events).toHaveLength(1);
    expect(events[0].success).toBe(false);
    expect(events[0].failedAt).toBe(device(lab.store, "R1").id);
    expect(events[0].forward.map((segment) => segment.toDevice)).toEqual([device(lab.store, "R1").id]);
    expect(events[0].back).toEqual([]);
  });

  test("a ping without a cable fails at the sender", () => {
    NetworkRuntime.reset();
    const store = new ProjectStore();
    store.snapToGrid = false;
    const pc = store.addDevice(pcTemplate, { x: 0, y: 0 }, "PC1");
    const cli = new CLISession(store, pc.id);
    cli.execute("netsh interface ip set address eth0 static 10.0.0.1 255.255.255.0");
    const events = traces(() => {
      cli.execute("ping 10.0.0.9 -n 1");
    });
    expect(events).toHaveLength(1);
    expect(events[0].success).toBe(false);
    expect(events[0].failedAt).toBe(pc.id);
    expect(events[0].forward).toEqual([]);
  });

  test("an echo lost on a cable stops at the device before it", () => {
    const lab = ciscoLab();
    lab.store.setLinkQuality(cable(lab.store, "R1", "R2").id, { loss: 100 });
    const events = traces(() => {
      lab.pc1.execute("ping 10.0.2.10 -n 2");
    });
    expect(events).toHaveLength(1);
    expect(events[0].success).toBe(false);
    expect(events[0].failedAt).toBe(device(lab.store, "R1").id);
    expect(linkIDs(events[0].forward)).toEqual([cable(lab.store, "PC1", "R1").id]);
    expect(events[0].back).toEqual([]);
  });

  test("a traceroute announces the path and a failed one the device where it stopped", () => {
    const lab = ciscoLab();
    lab.r1.execute("enable");
    const events = traces(() => {
      lab.r1.execute("traceroute 10.0.2.10");
      lab.r1.execute("traceroute 10.9.9.9");
    });
    expect(events).toHaveLength(2);
    expect(events[0].success).toBe(true);
    expect(linkIDs(events[0].forward)).toEqual([cable(lab.store, "R1", "R2").id, cable(lab.store, "R2", "PC2").id]);
    expect(linkIDs(events[0].back)).toEqual([cable(lab.store, "R2", "PC2").id, cable(lab.store, "R1", "R2").id]);
    expect(events[1].success).toBe(false);
    expect(events[1].failedAt).toBe(device(lab.store, "R1").id);
  });

  test("a broken listener does not break the console", () => {
    const lab = ciscoLab();
    const stop = onPacketTrace(() => {
      throw new Error("broken");
    });
    expect(lab.pc1.execute("ping 10.0.2.10 -n 1")).toContain("Reply from 10.0.2.10");
    stop();
  });
});

describe("pseudo-random numbers", () => {
  test("are deterministic, in [0, 1) and spread out", () => {
    expect(unitHash("a", 1)).toBe(unitHash("a", 1));
    expect(unitHash("a", 1)).not.toBe(unitHash("a", 2));
    const draws = Array.from({ length: 2000 }, (_, index) => unitHash("loss", "dev", index));
    expect(draws.every((value) => value >= 0 && value < 1)).toBe(true);
    const below = draws.filter((value) => value < 0.5).length;
    expect(below).toBeGreaterThan(900);
    expect(below).toBeLessThan(1100);
  });
});
