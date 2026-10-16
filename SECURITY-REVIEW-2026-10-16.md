# Security review `web/` — 2026-10-16

Read-only review (npm audit + code review agent). Nothing was fixed yet; findings are open.
Not verified at runtime.

## Open findings

### 1. Medium — unbounded port-range expansion in templates
- `web/src/core/catalog.ts:325-329` reads `rangeStart`/`rangeEnd` (any safe integer passes).
- `web/src/core/port-group.ts:106-112` (`portNames`) loops from `rangeStart` to `rangeEnd` and pushes a string each pass; `core/template.ts:123` and `core/panel-layout.ts:92` expand again.
- Template with `rangeEnd` ~ 9e15 (custom template or catalog override) freezes/OOMs the tab. Custom templates are re-read from `localStorage` on every load (`catalog.ts:81`), so the hang persists until site data is cleared.
- Fix: cap `rangeEnd - rangeStart` (e.g. 1024) in the decoder (`dataCorrupted`), cap group/name counts, add the same guard in `portNames`, cap stored text size.

### 2. Low — no size/complexity limit on imported `.netsketch` / catalog files
- `web/src/ui/files.ts:138,146` (`file.text()`), `core/json-decode.ts` (`readArray`), `core/project-io.ts` (`decodeProject`).
- Crafted file with huge device/port/link counts freezes the tab (self-DoS, user must open the file).
- Fix: reject files over a few MB; cap devices, ports per device and links.

### 3. Informational — wildcard regex from console input
- `web/src/cli/features/dhcp/host.ts:20-21`: metachars escaped (no injection), but repeated `*` -> repeated `.*` backtracks polynomially on short names. Negligible; collapse repeated `*` or use a glob matcher.

## Checked, clean
- SVG export (`renderToStaticMarkup`, blob URL only into `Image`), no `innerHTML`/`eval`/`dangerouslySetInnerHTML`.
- Prototype pollution: decoders read named keys only.
- Other CLI regexes anchored/linear; Dell interface-range loop bounded.

## Dependencies (`npm audit`)
- Production deps (react, react-dom): 0 vulnerabilities.
- Dev only: `vite` (high), `vitest` + `tinypool` (critical), `esbuild`, `@vitest/mocker` (moderate). Affect dev server/tests, not the deployed site. Fix needs a vite/vitest upgrade.
