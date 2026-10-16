# Katalog zařízení (`devices.json`)

Katalog popisuje modely zařízení, které lze v NetSketchi umístit na plátno: jejich porty
(názvy, konektory, rychlosti) a rozvržení předního panelu. Tento dokument popisuje formát
souboru `Sources/NetSketchCore/Resources/devices.json`, odkud se katalog načítá, jak se
generují názvy portů, jak se hlásí chyby a jak přidat nové zařízení.

Zdrojem pravdy je kód v `Sources/NetSketchCore`:
`Models/DeviceTemplate.swift`, `Models/PortGroup.swift`, `Models/PanelLayout.swift`,
`Models/Enums.swift` a `Catalog/DeviceCatalog.swift`.

> **Důležité:** všechny šablony ve vestavěném katalogu mají `"verified": false`, a to na
> úrovni šablony i každé skupiny portů. Počty portů, jejich názvy, rychlosti, konektory
> i rozvržení panelu byly sepsány bez fyzické kontroly a je nutné je ověřit podle
> skutečného hardwaru (výpis `show interfaces status` / `show interfaces`, štítky na panelu,
> datasheet). Dokud příznak není `true`, aplikace u zařízení zobrazuje upozornění
> „Ověřit podle hardwaru“.

## 1. Odkud se katalog načítá

Katalog (`DeviceCatalog`) se skládá ze dvou částí: **vestavěných** šablon a **vlastních**
(uživatelských) šablon. Načítá se při startu aplikace; změny souborů na disku se projeví
až po novém spuštění.

| Soubor | Role |
|---|---|
| `devices.json` přibalený k modulu `NetSketchCore` | vestavěný katalog (výchozí) |
| `<support>/devices.json` | **náhrada** vestavěného katalogu: pokud existuje a lze ho načíst, vestavěný soubor se vůbec nepoužije (nejde o sloučení, nahrazuje se celý) |
| `<support>/custom-devices.json` | vlastní šablony; zapisuje je aplikace (dialog „Nové zařízení…“) |

`<support>` je `~/Library/Application Support/NetSketch` (přesně: adresář
`.applicationSupportDirectory` uživatelské domény + `NetSketch`, viz
`DeviceCatalog.defaultSupportDirectory`). Adresář se vytvoří při prvním uložení vlastní
šablony. Testy a přepínač `--catalog-info` používají `DeviceCatalog(supportDirectory: nil)`,
tedy jen přibalený soubor bez čtení a zápisu na disk.

Přibalený soubor se hledá (`DeviceCatalog.bundledDevicesURL`) v SwiftPM resource bundlu
`NetSketch_NetSketchCore.bundle` postupně v `Contents/Resources` aplikace, vedle `.app`,
vedle spustitelného souboru, pak jako volný `devices.json` v hlavním bundlu a nakonec přes
`Bundle.module`. Skript `scripts/make-app.sh` kopíruje bundle do `Contents/Resources`.
Spuštění `NetSketch --catalog-info` vypíše, kde byl soubor nalezen, počet šablon a případné
problémy (návratový kód 1, pokud není žádná šablona).

Pořadí a priorita:

1. Vestavěné šablony (z náhradního souboru, jinak z přibaleného) v pořadí podle souboru.
2. Vlastní šablony v pořadí přidání. Vlastní šablona se stejným `id` jako vestavěná se ignoruje.
3. Paleta seskupuje šablony podle kategorie v pořadí `switch`, `router`, `L3 switch`,
   `AP`, `PC`, `server`; uvnitř kategorie jsou vestavěné před vlastními.

Úprava katalogu bez kompilace: zkopírujte celý `devices.json` do
`~/Library/Application Support/NetSketch/devices.json`, upravte ho a aplikaci restartujte.
Do náhradního souboru je nutné zkopírovat **všechny** šablony, ne jen novou.

## 2. Struktura souboru

```json
{
  "formatVersion": 1,
  "templates": [ { ... }, { ... } ]
}
```

- `formatVersion` (celé číslo, nepovinné, výchozí 1): verze formátu katalogu. Aplikace
  zapisuje 1. Hodnota se při čtení zatím **nekontroluje** (na rozdíl od projektu `.netsketch`,
  který novější verzi odmítne).
- `templates` (pole šablon, povinné, pokud je soubor objekt).
- Místo objektu je přípustné i holé pole šablon `[ { ... }, ... ]`.

Klíče, které dekodér nezná, se tiše ignorují. **Překlep v názvu nepovinného klíče se proto
neohlásí** a místo zadané hodnoty se použije výchozí (např. `"rangeend"` místo `"rangeEnd"`).
Všechny hodnoty výčtů (kategorie, konektor, uspořádání) rozlišují velká a malá písmena.

## 3. Šablona zařízení (`DeviceTemplate`)

| Klíč | Typ | Povinný | Význam |
|---|---|---|---|
| `id` | řetězec | ne | Stabilní identifikátor (slug), např. `cisco-catalyst-2960-24`. Ukládá se do zařízení v projektu jako `templateID`. Okrajové mezery se oříznou; chybí-li nebo je prázdný, odvodí se z `vendor` a `model` (viz níže). Musí být v katalogu jedinečný. |
| `vendor` | řetězec | ne (výchozí `""`) | Výrobce jako prostý text (žádná loga). Určuje také dialekt konfigurační konzole (viz níže). |
| `model` | řetězec | **ano** | Název modelu. U vlastních šablon nesmí být prázdný. |
| `category` | řetězec | **ano** | Kategorie zařízení, jedna z hodnot v tabulce níže. |
| `verified` | bool | ne (výchozí `false`) | Šablona jako celek byla ověřena podle hardwaru. |
| `note` | řetězec | ne | Poznámka; zobrazuje se v nápovědě (tooltipu) palety. |
| `portGroups` | pole | ne (výchozí `[]`) | Skupiny portů, viz kapitola 4. Pořadí určuje pořadí portů. |
| `layout` | objekt | ne | Rozvržení předního panelu, viz kapitola 6. Chybí-li, odvodí se automaticky. |
| `isCustom` | bool | ne | Při načítání se ignoruje: katalog ho nastaví sám (`false` pro vestavěné, `true` pro `custom-devices.json`). |

Hodnoty `category` (výčet `DeviceCategory`):

| Hodnota v JSON | Význam | Prefix automatického hostname |
|---|---|---|
| `"switch"` | L2 přepínač | `SW` (SW1, SW2, ...) |
| `"router"` | směrovač | `R` |
| `"L3 switch"` | L3 přepínač (s mezerou, velké L) | `SW` (sdílí číslování s L2) |
| `"AP"` | přístupový bod | `AP` |
| `"PC"` | počítač | `PC` |
| `"server"` | server | `SRV` |

Kategorie řídí skupinu v paletě, ikonu, výchozí hostname a to, zda má zařízení konzoli:
konfigurační CLI mají jen `switch`, `L3 switch` a `router`.

Dialekt konzole se volí podle `vendor` (hledá se podřetězec bez ohledu na velikost písmen):
`cisco` = Cisco IOS, `dell` = Dell OS9 (modely řady N, např. `N3024`, `N1124T-ON`, mají Dell OS6), `mikrotik` = MikroTik RouterOS, cokoli jiného =
obecný dialekt se syntaxí IOS.

Odvození `id` (`DeviceTemplate.slug`): text `"<vendor> <model>"` se zbaví diakritiky,
převede na malá písmena, zachovají se jen znaky `a-z` a `0-9` a každý úsek jiných znaků
mezi nimi se nahradí jednou pomlčkou. Prázdný výsledek dává `device`. Příklady:
`Dell EMC` + `S3048-ON` = `dell-emc-s3048-on`, `Acme Č` + `Švitch 8` = `acme-c-svitch-8`.
Dialog pro vlastní zařízení k obsazenému slugu přidá `-2`, `-3`, ... (`uniqueID`).

Změna `id` existující šablony nerozbije uložené projekty (zařízení nesou vlastní kopii,
viz kapitola 7), ale jejich `templateID` pak už neukazuje na žádnou šablonu.

## 4. Skupina portů (`PortGroup`)

Skupina je řada podobných portů, např. `Fa0/1` až `Fa0/24`.

| Klíč | Typ | Výchozí | Význam |
|---|---|---|---|
| `prefix` | řetězec | `""` | Text před číslem portu, např. `"Fa0/"`, `"GigabitEthernet 1/"`, `"ether"`. Mezera na konci je součástí názvu. |
| `rangeStart` | celé číslo | `1` | První číslo (včetně). |
| `rangeEnd` | celé číslo | počet `names` (nejméně 1), jinak `rangeStart` | Poslední číslo (včetně). |
| `step` | celé číslo | `1` | Krok číslování; `2` dává 53, 55, ... Hodnoty menší než 1 se berou jako 1. |
| `suffix` | řetězec | `""` | Text za číslem, např. `"s0"` dává `swp1s0`. |
| `names` | pole řetězců | nepřítomno | Explicitní názvy portů. Jsou-li uvedeny, `prefix`, `rangeStart`, `rangeEnd`, `step` a `suffix` se ignorují. |
| `speed` | řetězec | `""` | Nominální rychlost jako volný text: `"100M"`, `"1G"`, `"10G"`, `"40G"`, `"Wi-Fi"`. U konzole prázdné. Nic se podle ní nepočítá. |
| `connector` | řetězec | **povinný** | Typ konektoru, viz tabulka níže. Povinný i pro prázdnou pozici (`placeholder`). |
| `verified` | bool | `false` | Skupina byla ověřena podle hardwaru. Kopíruje se do každého portu. |
| `label` | řetězec | nepřítomno | Krátký popisek sekce panelu, např. `"PoE+"`, `"Uplink"`, `"NIM"`, `"Mgmt"`. Použije se jen u sekce s jedinou skupinou (viz kapitola 6). |
| `placeholder` | bool | `false` | Prázdná pozice pro modul (např. neosazený NIM slot): negeneruje žádné porty, jen rezervuje místo na panelu. |

Hodnoty `connector` (výčet `ConnectorType`):

| Hodnota | Význam | Kresba na panelu |
|---|---|---|
| `"RJ45"` | metalický port | zdířka RJ45 |
| `"SFP"` | modulární klec SFP | klec |
| `"SFP+"` | modulární klec SFP+ | klec |
| `"QSFP+"` | modulární klec QSFP+ | klec se středovou přepážkou |
| `"console"` | konzolový port | zdířka (jiná barva) |
| `"mgmt"` | management port (v CLI nepřijímá konfiguraci VLAN) | zdířka (jiná barva) |
| `"wireless"` | bezdrátové rozhraní, na panelu nemá fyzickou zdířku | značka antény |

`SFP`, `SFP+` a `QSFP+` jsou „modulární“ (`isModular`), což ovlivňuje automatické rozvržení.

## 5. Jak se generují názvy portů

Pro každou skupinu (`PortGroup.portNames`):

1. `placeholder: true` - žádné porty.
2. Jsou-li uvedeny `names` - přesně tyto názvy v uvedeném pořadí.
3. Jinak `prefix + číslo + suffix` pro čísla `rangeStart`, `rangeStart + step`,
   `rangeStart + 2*step`, ... dokud nepřekročí `rangeEnd`. Je-li `rangeStart > rangeEnd`,
   skupina nemá žádné porty (bez chybového hlášení).

Porty zařízení vzniknou spojením skupin v pořadí `portGroups`; každý port si pamatuje index
své skupiny (`groupIndex`), podle kterého ho rozvržení panelu umístí.

Příklady z vestavěného katalogu:

| Skupina | Výsledné názvy |
|---|---|
| `"prefix": "Fa0/", "rangeStart": 1, "rangeEnd": 24` | `Fa0/1` ... `Fa0/24` |
| `"prefix": "Gi0/0/", "rangeStart": 0, "rangeEnd": 1` | `Gi0/0/0`, `Gi0/0/1` |
| `"prefix": "fortyGigE 1/", "rangeStart": 53, "rangeEnd": 55, "step": 2` | `fortyGigE 1/53`, `fortyGigE 1/55` |
| `"prefix": "LAN ", "rangeStart": 1, "rangeEnd": 8` | `LAN 1` ... `LAN 8` |
| `"names": ["WAN SFP+"]` | `WAN SFP+` |

Doporučení pro názvy:

- Názvy musí být v rámci jednoho zařízení jedinečné. Při načítání se to nekontroluje,
  hlídá to test `CatalogTests.portNamesAreUniqueAndEveryPortHasASlot` a dialog pro vlastní
  zařízení.
- Pište názvy tak, jak je vypisuje operační systém zařízení (IOS `Fa0/1`, `Gi1/0/1`;
  Dell OS9 `GigabitEthernet 1/1`; RouterOS `ether1`). Konzole hledá rozhraní podle typu
  (část před první číslicí) a čísla, takže `interface fa0/1` najde port `Fa0/1` i
  `FastEthernet0/1`.
- Na koncích kabelů se zobrazuje zkrácený název (`PortNaming.shortName`): dlouhé typy se
  zkrátí, pokud za nimi následuje číslo, např. `GigabitEthernet 1/1` = `Gi1/1`,
  `TenGigabitEthernet 1/49` = `Te1/49`, `fortyGigE 1/53` = `Fo1/53`,
  `ManagementEthernet 1/1` = `Ma1/1`. Krátké názvy (`Fa0/1`, `ether1`, `LAN 3`, `Console`)
  zůstávají beze změny.

## 6. Rozvržení předního panelu (`layout`)

Panel je obdélník o `rows` řadách portů, zleva doprava vyplněný sekcemi. Souřadnice jsou
v buňkách: jeden port = 1 x 1 buňka. Mezi sekcemi je mezera 0,5 buňky
(`PanelLayout.sectionGap`), mezi bloky uvnitř sekce 0,25 buňky (`PanelLayout.blockGap`).

### `PanelLayout`

| Klíč | Typ | Výchozí | Význam |
|---|---|---|---|
| `rows` | celé číslo | `1` (nejméně 1) | Počet řad portů. Ve vestavěném katalogu 1 nebo 2. Pokud některá sekce používá dvouřadé uspořádání, zvýší se automaticky na 2. Hodnota nad 2 má smysl jen pro `singleRow` sekce s explicitním `row`. |
| `sections` | pole | `[]` | Sekce (bloky portů) zleva doprava. |

### `PanelSection`

| Klíč | Typ | Výchozí | Význam |
|---|---|---|---|
| `groups` | pole celých čísel | `[]` | Indexy do `portGroups` (od 0). Porty všech uvedených skupin se spojí v tomto pořadí a teprve pak rozmístí. |
| `group` | celé číslo | - | Zkrácený zápis pro jedinou skupinu; použije se jen tehdy, když chybí `groups`. |
| `arrangement` | řetězec | `"singleRow"` | Způsob rozmístění, viz tabulka níže. |
| `row` | celé číslo | dolní řada | Jen pro `singleRow`: řada, do které sekce patří (0 = horní). Chybí-li, použije se spodní řada (`rows - 1`); hodnota mimo rozsah se ořízne. |
| `blockColumns` | celé číslo | žádné bloky | Za každými N sloupci se vloží mezera 0,25 buňky. U dvouřadých uspořádání má sloupec dva porty, takže `6` znamená bloky po 12 portech. Hodnoty 0 a menší se ignorují. |
| `label` | řetězec | popisek skupiny | Popisek sekce. Chybí-li a sekce obsahuje právě jednu skupinu, převezme se `label` té skupiny. U sekce s více skupinami se popisky skupin nepoužijí. |
| `placeholderWidth` | číslo | 4 u prázdné pozice | Šířka v buňkách, kterou sekce zabere, když nemá žádné porty (prázdná pozice pro modul). Sekce bez portů a bez šířky se nekreslí. |

Hodnoty `arrangement` (výčet `PortArrangement`):

| Hodnota | Rozmístění |
|---|---|
| `"singleRow"` | Všechny porty zleva doprava v jedné řadě (`row`). |
| `"oddTopEvenBottom"` | Dvě řady po sloupcích: 1. port nahoře, 2. dole, 3. nahoře, ... (typický switch: liché nahoře, sudé dole). |
| `"evenTopOddBottom"` | Dvě řady po sloupcích: 1. port dole, 2. nahoře, 3. dole, ... |
| `"topRowThenBottomRow"` | Dvě řady po řádcích: první polovina portů (zaokrouhleno nahoru) v horní řadě, zbytek ve spodní. |

### Normalizace

Rozvržení se při načtení šablony i při vytvoření zařízení normalizuje
(`PanelLayout.normalized(for:)`, operace je idempotentní):

- neplatné indexy skupin a skupiny uvedené podruhé se ze sekcí vyřadí; sekce, které tím
  zůstanou prázdné, zmizí;
- skupiny, které žádná sekce nezmiňuje, se připojí na konec s automatickou sekcí, takže
  každý port je vždy nakreslen;
- chybějící popisek sekce s jedinou skupinou se převezme ze skupiny;
- `blockColumns <= 0` se odstraní;
- sekce složená jen z prázdných pozic dostane `placeholderWidth` 4;
- `rows` se zvýší na 2, používá-li některá sekce dvouřadé uspořádání.

### Automatické rozvržení

Pokud klíč `layout` chybí (a pro skupiny, které rozvržení nezmiňuje), vznikne pro každou
skupinu jedna sekce: skupina s alespoň 12 porty typu `RJ45`, `SFP`, `SFP+` nebo `QSFP+`
dostane `oddTopEvenBottom` (a při 24 a více portech `blockColumns: 6`), ostatní
`singleRow`. Popisek se převezme ze skupiny, prázdná pozice dostane šířku 4. Panel má
2 řady, pokud je některá sekce dvouřadá, jinak 1. Takto rozvržení vytváří i dialog pro
vlastní zařízení.

## 7. Co se stane při umístění zařízení

`DeviceTemplate.makeDevice` vytvoří zařízení s **kopií** šablony: `templateID`, `vendor`,
`model`, `category`, normalizované `layout`, `verified` a porty s novými UUID (název,
konektor, rychlost, `verified` ze skupiny, `groupIndex`). Pozdější změny katalogu (oprava
názvů portů, ověření, smazání šablony) se do už umístěných zařízení **nepromítnou** a
projekt se otevře i bez příslušné šablony. Po opravě šablony je třeba zařízení na plátně
vložit znovu.

Zařízení potřebuje ověření (`needsVerification`), pokud má `verified == false` ono samo
nebo kterýkoli jeho port.

## 8. Kontrola a hlášení chyb

Při dekódování se striktně kontroluje syntaxe JSON, typy hodnot (např. `rangeStart` musí být
číslo, ne řetězec), přítomnost `model`, `category` a `connector` a platnost hodnot výčtů
(`category`, `connector`, `arrangement`). Jediná taková chyba způsobí, že je nečitelný
**celý soubor**, ne jen jedna šablona. Ostatní nedostatky se opraví potichu (výchozí
hodnoty, normalizace rozvržení, viz výše).

Problémy při načítání se sbírají do `DeviceCatalog.loadIssues` (diagnostický text
v angličtině):

| Situace | Chování | Hlášení |
|---|---|---|
| Náhradní `<support>/devices.json` nelze načíst | použije se přibalený katalog | `Override catalog <cesta> is unreadable, using the bundled one: <chyba>` |
| Přibalený `devices.json` nelze najít nebo načíst | vestavěný katalog je prázdný | `Bundled devices.json is unreadable: <chyba>` |
| `custom-devices.json` nelze načíst | vlastní šablony se ignorují; při příštím uložení vlastní šablony se vadný soubor nejdřív zkopíruje do `custom-devices.invalid.json` | `Custom catalog <cesta> is unreadable and was ignored: <chyba>` |
| Duplicitní `id` (v jednom souboru nebo vlastní šablona se stejným `id` jako vestavěná) | platí první výskyt, další se vynechá | `Duplicate template id "<id>" was ignored.` |

Aplikace po startu zobrazí `loadIssues` v dialogu „Katalog zařízení se nenačetl celý“;
je-li katalog úplně prázdný, zobrazí dialog „Katalog zařízení je prázdný“. Totéž vypíše
`NetSketch --catalog-info`.

Operace nad vlastními šablonami (`addCustom`, `updateCustom`, `removeCustom`) hlásí chyby
výčtem `CatalogError`, který aplikace převádí na české zprávy (`CzechText`):

| Chyba | Kdy |
|---|---|
| `duplicateID(id)` | šablona s tímto `id` už existuje (vestavěná nebo vlastní) |
| `unknownTemplate(id)` | vlastní šablona s tímto `id` neexistuje |
| `notCustom(id)` | `id` patří vestavěné šabloně, kterou nelze měnit ani mazat |
| `invalidTemplate(text)` | šablona je nepoužitelná (prázdný `model`) |

Dialog „Nové zařízení…“ navíc sám kontroluje vyplněný model, alespoň jeden port, nejvýše
256 portů, platné rozsahy a jedinečnost názvů portů.

Co se při načítání **nekontroluje**: jedinečnost názvů portů, překlepy v nepovinných
klíčích, `rangeStart > rangeEnd` (skupina bez portů) a hodnota `formatVersion` katalogu.
Proto je po každé úpravě vestavěného katalogu nutné spustit testy (kapitola 9).

## 9. Příklad: přidání nového switche do vestavěného katalogu

Následující záznam je **ilustrační**: názvy a počty portů nejsou ověřené a před použitím je
nutné je zkontrolovat na skutečném zařízení, stejně jako zbytek katalogu.

1. Do pole `templates` v `Sources/NetSketchCore/Resources/devices.json` přidejte šablonu,
   např. do skupiny přepínačů za `cisco-catalyst-2960-48`:

   ```json
   {
     "id": "cisco-catalyst-2960x-24ts-l",
     "vendor": "Cisco",
     "model": "Catalyst 2960X-24TS-L",
     "category": "switch",
     "verified": false,
     "note": "Ilustrační příklad z dokumentace; ověřit podle hardwaru.",
     "portGroups": [
       { "prefix": "Gi1/0/", "rangeStart": 1, "rangeEnd": 24, "speed": "1G", "connector": "RJ45", "verified": false },
       { "prefix": "Gi1/0/", "rangeStart": 25, "rangeEnd": 28, "speed": "1G", "connector": "SFP", "verified": false, "label": "Uplink" },
       { "names": ["Console"], "speed": "", "connector": "console", "verified": false },
       { "names": ["Fa0"], "speed": "100M", "connector": "mgmt", "verified": false }
     ],
     "layout": {
       "rows": 2,
       "sections": [
         { "groups": [0], "arrangement": "oddTopEvenBottom", "blockColumns": 6 },
         { "groups": [1], "arrangement": "oddTopEvenBottom" },
         { "groups": [2, 3], "arrangement": "oddTopEvenBottom", "label": "Mgmt" }
       ]
     }
   }
   ```

   Výsledek: 30 portů `Gi1/0/1` ... `Gi1/0/24` (RJ45), `Gi1/0/25` ... `Gi1/0/28` (SFP),
   `Console` a `Fa0`. Panel má dvě řady: 24 metalických portů ve dvou blocích po 12
   (liché nahoře), za mezerou sekce „Uplink“ se čtyřmi klecemi SFP a vpravo sloupec
   s konzolí nahoře a management portem dole. Popisek „Mgmt“ je uveden přímo u sekce,
   protože sekce se dvěma skupinami popisek skupiny nepřebírá. Vendor `Cisco` zajistí
   konzoli v dialektu IOS, kategorie `switch` hostname `SW<n>`.

2. Doplňte nové `id` do `TemplateID` v `Tests/NetSketchCoreTests/TestSupport.swift`
   (konstanta a pole `TemplateID.all`). Test `CatalogTests.loadsFromBundle` porovnává počet
   šablon v katalogu s `TemplateID.all.count`.

3. Volitelně přidejte do `Tests/NetSketchCoreTests/PortNamingTests.swift` kontrolu
   vygenerovaných názvů, např.
   `#expect(template.makePorts().map(\.name).suffix(2) == ["Console", "Fa0"])`.

4. Spusťte testy (`swift test`, bez Xcode viz komentář v `Package.swift`).
   `CatalogTests` ověří mimo jiné, že soubor jde načíst, šablona je neověřená, názvy portů
   jsou jedinečné, každý port má na panelu vlastní buňku a uložené rozvržení je
   normalizované.

5. Znovu sestavte aplikaci (`scripts/make-app.sh`), aby se nový `devices.json` dostal do
   resource bundlu. Pro rychlé vyzkoušení bez kompilace lze místo kroků 1 až 5 použít
   náhradní soubor `~/Library/Application Support/NetSketch/devices.json` (kapitola 1),
   nebo zařízení vytvořit v aplikaci přes „Nové zařízení…“; to se uloží do
   `custom-devices.json`.

Až bude šablona fyzicky ověřena, nastavte `"verified": true` u šablony i u ověřených
skupin. Pozor: test `CatalogTests.everythingIsUnverified` dnes vyžaduje, aby všechny
vestavěné šablony byly neověřené, a je třeba ho upravit zároveň s ověřením.

## 10. Formát pole `Port.vlan` zapisovaný konzolí

`Port.vlan` je v modelu volný text (inspektor ho zobrazuje a umožňuje upravit). Konfigurační
konzole (`Sources/NetSketchCLI/SwitchportConfig.swift`) do něj ale zapisuje výhradně
následující **kanonický formát** a při čtení rozumí jen jemu:

| Text | Význam (IOS) |
|---|---|
| `""` | žádná konfigurace switchportu (access VLAN 1, režim nenastaven) |
| `"10"` | `switchport access vlan 10` (režim nenastaven) |
| `"access 10"` | `switchport mode access` + `switchport access vlan 10` |
| `"trunk"` | `switchport mode trunk` (všechny VLAN, native 1) |
| `"trunk 10,20,30-40"` | ... + `switchport trunk allowed vlan 10,20,30-40` |
| `"trunk native 99"` | ... + `switchport trunk native vlan 99` |
| `"trunk 10,20 native 99"` | obojí |
| `"trunk none"` | ... + `switchport trunk allowed vlan none` |

Nastavení režimu, který právě **není** aktivní, se uchovává za středníkem, takže nezáleží
na pořadí zadaných příkazů:

| Text | Význam |
|---|---|
| `"trunk 10,20; access 30"` | režim trunk, zapamatovaná access VLAN 30 |
| `"access 30; trunk 10,20 native 99"` | režim access, zapamatované nastavení trunku |
| `"30; trunk 10,20"` | režim nenastaven, zapamatováno obojí |

Pravidla:

- O režimu rozhoduje první klauzule; samotné číslo znamená „režim nenastaven“. Klauzule
  jsou nejvýše dvě.
- Čísla VLAN jsou 1 až 4094. Seznam povolených VLAN se zapisuje seřazený, bez duplicit
  a se sloučenými rozsahy (`1,2,3,10` = `1-3,10`). Seznam pokrývající všech 4094 VLAN se
  zapíše jako prosté `trunk`; při čtení se přijímá i `trunk all`.
- Klíčová slova se čtou bez ohledu na velikost písmen a nadbytečné mezery se ignorují.
- Za trunkem musí být zapamatovaná access VLAN uvedena explicitně (`access 30`).
- Cokoli jiného (např. poznámka napsaná ručně v inspektoru) není kanonické: konzole text
  nezmění a místo interpretace ho zobrazí v řádku poznámky (remark).
- Dell OS9 nemá režimy access/trunk; členství ve VLAN se mapuje takto: jen untagged ve VLAN
  N = `"access N"` (výchozí VLAN 1 = `""`), tagged ve VLAN A,B = `"trunk A,B"`, tagged
  v A,B a zároveň untagged v N (hybridní port) = `"trunk A,B native N"`.
- Porty s konektorem `mgmt` nejsou switchporty a konfiguraci VLAN nepřijímají.
