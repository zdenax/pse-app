# Spanning tree (STP, RSTP, PVST, MST)

Webová verze NetSketch simuluje protokol kostry sítě: z přepínačů propojených do smyčky vybere kořenový přepínač, spočítá role portů a porty, které by smyčku uzavíraly, zablokuje. Simulace je statická: strom se spočítá z kabeláže a konfigurace pokaždé znovu (po přidání kabelu, vypnutí portu nebo změně priority se okamžitě změní), nic neběží na pozadí a žádný čas neplyne.

## Co se simuluje

- **Kořenový přepínač.** V každé souvislé skupině přepínačů vyhraje nejnižší bridge ID, tedy dvojice (priorita, MAC). Priorita je výchozích 32768, nastavuje se příkazem `spanning-tree vlan N priority P` (Cisco), `spanning-tree mst 0 priority P` nebo prioritou bridge (MikroTik). MAC adresa přepínače je odvozená z jeho prvního portu a je stabilní.
- **Root port.** Na každém neroot přepínači port s nejnižší cenou cesty ke kořeni. Při shodě rozhoduje bridge ID souseda, ID portu souseda a nakonec vlastní ID portu.
- **Designated port.** Na každém kabelu ten konec, jehož přepínač nabízí lepší cestu ke kořeni (cena, bridge ID, ID portu). Kořenový přepínač má všechny porty designated.
- **Alternate / backup port.** Konec kabelu, který není ani root, ani designated. **Blokuje** provoz (`blocking`). Backup se objeví jen u kabelu mezi dvěma porty téhož přepínače.
- **Disabled.** Port vypnutý příkazem `shutdown` nebo kabel, jehož druhý konec je vypnutý.
- **Cena portu.** Odvozená z rychlosti kabelu (pomalejší konec rozhoduje), dlouhá škála IEEE 802.1D-2004: 10M = 2000000, 100M = 200000, 1G = 20000, 10G = 2000. Lze ji přepsat (`spanning-tree cost N`). Priorita portu je výchozích 128 (`spanning-tree port-priority`).
- **Port-channel.** Zařazené členy jednoho EtherChannelu počítá strom jako jeden port se součtem rychlostí (viz [etherchannel.md](etherchannel.md)).
- **Edge porty.** Port s PortFast a port směřující k zařízení, které STP nepoužívá (PC, server, router), je edge a vždy forwarding.
- **Režim `none`.** Přepínač s vypnutým STP BPDU ani neposílá, ani nepřeposílá, do stromu nepatří a nic neblokuje; smyčka přes takové přepínače zůstává.

### Vliv na simulaci

Blokovaný port nepřenáší rámce: cesta paketu (animace, `traceroute`) vede jen po forwarding kabelech. Dosažitelnost se rozhoduje podle layer-2 domén; správný strom doménu nikdy nerozdělí, takže smyčka v kabeláži ping nerozbije. Na plátně se blokované porty označují značkou na kabelu.

## Programové rozhraní

`computeSpanningTree(project)` v `web/src/cli/features/layer2/stp.ts` vrací pro každý přepínač (klíč = id zařízení) `STPBridgeInfo`: bridge ID (`priorita.MAC`), root bridge ID, cenu ke kořeni, root port a seznam kabelem připojených portů s rolí (`root`, `designated`, `alternate`, `backup`, `disabled`), stavem, cenou, prioritou a příznakem edge. `spanningTreePortStates(project)` z toho udělá mapu `"deviceID|portID"` na stav pro plátno.

## Zjednodušení oproti skutečným zařízením

- Jeden strom pro všechny VLAN. PVST, Rapid-PVST, MST (instance 0), STP a RSTP se počítají stejně; neexistuje strom na VLAN ani MST instance s mapováním VLAN. Priorita se bere z položky pro všechny VLAN (0), jinak z nejnižší nakonfigurované VLAN.
- BPDU procházejí každým kabelem mezi dvěma přepínači bez ohledu na VLAN a povolené VLAN na trunku.
- Porty přecházejí do stavu forwarding ihned, bez listening a learning, bez časovačů (hello, max age, forward delay) a bez topology change.
- Cena vždy podle dlouhé škály (i pro režimy `stp` a `pvst`, které by na skutečném zařízení použily krátkou: 100M = 19, 1G = 4).
- Přepínač s vypnutým STP se nechová jako průhledný pro BPDU sousedů; jeho okolí tvoří samostatné skupiny.
- Hlášeny jsou jen porty s kabelem. Bez podpory zůstává root guard, loop guard, UplinkFast, BackboneFast a BPDU filter.
