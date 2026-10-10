import Foundation
import Observation
import NetSketchCore

/// User-facing texts of the canvas (Czech), kept in one place.
enum CanvasStrings {
    static let verifyAgainstHardware = "Ověřit podle hardwaru"
    static let emptyProject = "Prázdný projekt"
    static let emptyCanvasHint = "Přetáhněte zařízení z palety na plátno"
    static let pendingHint = "Klikněte na cílový port. Esc zruší."
    static let newAnnotationPlaceholder = "Poznámka"

    static let menuRename = "Přejmenovat"
    static let menuDelete = "Odstranit"
    static let menuEditText = "Upravit text"
    static let menuDeleteCable = "Odstranit kabel"
    static let menuCableType = "Typ kabelu"
    static let menuBundle = "Sloučit do svazku (LAG)"
    static let menuUnbundle = "Zrušit svazek"
    static let menuRenameBundle = "Přejmenovat svazek"
    static let menuAddAnnotation = "Přidat poznámku"
    static let menuSelectAll = "Vybrat vše"
    static let menuZoomToFit = "Přizpůsobit zobrazení"
    static let menuActualSize = "Skutečná velikost"
    static let menuStatusA = "Stav konce A"
    static let menuStatusB = "Stav konce B"

    static func cableName(_ type: CableType) -> String {
        switch type {
        case .straight: return "Přímý"
        case .crossover: return "Křížený"
        case .console: return "Konzolový"
        case .fiber: return "Optický"
        @unknown default: return type.rawValue
        }
    }

    static func statusName(_ status: LinkStatus) -> String {
        switch status {
        case .none: return "bez označení"
        case .green: return "zelená"
        case .orange: return "oranžová"
        case .red: return "červená"
        @unknown default: return status.rawValue
        }
    }

    static func connectorName(_ connector: ConnectorType) -> String {
        switch connector {
        case .rj45: return "RJ45"
        case .sfp: return "SFP"
        case .sfpPlus: return "SFP+"
        case .qsfpPlus: return "QSFP+"
        case .console: return "konzole"
        case .mgmt: return "management"
        case .wireless: return "bezdrátové rozhraní"
        @unknown default: return connector.rawValue
        }
    }

    /// "SW1 Fa0/1" for messages and tooltips.
    static func portTitle(_ ref: PortRef, in project: Project) -> String {
        guard let (device, port) = project.resolve(ref) else { return "port" }
        return "\(device.hostname) \(port.shortName)"
    }

    /// Message for a refused edit.
    static func message(for error: EditError, in project: Project) -> String {
        switch error {
        case .portInUse(let ref):
            if let peer = project.peer(of: ref) {
                return "Port \(portTitle(ref, in: project)) je už obsazený (vede do \(peer.device.hostname) \(peer.port.shortName))."
            }
            return "Port \(portTitle(ref, in: project)) je už obsazený."
        case .sameDevice:
            return "Kabel nelze zapojit do dvou portů téhož zařízení."
        case .samePort:
            return "Kabel musí vést mezi dvěma různými porty."
        case .unknownTemplate:
            return "Tuto šablonu zařízení katalog nezná."
        case .unknownDevice, .unknownPort, .unknownLink, .unknownBundle, .unknownAnnotation:
            return "Objekt už v projektu není."
        case .bundleNeedsTwoLinks:
            return "Svazek potřebuje alespoň dva kabely."
        case .bundleLinksNotParallel:
            return "Kabely svazku musí spojovat stejnou dvojici zařízení."
        case .linkAlreadyBundled:
            return "Kabel už patří do jiného svazku."
        case .emptyName:
            return "Název nesmí být prázdný."
        case .noFileURL:
            return "Projekt ještě nebyl uložen."
        @unknown default:
            return "Operaci nelze provést."
        }
    }
}

/// Transient message shown as a small banner inside the canvas (e.g. "port in use").
@Observable
final class CanvasFeedback {
    private(set) var message: String?
    @ObservationIgnored private var generation = 0

    func show(_ text: String, duration: TimeInterval = 3.5) {
        generation += 1
        let current = generation
        message = text
        DispatchQueue.main.asyncAfter(deadline: .now() + duration) { [weak self] in
            guard let self, self.generation == current else { return }
            self.message = nil
        }
    }

    func clear() {
        generation += 1
        if message != nil { message = nil }
    }
}
