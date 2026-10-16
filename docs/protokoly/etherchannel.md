# EtherChannel (port-channel, LACP, PAgP)

Webová verze NetSketch simuluje agregaci linek na konzoli **Cisco IOS** (a obecné IOS konzoli). Svazek kabelů mezi dvěma přepínači se chová jako jeden logický spoj: sdílí konfiguraci portů, přežije výpadek člena a v kostře STP se počítá jako jeden port. Ostatní konzole (Dell, MikroTik, UniFi) zůstávají u kresby svazku v diagramu. Simulace je statická jako u ostatních funkcí: stav se spočítá z kabeláže a konfigurace pokaždé znovu, žádné PDU neběží a nic se nevyjednává v čase.

## Příkazy (Cisco)

| Režim | Příkaz | Význam |
|-------|--------|--------|
| global | `interface port-channel N` | vytvoří (nebo otevře) logické rozhraní, N = 1 až 4096 |
| global | `no interface port-channel N` | smaže ho i řádky `channel-group` jeho členů |
| rozhraní | `channel-group N mode active\|passive\|on\|desirable\|auto` | zařadí port (nebo `interface range`) do skupiny; chybějící port-channel se vytvoří a konzole to oznámí (`Creating a port-channel interface Port-channel N`) |
| rozhraní | `no channel-group` | vyřadí port ze skupiny |
| port-channel | `switchport mode access/trunk`, `switchport access vlan`, `switchport trunk allowed vlan ...`, `switchport trunk native vlan`, `description`, `shutdown` | nastavení svazku, zapisuje se i na všechny členy |
| port-channel (router) | `ip address A.B.C.D MASKA` | adresa svazku; uloží se na prvního člena (viz omezení) |
| EXEC | `show etherchannel summary` | příznaky, protokol a stav členů (`P` svazek, `D` dole, `I` samostatný, `s` pozastavený) |
| EXEC | `show etherchannel port-channel` | podrobnosti po skupinách |
| EXEC | `show interfaces port-channel N [switchport\|trunk\|status\|description]` | stav a konfigurace logického rozhraní, členové |
| EXEC | `show running-config` | `channel-group` u členů a blok `interface Port-channel N` |
| EXEC | `show spanning-tree` | svazek je v tabulce jednou řádkou `PoN` |

Členové jedné skupiny musí používat stejný protokol (LACP: active/passive, PAgP: desirable/auto, statický: on); jiný mód konzole odmítne a nic nezmění.

## Pravidla svazku

Konfigurace je v `Device.protocols.lacp` (`members`: port, skupina, mód; `channels`: logické rozhraní). Pravidla počítá čistá funkce `computeChannels` v `web/src/cli/features/layer2/etherchannel.ts`, takže konzole, simulace a STP vidí totéž.

- **Člen se počítá**, jen když je jeho kabel v pořádku (zapojený a oba konce bez `shutdown`). Jinak je ve stavu `D`.
- **Shoda módů obou konců.** Druhý konec musí být také členem skupiny (čísla skupin se nemusejí shodovat). Kompatibilní jsou: active-active, active-passive, desirable-desirable, desirable-auto, on-on. Nevytvoří svazek: passive-passive, auto-auto, LACP proti PAgP, `on` proti čemukoli jinému.
- **Jeden soused.** Všichni členové skupiny musí vést ke stejnému sousedovi a jeho stejné skupině; první zapojený člen rozhoduje, ostatní se nezařadí.
- **Nesoulad se hlásí.** Při `channel-group` konzole vypíše `NetSketch: Gi0/1 nevytvoří svazek: nesoulad módů: zde passive, na druhém konci passive`; všechny důvody je vidět pod `show etherchannel summary`.
- **Svazek, který nevznikl.** Dynamický člen (LACP, PAgP) zůstane samostatným portem (`I`) a funguje jako obyčejný spoj, takže redundantní kabely řeší STP. Statický člen (`on`) se pozastaví (`s`, podobně jako EtherChannel misconfig guard) a nepřenáší nic; pro STP je to kabel, který je dole.
- **Port-channel je nahoře**, pokud je nahoře aspoň jeden člen. Jakmile jsou všichni dole, je svazek dole (`SD`, `is down`).

## Logické rozhraní jako konfigurace členů

Port-channel si drží vlastní nastavení (switchport, trunk, popis, `shutdown`) a při každé změně ho zapíše na členy; simulace čte jen fyzické porty. Port, který do skupiny vstoupí později, převezme text switchportu svazku (první člen nového svazku jej určí). `shutdown` na port-channelu vypne i členy a `no shutdown` je zapne.

## Spanning tree

Zařazené (bundled) porty jedné skupiny jsou v `computeSpanningTree` **jedním portem stromu**: jedna role, jeden stav a jedna cena pro všechny členy. Dva paralelní kabely tedy bez svazku jeden zablokují, ve svazku žádný. Cena je podle součtu rychlostí (pomalejší konec kabelu rozhoduje): 2x 1G stojí 10000, po výpadku jednoho člena 20000. Informace o portu nese `channel` (číslo skupiny); `show spanning-tree` vypisuje svazek jednou řádkou `PoN`. Viz [stp.md](stp.md).

## Zjednodušení oproti skutečným zařízením

- Žádné LACPDU ani PAgP rámce, bez časovačů (short/long), bez `lacp port-priority`, `lacp system-priority`, `max-bundle`, `min-links`, `load-balance` (provoz se nerozkládá, simulace vede cestu prvním funkčním členem).
- Neověřuje se shoda rychlosti, duplexu ani switchportu členů s druhým koncem (členové vždy dostanou konfiguraci svazku).
- Dynamický nesoulad nechává členy samostatné (`I`), skutečný přepínač by je u LACP mohl pozastavit; statický nesoulad je pozastavení bez err-disable a bez obnovy časovačem.
- Adresa L3 port-channelu na routeru je uložena na prvním členu (v `show running-config` ji vidí i ten člen) a funguje jen tehdy, když jeho kabel vede k odpovídajícímu členu druhého konce. L3 port-channel (`no switchport`) na přepínači a podrozhraní port-channelu nejsou; na přepínači použijte VLAN rozhraní.
- Smazání portu, kabelu nebo zařízení nechá v `protocols.lacp` osiřelé položky; ignorují se.
- Skupina `N` na zařízení se maže jen příkazem `no interface port-channel N`; `no channel-group` na posledním členu logické rozhraní ponechá.
- Kresba svazku v diagramu (`LinkBundle`) je nezávislá na EtherChannelu; `show etherchannel summary` bez nastavených skupin vypíše dosavadní seznam nakreslených svazků.
