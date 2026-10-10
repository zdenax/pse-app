/// <reference types="vite/client" />
// Replays the IOS-style console transcripts of examples/UKAZKA.md (written by the Swift app,
// `swift run NetSketchExamples`) against the committed example projects and checks that the
// TypeScript consoles print exactly the same text.

import { CLISession } from "../../src/cli/session";
import ukazka from "../../../examples/UKAZKA.md?raw";
import { device, makeStore } from "./support";

/** The committed example projects, by path relative to the repository root. */
const projects: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../../../examples/*.netsketch", { query: "?raw", import: "default", eager: true }),
  ).map(([path, text]) => [path.replace("../../../", ""), text]),
);

interface Transcript {
  file: string;
  hostname: string;
  lines: string[];
}

/** The console blocks of the document: "Soubor: `examples/X`", then "### HOST" and a ``` block. */
function transcripts(markdown: string): Transcript[] {
  const result: Transcript[] = [];
  let file = "";
  let hostname = "";
  let block: string[] | null = null;
  for (const line of markdown.split("\n")) {
    const fileMatch = /^Soubor: `([^`]+)`/.exec(line);
    if (fileMatch) file = fileMatch[1];
    if (line.startsWith("### ")) hostname = line.slice(4).trim();
    if (line.startsWith("```")) {
      if (block === null) {
        block = [];
      } else {
        result.push({ file, hostname, lines: block });
        block = null;
      }
      continue;
    }
    block?.push(line);
  }
  return result;
}

const all = transcripts(ukazka);

describe("UKAZKA.md transcripts (IOS, Dell OS9, generic)", () => {
  test("the document has console blocks of every IOS-style dialect", () => {
    const dialects = new Set<string>();
    for (const transcript of all) {
      const store = makeStore();
      store.openText(projects[transcript.file], transcript.file);
      dialects.add(new CLISession(store, device(store, transcript.hostname).id).dialect);
    }
    for (const dialect of ["ios", "dellOS9", "generic"]) expect(dialects.has(dialect), dialect).toBe(true);
  });

  test.each(all.map((entry) => [entry.hostname, entry] as const))("%s", (_name, transcript) => {
    const store = makeStore();
    store.openText(projects[transcript.file], transcript.file.split("/").pop());
    const cli = new CLISession(store, device(store, transcript.hostname).id);
    if (cli.dialect === "routerOS" || cli.dialect === "host") return;

    let index = 0;
    while (index < transcript.lines.length) {
      const echoed = transcript.lines[index];
      const prefix = cli.prompt + " ";
      expect(echoed.startsWith(prefix), `line ${index + 1}: ${echoed}`).toBe(true);
      const output = cli.execute(echoed.slice(prefix.length));
      index += 1;
      if (output === "") continue;
      const count = output.split("\n").length;
      expect(output).toBe(transcript.lines.slice(index, index + count).join("\n"));
      index += count;
    }
  });
});
