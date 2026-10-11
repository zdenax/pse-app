# Časování, ztráty paketů a animace paketů

NetSketch umí k pingu a traceroute přidat realističtější čísla a ukázat pakety na plátně. Vše je
volitelné: dokud žádný kabel na cestě nemá nastavené zpoždění ani ztrátovost, vypisují konzole
přesně to, co vždy (IOS `round-trip min/avg/max = 1/1/1 ms`, Windows `time<1ms`, RouterOS `0ms`).

## Co se simuluje

- **Zpoždění kabelu** (ms): jednosměrné, nastavuje se v inspektoru vybraného kabelu (pole
  „Zpoždění (ms)"). Ping kabelem projde dvakrát (tam a zpět), takže kabel s 20 ms přidá k odezvě
  asi 40 ms.
- **Ztrátovost kabelu** (%): pole „Ztrátovost (%)" ve stejném inspektoru. Každý paket přes kabel
  projde nebo se zahodí s touto pravděpodobností; echo ping kabelem prochází dvakrát, takže při
  50 % ztrátovosti dorazí zpět asi čtvrtina odpovědí.
- **Doba odezvy** se skládá z: zpoždění kabelů na cestě tam a zpět (kabel bez zadaného zpoždění
  má malý výchozí čas podle rychlosti portů, desítky mikrosekund), krátkého zpracování v každém
  směrovači a malého rozptylu (jitter) u každého echa. Rozptyl není náhodný: je to hash z id
  zařízení, cíle, pořadí příkazu a pořadí echa, takže stejný projekt dává stejná čísla a každý
  další `ping` jiná. Po otevření projektu se počítadlo příkazů vynuluje.
- **TTL** odpovědi na Windows (128 u PC a serverů, 255 u routerů a přepínačů) a na RouterOS (64)
  klesá o jedničku za každý směrovač, kterým odpověď prošla.

Zpoždění a ztráty se počítají jen tehdy, když aspoň jeden kabel na cestě má jednu z hodnot
nastavenou. Smazáním hodnoty (prázdné pole nebo 0) se výpis vrátí k původnímu.

## Co vypisují konzole

| Konzole | Zpoždění | Ztracené echo |
| --- | --- | --- |
| Cisco IOS, Dell OS9, ostatní IOS styly | `Success rate is 80 percent (4/5), round-trip min/avg/max = 40/41/42 ms`; traceroute `1 10.0.12.2 41 msec 41 msec 42 msec` | `.` v řádku značek; u traceroute `*` |
| PC (Windows) | `Reply from 10.0.2.10: bytes=32 time=41ms TTL=126`, pod 1 ms `time<1ms`; tracert `41 ms` / `<1 ms` | `Request timed out.`; v tracert `*` |
| MikroTik RouterOS | řádek `SEQ HOST SIZE TTL TIME` s časem (`41ms`, `41ms350us`, pod 1 ms `350us`) a souhrn `sent=5 received=4 packet-loss=20% min-rtt=40ms avg-rtt=41ms max-rtt=42ms` | `timeout`; souhrn počítá ztráty |

Pokud se echa ztratila na kabelu, přidá NetSketch pod výpis českou větu, na kterém kabelu a s jakou
ztrátovostí, např. `NetSketch: ztraceno 7 z 10 paketů na kabelu R1 Gi0/0/1 – R2 Gi0/0/0 (ztrátovost
50 %).` Totéž platí pro traceroute (`sondy`).

## Animace paketů

Každý příkaz `ping`, `traceroute` a `tracert` oznámí plátnu, kudy paket šel. Plátno ho ukáže jako
malou obálku, která běží po nakreslených kabelech zařízení po zařízení:

- žádost má modrou barvu, odpověď zelenou,
- paket, který se zahodil (chybí trasa, ACL, ztráta na kabelu, vypnutý port), skončí červeným
  křížkem u zařízení, kde se zastavil,
- při více příkazech za sebou (i z různých konzolí) se animace řadí do fronty,
- s nastavením systému „omezit pohyb" (`prefers-reduced-motion`) se nic nepohybuje, cesta se jen
  krátce zvýrazní,
- tlačítko **Animace paketů** na liště animaci vypíná a zapíná (ve výchozím stavu je zapnutá,
  volba se pamatuje v prohlížeči).

## Značky STP

U konce kabelu, kde port **blokuje** (spanning tree), kreslí plátno malou oranžovou příčku. Stavy
portů dodává simulace STP; bez nastaveného STP se nic nekreslí.

## Zkratka konzole

Konzoli vybraného zařízení otevře **Alt+T** (na Macu **Option+T**). Dřívější Ctrl+T otevíralo
nový panel prohlížeče, proto ho NetSketch už nezachytává. Na Macu se v textovém poli Option+T
nechává poli (píše znak), jinde zkratka funguje všude.

## Zjednodušení

- Jitter a ztráty jsou deterministické, ne skutečně náhodné; po každém dalším příkazu se mění.
- Kabel bez nastaveného zpoždění ukazuje stále pod 1 ms (Windows `time<1ms`, IOS 1 ms).
- Zpoždění je stejné v obou směrech; šířka pásma, fronty a přetížení se nemodelují.
- U traceroute se čas k n-tému routeru počítá z cesty tam a stejné cesty zpět.
- Animace ukazuje jedno echo na příkaz (první), ne všech pět.

## Příklad

Dva routery R1 a R2 spojené kabelem Gi0/0/1 – Gi0/0/0, PC1 za R1 a PC2 za R2.

1. Vyberte kabel mezi R1 a R2 a v inspektoru zadejte Zpoždění `20` a Ztrátovost `0`.
2. Na PC1: `ping 10.0.2.10`:

```
Reply from 10.0.2.10: bytes=32 time=41ms TTL=126
Reply from 10.0.2.10: bytes=32 time=42ms TTL=126
...
Approximate round trip times in milli-seconds:
    Minimum = 41ms, Maximum = 42ms, Average = 41ms
```

3. Změňte Ztrátovost na `50` a ping opakujte: část ech skončí `Request timed out.` a pod výpisem
   se objeví věta o ztrátě na kabelu R1 – R2.
4. Na plátně sledujte obálku, která letí z PC1 přes R1 a R2 k PC2 a zpět. Při 100 % ztrátě skončí
   červeným křížkem u R1.
