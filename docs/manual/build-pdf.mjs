// Renders docs/manual/manual.html to docs/NetSketch-navod.pdf with headless Chromium.
//
//   npm install --no-save playwright-core   (once, anywhere on the module path)
//   CHROMIUM=/path/to/chrome-or-headless_shell node docs/manual/build-pdf.mjs
//
// Without CHROMIUM, Playwright's own browser lookup is used.
import { chromium } from "playwright-core";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = pathToFileURL(path.join(here, "manual.html")).href;
const target = path.join(here, "..", "NetSketch-navod.pdf");

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
await page.goto(source, { waitUntil: "load" });
await page.pdf({
  path: target,
  format: "A4",
  printBackground: true,
  preferCSSPageSize: true,
  displayHeaderFooter: true,
  headerTemplate: "<span></span>",
  footerTemplate:
    '<div style="width:100%;font-size:7.5pt;color:#55656f;font-family:DejaVu Sans,sans-serif;padding:0 17mm;display:flex;justify-content:space-between">' +
    '<span>NetSketch – návod · soukromá cvičná aplikace studenta, není nástrojem UJEP</span>' +
    '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
});
await browser.close();
console.log(`written ${target}`);
