# Tabulka MAC adres a ARP

Webová verze NetSketch umí na konzoli Cisco IOS vypsat tabulku MAC adres přepínače
(`show mac address-table`) a ARP tabulku (`show arp`, `show ip arp`). Tabulky nejsou součástí
projektu: jsou to **stav běžící sítě**, který po sobě zanechává provoz (ping, traceroute, TCP, DHCP),
a po znovunačtení stránky zmizí, stejně jako na skutečném zařízení po restartu. Model je
deterministický: stejné zapojení a stejné příkazy dají vždy stejné tabulky. Čas neplyne, nic nestárne.

## Model učení

Jeden skok paketu vede z rozhraní S (odesílatel) na rozhraní R (příjemce) v jedné L2 doméně.

- **MAC přepínače**
  - ARP žádost je broadcast, proto se MAC adresu S naučí **každý přepínač**, který doménu přemosťuje,
    na portu, který míří k S (ve VLAN, kterou ten přepínač pro doménu používá).
  - Odpověď je unicast, proto se MAC adresu R naučí jen přepínače **na cestě** mezi S a R, na portu
    směrem k R.
  - Host, který nic neposlal a nic nedostal, v tabulce není. Zápis se přesune na konec, když se
    adresa objeví na jiném portu (vyhrává nejnovější).
- **ARP**
  - Odesílatel se naučí adresu skoku -> MAC příjemce, příjemce adresu S -> MAC odesílatele. Router se tak
    naučí PC za přepínačem a PC svou bránu; skok přes několik routerů se učí na každém úseku zvlášť.
  - Navíc každé routované rozhraní zná souseda na druhém konci kabelu, pokud je to také routovaný port
    se stejnou sítí (přímo spojené routery se znají bez pingu). Tyto záznamy se přidají jednou;
    `clear arp-cache` je odstraní natrvalo, dokud provoz nebo nový kabel nepřinese znovu.
  - Vlastní adresy rozhraní jsou v tabulce vždy, s `-` ve sloupci stáří.
- MAC adresy jsou deterministické adresy ze `sim/mac.ts` (odvozené z ID portu; SVI používá MAC prvního
  portu zařízení). Jsou stejné jako v `ipconfig /all`, `show ip dhcp binding` a STP.
- Skok, na který nikdo neodpoví na ARP (chybí kabel, VLAN, adresa), nic nenaučí; skoky před ním, které
  proběhly, ano.
- Při čtení se zápisy ověřují proti diagramu: port bez fungujícího kabelu, rozhraní, které už nemá danou
  adresu, a odpojené zařízení se nevypisují.

## Cisco IOS

```
show mac address-table [dynamic] [vlan N | interface IF]     (také show mac-address-table)
show arp
show ip arp [A.B.C.D | vlan N]
clear mac address-table dynamic [vlan N | interface IF]      (také clear mac-address-table)  # privilegovaný režim
clear arp-cache                                              # i clear ip arp
```

Příkazy fungují i s `do` v konfiguračních režimech. Podporují se dialekty `ios` a `generic`
(Cisco a obecná syntaxe ve stylu Cisco).

```
SW1#show mac address-table
          Mac Address Table
-------------------------------------------

Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
   1    0212.3456.789a    DYNAMIC     Fa0/1
   1    0245.6789.abcd    DYNAMIC     Fa0/24
Total Mac Addresses for this criterion: 2

R1#show ip arp
Protocol  Address          Age (min)  Hardware Addr   Type   Interface
Internet  192.168.10.1            -   0245.6789.abcd  ARPA   GigabitEthernet0/0/0
Internet  192.168.10.11           0   0212.3456.789a  ARPA   GigabitEthernet0/0/0
```

Pod výpisy konzole přidá poznámku `NetSketch:` o tom, jak se tabulka plní. Na zařízení, které není
přepínač, `show mac address-table` a `clear mac address-table` odpoví, že tabulku MAC nemá.

## Pro ostatní výrobce

Logika je mimo kód Cisca, ve `web/src/cli/features/macarp/`:

- `model.ts`: běhový stav a pohledy. `macTable(sim, deviceID)`, `arpTable(sim, deviceID)`,
  `clearMacTable(deviceID, filtr?)`, `clearArpCache(deviceID)`, `interfaceMAC`, `formatMAC(mac, "cisco" | "windows" | "colon")`.
  Funguje pro každé zařízení (i PC), proto z něj může později číst `arp -a` hostů, MikroTik
  `/ip arp` nebo Dell `show arp`.
- `sim.ts`: funkce simulace, která po každém sledovaném paketu volá učení (nový hák `delivered` v
  `SimFeature`, `sim/packet.ts`).
- `ios.ts`: příkazy a formát Cisco. Další výrobce přidá jen svůj soubor s příkazy a formátem.

`NetworkSimulator` má kvůli tomu dvě malé veřejné metody: `framePath` (kabely, kterými jde rámec) a
`bridgesInDomain` (přepínače, které přemosťují doménu).

## Co chybí

- Stárnutí záznamů (`mac address-table aging-time`, sloupec Age je vždy 0), omezení velikosti tabulky.
- Statické záznamy (`mac address-table static`), záznamy CPU, `port-security`, `show mac address-table count`
  a `address`.
- Flooding neznámého unicastu: odpovídá se jen na to, co se naučilo; přepínače mimo cestu se
  nenaučí MAC příjemce.
- Dell OS9 a OS6, MikroTik, UniFi a PC: tabulky se plní (stejný model), ale jejich příkazy zatím
  vypisují jen oznámení.
- Gratuitous ARP, proxy ARP, ARP timeout a `arp A.B.C.D MAC` (statické ARP).
