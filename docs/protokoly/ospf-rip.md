# OSPF a RIP (dynamické směrování)

Webová verze NetSketch simuluje OSPF a RIP v konzoli **Cisco IOS** (směrovače a L3 přepínače). Nic neběží na pozadí a neplyne čas: po každém příkazu se z konfigurace a zapojení spočítá už **ustálený stav** celé sítě. Naučené trasy se objeví v `show ip route` a ping je používá jako každou jinou trasu. Swift/macOS aplikace OSPF ani RIP nesimuluje.

## Příkazy

| Režim | Příkaz | Poznámka |
|---|---|---|
| global | `router ospf N`, `no router ospf N` | podporován jen **jeden proces** na zařízení (jiné číslo se odmítne zprávou) |
| global | `router rip`, `no router rip` | |
| router-ospf | `network A.B.C.D WILDCARD area X` (`no network ...`) | area číslem nebo tečkovaně; wildcard musí být souvislý (`0.0.0.255`); platí první shodný příkaz |
| router-ospf | `router-id A.B.C.D`, `no router-id` | bez něj nejvyšší adresa rozhraní, které je v provozu |
| router-ospf | `passive-interface IF`, `passive-interface default`, `no passive-interface IF` | |
| router-ospf | `auto-cost reference-bandwidth MBPS` | výchozí 100 |
| router-rip | `version 1\|2`, `network A.B.C.D` (classful), `passive-interface ...`, `auto-summary`, `no auto-summary` | výchozí verze 1 a auto-summary zapnuto jako v IOS |
| interface | `ip ospf cost N`, `ip ospf N area X` (i `no`) | |
| show | `show ip route`, `show ip ospf neighbor`, `show ip protocols` | funguje i jako `do show ...` |

`redistribute`, `default-information`, `log-adjacency-changes`, `area ...` a `timers` se přijmou s oznámením, že se neukládají. Konfigurace se ukládá do `Device.protocols.ospf` / `.rip` (a zobrazuje v `show running-config`). `RIPConfig.passiveDefault` je nové pole; `passive` pak obsahuje výjimky (`no passive-interface X`), stejně u OSPF.

## Jak se sousedství a trasy tvoří

**Soused** vznikne, když rozhraní dvou zařízení jsou v provozu (kabel zapojený, žádný `shutdown`), leží ve stejné L2 doméně (přímý kabel, nebo přes přepínače) a stejné podsíti, účastní se protokolu (`network`) a nejsou pasivní. Odpojení kabelu nebo `shutdown` odstraní rozhraní ze simulace, takže zmizí soused i všechny trasy přes něj.

### OSPF

- Soused musí být ve stejné **area** a mít jiné router-id. Pasivní rozhraní soused netvoří, ale jeho síť se inzeruje.
- Na společném segmentu je DR zařízení s nejvyšším router-id, BDR druhé nejvyšší (priorita je vždy 1). Stav v `show ip ospf neighbor`: `FULL/DR`, `FULL/BDR`, `FULL/DROTHER`, mezi dvěma DROTHER `2WAY/DROTHER`.
- Cena rozhraní = referenční šířka / šířka pásma (`speed` portu, jinak podle jména: Fa 100M, Gi 1G, Te 10G, Eth 10M), minimálně 1; nebo `ip ospf cost`. Cena trasy je součet cen odchozích rozhraní po cestě plus cena rozhraní cílové sítě.
- Z každého směrovače se spustí **Dijkstra** nad grafem sousedů. Do tabulky jde `O` (síť v area, ve které má směrovač rozhraní) nebo `O IA` (jiná area). Administrativní vzdálenost 110. Připojená síť má vždy přednost (AD 0).

### RIP

- Vektor vzdáleností se počítá po kolech do ustálení; metrika = počet skoků, 16 je nedosažitelné. Administrativní vzdálenost 120.
- **Split horizon**: trasa se nevrací rozhraním, ze kterého se naučila.
- **Auto-summary** (version 1 vždy): při inzerci přes rozhraní jiné classful sítě se podsíť sloučí na `/8`, `/16`, `/24`.
- Směrovač RIPv2 neslyší RIPv1 odesílatele; RIPv1 slyší obě verze. Pasivní rozhraní nic neodesílá, ale přijímá.
- OSPF (110) má přednost před RIP (120) pro stejnou síť; statická trasa (1) před oběma.

## Zjednodušení (co se nesimuluje)

- Žádné pakety, časovače, hello/dead intervaly, LSA databáze, `Dead Time` a „last update" jsou jen vzhled; nic nevyprší, nic nekonverguje postupně.
- OSPF: jen jeden proces, žádné stub/NSSA, virtuální linky, ECMP (při shodě vyhrává soused s nižším router-id), priorita DR, typy sítí, autentizace, filtry; inter-area trasa se najde stejným Dijkstrou bez ohledu na to, zda vede přes area 0.
- RIP: bez časovačů, hold-down, triggered updates, poison reverse, filtrů a autentizace.
- Bez redistribuce a `default-information originate`.
- MikroTik `/routing`, Dell a EdgeOS: datový model stejný (`protocols.ospf` / `.rip`) a simulace trasy spočítá, ale příkazy pro tyto konzole nejsou doplněny a Dell `show ip route` dynamické trasy nerozlišuje.

## Kde to je v kódu

`web/src/cli/features/routing/`: `model.ts` (cena, wildcard, pasivní rozhraní), `sim.ts` (výpočet sousedů a tras, hook `routes` simulace), `ios.ts` (příkazy, `show`, running-config). Řádek `O` / `R` v `show ip route` vypisuje `web/src/cli/ios-network.ts`. Testy: `web/test/features/routing.test.ts`.
