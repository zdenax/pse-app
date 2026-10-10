# pse-app (NetSketch)

> **Nejde o nástroj UJEP.** NetSketch není oficiální aplikace Univerzity J. E. Purkyně v Ústí nad
> Labem, nevznikl na její zakázku ani s jejím schválením. Je to soukromá cvičná aplikace studenta
> k procvičování počítačových sítí, inspirovaná vybavením laboratoře a látkou předmětu KI/PSE.
> Za obsah odpovídá autor.

> **Využití umělé inteligence.** Projekt vznikl s výrazným využitím nástroje generativní AI
> **Claude Code** (Anthropic). Prohlášení o využití AI v souladu s
> [pravidly využívání AI (SR-07-26)](https://www.fzp.ujep.cz/wp-content/uploads/2026/06/SR-07-26_Pravidla-AI.pdf):
>
> - **K čemu byla AI použita:** návrh a psaní zdrojového kódu (Swift i TypeScript), testů, CI,
>   dokumentace, katalogu zařízení a ukázkových cvičení, podle zadání a průběžných pokynů autora.
> - **Co dělal autor:** zadání a rozsah projektu, volba funkcí a technologií, průběžná kontrola
>   výsledků, spouštění a testování aplikace na Macu, podklady z laboratoře (fotka racku pro katalog
>   zařízení) a rozhodnutí o přijetí změn.
> - **Ověření výstupů AI:** automatické testy (Swift i webová verze, včetně vzájemného porovnání
>   výstupů obou verzí) a ruční vyzkoušení aplikace. Údaje o portech v katalogu zůstávají označené
>   jako neověřené, dokud nejsou zkontrolované na skutečném hardwaru.
> - Části vytvořené s AI jsou v historii repozitáře označené (`Co-Authored-By: Claude`).
>   Za obsah projektu a jeho použití odpovídá autor.

Vizuální editor síťové topologie ve stylu Cisco Packet Tracer pro procvičování látky předmětu
KI/PSE, ve dvou verzích:
nativní macOS aplikace (Swift + SwiftUI, macOS 14+) a webová verze pro libovolný OS (složka
[`web/`](web/), TypeScript + React, běží v prohlížeči). Zařízení se kreslí a propojují na plátně, konfigurují
v konzolích podle výrobce (Cisco IOS, Dell OS9, MikroTik RouterOS, příkazový řádek PC) a `ping` /
`traceroute` mezi nimi opravdu prochází podle kabeláže, VLAN, IP adres a statických tras.

![NetSketch s otevřeným cvičením 2: paleta zařízení, plátno s panely routerů a kabely, inspector](docs/screenshots/aplikace-cviceni-2.png)

**Návod s obrázky:** [docs/NetSketch-navod.pdf](docs/NetSketch-navod.pdf) (spuštění, kreslení, konzole,
IP adresy, ping a obě cvičení).

## Rychlé spuštění

**Webová verze (Windows, Linux, macOS):** potřebuje jen [Node.js](https://nodejs.org) 20 nebo novější.

```sh
cd web
npm install
npm start          # otevře aplikaci v prohlížeči (http://localhost:5173)
```

Se zvoleným cvičením: http://localhost:5173/#cviceni-1 nebo http://localhost:5173/#cviceni-2.
Podrobnosti v [web/README.md](web/README.md).

**macOS aplikace:** potřebuje Command Line Tools (`xcode-select --install`).

```sh
swift run NetSketch
```

## Stav (2026-10-10)

| Target | Stav |
|---|---|
| `NetSketchCore` (modely, katalog `devices.json`, `ProjectStore`, undo) | sestaví se na macOS i Linuxu; testy procházejí v CI |
| `NetSketchCLI` (konzole Cisco IOS / Dell OS9 / MikroTik RouterOS / PC, simulace sítě, cvičení) | sestaví se na macOS i Linuxu; testy v `Tests/NetSketchCLITests` procházejí v CI |
| `NetSketchCanvas` (plátno, panely, kabely, export PNG/PDF) | jen macOS; sestaví se a běží |
| `NetSketch` (aplikace: paleta, inspector, konzole, menu) | jen macOS; sestaví se a běží, konzole i ping ověřené na Macu |
| `web/` (webová verze: jádro, konzole, simulace, plátno, UI) | všechny OS; testy a build v CI, výstupy konzolí a soubory cvičení shodné se Swift verzí |

CI (GitHub Actions, `.github/workflows/ci.yml`):

- každý push: Linux sestaví Core a CLI, spustí testy, postaví cvičení přes konzole a při změně je
  commitne do `examples/` (soubory i výstupy konzolí v `examples/UKAZKA.md`);
- commit se značkou `[screenshots]` ve zprávě: macOS navíc sestaví celou aplikaci a vyrenderuje
  diagramy z `examples/` do `docs/screenshots/` (minuty macOS jsou u soukromého repa drahé, proto
  jen na vyžádání).

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

## Cvičení

| Soubor | Obsah |
|---|---|
| `examples/cviceni-1-multivendor-switche.netsketch` | 4 switche (Cisco, Dell, MikroTik, Ubiquiti) v síti 192.168.10.0/24, management IP na VLAN 1, 2 PC; ping mezi všemi |
| `examples/cviceni-2-ctyri-routery.netsketch` | 4 routery (Cisco, MikroTik, Ubiquiti, Cisco), propoje /30, statické trasy, PC v LAN 192.168.1.0/24 a 192.168.4.0/24 |

Výstupy konzolí z hotových cvičení (ipconfig, ping, tracert, show ip route, ...) a obrázky diagramů
jsou v [examples/UKAZKA.md](examples/UKAZKA.md).

Cvičení jsou definovaná v `Sources/NetSketchCLI/Exercises.swift` a sestavená přes konzole zařízení
(stejnými příkazy, jaké by psal student). `swift run NetSketchExamples` je uloží do `examples/`,
CI je při změně samo přegeneruje a commitne a testy ověřují, že všechny pingy v nich projdou.

## Obrázky

Konzole PC1 ve cvičení 2: `ipconfig`, `ping` a `tracert` přes čtyři routery.

![Konzole PC1: ipconfig, ping a tracert](docs/screenshots/konzole-pc1.png)

| Cisco IOS (R1): `show ip route`, `ping` | MikroTik RouterOS (R2): `/ip address print`, `/ip route print`, `/ping` |
|---|---|
| ![Konzole R1](docs/screenshots/konzole-r1-cisco.png) | ![Konzole R2](docs/screenshots/konzole-r2-mikrotik.png) |

| Cvičení 1, fyzický pohled | Cvičení 1, logický pohled |
|---|---|
| ![Cvičení 1, fyzický pohled](docs/screenshots/aplikace-cviceni-1.png) | ![Cvičení 1, logický pohled](docs/screenshots/aplikace-cviceni-1-logicky.png) |

| Inspector vybraného PC (IP z konzole) | Dell OS9 (SW2): `show ip route`, `ping` |
|---|---|
| ![Inspector PC1](docs/screenshots/aplikace-inspector-pc1.png) | ![Konzole SW2](docs/screenshots/konzole-sw2-dell.png) |

Celé diagramy vyrenderované exportem (PNG):
[cvičení 1](docs/screenshots/cviceni-1-multivendor-switche-fyzicky.png),
[cvičení 1 logicky](docs/screenshots/cviceni-1-multivendor-switche-logicky.png),
[cvičení 2](docs/screenshots/cviceni-2-ctyri-routery-fyzicky.png),
[cvičení 2 logicky](docs/screenshots/cviceni-2-ctyri-routery-logicky.png),
[trojúhelník](docs/screenshots/trojuhelnik-fyzicky.png).

Obrázky vytváří CI na macOS (`swift run NetSketch --screenshots=docs/screenshots` a `NetSketchRender`)
pro commity se značkou `[screenshots]`.

## Simulace sítě

Konzole ukládají IP konfiguraci do projektu, `ping` a `traceroute` ji vyhodnocují nad diagramem:

- L2: switch přepíná podle VLAN na portech (access, trunk, allowed VLAN, native VLAN), kabel spojí
  to, co nesou oba konce, `shutdown` port vypne. Smyčky nevadí (STP se nesimuluje).
- L3: adresy na portech routerů, na VLAN rozhraních switchů (SVI, MikroTik `bridge`) a na PC,
  připojené sítě, statické trasy, výchozí brána. Routery a L3 switche směrují, PC a L2 switche ne.
- Když ping neprojde, konzole česky napíše, kde a proč se paket zastavil.
- Nesimuluje se: STP, OSPF a jiné dynamické směrování, DHCP, ACL, NAT, časování.

| Zařízení | Adresa | Trasy a brána | Test |
|---|---|---|---|
| Cisco IOS (a obecný dialekt) | `interface gi0/0/0` / `interface vlan 1`, `ip address A.B.C.D M.M.M.M` | `ip route NET MASK NEXTHOP`, `ip default-gateway X` | `ping`, `traceroute`, `show ip route`, `show ip interface brief` |
| Dell OS9 | `interface vlan 1`, `ip address A.B.C.D/NN` | `ip route NET/NN NEXTHOP` | `ping`, `traceroute`, `show ip route` |
| MikroTik RouterOS | `/ip address add address=A.B.C.D/NN interface=ether1` (switch: `interface=bridge`) | `/ip route add dst-address=NET/NN gateway=X` | `/ping X`, `/ip route print` |
| PC, server | `netsh interface ip set address eth0 static A.B.C.D M.M.M.M [BRÁNA]` | brána v témže příkazu | `ipconfig`, `ping`, `tracert` |

Konzoli otevře Cmd+T (nebo tlačítko na liště či v inspectoru) u vybraného zařízení; nemají ji jen
access pointy. Inspector u zařízení ukazuje adresy, bránu a trasy nastavené v konzoli.

## Katalog zařízení

`Sources/NetSketchCore/Resources/devices.json`. Všechny počty a názvy portů mají `"verified": false`
a je nutné je ověřit podle skutečného hardwaru. Formát katalogu, vlastní zařízení a textový formát
VLAN, který zapisuje konzole, popisuje [docs/katalog.md](docs/katalog.md).

## Mimo rozsah

Simulace STP/RSTP/MSTP, LACP, dynamického směrování (OSPF, RIP), DHCP, ACL a NAT, emulace firmware.

## Licence

Kód je pod licencí [MIT](LICENSE): lze ho volně používat, upravovat i šířit, jen je potřeba ponechat
uvedení autora a text licence. Názvy výrobců a modelů zařízení v katalogu (Cisco, Dell, MikroTik,
Ubiquiti, Netgear) jsou ochranné známky svých vlastníků a slouží jen k označení zařízení.
