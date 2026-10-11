# DHCP (server, relay, klient)

Webová verze NetSketch simuluje DHCP: server na routeru nebo L3 přepínači, relay agenta (`ip helper-address`) a klienta na PC, routeru i přepínači. Simulace je statická: klient si adresu vyžádá příkazem, výsledek (přidělená adresa, brána) se uloží do projektu jako běžná adresa rozhraní a vidí ji ping, traceroute i inspektor. Nic neběží na pozadí, žádný čas neplyne.

## Co se simuluje

- **Server.** Cisco a Dell mají `ip dhcp pool`, MikroTik trojici `/ip pool`, `/ip dhcp-server` a `/ip dhcp-server network`. Server odpovídá na rozhraní, které má adresu v síti poolu.
- **Relay.** Rozhraní s `ip helper-address A.B.C.D` (MikroTik `/ip dhcp-relay`) předá požadavek serveru jinde v síti. Pool se vybírá podle sítě relay rozhraní (`giaddr`), ne podle sítě serveru.
- **Klient.** `ipconfig /renew` na PC, `ip address dhcp` na rozhraní routeru nebo SVI přepínače, `/ip dhcp-client add` na MikroTiku.

### Jak klient najde server

Klient pošle DISCOVER do svého layer-2 segmentu (stejné kabely, přepínače a VLAN, jaké používá ping). Odpoví první zařízení v tomto segmentu, které

1. má na rozhraní v segmentu adresu ležící v síti některého svého poolu (a pool případně nemá omezení na jiné rozhraní), nebo
2. má na rozhraní v segmentu `ip helper-address` a server z této adresy je dosažitelný: simulace pošle UDP paket na port 67 od relay k serveru a zpět (takže se uplatní trasy, vypnutá rozhraní i případné ACL) a server musí mít pool pro síť relay rozhraní.

Servery se zkoušejí v pořadí zařízení v projektu; vyhrává první, který přidělí adresu.

### Která adresa se přidělí

Deterministicky: nejnižší volná adresa poolu, která

- není ve vyloučeném rozsahu (`ip dhcp excluded-address`),
- není adresa sítě ani broadcast,
- není adresa brány poolu,
- není nastavená na žádném jiném zařízení projektu (adresy rozhraní, statické adresy PC i dřívější přidělené adresy).

Při opakovaném `renew` si klient podrží svoji adresu, pokud je pořád platná. Dva klienti proto dostanou dvě různé adresy a výsledek je při stejné konfiguraci vždy stejný.

Přidělení se zapíše jako jeden krok zpět (Undo): adresa rozhraní, na PC a L2 přepínači výchozí brána, označení rozhraní jako DHCP klienta a záznam o tom, co server sdělil (server, brána, DNS, doména).

## Příkazy

### Cisco IOS (a obecný styl IOS)

| Příkaz | Význam |
| --- | --- |
| `ip dhcp excluded-address A [B]` | vyloučí adresu nebo rozsah (`no` ho vrátí) |
| `ip dhcp pool NAME` | vytvoří pool a vstoupí do režimu `(dhcp-config)#` |
| `network A.B.C.D M.M.M.M` nebo `network A.B.C.D/NN` | síť poolu |
| `default-router A [B ...]` | brána, kterou klient dostane (první z nich) |
| `dns-server A [B ...]` | DNS servery |
| `domain-name NAME`, `lease DNY [HODINY [MINUTY]]`, `lease infinite` | doména a doba zápůjčky |
| `no network`, `no default-router`, `no dns-server`, `no domain-name`, `no lease` | zrušení položky poolu |
| `no ip dhcp pool NAME` | smaže pool |
| `ip helper-address A.B.C.D` (v rozhraní) | relay; `no ip helper-address [A.B.C.D]` ho zruší |
| `ip address dhcp` (v rozhraní nebo `interface vlan N`) | rozhraní je DHCP klient; `no ip address` ho vrátí na ruční adresu |
| `renew dhcp ROZHRANÍ`, `release dhcp ROZHRANÍ` (privilegovaný režim) | znovu si vyžádá adresu, resp. ji vrátí |
| `show ip dhcp binding [A.B.C.D]` | tabulka přidělených adres s MAC adresou klienta |
| `show ip dhcp pool [NAME]` | poolové statistiky (velikost, počet přidělených adres, další adresa) |
| `show running-config` | obsahuje `ip dhcp excluded-address`, `ip dhcp pool` i `ip helper-address` |

Další příkazy poolu (`option`, `netbios-name-server`, `next-server`, `bootfile`) a `ip dhcp conflict ...` se přijmou a oznámí, že se neukládají.

### Dell OS9

Syntaxe se liší: server se konfiguruje v režimu `ip dhcp server`, síť se zadává jako `A.B.C.D/NN`.

```
ip dhcp server
 excluded-address 10.0.10.1 10.0.10.9
 pool LAN
  network 10.0.10.0/24
  default-router 10.0.10.1
  dns-server 1.1.1.1
  lease 0 8
```

Prompty jsou `(conf-dhcp)#` a `(conf-dhcp-LAN)#`. `ip helper-address` a `ip address dhcp` se zadávají na rozhraní (včetně `interface vlan N`), `show ip dhcp binding` vypíše tabulku v dellovském formátu, `no ip dhcp server` smaže celou konfiguraci serveru. Přesná podoba příkazů OS9 se může lišit podle verze firmwaru; ostatní příkazy `show ip dhcp ...` hlásí, že vyžadují simulaci.

### MikroTik RouterOS

| Příkaz | Význam |
| --- | --- |
| `/ip pool add name= ranges=A-B[,C-D]`, `print`, `remove` | rozsahy adres |
| `/ip dhcp-server add name= interface= address-pool= [lease-time=] [disabled=]`, `print`, `set`, `remove`, `enable`, `disable` | DHCP server na rozhraní |
| `/ip dhcp-server network add address=NET/NN gateway= dns-server= [domain=]`, `print`, `remove` | parametry sítě, které klient dostane |
| `/ip dhcp-server lease print` | přidělené adresy (MAC, jméno klienta, server) |
| `/ip dhcp-client add interface=`, `print`, `remove`, `renew`, `release` | router jako klient |
| `/ip dhcp-relay add interface= dhcp-server= [name=] [disabled=]`, `print`, `remove`, `enable`, `disable` | relay |
| `/export` | obsahuje `/ip pool`, `/ip dhcp-server`, `/ip dhcp-server network`, `/ip dhcp-client`, `/ip dhcp-relay` |

Stejně jako na skutečném RouterOS vzniká `/ip dhcp-server add` i `/ip dhcp-relay add` **vypnuté** (`disabled=yes`). Zapnete je `enable` nebo `disabled=no` při vytvoření; do té doby simulace vysvětlí, proč klient adresu nedostal. Server navíc potřebuje záznam v `/ip dhcp-server network`, který pokrývá rozsah poolu.

### PC (příkazový řádek)

| Příkaz | Význam |
| --- | --- |
| `ipconfig /renew [adaptér]` | vyžádá adresu pro všechny adaptéry bez statické adresy nebo s DHCP, případně jen pro pojmenovaný (jsou povoleny hvězdičky, např. `eth*`) |
| `ipconfig /release [adaptér]` | vrátí adresu a bránu |
| `ipconfig /all` | přidává fyzickou adresu (MAC), `DHCP Enabled`, `DHCP Server`, `DNS Servers` a doménu |
| `netsh interface ip set address eth0 dhcp` | zapne DHCP na adaptéru a hned si vyžádá adresu |
| `netsh interface ip set address eth0 static ...` | vrátí adaptér na statickou adresu |

## Chybová hlášení

Když server neodpoví, PC vypíše hlášku jako Windows:

```
An error occurred while renewing interface eth0 : unable to contact your DHCP server. Request has timed out.
NetSketch: DHCP neuspělo – <důvod česky>
```

Možné důvody: na rozhraní není kabel nebo je vypnuté (u PC místo toho `No operation can be performed on eth0 while it has its media disconnected.`), v segmentu není žádný server ani relay, pool patří do jiné sítě než rozhraní serveru, pool nemá `network`, MikroTik server je vypnutý nebo mu chybí záznam `network`, pool je vyčerpaný, relay neumí doručit požadavek serveru, nebo server nemá trasu zpět k síti relay rozhraní. U routeru a SVI (`ip address dhcp`) dostanete stejné vysvětlení; rozhraní zůstane DHCP klientem bez adresy a později ho opravíte příkazem `renew dhcp`.

Při úspěchu vypíše router řádek `%DHCP-6-ADDRESS_ASSIGN: Interface ... assigned DHCP address ...`.

## Zjednodušení oproti skutečným zařízením

- Žádné časování: zápůjčka nevyprší, `lease` jen určuje datum ve výpisu (výchozí čas je pevný, 1. ledna 2026 0:00). Přidělená adresa platí, dokud ji nezměníte (`renew`, `release`, ruční adresa), i když server zmizí.
- Klient si adresu vyžádá jen příkazem. Po opravě sítě nebo konfigurace serveru proto zadejte `ipconfig /renew`, `renew dhcp` nebo `/ip dhcp-client renew`.
- Přidělení se řídí jen sítí poolu a vyloučenými adresami. Klienty, kteří adresu mají, tabulky `show ip dhcp binding` a `/ip dhcp-server lease print` odvozují z projektu (adresa v poolu a server, který lease poslal); není to skutečná databáze serveru, `clear ip dhcp binding` proto není podporován.
- Rozhraní má v NetSketch jedinou adresu. Na MikroTiku `/ip dhcp-client add` nahradí ruční adresu rozhraní a adresa z DHCP se ve `/ip address print` zobrazí jako obyčejná (bez příznaku D).
- Výchozí brána se z DHCP nastaví na PC, serverech a L2 přepínačích. Router nebo L3 přepínač s `ip address dhcp` bránu nepřevezme (nevznikne výchozí trasa); přidejte ji ručně.
- Nepodporováno: DHCP options, rezervace podle MAC (`host`, `client-identifier`), konflikty adres, více podsítí v jednom poolu, VRF, DHCPv6. `show ip interface brief` u DHCP rozhraní ve sloupci Method stále uvádí `manual`.
- Odpověď relay se kontroluje jen UDP paketem 67 tam a zpět po trasách; inbound ACL na rozhraní klienta se pro samotný DISCOVER neuplatní.

## Příklad

Topologie: `PC1` a `PC2` připojená k přepínači `SW`, ten k routeru `R1` (rozhraní `Gi0/0/0`).

```
R1(config)# interface gi0/0/0
R1(config-if)# ip address 192.168.10.1 255.255.255.0
R1(config-if)# no shutdown
R1(config-if)# exit
R1(config)# ip dhcp excluded-address 192.168.10.1 192.168.10.10
R1(config)# ip dhcp pool LAN10
R1(dhcp-config)# network 192.168.10.0 255.255.255.0
R1(dhcp-config)# default-router 192.168.10.1
R1(dhcp-config)# dns-server 8.8.8.8
R1(dhcp-config)# end
```

Na PC1:

```
C:\> ipconfig /renew
Windows IP Configuration

Ethernet adapter eth0:

   Media State . . . . . . . . . . . : Media connected
   Cabled to . . . . . . . . . . . . : SW Fa0/1
   IPv4 Address . . . . . . . . . .  : 192.168.10.11
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : 192.168.10.1

C:\> ping 192.168.10.1
Reply from 192.168.10.1: bytes=32 time<1ms TTL=255
...
```

PC2 po `ipconfig /renew` dostane `192.168.10.12`. Na routeru:

```
R1# show ip dhcp binding
Bindings from all pools not associated with VRF:
IP address      Client-ID/              Lease expiration        Type       State      Interface
                Hardware address/
                User name
192.168.10.11   0102.ed8c.ef74.f5       Jan 02 2026 12:00 AM    Automatic  Active     GigabitEthernet0/0/0
192.168.10.12   0102.2f1a.cd75.62       Jan 02 2026 12:00 AM    Automatic  Active     GigabitEthernet0/0/0
```

(MAC adresy jsou odvozené z ID portů, takže se u každého projektu liší.)

### Relay

Chcete-li mít server jinde (`R2`, adresa `10.0.0.2`, za routerem `R1` s adresou `10.0.0.1`), přidejte na `R1` do rozhraní `Gi0/0/0`:

```
R1(config-if)# ip helper-address 10.0.0.2
```

a na `R2` pool pro síť `192.168.10.0/24` a trasu zpět `ip route 192.168.10.0 255.255.255.0 10.0.0.1`. Bez zpětné trasy PC vypíše: `NetSketch: DHCP neuspělo – odpověď serveru R2 se nedostane zpět k relay R1 (Gi0/0/0) (192.168.10.1): R2 nemá trasu …`. Adresu přidělí pool, jehož síť obsahuje adresu relay rozhraní (`192.168.10.1`), takže jeden server může obsluhovat víc sítí za víc relay rozhraními.
