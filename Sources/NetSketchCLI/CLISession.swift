import Foundation
import NetSketchCore

/// The command language a device's console speaks.
public enum CLIDialect: String, CaseIterable, Sendable {
    /// Cisco IOS (Catalyst switches, ISR routers).
    case ios
    /// Dell Networking OS9 (FTOS).
    case dellOS9
    /// MikroTik RouterOS.
    case routerOS
    /// A device whose real CLI NetSketch does not know: IOS-style syntax, clearly announced.
    case generic
}

/// Entry points of the CLI target that do not need a session.
public enum CLI {
    /// The dialect of a device, decided by its vendor. The model and category are accepted so
    /// that a vendor with several operating systems can be told apart later.
    public static func dialect(vendor: String, model: String, category: DeviceCategory) -> CLIDialect {
        let vendor = vendor.lowercased()
        if vendor.contains("cisco") { return .ios }
        if vendor.contains("dell") { return .dellOS9 }
        if vendor.contains("mikrotik") { return .routerOS }
        return .generic
    }

    public static func dialect(of device: Device) -> CLIDialect {
        dialect(vendor: device.vendor, model: device.model, category: device.category)
    }

    /// Only network devices (switches and routers) get a configuration console.
    /// PCs, servers and access points have nothing the CLI could configure.
    public static func supportsConsole(_ device: Device) -> Bool {
        switch device.category {
        case .switch, .l3switch, .router: return true
        case .accessPoint, .pc, .server: return false
        }
    }
}

/// One console of one device: the public face of the dialect engines.
///
/// The session keeps only the console state (mode, history); the configuration itself is
/// read from and written to the `ProjectStore`, so every change is visible on the canvas and
/// in the inspector at once and can be undone. Each command is one undo step.
public final class CLISession {
    public let deviceID: UUID
    public let dialect: CLIDialect
    private let engine: ConsoleEngine

    public init(store: ProjectStore, deviceID: UUID) {
        self.deviceID = deviceID
        let access = DeviceAccess(store: store, deviceID: deviceID)
        let dialect = access.device.map(CLI.dialect(of:)) ?? .generic
        self.dialect = dialect
        switch dialect {
        case .routerOS: engine = RouterOSEngine(access: access)
        case .ios, .dellOS9, .generic: engine = IOSEngine(access: access, dialect: dialect)
        }
    }

    /// The greeting printed when the console opens.
    public var banner: String { engine.banner }

    /// The prompt for the next line, e.g. "SW1(config-if)#" or "[admin@R1] > ".
    public var prompt: String { engine.prompt }

    /// True after `exit`/`quit` at the top level, or when the device was deleted.
    public var isClosed: Bool { engine.isClosed }

    /// Runs one line (or a pasted block of lines) and returns what the device prints.
    @discardableResult
    public func execute(_ line: String) -> String { engine.execute(line) }

    /// Words that may continue the partial line (Tab completion).
    public func complete(_ partial: String) -> [String] { engine.complete(partial) }

    /// The `?` help for a partial line.
    public func help(_ partial: String) -> String { engine.help(partial) }
}
