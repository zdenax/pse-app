# pse-app (NetSketch)

Nativní macOS aplikace (Swift + SwiftUI, macOS 14+, Swift Package): vizuální editor síťové topologie
ve stylu Cisco Packet Tracer pro KI/PSE (UJEP). Jen vizualizace a konfigurační CLI nad daty diagramu,
žádná simulace protokolů.

## Stav (2026-10-10)

| Target | Stav |
|---|---|
| `NetSketchCore` (modely, katalog `devices.json`, `ProjectStore`, undo) | sestaví se na macOS i Linuxu; testy procházejí v CI |
| `NetSketchCLI` (Cisco IOS / Dell OS9 / MikroTik RouterOS / obecný dialekt) | sestaví se na macOS i Linuxu; testy v `Tests/NetSketchCLITests` procházejí v CI |
| `NetSketchCanvas` (plátno, panely, kabely, export PNG/PDF) | jen macOS; opravy tažení a hit-testu, ověřuje se na Macu |
| `NetSketch` (aplikace: paleta, inspector, konzole, menu) | jen macOS; dokončeno, chyby z prvního sestavení na Macu opraveny |

CI (GitHub Actions, `.github/workflows/ci.yml`): na každý push se na Linuxu sestaví a otestuje
Core a CLI. Sestavení celé aplikace na macOS se spouští ručně (Actions -> CI -> Run workflow),
protože minuty macOS jsou u soukromého repa drahé.

## Sestavení a spuštění (macOS 14+)

Stačí Command Line Tools (`xcode-select --install`), Xcode není nutný.

```sh
swift build
swift run NetSketch                 # spustí aplikaci přímo
swift run NetSketch --selftest      # automatický průchod hlavními funkcemi, vypíše ok/FAIL
scripts/make-app.sh                 # sestaví build/NetSketch.app (release, ad-hoc podpis)
open build/NetSketch.app
```

Testy bez Xcode (jen Command Line Tools), viz komentář v Package.swift:

```sh
swift test -Xswiftc -F -Xswiftc /Library/Developer/CommandLineTools/Library/Developer/Frameworks
```

Na Linuxu (Swift 6.x) se sestaví a otestují jen Core a CLI: `swift build && swift test`.
Package.swift na jiných systémech než macOS Canvas a aplikaci vůbec nedeklaruje.

Příklad projektu: `examples/trojuhelnik.netsketch` (Soubor > Otevřít).

## Katalog zařízení

`Sources/NetSketchCore/Resources/devices.json`. Všechny počty a názvy portů mají `"verified": false`
a je nutné je ověřit podle skutečného hardwaru. Formát katalogu, vlastní zařízení a textový formát
VLAN, který zapisuje konzole, popisuje [docs/katalog.md](docs/katalog.md).

## Mimo rozsah

Simulace STP/RSTP/MSTP, LACP, VLAN forwarding, routing, ping, emulace firmware.
