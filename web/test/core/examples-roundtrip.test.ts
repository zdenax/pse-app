/// <reference types="vite/client" />
// Every committed example file must come out of decode + encode byte for byte, i.e. the web
// app writes exactly what the Swift app writes.

import { decodeProject, encodeProject, validateProject } from "../../src/core/project-io";

const examples = import.meta.glob<string>("../../../examples/*.netsketch", {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("example files", () => {
  const entries = Object.entries(examples);

  test("are found", () => {
    expect(entries.map(([path]) => path.split("/").pop()).sort()).toEqual([
      "cviceni-1-multivendor-switche.netsketch",
      "cviceni-2-ctyri-routery.netsketch",
      "opnsense-mint-lab.netsketch",
      "trojuhelnik.netsketch",
    ]);
  });

  test.each(entries)("%s round-trips byte for byte", (_path, text) => {
    const project = decodeProject(text);
    expect(validateProject(project)).toEqual([]);
    const encoded = encodeProject(project);
    if (encoded !== text) {
      // Point at the first difference instead of dumping two 40 kB strings.
      let index = 0;
      while (index < text.length && encoded[index] === text[index]) index += 1;
      expect(encoded.slice(Math.max(0, index - 80), index + 80)).toBe(text.slice(Math.max(0, index - 80), index + 80));
    }
    expect(encoded).toBe(text);
  });
});
