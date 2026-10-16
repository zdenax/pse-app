// NetSketch's own explanatory texts (Czech). Device output itself stays English, as on real gear.
// Port of Notices.swift (NetSketchCLI).
//
// Every notice starts with "NetSketch:" so it can never be mistaken for output of the device.

export class CLILimits {
  /** Longest accepted command line, in characters. */
  static readonly maxLineLength = 1000;
  /** Number of commands kept for `show history`. */
  static readonly historySize = 20;
}

export class Notices {
  static readonly needsSimulation =
    "NetSketch: tento příkaz vyžaduje simulaci sítě, kterou NetSketch zatím nemá. " +
    "Konzole pracuje jen s daty diagramu, nic se nezměnilo.";

  static notStored(command: string): string {
    return (
      `NetSketch: příkaz „${command}“ je rozpoznán, ale neukládá se – diagram pro něj nemá datové pole. ` +
      "Nic se nezměnilo."
    );
  }

  static readonly savedInProject = "NetSketch: konfigurace je součástí projektu. Uložte ji v aplikaci pomocí Cmd+S.";

  static readonly nothingToErase =
    "NetSketch: zařízení nemá samostatnou startup konfiguraci – vše je v souboru projektu. Nic se nezměnilo.";

  static readonly lagIsDrawn =
    "NetSketch: agregace linek (LAG) se kreslí v diagramu jako svazek linek. " +
    "Z CLI ji zatím nastavit nelze, nic se nezměnilo.";

  static readonly channelNeedsMember =
    "NetSketch: port-channel zatím nemá žádný člen (channel-group), IP adresa se ukládá na prvního člena. Nic se nezměnilo.";

  static readonly virtualInterface =
    "NetSketch: virtuální rozhraní (Vlan/SVI, Port-channel, Loopback) diagram neukládá. " +
    "Konfigurovat lze jen fyzické porty zařízení.";

  static readonly lineMode = "NetSketch: režim line je přijat jen formálně, nastavení linek se neukládá.";

  static readonly bannerNotStored = "NetSketch: text banneru se neukládá – diagram pro něj nemá datové pole.";

  static readonly deviceGone = "NetSketch: zařízení už v projektu neexistuje, konzole je ukončena.";

  static readonly interfaceGone =
    "NetSketch: konfigurované rozhraní už v diagramu neexistuje, návrat do globální konfigurace.";

  static readonly lineTooLong = `NetSketch: příliš dlouhý řádek (nejvýše ${CLILimits.maxLineLength} znaků), příkaz nebyl proveden.`;

  static readonly routedPortNotModelled =
    "NetSketch: směrovaný (L3) režim portu diagram neukládá, port zůstává přepínaný. Nic se nezměnilo.";

  static readonly dynamicTrunking =
    "NetSketch: dynamické vyjednávání trunku (DTP) vyžaduje simulaci, kterou NetSketch zatím nemá. " +
    "Použijte „switchport mode access“ nebo „switchport mode trunk“. Nic se nezměnilo.";

  static readonly managementPort =
    "NetSketch: management port není přepínaný port, nastavení VLAN se na něj nevztahuje.";

  static replacedVLANText(port: string, text: string): string {
    return `NetSketch: port ${port} měl v diagramu vlastní text VLAN „${text}“ mimo formát CLI; byl nahrazen.`;
  }

  static readonly singleVLANOnly = "NetSketch: příkaz name lze použít jen pro jednu VLAN, nic se nezměnilo.";

  static readonly neighborsFromDiagram =
    "NetSketch: sousedé jsou odvozeni z kabeláže nakreslené v diagramu, žádný protokol neběží.";

  static readonly bundlesFromDiagram =
    "NetSketch: svazky linek nakreslené v diagramu. LACP/PAgP se nesimuluje, stav členů není znám.";

  static readonly trunkStatic =
    "NetSketch: zobrazena jen konfigurace; Status plyne z kabeláže v diagramu. " +
    "Stav STP (forwarding/pruning) vyžaduje simulaci a je vynechán.";

  static readonly interfaceStatic =
    "NetSketch: stav plyne jen z kabeláže a příkazu shutdown; čítače a provozní údaje vyžadují simulaci.";

  static readonly statusFromDiagram = "NetSketch: stav rozhraní plyne z kabeláže v diagramu a z příkazu shutdown.";

  static readonly noAddresses =
    "NetSketch: IP adresy diagram neukládá; stav plyne jen z kabeláže a příkazu shutdown.";

  static readonly switchPortHasNoAddress =
    "NetSketch: port přepínače je přepínaný (L2), IP adresu nemá. Nastavte ji na rozhraní VLAN: " +
    "„interface vlan 1“ a „ip address …“.";

  static readonly dhcpNotSimulated = "NetSketch: DHCP se nesimuluje, nastavte adresu ručně. Nic se nezměnilo.";

  static duplicateAddress(address: string, owner: string): string {
    return `NetSketch: adresu ${address} už používá i ${owner}. Ping na ni nemusí dojít tam, kam čekáte.`;
  }

  static inactiveRoutes(routes: string[]): string {
    return "NetSketch: neaktivní statické trasy (další skok není v žádné připojené síti): " + routes.join("; ");
  }

  static readonly versionStatic = "NetSketch: verze softwaru, sériová čísla ani uptime nejsou v diagramu uloženy.";

  static readonly dellUsesVLANInterface =
    "NetSketch: Dell OS9 tuto syntaxi nemá. Členství ve VLAN se nastavuje v režimu " +
    "„interface vlan N“ příkazy „untagged <rozhraní>“ a „tagged <rozhraní>“. Nic se nezměnilo.";

  static readonly dellVLANCommand =
    "NetSketch: Dell OS9 vytváří VLAN příkazem „interface vlan N“ (název: „name TEXT“). Nic se nezměnilo.";

  static customVLANText(text: string): string {
    return `vlastní text VLAN z diagramu (mimo formát CLI): ${text}`;
  }

  static missingVLAN(port: string, vlan: number): string {
    return `NetSketch: port ${port} má přístupovou VLAN ${vlan}, která není v tabulce VLAN zařízení.`;
  }

  static unreadableVLANText(port: string, text: string): string {
    return `NetSketch: port ${port} má v diagramu vlastní text VLAN „${text}“ (mimo formát CLI).`;
  }

  /** The console greeting. Accepts the Swift labels as an object too:
   * `Notices.banner({ hostname, model, dialect, unknownCLI })`. */
  static banner(hostname: string, model: string, dialect: string, unknownCLI: boolean): string;
  static banner(options: { hostname: string; model: string; dialect: string; unknownCLI: boolean }): string;
  static banner(
    hostnameOrOptions: string | { hostname: string; model: string; dialect: string; unknownCLI: boolean },
    model = "",
    dialect = "",
    unknownCLI = false,
  ): string {
    let hostname: string;
    if (typeof hostnameOrOptions === "string") {
      hostname = hostnameOrOptions;
    } else {
      ({ hostname, model, dialect, unknownCLI } = hostnameOrOptions);
    }
    const lines = [
      `NetSketch – konzole zařízení ${hostname} (${model}, dialekt ${dialect}).`,
      "Příkazy upravují data diagramu. Ping a traceroute sledují kabely, VLAN, IP adresy a statické trasy; dynamické protokoly (STP, OSPF, DHCP) se nesimulují.",
    ];
    if (unknownCLI) {
      lines.push("Skutečné CLI tohoto zařízení NetSketch nezná, proto nabízí obecnou syntaxi ve stylu Cisco IOS.");
    }
    lines.push("Nápověda: ?   Doplnění příkazu: Tab");
    return lines.join("\n");
  }
}
