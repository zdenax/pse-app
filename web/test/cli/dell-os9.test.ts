// Port of the DellOS9Tests suite of Tests/NetSketchCLITests/DellAndRouterOSTests.swift.

import type { CLISession } from "../../src/cli/session";
import { Notices } from "../../src/cli/notices";
import type { Device } from "../../src/core/model";
import type { ProjectStore } from "../../src/core/store";
import { device, makeSession, port, run, snapshot, TemplateID } from "./support";

function configured(): [ProjectStore, Device, CLISession] {
  const result = makeSession(TemplateID.dellS3048, "DELL1");
  run(result[2], "enable", "configure");
  return result;
}

describe("DellOS9Tests", () => {
  test("prompts follow OS9", () => {
    const [, , cli] = makeSession(TemplateID.dellS3048, "DELL1");
    expect(cli.prompt).toBe("DELL1>");
    cli.execute("enable");
    expect(cli.prompt).toBe("DELL1#");
    expect(cli.execute("configure")).toBe("");
    expect(cli.prompt).toBe("DELL1(conf)#");
    cli.execute("interface gigabitethernet 1/1");
    expect(cli.prompt).toBe("DELL1(conf-if-gi-1/1)#");
    cli.execute("exit");
    cli.execute("interface vlan 10");
    expect(cli.prompt).toBe("DELL1(conf-if-vl-10)#");
    cli.execute("end");
    expect(cli.prompt).toBe("DELL1#");
  });

  test("VLAN membership is set in the VLAN interface", () => {
    const [store, , cli] = configured();
    cli.execute("interface vlan 10");
    expect(device(store, "DELL1").vlans).toEqual([{ id: 10, name: "" }]);
    run(cli, "name USERS", "untagged gigabitethernet 1/1", "tagged gi 1/2");
    expect(device(store, "DELL1").vlans).toEqual([{ id: 10, name: "USERS" }]);
    expect(port(store, "DELL1", "GigabitEthernet 1/1").vlan).toBe("access 10");
    expect(port(store, "DELL1", "GigabitEthernet 1/2").vlan).toBe("trunk 10");

    // Tagged in 20 as well, untagged in 10: an OS9 hybrid port.
    run(cli, "exit", "interface vlan 20", "tagged gigabitethernet 1/1");
    expect(port(store, "DELL1", "GigabitEthernet 1/1").vlan).toBe("trunk 20 native 10");

    // Deleting the VLAN removes its memberships too.
    cli.execute("no interface vlan 20");
    expect(cli.prompt).toBe("DELL1(conf)#");
    expect(port(store, "DELL1", "GigabitEthernet 1/1").vlan).toBe("access 10");
    expect(device(store, "DELL1").vlans.map((entry) => entry.id)).toEqual([10]);
  });

  test("IOS VLAN syntax is explained", () => {
    const [store, , cli] = configured();
    const before = snapshot(store);
    expect(cli.execute("vlan 10")).toBe(Notices.dellVLANCommand);
    cli.execute("interface gigabitethernet 1/3");
    expect(cli.execute("switchport access vlan 10")).toBe(Notices.dellUsesVLANInterface);
    expect(store.project).toEqual(before);
  });

  test("errors use the OS9 wording", () => {
    const [, , cli] = configured();
    expect(cli.execute("hostname")).toBe("% Error: Incomplete command.");
    expect(cli.execute("bogus").endsWith('% Error: Invalid input at "^" marker.')).toBe(true);
  });

  test("description and shutdown on a range", () => {
    const [store, , cli] = configured();
    run(cli, "interface range gigabitethernet 1/1 - 1/3", "description Access", "shutdown");
    expect(cli.prompt.startsWith("DELL1(conf-if-range-gi-1/1-1/3)")).toBe(true);
    for (let number = 1; number <= 3; number += 1) {
      const member = port(store, "DELL1", `GigabitEthernet 1/${number}`);
      expect(member.description === "Access" && member.adminDown).toBe(true);
    }
    expect(port(store, "DELL1", "GigabitEthernet 1/4").adminDown).toBe(false);
  });
});
