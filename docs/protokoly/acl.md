# Paketové filtry: ACL a firewall

NetSketch (webová verze) simuluje filtrování paketů na routerech a L3 přepínačích: přístupové seznamy
(ACL) Cisco IOS a Dell OS9 a pravidla `/ip firewall filter` na MikroTiku. Filtr rozhoduje o každém
paketu, který projde simulací sítě (`ping`, `traceroute`, TCP spojení z `Test-NetConnection` nebo
`telnet`). Když paket zahodí, `ping` a spol. za výpisem zařízení vypíšou česky, **kde a proč**
(zařízení, rozhraní, směr, seznam a konkrétní řádek).

Konfigurace je součástí projektu (`protocols.acl` zařízení), takže se ukládá se souborem, každý příkaz
je jeden krok zpět a `show running-config` / `/export` ji zobrazí.

## Co se simuluje

- **Cisco IOS a Dell OS9: seznam na rozhraní.** Seznam navázaný `ip access-group NÁZEV in` se vyhodnotí
  pro pakety, které na rozhraní přicházejí, seznam `out` pro pakety, které rozhraním odcházejí. První
  vyhovující řádek rozhoduje, na konci seznamu je **implicitní deny**. Navázaný seznam, který
  neexistuje (nebo nemá žádný řádek), propouští všechno.
- **Pakety, které router sám vytvoří, nefiltruje jeho odchozí seznam** (jako IOS). Příchozí seznam
  filtruje i pakety určené samotnému routeru.
- **MikroTik: řetězce.** `forward` platí pro pakety směrované přes router, `input` pro pakety určené
  routeru, `output` pro pakety, které router sám posílá. Pravidla se čtou shora dolů, první shoda
  rozhoduje, bez shody se paket propustí (`accept`). `drop` zahodí paket mlčky, `reject` a zákaz
  v ACL pošlou odesílateli zprávu o nedostupnosti („administratively prohibited“, symbol `U`; `telnet`
  z IOS ji ukáže jako `% Destination unreachable`, mlčky zahozený paket jako časový limit).
- **Odpověď je také paket.** Echo odpověď i odpověď TCP spojení (SYN-ACK) projdou filtry zpátky stejně
  jako požadavek. Proto seznam, který pouští jen jeden směr, může způsobit „požadavek došel, ale
  odpověď ne“.
- **TCP spojení.** Pro zkoušení portů umí PC příkazy `Test-NetConnection` a `telnet`, router IOS příkaz
  `telnet`. Spojení se naváže, když SYN dojde k cíli a odpověď se vrátí. Servery poslouchají na každém
  portu, routery a přepínače jen na 22 a 23, PC na žádném (spojení je pak odmítnuto, „refused“).

## Cisco IOS

### Číslované seznamy

```
access-list 10 deny host 192.168.1.10
access-list 10 permit any
access-list 101 deny icmp any any echo
access-list 101 permit tcp 192.168.1.0 0.0.0.255 any eq www 443
access-list 101 permit udp any any eq domain
access-list 101 remark zbytek se zahodi
```

- čísla 1–99 a 1300–1999 jsou standardní seznamy (filtrují podle zdrojové adresy), 100–199 a 2000–2699
  rozšířené (protokol, zdroj, cíl, porty),
- adresa: `any`, `host A.B.C.D` nebo `A.B.C.D W.W.W.W` (wildcard maska); u standardního seznamu stačí
  `A.B.C.D`,
- protokoly `ip`, `icmp`, `tcp`, `udp`; porty `eq` (i víc hodnot: `eq 80 443`), `neq`, `gt`, `lt`,
  `range A B`, jména jako `www`, `telnet`, `ssh` (uloží se jako 22), `domain`, `ftp`, `smtp`, `pop3`, `ntp`,
- ICMP: `echo`, `echo-reply` (ostatní typy se přijmou, ale simulované pakety jsou jen echo),
- `established` u TCP (viz zjednodušení), `log` se přijme a ukáže ve výpisu, bez dalšího účinku,
- `no access-list 101` smaže celý seznam.

### Pojmenované seznamy

```
ip access-list extended BLOCK_WEB
 permit ip any any
 5 deny tcp any any eq www
 remark vse ostatni je povoleno
 no 20
 exit
ip access-list resequence BLOCK_WEB 100 10
no ip access-list extended BLOCK_WEB
```

Režim má výzvu `(config-std-nacl)#` nebo `(config-ext-nacl)#`. Řádek bez čísla se přidá na konec
(poslední číslo + 10), s číslem se vloží na své místo; stejné číslo dvakrát je chyba
`% Duplicate sequence number`. `no 10` odebere řádek podle čísla, `no permit …` podle obsahu.
Seznam lze upravovat i příkazem `ip access-list standard|extended 101` pro číselný seznam.

### Navázání na rozhraní

```
interface GigabitEthernet0/0/0
 ip access-group BLOCK_WEB in
 no ip access-group BLOCK_WEB in
```

Funguje na portech routeru i na rozhraních VLAN (SVI) L3 přepínače. Na přepínaném (L2) portu se
filtrování nesimuluje, příkaz to řekne a nic nezmění.

### Výpisy

- `show access-lists [číslo|název]`, `show ip access-lists [...]`,
- `show running-config`: číslované seznamy jako `access-list …`, pojmenované jako `ip access-list …`,
  navázání jako ` ip access-group … in|out` pod rozhraním,
- `telnet A.B.C.D [port]` v EXEC režimu: `Trying … Open`, `% Connection refused by remote host`,
  `% Connection timed out; remote host not responding` nebo `% Destination unreachable; gateway or host
  down` (když paket zakázal seznam a router poslal zprávu „administratively prohibited“).

## Dell OS9

```
ip access-list extended BLOCK
 seq 5 deny icmp host 10.10.10.10 any
 seq 10 permit tcp 10.10.10.0/24 any eq 80
 exit
interface vlan 10
 ip access-group BLOCK in
```

Řádky `seq N permit|deny …` (bez `seq` se číslo přidělí po pěti), sítě se píší `A.B.C.D/NN`, porty jen
čísly (wildcard masky ani jména portů Dell nemá). `no seq 5` řádek odebere. Výpis: `show ip access-lists`
a `show running-config`.

## MikroTik RouterOS

```
/ip firewall filter
add chain=forward protocol=icmp src-address=192.168.88.0/24 action=drop comment="zadny ping"
add chain=forward protocol=tcp dst-port=80,443 in-interface=ether2 action=reject
add chain=input protocol=tcp dst-port=22,23 action=drop
add chain=forward connection-state=established,related action=accept place-before=0
print
disable 0
enable 0
set 1 action=drop
comment 1 comment=web
remove 2
export
```

Vlastnosti: `chain` (input, forward, output; povinná), `action` (accept, drop, reject), `protocol`
(tcp, udp, icmp), `src-address`, `dst-address` (adresa, síť `A.B.C.D/NN` nebo rozsah `A-B`),
`src-port`, `dst-port` (`80`, `20-21`, `80,443`), `in-interface`, `out-interface`, `connection-state`,
`comment`, `disabled=yes|no`, `place-before=N`. Před hodnotu lze dát `!` (negace). `print` vypisuje ve
stylu RouterOS 7 (`Flags: X - disabled …`, číslované řádky, komentář jako `;;;`), `/export` a
`/ip firewall export` pravidla přidají do skriptu. `log`/`log-prefix` se přijmou a ignorují.

## Zjednodušení proti skutečným zařízením

- Simulace nesleduje spojení. `established` (IOS) a `connection-state` (MikroTik) proto poznají odpověď
  podle portů: TCP/UDP paket na port od 49152 výš ze zdrojového portu pod 49152 (zkušební spojení
  `Test-NetConnection` a `telnet` používají porty od 49152) a ICMP echo odpověď. Stav `new` platí pro
  ostatní pakety, `invalid` a `untracked` nikdy.
- ACL na L2 portech přepínače (port ACL, VACL) a vlastní řetězce MikroTiku (`jump`) se nesimulují.
- Počítadla zásahů (`(4 matches)`) nejsou; `show access-lists` je neukazuje.
- Z `show ip interface` se nedá zjistit navázaný seznam; použijte `show running-config`.
- Nesimulují se další vlastnosti ACL (`time-range`, `dscp`, `fragments`, příznaky TCP kromě
  `established`), seznamy adres MikroTiku a akce kromě accept/drop/reject.
- Filtr MikroTiku `forward` vidí paket před zdrojovým NATem, pokud je cíl paketu jiný než router samotný;
  přeložený paket (port forwarding) vidí až po překladu.
- Jména se nepřekládají (`telnet`, `Test-NetConnection` berou jen IP adresy).

## Příklad

Topologie: `PC1 (192.168.1.10) – R1 – R2 – SRV (192.168.2.10)`, statické trasy na obou routerech.

```
R1(config)# access-list 101 deny icmp any any echo
R1(config)# access-list 101 permit tcp any any eq www
R1(config)# access-list 101 deny ip any any
R1(config)# interface gi0/0/0
R1(config-if)# ip access-group 101 in
```

Na `PC1`:

```
C:\> ping 192.168.2.10
Request timed out.
NetSketch: požadavek nedošel – R1 zahodil paket: access-list 101 na rozhraní Gi0/0/0, směr in – řádek „10 deny icmp any any echo“ ho zakázal.

C:\> Test-NetConnection 192.168.2.10 -Port 80
ComputerName     : 192.168.2.10
RemoteAddress    : 192.168.2.10
RemotePort       : 80
InterfaceAlias   : eth0
SourceAddress    : 192.168.1.10
TcpTestSucceeded : True

C:\> Test-NetConnection 192.168.2.10 -Port 22
WARNING: TCP connect to (192.168.2.10 : 22) failed
…
TcpTestSucceeded       : False
NetSketch: spojení se nenavázalo – R1 zahodil paket: … „30 deny ip any any“ ho zakázal.
```

Ping je zakázaný, web (port 80) projde a ostatní porty zahodí poslední řádek. Řádek `10` odeberete tak,
že seznam otevřete jako pojmenovaný a použijete `no 10`:

```
R1(config)# ip access-list extended 101
R1(config-ext-nacl)# no 10
```

Ping ale stále neprojde, protože ho zahodí poslední řádek `deny ip any any`; propustí ho až
`permit icmp any any` vložený před něj (`15 permit icmp any any`).
