# pse-app (NetSketch)

Nativní macOS aplikace (Swift + SwiftUI, macOS 14+, Swift Package): vizuální editor síťové topologie
ve stylu Cisco Packet Tracer pro KI/PSE (UJEP). Jen vizualizace a konfigurační CLI nad daty diagramu,
žádná simulace protokolů.

## Stav: rozpracováno, celek se zatím NESESTAVÍ

Práce byla přerušena v půlce (2026-10-10). Co platí:

| Target | Stav |
|---|---|
| `NetSketchCore` (modely, katalog `devices.json`, `ProjectStore`, undo) | sestaví se bez chyb; testy v `Tests/NetSketchCoreTests` napsané, naposledy nespuštěné |
| `NetSketchCanvas` (plátno, panely, kabely, export PNG/PDF) | sestaví se bez chyb; chování neověřeno |
| `NetSketchCLI` (IOS / Dell OS9 / RouterOS příkazy) | NESESTAVÍ SE: chybí veřejné API (`CLISession`, `CLIDialect`, `CLI.supportsConsole`), testy chybí |
| `NetSketch` (aplikace: paleta, inspector, konzole, menu) | nedokončeno, závisí na `NetSketchCLI` |

Chybí: testy CLI, ověření `examples/trojuhelnik.netsketch`, dokončení shellu, dokumentace katalogu.

## Sestavení

Vyžaduje macOS (SwiftUI/AppKit); na Linuxu se sestavit nedá.

```sh
swift build --target NetSketchCore
swift build --target NetSketchCanvas
# testy bez Xcode (jen Command Line Tools), viz komentář v Package.swift:
swift test -Xswiftc -F -Xswiftc /Library/Developer/CommandLineTools/Library/Developer/Frameworks
```

`xcodebuild` nebyl ověřen (Xcode nebyl nainstalován).

## Katalog zařízení

`Sources/NetSketchCore/Resources/devices.json`. Všechny počty a názvy portů mají `"verified": false`
a je nutné je ověřit podle skutečného hardwaru.

## Mimo rozsah

Simulace STP/RSTP/MSTP, LACP, VLAN forwarding, routing, ping, emulace firmware.
