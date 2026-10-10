import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import NetSketchCore
@testable import NetSketchCLI

enum TemplateID {
    static let c2960_24 = "cisco-catalyst-2960-24"
    static let c3650 = "cisco-catalyst-3650-24ps"
    static let isr4321 = "cisco-isr-4321"
    static let dellS3048 = "dell-s3048-on"
    static let hapLite = "mikrotik-hap-lite"
    static let udmPro = "ubiquiti-udm-pro"
    static let pc = "generic-pc"
    static let server = "generic-server"
    static let accessPoint = "generic-ap"
}

struct MissingDevice: Error { let hostname: String }
struct MissingPort: Error { let hostname: String; let port: String }

/// A store on the bundled catalog only; never touches Application Support.
func makeStore() -> ProjectStore {
    let store = ProjectStore(catalog: DeviceCatalog(supportDirectory: nil))
    store.snapToGrid = false
    return store
}

/// A store with one device and a console session on it.
func makeSession(_ templateID: String, hostname: String? = nil) throws -> (ProjectStore, Device, CLISession) {
    let store = makeStore()
    let device = try store.addDevice(templateID: templateID, at: CGPoint(x: 100, y: 100), hostname: hostname)
    return (store, device, CLISession(store: store, deviceID: device.id))
}

extension CLISession {
    /// Runs several lines and returns the output of the last one.
    @discardableResult
    func run(_ lines: String...) -> String {
        var output = ""
        for line in lines { output = execute(line) }
        return output
    }
}

extension ProjectStore {
    func device(_ hostname: String) throws -> Device {
        guard let device = project.device(hostname: hostname) else { throw MissingDevice(hostname: hostname) }
        return device
    }

    func port(_ hostname: String, _ portName: String) throws -> Port {
        guard let port = try device(hostname).port(named: portName) else {
            throw MissingPort(hostname: hostname, port: portName)
        }
        return port
    }

    func ref(_ hostname: String, _ portName: String) throws -> PortRef {
        guard let ref = try device(hostname).ref(portNamed: portName) else {
            throw MissingPort(hostname: hostname, port: portName)
        }
        return ref
    }
}
