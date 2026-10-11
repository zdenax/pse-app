# NAT a PAT (překlad adres)

Webová verze NetSketch simuluje překlad síťových adres na routerech Cisco IOS a MikroTik RouterOS.
Konfigurace se ukládá do projektu (`Device.protocols.nat`), překládané spojení (tabulka překladů) je
jen stav běžící sítě: po znovunačtení stránky zmizí, stejně jako na skutečném zařízení po restartu.

## Co se simuluje

- **Statický NAT** (1:1): vnitřní adresa se vždy mění na pevnou vnější adresu a naopak. Vnější strana
  se tak dostane k vnitřnímu serveru.
- **Dynamický NAT s poolem**: každý vnitřní počítač dostane volnou adresu z poolu. Když pool dojde
  a pravidlo nemá `overload`, další paket se zahodí a ping vysvětlí proč.
- **PAT (overload)**: mnoho vnitřních počítačů sdílí jednu vnější adresu (první adresa poolu nebo
  adresa vnějšího rozhraní). Rozlišují se čísly portů (TCP/UDP) a identifikátory dotazu (ICMP).
- **MikroTik**: `masquerade`, `src-nat` a `dst-nat` (včetně `protocol`, `dst-port`, `to-ports`).
  Odpovědi přeloženého spojení se vracejí automaticky, jako při sledování spojení na RouterOS.
- Cesta paketu: router překládá zdrojovou adresu u paketu, který přišel na vnitřním rozhraní a
  odchází vnějším, a cílovou adresu u paketu přicházejícího na vnějším rozhraní. Ping přes NAT
  proto funguje celý (požadavek i odpověď) a server vidí vnější (globální) adresu.
- Router odpovídá na ARP za statické globální adresy a adresy poolu na svém vnějším rozhraní,
  takže server ve stejné síti je najde bez další konfigurace.
- Dynamické pravidlo odkazuje na seznam přístupu podle jména (`ip nat inside source list 1 ...`).
  Seznam se čte z konfigurace ACL téhož routeru; pravidlo se použije, jen když první odpovídající
  řádek seznamu je `permit`. Seznam, který neexistuje, nepovoluje nic.

## Cisco IOS

Rozhraní (fyzické porty routeru i rozhraní `Vlan`):

```
interface GigabitEthernet0/0/0
 ip nat inside
interface GigabitEthernet0/0/1
 ip nat outside
 no ip nat outside
```

Rozhraní je buď inside, nebo outside; nové nastavení to druhé zruší. Na přepínaném (L2) portu
přepínače příkaz nelze použít.

Globální konfigurace:

| Příkaz | Význam |
| --- | --- |
| `ip nat pool NAME START END netmask M` (nebo `prefix-length N`) | pool vnějších adres |
| `ip nat inside source static LOCAL GLOBAL` | statický překlad |
| `ip nat inside source list ACL pool NAME [overload]` | dynamický překlad z poolu |
| `ip nat inside source list ACL interface IF overload` | PAT na adresu rozhraní |
| `no ...` | zruší stejnou položku (pool lze smazat, až když ho nic nepoužívá) |

Výpisy a mazání:

- `show ip nat translations`: sloupce `Pro`, `Inside global`, `Inside local`, `Outside local`,
  `Outside global`. Statické položky (`---`) jsou vidět vždy, ostatní vznikají až provozem.
- `show ip nat statistics`: počty překladů, rozhraní inside/outside, počet zásahů a minutí,
  dynamická pravidla a využití poolu.
- `clear ip nat translation *`: vymaže dynamické záznamy (statické pravidlo zůstává).
- `show running-config` obsahuje `ip nat inside` / `ip nat outside` na rozhraních a pravidla
  `ip nat pool` / `ip nat inside source ...` za rozhraními.

## MikroTik RouterOS

Menu `/ip firewall nat`:

```
/ip firewall nat add chain=srcnat action=masquerade out-interface=ether1 [src-address=192.168.1.0/24]
/ip firewall nat add chain=srcnat action=src-nat to-addresses=203.0.113.9 [src-address=...] [out-interface=...]
/ip firewall nat add chain=dstnat action=dst-nat dst-address=203.0.113.1 to-addresses=192.168.1.50 \
    [protocol=tcp dst-port=80 to-ports=8080] [in-interface=ether1]
/ip firewall nat print
/ip firewall nat remove 0
/ip firewall nat disable 0
/ip firewall nat enable 0
/ip firewall nat export
```

- `masquerade` používá adresu výstupního rozhraní (`out-interface`), `src-nat` pevnou adresu
  z `to-addresses`.
- `dst-nat` mění cílovou adresu (a případně port). Bez `protocol` platí i pro ping, s
  `protocol=tcp dst-port=80` jen pro TCP na port 80.
- Vypnuté pravidlo (příznak `X`) se nepoužije; pravidlo s neexistujícím rozhraním má příznak `I`.
- `/export` vypisuje pravidla v sekci `/ip firewall nat` (parametry řazené abecedně, jako RouterOS).

## Zjednodušení proti skutečným zařízením

- Časové limity překladů se nesimulují: záznam zůstane, dokud ho nesmažete příkazem `clear ...`
  (nebo nezmizí s obnovením stránky). Změníte-li pravidlo nebo seznam přístupu, už vytvořené
  překlady zůstávají (stejně jako na zařízení) a je potřeba tabulku vyčistit.
- Simulace nemá čísla ICMP dotazů, ID dotazu v tabulce je počítadlo záznamů. Odpověď na ping se
  přiřadí k překladu podle dvojice adres a podle toho, že na ni čeká odeslaný požadavek.
- Překládá se jen zdrojová adresa vnitřních hostitelů (`inside source`) a cílová adresa MikroTik
  `dst-nat`. Překlad vnější strany (`ip nat outside source`), `ip nat inside destination`, statický
  překlad portů (`static tcp ...`), NAT pro provoz generovaný samotným routerem a `redirect`/`netmap`
  na MikroTiku se nesimulují (příkazy jsou přijaty a nic neukládají, nebo jsou odmítnuty s vysvětlením).
- Pool s `overload` používá první adresu poolu, ostatní adresy slouží jen pro ARP odpovědi.
- `src-nat` na MikroTiku používá první adresu z `to-addresses` (rozsah adres se nerozděluje).
- Router překládá jen pakety, které prošly přes něj mezi dvěma jeho rozhraními; ARP odpovídá na
  globální adresy jen Cisco (na MikroTiku musí být adresa nastavena na rozhraní).

## Příklad: PAT pro dva počítače

Topologie: PC1 (192.168.1.10) a PC2 (192.168.1.11) na přepínači SW1, ten na `Gi0/0/0` routeru R1
(192.168.1.1/24, inside); `Gi0/0/1` routeru R1 (203.0.113.1/24, outside) vede k serveru WEB
(203.0.113.100). Počítače mají bránu 192.168.1.1.

```
R1(config)# access-list 1 permit 192.168.1.0 0.0.0.255
R1(config)# interface gi0/0/0
R1(config-if)# ip nat inside
R1(config-if)# interface gi0/0/1
R1(config-if)# ip nat outside
R1(config-if)# exit
R1(config)# ip nat inside source list 1 interface gi0/0/1 overload
R1(config)# end
```

Na PC1 `ping 203.0.113.100` odpoví čtyřikrát (`Reply from 203.0.113.100`). Server ale vidí zdroj
203.0.113.1, ne 192.168.1.10. Na routeru:

```
R1# show ip nat translations
Pro Inside global      Inside local       Outside local      Outside global
icmp 203.0.113.1:1      192.168.1.10:1     203.0.113.100:1    203.0.113.100:1
R1# clear ip nat translation *
```

Bez `ip nat outside` na `Gi0/0/1` (nebo bez `ip nat inside` na `Gi0/0/0`) se nic nepřeloží: server
dostane paket s adresou 192.168.1.10. Když nemá cestu zpět, ping selže a NetSketch vypíše, kde
odpověď uvázla.

Statický NAT pro server v LAN: `ip nat inside source static 192.168.1.50 203.0.113.50`. Ping
z WEB na 203.0.113.50 pak dojde na vnitřní server a odpověď se vrátí s globální adresou.

Pool bez overload (`ip nat pool OUT 203.0.113.10 203.0.113.11 netmask 255.255.255.0`,
`ip nat inside source list 1 pool OUT`) vystačí na dva počítače; třetí ping skončí zprávou, že
pool R1 nemá volnou adresu.

## Příklad: MikroTik

```
/ip address add address=192.168.1.1/24 interface=ether2
/ip address add address=203.0.113.1/24 interface=ether1
/ip firewall nat add chain=srcnat action=masquerade out-interface=ether1
/ip firewall nat add chain=dstnat action=dst-nat dst-address=203.0.113.1 protocol=tcp dst-port=80 to-addresses=192.168.1.50
/ip firewall nat print
```

Ping z vnitřní sítě na server projde a server vidí adresu `ether1`. Bez pravidla `masquerade` se
zdrojová adresa nezmění.
