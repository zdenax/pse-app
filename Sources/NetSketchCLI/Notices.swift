import Foundation

/// NetSketch's own explanatory texts (Czech). Device output itself stays English, as on real gear.
///
/// Every notice starts with "NetSketch:" so it can never be mistaken for output of the device.
enum Notices {
    static let needsSimulation =
        "NetSketch: tento příkaz vyžaduje simulaci sítě, kterou NetSketch zatím nemá. "
        + "Konzole pracuje jen s daty diagramu, nic se nezměnilo."

    static func notStored(_ command: String) -> String {
        "NetSketch: příkaz „\(command)“ je rozpoznán, ale neukládá se – diagram pro něj nemá datové pole. "
            + "Nic se nezměnilo."
    }

    static let savedInProject =
        "NetSketch: konfigurace je součástí projektu. Uložte ji v aplikaci pomocí Cmd+S."

    static let nothingToErase =
        "NetSketch: zařízení nemá samostatnou startup konfiguraci – vše je v souboru projektu. Nic se nezměnilo."

    static let lagIsDrawn =
        "NetSketch: agregace linek (LAG) se kreslí v diagramu jako svazek linek. "
        + "Z CLI ji zatím nastavit nelze, nic se nezměnilo."

    static let virtualInterface =
        "NetSketch: virtuální rozhraní (Vlan/SVI, Port-channel, Loopback) diagram neukládá. "
        + "Konfigurovat lze jen fyzické porty zařízení."

    static let lineMode =
        "NetSketch: režim line je přijat jen formálně, nastavení linek se neukládá."

    static let bannerNotStored =
        "NetSketch: text banneru se neukládá – diagram pro něj nemá datové pole."

    static let deviceGone =
        "NetSketch: zařízení už v projektu neexistuje, konzole je ukončena."

    static let interfaceGone =
        "NetSketch: konfigurované rozhraní už v diagramu neexistuje, návrat do globální konfigurace."

    static let lineTooLong =
        "NetSketch: příliš dlouhý řádek (nejvýše \(CLILimits.maxLineLength) znaků), příkaz nebyl proveden."

    static let routedPortNotModelled =
        "NetSketch: směrovaný (L3) režim portu diagram neukládá, port zůstává přepínaný. Nic se nezměnilo."

    static let dynamicTrunking =
        "NetSketch: dynamické vyjednávání trunku (DTP) vyžaduje simulaci, kterou NetSketch zatím nemá. "
        + "Použijte „switchport mode access“ nebo „switchport mode trunk“. Nic se nezměnilo."

    static let managementPort =
        "NetSketch: management port není přepínaný port, nastavení VLAN se na něj nevztahuje."

    static func replacedVLANText(_ port: String, _ text: String) -> String {
        "NetSketch: port \(port) měl v diagramu vlastní text VLAN „\(text)“ mimo formát CLI; byl nahrazen."
    }

    static let singleVLANOnly =
        "NetSketch: příkaz name lze použít jen pro jednu VLAN, nic se nezměnilo."

    static let neighborsFromDiagram =
        "NetSketch: sousedé jsou odvozeni z kabeláže nakreslené v diagramu, žádný protokol neběží."

    static let bundlesFromDiagram =
        "NetSketch: svazky linek nakreslené v diagramu. LACP/PAgP se nesimuluje, stav členů není znám."

    static let trunkStatic =
        "NetSketch: zobrazena jen konfigurace; Status plyne z kabeláže v diagramu. "
        + "Stav STP (forwarding/pruning) vyžaduje simulaci a je vynechán."

    static let interfaceStatic =
        "NetSketch: stav plyne jen z kabeláže a příkazu shutdown; čítače a provozní údaje vyžadují simulaci."

    static let noAddresses =
        "NetSketch: IP adresy diagram neukládá; stav plyne jen z kabeláže a příkazu shutdown."

    static let versionStatic =
        "NetSketch: verze softwaru, sériová čísla ani uptime nejsou v diagramu uloženy."

    static let dellUsesVLANInterface =
        "NetSketch: Dell OS9 tuto syntaxi nemá. Členství ve VLAN se nastavuje v režimu "
        + "„interface vlan N“ příkazy „untagged <rozhraní>“ a „tagged <rozhraní>“. Nic se nezměnilo."

    static let dellVLANCommand =
        "NetSketch: Dell OS9 vytváří VLAN příkazem „interface vlan N“ (název: „name TEXT“). Nic se nezměnilo."

    static func customVLANText(_ text: String) -> String {
        "vlastní text VLAN z diagramu (mimo formát CLI): \(text)"
    }

    static func missingVLAN(_ port: String, _ vlan: Int) -> String {
        "NetSketch: port \(port) má přístupovou VLAN \(vlan), která není v tabulce VLAN zařízení."
    }

    static func unreadableVLANText(_ port: String, _ text: String) -> String {
        "NetSketch: port \(port) má v diagramu vlastní text VLAN „\(text)“ (mimo formát CLI)."
    }

    static func banner(hostname: String, model: String, dialect: String, unknownCLI: Bool) -> String {
        var lines = [
            "NetSketch – konzole zařízení \(hostname) (\(model), dialekt \(dialect)).",
            "Příkazy čtou a upravují pouze data diagramu; síťové protokoly se nesimulují.",
        ]
        if unknownCLI {
            lines.append("Skutečné CLI tohoto zařízení NetSketch nezná, proto nabízí obecnou syntaxi ve stylu Cisco IOS.")
        }
        lines.append("Nápověda: ?   Doplnění příkazu: Tab")
        return lines.joined(separator: "\n")
    }
}

enum CLILimits {
    /// Longest accepted command line, in characters.
    static let maxLineLength = 1000
    /// Number of commands kept for `show history`.
    static let historySize = 20
}
