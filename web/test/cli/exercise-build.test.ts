// Port of ExerciseTests (Tests/NetSketchCLITests/NetworkTests.swift). The committed files in
// examples/ are checked in golden.test.ts.

import { ProjectStore } from "../../src/core/store";
import { CommandFailed, Exercises } from "../../src/cli/exercises";
import { CLISession } from "../../src/cli/session";

function makeStore(): ProjectStore {
  const store = new ProjectStore();
  store.snapToGrid = false;
  return store;
}

function deviceID(store: ProjectStore, hostname: string): string {
  const found = store.project.devices.find((item) => item.hostname === hostname);
  if (!found) throw new Error(`missing device ${hostname}`);
  return found.id;
}

describe.each(Exercises.all.map((exercise) => [exercise.fileName, exercise] as const))("exercise %s", (_, exercise) => {
  test("builds and pings, also after saving and opening again", () => {
    const store = makeStore();
    exercise.build(store);
    expect(Exercises.failedPings(exercise, store)).toEqual([]);
    // Saved and opened again it still works.
    const reopened = makeStore();
    reopened.openText(store.serialize(), exercise.fileName);
    expect(reopened.openIssues).toEqual([]);
    expect(Exercises.failedPings(exercise, reopened)).toEqual([]);
  });

  test("the file is deterministic", () => {
    const first = makeStore();
    const second = makeStore();
    exercise.build(first);
    exercise.build(second);
    const data = Exercises.fileData(first);
    expect(data).toBe(Exercises.fileData(second));
    expect(data).toContain('"id" : "00000000-0000-4000-8000-000000000001"');
    expect(data).not.toMatch(/[0-9A-F]{8}-(?!0000-4000-8000)[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/);
  });

  test("each exercise is undoable command by command", () => {
    const store = makeStore();
    exercise.build(store);
    expect(store.canUndo).toBe(true);
  });
});

describe("exercise helpers", () => {
  test("the PC console shows the route through the routers", () => {
    const store = makeStore();
    Exercises.fourRouters.build(store);
    const pc = new CLISession(store, deviceID(store, "PC1"));
    const trace = pc.execute("tracert 192.168.4.10");
    for (const hop of ["192.168.1.1", "10.0.12.2", "10.0.23.2", "10.0.34.2", "192.168.4.10"]) {
      expect(trace, hop).toContain(hop);
    }
    expect(pc.execute("ping 192.168.4.10")).toContain("Reply from 192.168.4.10");
  });

  test("failed pings name the cause", () => {
    const store = makeStore();
    Exercises.fourRouters.build(store);
    // Without R2 the network falls apart.
    store.removeDevices([deviceID(store, "R2-MIKROTIK")]);
    const failures = Exercises.failedPings(Exercises.fourRouters, store);
    expect(failures.length).toBe(Exercises.fourRouters.pings.length);
    expect(failures[0].startsWith("PC1 -> 192.168.4.10: NetSketch:")).toBe(true);
    expect(failures).toContain("R2-MIKROTIK -> 192.168.4.10: unknown device or address");
  });

  test("a failed command is described", () => {
    const error = new CommandFailed("SW1", "bogus", "% Invalid input");
    expect(error.description).toBe("SW1: bogus -> % Invalid input");
    expect(error.message).toBe("SW1: bogus -> % Invalid input");
    expect(error).toBeInstanceOf(Error);
  });

  test("identifiers are numbered in order of first appearance", () => {
    const text = '{"a":"6F9619FF-8B86-D011-B42D-00C04FC964FF","b":"1b4e28ba-2fa1-11d2-883f-0016d3cca427","c":"6F9619FF-8B86-D011-B42D-00C04FC964FF"}';
    expect(Exercises.stabilizeIdentifiers(text)).toBe(
      '{"a":"00000000-0000-4000-8000-000000000001","b":"00000000-0000-4000-8000-000000000002","c":"00000000-0000-4000-8000-000000000001"}',
    );
    let many = "";
    for (let index = 0; index < 11; index++) many += `${index.toString(16).padStart(8, "a")}-0000-0000-0000-000000000000 `;
    expect(Exercises.stabilizeIdentifiers(many).split(" ")[10]).toBe("00000000-0000-4000-8000-00000000000B");
  });
});
