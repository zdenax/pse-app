// Packet filters: Cisco/Dell access lists, MikroTik firewall filter, TCP probes.

import { readProtocols } from "../../src/core/protocols";
import { ProjectStore } from "../../src/core/store";
import { CLISession } from "../../src/cli/session";
import { device, ref, run } from "../cli/support";

interface Lab {
  store: ProjectStore;
  r1: CLISession;
  r2: CLISession;
  pc: CLISession;
  srv: CLISession;
}

/**
 * PC1 (192.168.1.10) - R1 - R2 - SRV (192.168.2.10), R1/R2 joined by 10.0.12.0/30 with static
 * routes both ways.
 */
function lab(): Lab {
  const store = new ProjectStore();
  store.snapToGrid = false;
  const r1 = store.addDevice("cisco-isr-4321", { x: 0, y: 0 }, "R1");
  const r2 = store.addDevice("cisco-isr-4321", { x: 300, y: 0 }, "R2");
  const pc = store.addDevice("generic-pc", { x: 0, y: 200 }, "PC1");
  const srv = store.addDevice("generic-server", { x: 300, y: 200 }, "SRV");
  store.connect(ref(store, "PC1", "eth0"), ref(store, "R1", "Gi0/0/0"));
  store.connect(ref(store, "R1", "Gi0/0/1"), ref(store, "R2", "Gi0/0/1"));
  store.connect(ref(store, "SRV", "eth0"), ref(store, "R2", "Gi0/0/0"));
  const sessions = {
    r1: new CLISession(store, r1.id),
    r2: new CLISession(store, r2.id),
    pc: new CLISession(store, pc.id),
    srv: new CLISession(store, srv.id),
  };
  run(
    sessions.r1,
    "enable",
    "configure terminal",
    "interface gi0/0/0",
    "ip address 192.168.1.1 255.255.255.0",
    "interface gi0/0/1",
    "ip address 10.0.12.1 255.255.255.252",
    "exit",
    "ip route 192.168.2.0 255.255.255.0 10.0.12.2",
    "end",
  );
  run(
    sessions.r2,
    "enable",
    "configure terminal",
    "interface gi0/0/0",
    "ip address 192.168.2.1 255.255.255.0",
    "interface gi0/0/1",
    "ip address 10.0.12.2 255.255.255.252",
    "exit",
    "ip route 192.168.1.0 255.255.255.0 10.0.12.1",
    "end",
  );
  sessions.pc.execute("netsh interface ip set address eth0 static 192.168.1.10 255.255.255.0 192.168.1.1");
  sessions.srv.execute("netsh interface ip set address eth0 static 192.168.2.10 255.255.255.0 192.168.2.1");
  return { store, ...sessions };
}

describe("standard access lists", () => {
  test("a standard list denies one host on the outbound interface", () => {
    const { store, r1, r2, pc } = lab();
    expect(pc.execute("ping 192.168.2.10")).toContain("Reply from 192.168.2.10");
    run(
      r2,
      "configure terminal",
      "access-list 10 deny host 192.168.1.10",
      "access-list 10 permit any",
      "interface gi0/0/0",
      "ip access-group 10 out",
      "end",
    );
    const blocked = pc.execute("ping 192.168.2.10");
    expect(blocked).toContain("Request timed out.");
    expect(blocked).toContain("NetSketch: požadavek nedošel – R2 zahodil paket:");
    expect(blocked).toContain("access-list 10 na rozhraní Gi0/0/0, směr out");
    expect(blocked).toContain("„10 deny 192.168.1.10“");
    // Another source address is permitted by the second line.
    expect(r1.execute("ping 192.168.2.10")).toContain("Success rate is 100 percent (5/5)");
    expect(device(store, "R2").protocols?.acl?.bindings).toEqual([
      { interface: `port:${device(store, "R2").ports.find((port) => port.name === "Gi0/0/0")?.id}`, direction: "out", list: "10" },
    ]);
  });

  test("a wildcard network and the implicit deny", () => {
    const { r1, r2, pc } = lab();
    run(r1, "configure terminal", "access-list 20 permit 10.0.12.0 0.0.0.3", "interface gi0/0/0", "ip access-group 20 in", "end");
    const blocked = pc.execute("ping 192.168.2.10");
    expect(blocked).toContain("Request timed out.");
    expect(blocked).toContain("access-list 20 na rozhraní Gi0/0/0, směr in");
    expect(blocked).toContain("implicitní deny na konci seznamu");
    // The router's own packets come from 10.0.12.1 and do not pass its ingress list.
    expect(r2.execute("ping 10.0.12.1")).toContain("Success rate is 100 percent (5/5)");
    run(r1, "configure terminal", "access-list 20 permit 192.168.1.0 0.0.0.255", "end");
    expect(pc.execute("ping 192.168.2.10")).toContain("Reply from 192.168.2.10");
  });

  test("a bound list that does not exist (or has no lines) permits everything", () => {
    const { r1, pc } = lab();
    const note = run(r1, "configure terminal", "interface gi0/0/0", "ip access-group NOWHERE in");
    expect(note).toContain("NetSketch: seznam NOWHERE zatím neexistuje");
    expect(pc.execute("ping 192.168.2.10")).toContain("Reply from 192.168.2.10");
    run(r1, "exit", "ip access-list standard NOWHERE", "exit");
    expect(pc.execute("ping 192.168.2.10")).toContain("Reply from 192.168.2.10");
    run(r1, "ip access-list standard NOWHERE", "deny any", "end");
    expect(pc.execute("ping 192.168.2.10")).toContain("R1 zahodil paket");
  });

  test("a router does not filter its own packets with outbound lists", () => {
    const { r1 } = lab();
    run(r1, "configure terminal", "access-list 30 deny any", "interface gi0/0/1", "ip access-group 30 out", "end");
    expect(r1.execute("ping 192.168.2.10")).toContain("Success rate is 100 percent (5/5)");
  });
});

describe("extended access lists", () => {
  test("icmp is blocked, tcp 80 is allowed and checked with Test-NetConnection", () => {
    const { r1, pc } = lab();
    run(
      r1,
      "configure terminal",
      "access-list 101 deny icmp any any echo",
      "access-list 101 permit tcp any any eq www",
      "access-list 101 deny ip any any",
      "interface gi0/0/0",
      "ip access-group 101 in",
      "end",
    );
    const ping = pc.execute("ping 192.168.2.10");
    expect(ping).toContain("Request timed out.");
    expect(ping).toContain("„10 deny icmp any any echo“");

    const web = pc.execute("Test-NetConnection 192.168.2.10 -Port 80");
    expect(web).toContain("ComputerName     : 192.168.2.10");
    expect(web).toContain("RemoteAddress    : 192.168.2.10");
    expect(web).toContain("RemotePort       : 80");
    expect(web).toContain("TcpTestSucceeded : True");
    expect(pc.execute("tnc 192.168.2.10 -Port 80 -InformationLevel Quiet")).toBe("True");

    const ssh = pc.execute("Test-NetConnection 192.168.2.10 -Port 22");
    expect(ssh).toContain("WARNING: TCP connect to (192.168.2.10 : 22) failed");
    expect(ssh).toContain("TcpTestSucceeded       : False");
    expect(ssh).toContain("„30 deny ip any any“");
    expect(pc.execute("telnet 192.168.2.10 22")).toContain("Could not open connection to the host, on port 22");
    expect(pc.execute("telnet 192.168.2.10 80")).toContain("Connecting To 192.168.2.10...");
  });

  test("ping succeeds while a port is closed: PingSucceeded and TcpTestSucceeded differ", () => {
    const { r1, pc } = lab();
    run(r1, "configure terminal", "access-list 102 permit icmp any any", "interface gi0/0/0", "ip access-group 102 in", "end");
    const result = pc.execute("Test-NetConnection 192.168.2.10 -Port 80");
    expect(result).toContain("PingSucceeded          : True");
    expect(result).toContain("TcpTestSucceeded       : False");
    expect(result).not.toContain("Ping to");
    const ping = pc.execute("Test-NetConnection 192.168.2.10");
    expect(ping).toContain("PingSucceeded          : True");
    expect(ping).not.toContain("TcpTestSucceeded");
  });

  test("source and destination ports, port ranges and port names", () => {
    const { r2, pc } = lab();
    run(
      r2,
      "configure terminal",
      "access-list 110 permit tcp host 192.168.1.10 host 192.168.2.10 range 20 21",
      "access-list 110 permit tcp 192.168.1.0 0.0.0.255 any eq telnet 443",
      "access-list 110 permit tcp any any gt 8000",
      "interface gi0/0/1",
      "ip access-group 110 in",
      "end",
    );
    expect(pc.execute("Test-NetConnection 192.168.2.10 -Port 21 -InformationLevel Quiet")).toBe("True");
    expect(pc.execute("Test-NetConnection 192.168.2.10 -Port 22 -InformationLevel Quiet")).toBe("False");
    expect(pc.execute("Test-NetConnection 192.168.2.10 -Port 23 -InformationLevel Quiet")).toBe("True");
    expect(pc.execute("Test-NetConnection 192.168.2.10 -Port 443 -InformationLevel Quiet")).toBe("True");
    expect(pc.execute("Test-NetConnection 192.168.2.10 -Port 8080 -InformationLevel Quiet")).toBe("True");
    expect(pc.execute("Test-NetConnection 192.168.2.10 -Port 8000 -InformationLevel Quiet")).toBe("False");
    // The numbers are stored; IOS prints the names again.
    expect(r2.execute("show access-lists 110")).toContain("10 permit tcp host 192.168.1.10 host 192.168.2.10 range ftp-data ftp");
    expect(r2.execute("show access-lists 110")).toContain("20 permit tcp 192.168.1.0 0.0.0.255 any eq telnet 443");
    // ssh is accepted as a name for 22 and stored as the number.
    run(r2, "configure terminal", "access-list 110 permit tcp any any eq ssh", "end");
    expect(pc.execute("Test-NetConnection 192.168.2.10 -Port 22 -InformationLevel Quiet")).toBe("True");
    expect(r2.execute("show access-lists 110")).toContain("40 permit tcp any any eq 22");
  });

  test("established lets the replies of an outgoing connection in", () => {
    const { r1, pc, srv } = lab();
    run(
      r1,
      "configure terminal",
      "ip access-list extended FROM_OUTSIDE",
      "permit tcp any any established",
      "permit icmp any any echo-reply",
      "exit",
      "interface gi0/0/1",
      "ip access-group FROM_OUTSIDE in",
      "end",
    );
    expect(pc.execute("Test-NetConnection 192.168.2.10 -Port 80 -InformationLevel Quiet")).toBe("True");
    expect(pc.execute("ping 192.168.2.10")).toContain("Reply from 192.168.2.10");
    // The other direction starts a connection: it is not an established one.
    expect(srv.execute("Test-NetConnection 192.168.1.10 -Port 80 -InformationLevel Quiet")).toBe("False");
    const reason = srv.execute("ping 192.168.1.10");
    expect(reason).toContain("implicitní deny na konci seznamu");
    expect(reason).toContain("access-list FROM_OUTSIDE na rozhraní Gi0/0/1, směr in");
  });

  test("the reply can be the packet that is dropped", () => {
    const { r1, pc } = lab();
    run(r1, "configure terminal", "access-list 105 deny icmp any any echo-reply", "access-list 105 permit ip any any", "interface gi0/0/0", "ip access-group 105 out", "end");
    const ping = pc.execute("ping 192.168.2.10");
    expect(ping).toContain("Request timed out.");
    expect(ping).toContain("NetSketch: požadavek došel, ale odpověď ne – R1 zahodil paket:");
    expect(ping).toContain("směr out");
  });
});

describe("named access lists", () => {
  test("lines are edited by sequence number", () => {
    const { r1, pc } = lab();
    const entered = run(r1, "configure terminal", "ip access-list extended BLOCK_WEB");
    expect(entered).toBe("");
    expect(r1.prompt).toBe("R1(config-ext-nacl)#");
    run(r1, "permit ip any any", "5 deny tcp any any eq www", "remark everything else is allowed");
    expect(r1.execute("10 permit ip any any")).toBe("% Duplicate sequence number");
    run(r1, "exit", "interface gi0/0/0", "ip access-group BLOCK_WEB in", "end");
    expect(r1.execute("show ip access-lists")).toBe(
      [
        "Extended IP access list BLOCK_WEB",
        "    5 deny tcp any any eq www",
        "    10 permit ip any any",
        "    20 remark everything else is allowed",
      ].join("\n"),
    );
    expect(pc.execute("Test-NetConnection 192.168.2.10 -Port 80 -InformationLevel Quiet")).toBe("False");
    expect(pc.execute("Test-NetConnection 192.168.2.10 -Port 8080 -InformationLevel Quiet")).toBe("True");
    const blocked = pc.execute("Test-NetConnection 192.168.2.10 -Port 80");
    expect(blocked).toContain("„5 deny tcp any any eq www“");

    run(r1, "configure terminal", "ip access-list extended BLOCK_WEB", "no 5");
    expect(r1.execute("no 5")).toBe("% Invalid sequence number");
    run(r1, "end");
    expect(pc.execute("Test-NetConnection 192.168.2.10 -Port 80 -InformationLevel Quiet")).toBe("True");

    run(r1, "configure terminal", "ip access-list extended BLOCK_WEB", "no permit ip any any", "15 deny udp any any eq domain", "end");
    expect(r1.execute("show access-lists BLOCK_WEB")).toBe(
      ["Extended IP access list BLOCK_WEB", "    15 deny udp any any eq domain", "    20 remark everything else is allowed"].join(
        "\n",
      ),
    );
    run(r1, "configure terminal", "ip access-list resequence BLOCK_WEB 100 100", "end");
    expect(r1.execute("show access-lists BLOCK_WEB")).toContain("    100 deny udp any any eq domain");
  });

  test("a named standard list, the type of an existing list and deleting", () => {
    const { r1 } = lab();
    run(r1, "configure terminal", "ip access-list standard ONLY_LAN");
    expect(r1.prompt).toBe("R1(config-std-nacl)#");
    run(r1, "permit 192.168.1.0 0.0.0.255", "deny any log", "exit");
    expect(r1.execute("ip access-list extended ONLY_LAN")).toBe("% Access-list type mismatch");
    run(r1, "end");
    expect(r1.execute("show access-lists ONLY_LAN")).toBe(
      ["Standard IP access list ONLY_LAN", "    10 permit 192.168.1.0, wildcard bits 0.0.0.255", "    20 deny   any log"].join("\n"),
    );
    run(r1, "configure terminal", "no ip access-list standard ONLY_LAN", "end");
    expect(r1.execute("show access-lists")).toBe("");
    expect(r1.execute("show access-lists ONLY_LAN")).toContain("neexistuje");
  });
});

describe("listings", () => {
  test("show access-lists and the running-config", () => {
    const { store, r1 } = lab();
    run(
      r1,
      "configure terminal",
      "access-list 10 permit host 10.1.1.1",
      "access-list 10 remark management",
      "access-list 10 deny 10.2.2.0 0.0.0.255",
      "access-list 101 permit tcp any eq 80 any",
      "access-list 101 deny   ip host 1.1.1.1 any",
      "ip access-list extended WEB",
      "permit tcp any any eq 443 log",
      "deny   icmp any any echo-reply",
      "exit",
      "interface gi0/0/0",
      "ip access-group 101 in",
      "ip access-group WEB out",
      "end",
    );
    expect(r1.execute("show access-lists")).toBe(
      [
        "Standard IP access list 10",
        "    10 permit 10.1.1.1",
        "    20 remark management",
        "    30 deny   10.2.2.0, wildcard bits 0.0.0.255",
        "Extended IP access list 101",
        "    10 permit tcp any eq www any",
        "    20 deny ip host 1.1.1.1 any",
        "Extended IP access list WEB",
        "    10 permit tcp any any eq 443 log",
        "    20 deny icmp any any echo-reply",
      ].join("\n"),
    );
    expect(r1.execute("show access-lists 10")).toBe(
      ["Standard IP access list 10", "    10 permit 10.1.1.1", "    20 remark management", "    30 deny   10.2.2.0, wildcard bits 0.0.0.255"].join(
        "\n",
      ),
    );
    const config = r1.execute("show running-config");
    expect(config).toContain(
      [
        "interface GigabitEthernet0/0/0",
        " ip address 192.168.1.1 255.255.255.0",
        " ip access-group 101 in",
        " ip access-group WEB out",
        "!",
      ].join("\n"),
    );
    expect(config).toContain(
      [
        "access-list 10 permit 10.1.1.1",
        "access-list 10 remark management",
        "access-list 10 deny   10.2.2.0 0.0.0.255",
        "access-list 101 permit tcp any eq www any",
        "access-list 101 deny   ip host 1.1.1.1 any",
        "!",
        "ip access-list extended WEB",
        " permit tcp any any eq 443 log",
        " deny   icmp any any echo-reply",
        "!",
        "end",
      ].join("\n"),
    );
    // The configuration is plain data in the project and survives a reload of the file.
    const acl = device(store, "R1").protocols?.acl;
    expect(acl?.lists.map((list) => list.name)).toEqual(["10", "101", "WEB"]);
    expect(readProtocols(JSON.parse(JSON.stringify(device(store, "R1").protocols))).acl).toEqual(acl);
  });

  test("no forms and undo", () => {
    const { store, r1, pc } = lab();
    run(r1, "configure terminal", "access-list 101 deny icmp any any", "interface gi0/0/0", "ip access-group 101 in");
    expect(pc.execute("ping 192.168.2.10")).toContain("Request timed out.");
    // One command, one undo step.
    expect(store.undo()).toBe(true);
    expect(pc.execute("ping 192.168.2.10")).toContain("Reply from");
    expect(store.redo()).toBe(true);
    expect(pc.execute("ping 192.168.2.10")).toContain("Request timed out.");

    run(r1, "no ip access-group 101 in");
    expect(pc.execute("ping 192.168.2.10")).toContain("Reply from");
    expect(device(store, "R1").protocols?.acl?.bindings).toEqual([]);
    run(r1, "ip access-group 101 in", "end", "configure terminal", "no access-list 101", "end");
    // The binding stays, the list is gone: everything is permitted again.
    expect(pc.execute("ping 192.168.2.10")).toContain("Reply from");
    run(r1, "configure terminal", "interface gi0/0/0", "no ip access-group", "end");
    expect(device(store, "R1").protocols).toBeUndefined();
    expect(r1.execute("show running-config")).not.toContain("access");
  });

  test("syntax errors point at the wrong word, help lists what may follow", () => {
    const { r1 } = lab();
    run(r1, "configure terminal");
    expect(r1.execute("access-list 101 permit foo any any")).toBe(
      "                                  ^\n% Invalid input detected at '^' marker.",
    );
    expect(r1.execute("access-list 101 permit tcp any")).toBe("% Incomplete command.");
    expect(r1.execute("access-list 101 permit tcp any any eq")).toBe("% Incomplete command.");
    expect(r1.execute("access-list 101 permit tcp any any eq www xyz").includes("^")).toBe(true);
    expect(r1.execute("access-list 10 permit 10.1.1.1 0.0.0.x").includes("^")).toBe(true);
    expect(r1.execute("access-list 101 permit tcp any any range 80 20").includes("^")).toBe(true);
    expect(r1.execute("access-list 101 permit tcp any ?")).toContain("range    Match only packets in the range of port numbers");
    expect(r1.execute("access-list 101 permit ?")).toContain("tcp   Transmission Control Protocol");
    expect(r1.execute("access-list ?")).toContain("<100-199>");
    expect(r1.execute("access-list 5 permit any any")).toContain("^");
    // Abbreviations and the same list from the other keyword.
    expect(r1.execute("access-list 101 per tc any any eq 80")).toBe("");
    expect(r1.execute("do show access-lists")).toBe("Extended IP access list 101\n    10 permit tcp any any eq www");
  });

  test("access-group is refused on a switch port and the bad number is refused", () => {
    const store = new ProjectStore();
    store.snapToGrid = false;
    const sw = store.addDevice("cisco-catalyst-2960-24", { x: 0, y: 0 }, "SW1");
    const cli = new CLISession(store, sw.id);
    const output = run(cli, "enable", "configure terminal", "interface fa0/1", "ip access-group 10 in");
    expect(output).toContain("NetSketch: seznam lze navázat jen na směrované rozhraní");
    expect(device(store, "SW1").protocols).toBeUndefined();
  });
});

describe("layer-3 switch", () => {
  test("a list on a VLAN interface filters routed traffic between VLANs", () => {
    const store = new ProjectStore();
    store.snapToGrid = false;
    const sw = store.addDevice("cisco-catalyst-3650-24ps", { x: 0, y: 0 }, "L3");
    const pc = store.addDevice("generic-pc", { x: 0, y: 200 }, "PC1");
    const srv = store.addDevice("generic-server", { x: 300, y: 200 }, "SRV");
    store.connect(ref(store, "PC1", "eth0"), ref(store, "L3", "Gi1/0/1"));
    store.connect(ref(store, "SRV", "eth0"), ref(store, "L3", "Gi1/0/2"));
    const l3 = new CLISession(store, sw.id);
    const host = new CLISession(store, pc.id);
    new CLISession(store, srv.id).execute("netsh interface ip set address eth0 static 10.20.0.10 255.255.255.0 10.20.0.1");
    host.execute("netsh interface ip set address eth0 static 10.10.0.10 255.255.255.0 10.10.0.1");
    run(
      l3,
      "enable",
      "configure terminal",
      "ip routing",
      "vlan 10",
      "vlan 20",
      "interface gi1/0/1",
      "switchport mode access",
      "switchport access vlan 10",
      "interface gi1/0/2",
      "switchport mode access",
      "switchport access vlan 20",
      "interface vlan 10",
      "ip address 10.10.0.1 255.255.255.0",
      "interface vlan 20",
      "ip address 10.20.0.1 255.255.255.0",
      "exit",
    );
    expect(host.execute("ping 10.20.0.10")).toContain("Reply from 10.20.0.10");
    run(l3, "ip access-list extended VLAN10_IN", "permit tcp 10.10.0.0 0.0.0.255 any eq 80", "exit", "interface vlan 10", "ip access-group VLAN10_IN in", "end");
    expect(l3.execute("show running-config")).toContain("interface Vlan10\n ip address 10.10.0.1 255.255.255.0\n ip access-group VLAN10_IN in\n!");
    const blocked = host.execute("ping 10.20.0.10");
    expect(blocked).toContain("L3 zahodil paket: access-list VLAN10_IN na rozhraní Vlan10, směr in");
    expect(host.execute("Test-NetConnection 10.20.0.10 -Port 80 -InformationLevel Quiet")).toBe("True");
    expect(host.execute("Test-NetConnection 10.20.0.10 -Port 22 -InformationLevel Quiet")).toBe("False");
    // The replies leave through Vlan10: an outbound list there sees them with source port 80.
    run(l3, "configure terminal", "ip access-list extended VLAN10_OUT", "deny tcp any eq 80 any", "permit ip any any", "exit", "interface vlan 10", "ip access-group VLAN10_OUT out", "end");
    const lost = host.execute("Test-NetConnection 10.20.0.10 -Port 80");
    expect(lost).toContain("TcpTestSucceeded       : False");
    expect(lost).toContain("access-list VLAN10_OUT na rozhraní Vlan10, směr out");
  });
});

describe("telnet from a router", () => {
  test("open, refused and timed out", () => {
    const { r1, r2 } = lab();
    expect(r1.execute("telnet 192.168.2.10 80")).toContain("Trying 192.168.2.10, 80 ... Open");
    expect(r1.execute("telnet 192.168.2.1")).toContain("Trying 192.168.2.1 ... Open");
    const refused = r1.execute("telnet 192.168.2.1 80");
    expect(refused).toContain("Trying 192.168.2.1, 80 ...");
    expect(refused).toContain("% Connection refused by remote host");
    expect(r1.execute("telnet nonsense")).toBe("% Unknown command or computer name, or unable to find computer address");
    // A silent drop is a timeout, a deny of a list is "unreachable".
    run(r2, "configure terminal", "access-list 140 deny tcp any any eq 23", "access-list 140 permit ip any any", "interface gi0/0/1", "ip access-group 140 in", "end");
    const denied = r1.execute("telnet 192.168.2.1");
    expect(denied).toContain("% Destination unreachable; gateway or host down");
    expect(denied).toContain("access-list 140 na rozhraní Gi0/0/1");
    run(r1, "configure terminal", "interface gi0/0/1", "shutdown", "end");
    expect(r1.execute("telnet 192.168.2.1")).toContain("% Connection timed out; remote host not responding");
  });

  test("the answer that is lost makes it a timeout", () => {
    const { r1 } = lab();
    run(r1, "configure terminal", "access-list 150 deny tcp any eq 23 any", "access-list 150 permit ip any any", "interface gi0/0/1", "ip access-group 150 in", "end");
    // R1 -> R2 telnet: the SYN passes (no list on the way out), the answer has source port 23 and is denied.
    const lost = r1.execute("telnet 192.168.2.1");
    expect(lost).toContain("% Connection timed out; remote host not responding");
    expect(lost).toContain("požadavek došel, ale odpověď ne");
    expect(r1.execute("telnet 192.168.2.10 80")).toContain("Open");
  });
});

describe("Dell OS9", () => {
  function dellLab() {
    const store = new ProjectStore();
    store.snapToGrid = false;
    const sw = store.addDevice("dell-s3048-on", { x: 0, y: 0 }, "D1");
    const pc = store.addDevice("generic-pc", { x: 0, y: 200 }, "PC1");
    const srv = store.addDevice("generic-server", { x: 300, y: 200 }, "SRV");
    store.connect(ref(store, "PC1", "eth0"), ref(store, "D1", "GigabitEthernet 1/1"));
    store.connect(ref(store, "SRV", "eth0"), ref(store, "D1", "GigabitEthernet 1/2"));
    const dell = new CLISession(store, sw.id);
    const host = new CLISession(store, pc.id);
    const server = new CLISession(store, srv.id);
    host.execute("netsh interface ip set address eth0 static 10.10.10.10 255.255.255.0 10.10.10.1");
    server.execute("netsh interface ip set address eth0 static 10.20.20.10 255.255.255.0 10.20.20.1");
    run(
      dell,
      "enable",
      "configure",
      "interface vlan 10",
      "ip address 10.10.10.1/24",
      "untagged gigabitethernet 1/1",
      "exit",
      "interface vlan 20",
      "ip address 10.20.20.1/24",
      "untagged gigabitethernet 1/2",
      "exit",
    );
    return { store, dell, host, server };
  }

  test("seq lines, CIDR networks and ip access-group on a VLAN interface", () => {
    const { store, dell, host } = dellLab();
    expect(host.execute("ping 10.20.20.10")).toContain("Reply from 10.20.20.10");
    run(dell, "ip access-list extended BLOCK");
    expect(dell.prompt).toBe("D1(config-ext-nacl)#");
    run(dell, "seq 5 deny icmp host 10.10.10.10 any", "seq 10 permit tcp 10.10.10.0/24 any eq 80", "exit");
    run(dell, "interface vlan 10", "ip access-group BLOCK in", "end");
    const ping = host.execute("ping 10.20.20.10");
    expect(ping).toContain("Request timed out.");
    expect(ping).toContain("D1 zahodil paket: access-list BLOCK na rozhraní Vlan10, směr in");
    expect(host.execute("Test-NetConnection 10.20.20.10 -Port 80 -InformationLevel Quiet")).toBe("True");
    expect(host.execute("Test-NetConnection 10.20.20.10 -Port 81 -InformationLevel Quiet")).toBe("False");
    expect(dell.execute("show ip access-lists")).toBe(
      ["Extended IP access list BLOCK", " seq 5 deny icmp host 10.10.10.10 any", " seq 10 permit tcp 10.10.10.0/24 any eq 80"].join("\n"),
    );
    const config = dell.execute("show running-config");
    expect(config).toContain("ip access-list extended BLOCK\n seq 5 deny icmp host 10.10.10.10 any\n seq 10 permit tcp 10.10.10.0/24 any eq 80\n!");
    expect(config).toContain(" ip access-group BLOCK in");
    // Dell takes no wildcard masks and no port names.
    run(dell, "configure", "ip access-list extended BLOCK");
    expect(dell.execute("permit ip 10.0.0.0 0.0.0.255 any")).toContain("^");
    expect(dell.execute("permit tcp any any eq www")).toContain("^");
    run(dell, "no seq 5");
    // Without the deny line the implicit deny at the end drops the ping.
    expect(host.execute("ping 10.20.20.10")).toContain("implicitní deny na konci seznamu");
    run(dell, "seq 20 permit icmp any any", "end");
    expect(host.execute("ping 10.20.20.10")).toContain("Reply from 10.20.20.10");
    expect(device(store, "D1").protocols?.acl?.lists[0]?.entries.map((entry) => entry.sequence)).toEqual([10, 20]);
  });
});

describe("MikroTik firewall filter", () => {
  function mikrotikLab() {
    const store = new ProjectStore();
    store.snapToGrid = false;
    const mt = store.addDevice("mikrotik-hap-lite", { x: 0, y: 0 }, "MT");
    const pc = store.addDevice("generic-pc", { x: 0, y: 200 }, "PC1");
    const srv = store.addDevice("generic-server", { x: 300, y: 200 }, "SRV");
    store.connect(ref(store, "PC1", "eth0"), ref(store, "MT", "ether2"));
    store.connect(ref(store, "SRV", "eth0"), ref(store, "MT", "ether1"));
    const router = new CLISession(store, mt.id);
    const host = new CLISession(store, pc.id);
    const server = new CLISession(store, srv.id);
    host.execute("netsh interface ip set address eth0 static 192.168.88.10 255.255.255.0 192.168.88.1");
    server.execute("netsh interface ip set address eth0 static 10.0.0.10 255.255.255.0 10.0.0.1");
    run(router, "/ip address add address=192.168.88.1/24 interface=ether2", "/ip address add address=10.0.0.1/24 interface=ether1");
    return { store, router, host, server };
  }

  test("forward chain: a drop rule blocks routed packets", () => {
    const { store, router, host } = mikrotikLab();
    expect(host.execute("ping 10.0.0.10")).toContain("Reply from 10.0.0.10");
    expect(
      router.execute('/ip firewall filter add chain=forward protocol=icmp src-address=192.168.88.0/24 action=drop comment="no ping"'),
    ).toBe("");
    const blocked = host.execute("ping 10.0.0.10");
    expect(blocked).toContain("Request timed out.");
    expect(blocked).toContain("NetSketch: požadavek nedošel – MT zahodil paket: pravidlo 0 firewallu v řetězci forward");
    expect(blocked).toContain("chain=forward action=drop protocol=icmp src-address=192.168.88.0/24");
    // Other protocols are not touched, a disabled rule does nothing.
    expect(host.execute("Test-NetConnection 10.0.0.10 -Port 80 -InformationLevel Quiet")).toBe("True");
    router.execute("/ip firewall filter disable 0");
    expect(host.execute("ping 10.0.0.10")).toContain("Reply from 10.0.0.10");
    router.execute("/ip firewall filter enable 0");
    expect(host.execute("ping 10.0.0.10")).toContain("Request timed out.");
    expect(device(store, "MT").protocols?.acl?.firewall[0]).toMatchObject({ chain: "forward", action: "drop", protocol: "icmp", comment: "no ping" });
  });

  test("ports, interfaces, reject and the order of the rules", () => {
    const { router, host, server } = mikrotikLab();
    run(
      router,
      "/ip firewall filter add chain=forward protocol=tcp dst-port=80,443 action=drop in-interface=ether2",
      "/ip firewall filter add chain=forward protocol=tcp dst-port=22 action=reject out-interface=ether1",
      "/ip firewall filter add chain=forward protocol=tcp dst-port=22 action=accept place-before=1",
    );
    expect(host.execute("Test-NetConnection 10.0.0.10 -Port 80 -InformationLevel Quiet")).toBe("False");
    expect(host.execute("Test-NetConnection 10.0.0.10 -Port 443 -InformationLevel Quiet")).toBe("False");
    expect(host.execute("Test-NetConnection 10.0.0.10 -Port 8080 -InformationLevel Quiet")).toBe("True");
    // The accept rule was placed before the reject: port 22 passes.
    expect(host.execute("Test-NetConnection 10.0.0.10 -Port 22 -InformationLevel Quiet")).toBe("True");
    // The server side does not come in on ether2: nothing is dropped there.
    expect(server.execute("ping 192.168.88.10")).toContain("Reply from 192.168.88.10");
    run(router, "/ip firewall filter remove 1");
    const rejected = host.execute("telnet 10.0.0.10 22");
    expect(rejected).toContain("MT odmítl (reject) paket: pravidlo 1 firewallu v řetězci forward");
  });

  test("input chain: packets to the router, output chain: packets from the router", () => {
    const { router, host } = mikrotikLab();
    run(router, "/ip firewall filter add chain=input protocol=tcp dst-port=23 action=drop", "/ip firewall filter add chain=input protocol=icmp in-interface=ether1 action=drop");
    expect(host.execute("telnet 192.168.88.1")).toContain("Could not open connection");
    expect(host.execute("telnet 192.168.88.1")).toContain("v řetězci input");
    expect(host.execute("Test-NetConnection 192.168.88.1 -Port 22 -InformationLevel Quiet")).toBe("True");
    // Pings to the router from the PC side are allowed, so is the router's own ping to the PC.
    expect(host.execute("ping 192.168.88.1")).toContain("Reply from 192.168.88.1");
    expect(router.execute("/ping 192.168.88.10")).toContain("received=4");
    // The reply of the server enters on ether1 and meets the input chain.
    const lost = router.execute("/ping 10.0.0.10");
    expect(lost).toContain("received=0");
    expect(lost).toContain("požadavek došel, ale odpověď ne");
    expect(lost).toContain("v řetězci input");
    run(router, "/ip firewall filter add chain=output protocol=icmp action=drop");
    const ping = router.execute("/ping 192.168.88.10");
    expect(ping).toContain("received=0");
    expect(ping).toContain("v řetězci output");
  });

  test("a stateful default: established replies are accepted, new connections are dropped", () => {
    const { router, host, server } = mikrotikLab();
    run(
      router,
      "/ip firewall filter add chain=forward connection-state=established,related action=accept",
      "/ip firewall filter add chain=forward in-interface=ether1 action=drop",
    );
    expect(host.execute("Test-NetConnection 10.0.0.10 -Port 80 -InformationLevel Quiet")).toBe("True");
    expect(host.execute("ping 10.0.0.10")).toContain("Reply from 10.0.0.10");
    expect(server.execute("Test-NetConnection 192.168.88.10 -Port 80 -InformationLevel Quiet")).toBe("False");
    expect(server.execute("ping 192.168.88.10")).toContain("Request timed out.");
  });

  test("print, set, comment, remove and export", () => {
    const { store, router } = mikrotikLab();
    run(
      router,
      '/ip firewall filter add chain=forward action=drop protocol=tcp dst-port=80 comment="web off"',
      "/ip firewall filter add chain=input action=accept src-address=192.168.88.0/24 disabled=yes",
    );
    expect(router.execute("/ip firewall filter print")).toBe(
      [
        "Flags: X - disabled, I - invalid; D - dynamic",
        " 0    ;;; web off",
        "      chain=forward action=drop protocol=tcp dst-port=80",
        " 1 X  chain=input action=accept src-address=192.168.88.0/24",
      ].join("\n"),
    );
    run(router, "/ip firewall filter set 1 disabled=no in-interface=ether2", "/ip firewall filter comment 1 comment=lan");
    expect(router.execute("/ip firewall filter print")).toContain(" 1    ;;; lan\n      chain=input action=accept src-address=192.168.88.0/24 in-interface=ether2");
    const exported = router.execute("/ip firewall filter export");
    expect(exported).toContain("/ip firewall filter\nadd action=drop chain=forward comment=\"web off\" dst-port=80 protocol=tcp");
    expect(exported).toContain("add action=accept chain=input comment=lan in-interface=ether2 src-address=192.168.88.0/24");
    expect(router.execute("/export")).toContain("/ip firewall filter\nadd action=drop chain=forward");

    expect(router.execute("/ip firewall filter remove 5")).toBe("no such item");
    expect(router.execute("/ip firewall filter add chain=forward dst-port=80")).toContain("failure:");
    expect(router.execute("/ip firewall filter add chain=forward action=allow")).toContain("invalid value for argument action");
    expect(router.execute("/ip firewall filter add chain=forward protocol=tcp dst-port=99999")).toBe("invalid value for argument dst-port");
    expect(router.execute("/ip firewall filter add chain=forward in-interface=ether9")).toContain("input does not match any value of interface");
    expect(router.execute("/ip firewall filter add chain=forward bogus=1")).toContain("expected end of command");
    run(router, "/ip firewall filter remove [find]");
    expect(device(store, "MT").protocols).toBeUndefined();
    expect(router.execute("/ip firewall filter print")).toBe("Flags: X - disabled, I - invalid; D - dynamic");
    // One command, one undo step.
    expect(store.undo()).toBe(true);
    expect(router.execute("/ip firewall filter print")).toContain("chain=input");
  });
});
