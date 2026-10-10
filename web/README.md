# NetSketch – webová verze

Stejná aplikace jako macOS verze v kořeni repozitáře, jen napsaná v TypeScriptu (React, SVG), takže
běží v prohlížeči na Windows, Linuxu i macOS. Otevírá i ukládá stejné soubory `.netsketch` a používá
stejný katalog zařízení (`Sources/NetSketchCore/Resources/devices.json`).

## Spuštění

Potřeba je [Node.js](https://nodejs.org) 20 nebo novější (`node --version`).

```sh
cd web
npm install        # jen poprvé
npm start          # vývojový server, otevře http://localhost:5173
```

- Se zvoleným cvičením: `http://localhost:5173/#cviceni-1` (4 multivendor switche) nebo
  `#cviceni-2` (4 routery). Cvičení jsou přibalená v aplikaci, soubory jsou i v `../examples/`.
- Konzole vybraného zařízení: tlačítko s terminálem na liště nebo „Otevřít konzoli“ v inspectoru.

## Další příkazy

```sh
npm test           # testy (Vitest): jádro, konzole, simulace, plátno, UI
npm run typecheck  # kontrola typů
npm run build      # produkční build do dist/ (statické soubory, jdou dát na libovolný web)
npx vite preview   # spustí hotový build z dist/
```

Složku `dist/` po `npm run build` stačí nahrát na jakýkoli statický hosting (GitHub Pages, školní
server); cesty jsou relativní.

## Struktura

| Složka | Obsah | Odpovídá ve Swift verzi |
|---|---|---|
| `src/core` | datový model, katalog, panely portů, čtení a zápis `.netsketch`, úpravy s undo | `Sources/NetSketchCore` |
| `src/cli` | konzole Cisco IOS, Dell OS9, MikroTik RouterOS, PC; simulace sítě; cvičení | `Sources/NetSketchCLI` |
| `src/canvas` | plátno v SVG: panely, kabely, výběr, tažení, zoom, export | `Sources/NetSketchCanvas` |
| `src/ui` | okno aplikace: lišta, paleta, inspector, okna konzolí, soubory | `Sources/NetSketch` |
| `test` | testy včetně porovnání se Swift verzí (`examples/UKAZKA.md`, soubory cvičení bajt po bajtu) | `Tests` |
