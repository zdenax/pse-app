/// <reference types="vite/client" />
// The packet animation of the canvas: the path of a trace over the drawn cables, the playing of
// several traces one after another, reduced motion, and the markers of blocking STP ports.
// Two 24-port switches stacked vertically (as in scene.test.ts): the cable Fa0/2 - Fa0/1 runs
// straight down from (304.5, 308.5) to (304.5, 591.5), 283 points long.

import {
  PacketAnimator,
  buildPacketPlan,
  stpMarkers,
  type PacketTraceLike,
  type TraceSegmentLike,
} from "../../src/canvas/packet-animation";
import { DiagramScene } from "../../src/canvas/scene";
import { approximateMeasurer, setTextMeasurer } from "../../src/canvas/text";
import { addSwitch, makeStore, port } from "./support";

beforeAll(() => setTextMeasurer(approximateMeasurer));

function setup() {
  const store = makeStore();
  const sw1 = addSwitch(store, "SW1", { x: 400, y: 300 });
  const sw2 = addSwitch(store, "SW2", { x: 400, y: 600 });
  const cable = store.connect(port(sw1, "Fa0/2"), port(sw2, "Fa0/1"));
  const segment = (from: string, to: string): TraceSegmentLike => ({
    fromDevice: from,
    toDevice: to,
    links: [{ linkID: cable.id, fromDevice: from, toDevice: to }],
  });
  const trace = (overrides: Partial<PacketTraceLike> = {}): PacketTraceLike => ({
    kind: "ping",
    deviceID: sw1.id,
    forward: [segment(sw1.id, sw2.id)],
    back: [segment(sw2.id, sw1.id)],
    success: true,
    failedAt: null,
    ...overrides,
  });
  return { store, sw1, sw2, cable, segment, trace };
}

describe("buildPacketPlan", () => {
  test("the request runs along the cable and the reply comes back", () => {
    const { store, trace } = setup();
    const scene = new DiagramScene(store.project, "physical");
    const plan = buildPacketPlan(scene, store.project, trace())!;
    expect(plan.failure).toBeNull();
    expect(plan.legs.map((leg) => leg.phase)).toEqual(["request", "reply"]);
    expect(plan.legs[0].from).toEqual({ x: 304.5, y: 308.5 });
    expect(plan.legs[0].to).toEqual({ x: 304.5, y: 591.5 });
    expect(plan.legs[0].length).toBeCloseTo(283);
    // The reply goes the other way.
    expect(plan.legs[1].from).toEqual({ x: 304.5, y: 591.5 });
    expect(plan.legs[1].to).toEqual({ x: 304.5, y: 308.5 });
    // The device at the end of the request handles it for a moment; the last leg does not wait.
    expect(plan.legs[0].dwell).toBeGreaterThan(0);
    expect(plan.legs[1].dwell).toBe(0);
  });

  test("a trace that starts at the b end of the cable runs the other way", () => {
    const { store, sw1, sw2, trace, segment } = setup();
    const scene = new DiagramScene(store.project, "physical");
    const plan = buildPacketPlan(scene, store.project, trace({ deviceID: sw2.id, forward: [segment(sw2.id, sw1.id)], back: [] }))!;
    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0].from).toEqual({ x: 304.5, y: 591.5 });
    expect(plan.legs[0].to).toEqual({ x: 304.5, y: 308.5 });
  });

  test("the logical view follows the strand between the device icons", () => {
    const { store, trace } = setup();
    const scene = new DiagramScene(store.project, "logical");
    const plan = buildPacketPlan(scene, store.project, trace())!;
    expect(plan.legs).toHaveLength(2);
    const [strand] = scene.links;
    expect(plan.legs[0].from).toEqual(strand.start);
    expect(plan.legs[0].to).toEqual(strand.end);
    expect(plan.legs[1].from).toEqual(strand.end);
  });

  test("a failed packet gets a red cross where it stopped", () => {
    const { store, sw2, trace, segment, sw1 } = setup();
    const scene = new DiagramScene(store.project, "physical");
    const stopped = buildPacketPlan(
      scene,
      store.project,
      trace({ forward: [segment(sw1.id, sw2.id)], back: [], success: false, failedAt: sw2.id }),
    )!;
    expect(stopped.legs).toHaveLength(1);
    expect(stopped.failure).toEqual({ x: 304.5, y: 591.5 });
  });

  test("a packet that failed at its sender has no way, only the cross at the device", () => {
    const { store, sw1, trace } = setup();
    const scene = new DiagramScene(store.project, "physical");
    const plan = buildPacketPlan(scene, store.project, trace({ forward: [], back: [], success: false, failedAt: sw1.id }))!;
    expect(plan.legs).toEqual([]);
    const icon = scene.node(sw1.id)!.iconRect;
    expect(plan.failure).toEqual({ x: icon.x + icon.width / 2, y: icon.y + icon.height / 2 });
  });

  test("nothing to show gives no plan", () => {
    const { store, trace } = setup();
    const scene = new DiagramScene(store.project, "physical");
    expect(buildPacketPlan(scene, store.project, trace({ forward: [], back: [] }))).toBeNull();
    const unknown = trace({
      forward: [{ fromDevice: "a", toDevice: "b", links: [{ linkID: "missing", fromDevice: "a", toDevice: "b" }] }],
      back: [],
    });
    expect(buildPacketPlan(scene, store.project, unknown)).toBeNull();
  });
});

describe("PacketAnimator", () => {
  function plan() {
    const { store, trace } = setup();
    const scene = new DiagramScene(store.project, "physical");
    return buildPacketPlan(scene, store.project, trace())!;
  }

  test("the envelope moves along the cable and is gone at the end", () => {
    const animator = new PacketAnimator({ speed: 283, maxDuration: 100_000 });
    animator.enqueue(plan(), 1000);
    // 283 points at 283 points per second: one second there, a pause at the device, one back.
    const start = animator.frame(1000)!;
    expect(start.envelope?.point).toEqual({ x: 304.5, y: 308.5 });
    expect(start.envelope?.phase).toBe("request");
    const middle = animator.frame(1500)!;
    expect(middle.envelope?.phase).toBe("request");
    expect(middle.envelope?.point.y).toBeCloseTo(308.5 + 141.5, 0);
    // Waiting at SW2.
    const waiting = animator.frame(2050)!;
    expect(waiting.envelope?.point).toEqual({ x: 304.5, y: 591.5 });
    const back = animator.frame(2110 + 500)!;
    expect(back.envelope?.phase).toBe("reply");
    expect(back.envelope?.point.y).toBeCloseTo(591.5 - 141.5, 0);
    // Done: nothing on screen, nothing pending.
    expect(animator.frame(1000 + 2110 + 1000 + 500)).toBeNull();
    expect(animator.pending).toBe(0);
  });

  test("a frame stamped slightly before the announcement still shows the start", () => {
    const animator = new PacketAnimator();
    animator.enqueue(plan(), 1000);
    expect(animator.frame(996)?.envelope?.point).toEqual({ x: 304.5, y: 308.5 });
  });

  test("a long way is sped up to fit the maximum duration", () => {
    const animator = new PacketAnimator({ speed: 10, maxDuration: 1000, linger: 0 });
    animator.enqueue(plan(), 0);
    expect(animator.frame(0)).not.toBeNull();
    expect(animator.frame(990)?.envelope).not.toBeNull();
    expect(animator.frame(1200)).toBeNull();
  });

  test("several traces queue up and play one after another", () => {
    const animator = new PacketAnimator({ speed: 283, maxDuration: 100_000 });
    animator.enqueue(plan(), 0);
    animator.enqueue(plan(), 0);
    animator.enqueue(plan(), 0);
    expect(animator.pending).toBe(3);
    expect(animator.frame(0)?.envelope?.phase).toBe("request");
    expect(animator.pending).toBe(3);
    // The first one lasts 2110 ms of movement and a 120 ms tail; the second starts right behind it.
    const second = animator.frame(2500)!;
    expect(second.envelope?.phase).toBe("request");
    expect(second.envelope?.point.y).toBeCloseTo(308.5 + 0.283 * (2500 - 2230), 0);
    expect(animator.pending).toBe(2);
  });

  test("traces beyond the queue limit drop the oldest waiting ones", () => {
    const animator = new PacketAnimator({ maxQueue: 2 });
    for (let index = 0; index < 5; index++) animator.enqueue(plan(), 0);
    expect(animator.pending).toBe(2);
  });

  test("a failed packet leaves its cross for a while and then fades it", () => {
    const { store, sw1, sw2, segment, trace } = setup();
    const scene = new DiagramScene(store.project, "physical");
    const failed = buildPacketPlan(
      scene,
      store.project,
      trace({ forward: [segment(sw1.id, sw2.id)], back: [], success: false, failedAt: sw2.id }),
    )!;
    const animator = new PacketAnimator({ speed: 283, maxDuration: 100_000, linger: 1000 });
    animator.enqueue(failed, 0);
    expect(animator.frame(500)?.cross).toBeNull();
    const after = animator.frame(1200)!;
    expect(after.envelope).toBeNull();
    expect(after.cross?.point).toEqual({ x: 304.5, y: 591.5 });
    expect(after.cross?.opacity).toBe(1);
    expect(animator.frame(1900)?.cross?.opacity).toBeLessThan(1);
    expect(animator.frame(2100)).toBeNull();
  });

  test("with reduced motion the path is only highlighted for a moment", () => {
    const animator = new PacketAnimator({ highlightDuration: 900 });
    animator.enqueue(plan(), 0, true);
    const frame = animator.frame(100)!;
    expect(frame.envelope).toBeNull();
    expect(frame.highlight?.legs).toHaveLength(2);
    expect(frame.highlight?.opacity).toBe(1);
    expect(animator.frame(800)?.highlight?.opacity).toBeLessThan(1);
    expect(animator.frame(1000)).toBeNull();
  });

  test("clear stops everything", () => {
    const animator = new PacketAnimator();
    animator.enqueue(plan(), 0);
    animator.enqueue(plan(), 0);
    animator.clear();
    expect(animator.frame(0)).toBeNull();
    expect(animator.pending).toBe(0);
  });
});

describe("stpMarkers", () => {
  test("a blocking port gets an orange marker on its end of the cable", () => {
    const { store, sw1, sw2 } = setup();
    const scene = new DiagramScene(store.project, "physical");
    const blocked = port(sw2, "Fa0/1");
    const states = new Map([
      [`${blocked.deviceID}|${blocked.portID}`, "blocking"],
      [`${sw1.id}|${port(sw1, "Fa0/2").portID}`, "forwarding"],
    ]);
    const markers = stpMarkers(scene, store.project, states);
    expect(markers).toHaveLength(1);
    expect(markers[0].deviceID).toBe(sw2.id);
    expect(markers[0].portID).toBe(blocked.portID);
    // SW2's end of the cable, a little way up the cable towards SW1.
    expect(markers[0].point.x).toBeCloseTo(304.5);
    expect(markers[0].point.y).toBeCloseTo(591.5 - 11);
    expect(markers[0].angle).toBeCloseTo(-Math.PI / 2);
  });

  test("both ends can block, other states and an empty map give no markers", () => {
    const { store, sw1, sw2 } = setup();
    const scene = new DiagramScene(store.project, "physical");
    const a = port(sw1, "Fa0/2");
    const b = port(sw2, "Fa0/1");
    const both = new Map([
      [`${a.deviceID}|${a.portID}`, "blocking"],
      [`${b.deviceID}|${b.portID}`, "blocking"],
    ]);
    const markers = stpMarkers(scene, store.project, both);
    expect(markers.map((marker) => marker.deviceID).sort()).toEqual([sw1.id, sw2.id].sort());
    expect(stpMarkers(scene, store.project, new Map([[`${b.deviceID}|${b.portID}`, "listening"]]))).toEqual([]);
    expect(stpMarkers(scene, store.project, new Map())).toEqual([]);
  });

  test("in the logical view the marker sits on the strand next to the right device", () => {
    const { store, sw2 } = setup();
    const scene = new DiagramScene(store.project, "logical");
    const b = port(sw2, "Fa0/1");
    const [marker] = stpMarkers(scene, store.project, new Map([[`${b.deviceID}|${b.portID}`, "blocking"]]));
    const strand = scene.links[0];
    // SW2 is the b end of the cable, so the marker is next to the strand's end.
    const toEnd = Math.hypot(marker.point.x - strand.end.x, marker.point.y - strand.end.y);
    const toStart = Math.hypot(marker.point.x - strand.start.x, marker.point.y - strand.start.y);
    expect(toEnd).toBeLessThan(toStart);
  });
});
