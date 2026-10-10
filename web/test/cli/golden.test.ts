/// <reference types="vite/client" />
// Golden tests against files the Swift app produced (examples/, written by NetSketchExamples):
// 1. every committed exercise file opens and all pings of its exercise succeed,
// 2. rebuilding an exercise through the consoles gives the committed file byte for byte,
// 3. the demo transcript equals examples/UKAZKA.md character for character.

import { ProjectStore } from "../../src/core/store";
import { Exercises } from "../../src/cli/exercises";
import ukazka from "../../../examples/UKAZKA.md?raw";
import cviceni1 from "../../../examples/cviceni-1-multivendor-switche.netsketch?raw";
import cviceni2 from "../../../examples/cviceni-2-ctyri-routery.netsketch?raw";

const committed: Record<string, string> = {
  "cviceni-1-multivendor-switche.netsketch": cviceni1,
  "cviceni-2-ctyri-routery.netsketch": cviceni2,
};

/** A store on the built-in catalog, as NetSketchExamples makes it. */
function makeStore(): ProjectStore {
  return new ProjectStore();
}

/** The first line where two texts differ, for a readable failure message. */
function firstDifference(actual: string, expected: string): string {
  const a = actual.split("\n");
  const b = expected.split("\n");
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if (a[index] !== b[index]) {
      return `line ${index + 1}:\n  actual:   ${JSON.stringify(a[index])}\n  expected: ${JSON.stringify(b[index])}`;
    }
  }
  return "no difference";
}

test("every exercise has its committed file", () => {
  expect(Exercises.all.map((exercise) => exercise.fileName).sort()).toEqual(Object.keys(committed).sort());
  // The raw imports are the files themselves (no trailing newline, as Swift's JSONEncoder writes).
  for (const text of Object.values(committed)) {
    expect(text.startsWith('{\n  "annotations" : [')).toBe(true);
    expect(text.endsWith('"viewMode" : "physical"\n}')).toBe(true);
  }
  expect(ukazka.startsWith("# Ukázka cvičení\n")).toBe(true);
  expect(ukazka.length).toBeGreaterThan(5000);
});

describe.each(Exercises.all.map((exercise) => [exercise.fileName, exercise] as const))("golden %s", (fileName, exercise) => {
  test("the committed file opens and all pings succeed", () => {
    const store = makeStore();
    store.openText(committed[fileName], fileName);
    expect(store.openIssues).toEqual([]);
    expect(Exercises.failedPings(exercise, store)).toEqual([]);
  });

  test("rebuilding the exercise gives the committed file byte for byte", () => {
    const store = makeStore();
    exercise.build(store);
    const data = Exercises.fileData(store);
    if (data !== committed[fileName]) throw new Error(firstDifference(data, committed[fileName]));
    expect(data).toBe(committed[fileName]);
  });
});

test("the demo transcript equals examples/UKAZKA.md", () => {
  const transcript = Exercises.fullTranscript(makeStore);
  if (transcript !== ukazka) throw new Error(firstDifference(transcript, ukazka));
  expect(transcript).toBe(ukazka);
});

test("each demo section equals its part of examples/UKAZKA.md", () => {
  for (const exercise of Exercises.all) {
    const store = makeStore();
    exercise.build(store);
    const section = Exercises.demoTranscript(exercise, store);
    expect(ukazka, exercise.title).toContain("\n" + section);
  }
});
