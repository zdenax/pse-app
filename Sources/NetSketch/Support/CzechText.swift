import Foundation
import NetSketchCore

// Czech user-facing texts for the core's enums and errors. The core itself carries no UI strings.

extension DeviceCategory {
    /// Singular, e.g. for the inspector.
    var czechName: String {
        switch self {
        case .switch: return "Switch"
        case .router: return "Router"
        case .l3switch: return "L3 switch"
        case .accessPoint: return "Access point"
        case .pc: return "Počítač"
        case .server: return "Server"
        }
    }

    /// Plural, for palette section headers.
    var czechPlural: String {
        switch self {
        case .switch: return "Switche"
        case .router: return "Routery"
        case .l3switch: return "L3 switche"
        case .accessPoint: return "Access pointy"
        case .pc: return "Počítače"
        case .server: return "Servery"
        }
    }
}

extension ConnectorType {
    var czechName: String {
        switch self {
        case .rj45: return "RJ45"
        case .sfp: return "SFP"
        case .sfpPlus: return "SFP+"
        case .qsfpPlus: return "QSFP+"
        case .console: return "Konzole"
        case .mgmt: return "Management"
        case .wireless: return "Wi-Fi"
        }
    }
}

extension CableType {
    var czechName: String {
        switch self {
        case .straight: return "Přímý"
        case .crossover: return "Křížený"
        case .console: return "Konzolový"
        case .fiber: return "Optický"
        }
    }

    /// Longer form for menus and tooltips.
    var czechDescription: String {
        switch self {
        case .straight: return "Přímý kabel (straight-through)"
        case .crossover: return "Křížený kabel (crossover)"
        case .console: return "Konzolový kabel (rollover)"
        case .fiber: return "Optický kabel"
        }
    }
}

extension LinkStatus {
    var czechName: String {
        switch self {
        case .none: return "Žádný"
        case .green: return "Zelená"
        case .orange: return "Oranžová"
        case .red: return "Červená"
        }
    }
}

extension ViewMode {
    var czechName: String {
        switch self {
        case .physical: return "Fyzický"
        case .logical: return "Logický"
        }
    }
}

enum CzechText {
    static let verifyHint = "Ověřit podle hardwaru"

    /// "1 port", "3 porty", "24 portů".
    static func ports(_ count: Int) -> String {
        "\(count) " + plural(count, "port", "porty", "portů")
    }

    /// "1 kabel", "2 kabely", "5 kabelů".
    static func cables(_ count: Int) -> String {
        "\(count) " + plural(count, "kabel", "kabely", "kabelů")
    }

    static func devices(_ count: Int) -> String {
        "\(count) zařízení"
    }

    /// "1 poznámka", "2 poznámky", "5 poznámek".
    static func notes(_ count: Int) -> String {
        "\(count) " + plural(count, "poznámka", "poznámky", "poznámek")
    }

    static func plural(_ count: Int, _ one: String, _ few: String, _ many: String) -> String {
        switch count {
        case 1: return one
        case 2...4: return few
        default: return many
        }
    }

    /// Short port summary of a template for the palette, e.g. "24× Fa, 2× Gi".
    /// Console and management ports are left out; they would only add noise.
    static func portSummary(of template: DeviceTemplate) -> String {
        var parts: [(label: String, count: Int)] = []
        for group in template.portGroups where !group.isPlaceholder {
            guard group.connector != .console, group.connector != .mgmt else { continue }
            let count = group.portCount
            guard count > 0 else { continue }
            let label = summaryLabel(of: group)
            if let last = parts.indices.last, parts[last].label == label {
                parts[last].count += count
            } else {
                parts.append((label, count))
            }
        }
        guard !parts.isEmpty else { return ports(template.portCount) }
        return parts.map { "\($0.count)× \($0.label)" }.joined(separator: ", ")
    }

    /// The letters in front of the port number ("Fa", "Gi", "ether"), or the connector when
    /// the group has explicit names or no usable prefix.
    private static func summaryLabel(of group: PortGroup) -> String {
        if group.connector == .wireless { return ConnectorType.wireless.czechName }
        guard group.names == nil, let first = group.portNames.first else { return group.connector.czechName }
        let short = PortNaming.shortName(first)
        let letters = short.prefix { !$0.isNumber }
            .trimmingCharacters(in: CharacterSet(charactersIn: " /-_."))
        return letters.isEmpty ? group.connector.czechName : letters
    }

    // MARK: Errors

    /// A Czech sentence for any error the app can run into.
    static func message(for error: Error, in project: Project? = nil) -> String {
        if let error = error as? EditError { return message(for: error, in: project) }
        if let error = error as? CatalogError { return message(for: error) }
        if let error = error as? ProjectFileError {
            switch error {
            case .unsupportedFormatVersion(let found, let supported):
                return "Soubor je ve formátu verze \(found), tato verze aplikace umí nejvýše verzi \(supported)."
            }
        }
        if error is DecodingError {
            return "Soubor není platný projekt NetSketch (obsah se nepodařilo načíst). Podrobnosti: \(decodingDetail(error))"
        }
        return (error as NSError).localizedDescription
    }

    static func message(for error: EditError, in project: Project? = nil) -> String {
        func portName(_ ref: PortRef) -> String {
            guard let resolved = project?.resolve(ref) else { return "port" }
            return "port \(resolved.port.name) na zařízení \(resolved.device.hostname)"
        }
        switch error {
        case .unknownTemplate(let id):
            return "Šablona zařízení „\(id)“ v katalogu neexistuje."
        case .unknownDevice:
            return "Zařízení už v projektu není."
        case .unknownPort:
            return "Port nebo jeho zařízení už v projektu není."
        case .unknownLink:
            return "Kabel už v projektu není."
        case .unknownBundle:
            return "Svazek už v projektu není."
        case .unknownAnnotation:
            return "Poznámka už v projektu není."
        case .samePort:
            return "Kabel nelze zapojit oběma konci do stejného portu."
        case .sameDevice:
            return "Kabel nelze zapojit oběma konci do stejného zařízení."
        case .portInUse(let ref):
            return "V portu už kabel je (\(portName(ref))). Do jednoho portu lze zapojit jen jeden kabel."
        case .bundleNeedsTwoLinks:
            return "Svazek (LAG) potřebuje alespoň dva kabely."
        case .bundleLinksNotParallel:
            return "Do svazku (LAG) lze seskupit jen kabely mezi stejnou dvojicí zařízení."
        case .linkAlreadyBundled:
            return "Některý z vybraných kabelů už patří do jiného svazku. Nejprve ten svazek zrušte."
        case .emptyName:
            return "Název nesmí být prázdný."
        case .noFileURL:
            return "Projekt ještě nebyl uložen do souboru. Použijte Uložit jako…"
        }
    }

    static func message(for error: CatalogError) -> String {
        switch error {
        case .duplicateID(let id):
            return "Zařízení s identifikátorem „\(id)“ už v katalogu je. Změňte výrobce nebo model."
        case .unknownTemplate(let id):
            return "Vlastní zařízení „\(id)“ v katalogu není."
        case .notCustom(let id):
            return "Zařízení „\(id)“ je vestavěné a nelze ho měnit ani mazat."
        case .invalidTemplate:
            return "Zařízení nelze uložit: chybí název modelu."
        }
    }

    /// One Czech line per repaired inconsistency of an opened file.
    static func describe(_ issue: ProjectIssue) -> String {
        switch issue {
        case .duplicateID:
            return "dva objekty se stejným identifikátorem"
        case .danglingPortRef:
            return "kabel vedoucí do neexistujícího portu"
        case .linkWithinDevice:
            return "kabel s oběma konci na jednom zařízení"
        case .portUsedTwice:
            return "port se dvěma kabely"
        case .bundleMissingLink:
            return "svazek s neexistujícím kabelem"
        case .bundleTooSmall:
            return "svazek s méně než dvěma kabely"
        case .bundleNotParallel:
            return "svazek s kabely mezi různými zařízeními"
        case .bundleMembershipMismatch:
            return "nesoulad mezi svazkem a jeho kabely"
        }
    }

    private static func decodingDetail(_ error: Error) -> String {
        guard let error = error as? DecodingError else { return "" }
        func path(_ context: DecodingError.Context) -> String {
            let keys = context.codingPath.map { $0.intValue.map { "[\($0)]" } ?? $0.stringValue }
            return keys.isEmpty ? "kořen dokumentu" : keys.joined(separator: ".")
        }
        switch error {
        case .keyNotFound(let key, let context):
            return "chybí položka „\(key.stringValue)“ (\(path(context)))."
        case .typeMismatch(_, let context), .valueNotFound(_, let context):
            return "neočekávaná hodnota (\(path(context)))."
        case .dataCorrupted(let context):
            return "poškozená data (\(path(context)))."
        @unknown default:
            return "neznámá chyba formátu."
        }
    }
}
