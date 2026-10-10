import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import NetSketchCore

/// Ready-made lab exercises, built the way a student would build them: devices from the
/// catalog, cables, and every setting typed into the device consoles in each vendor's syntax.
///
/// The NetSketchExamples tool saves them to `examples/`; the tests check that the pings of
/// each exercise succeed.
public enum Exercises {
    public struct Exercise {
        public let fileName: String
        public let title: String
        /// Builds the finished exercise into an empty store.
        public let build: (ProjectStore) throws -> Void
        /// Pairs (from hostname, to address) that must answer a ping when the exercise is done.
        public let pings: [(from: String, to: String)]
        /// Console sessions that show the finished exercise working (for examples/UKAZKA.md).
        public var demo: [(device: String, commands: [String])] = []
    }

    public struct CommandFailed: Error, CustomStringConvertible {
        public let hostname: String
        public let command: String
        public let output: String
        public var description: String { "\(hostname): \(command) -> \(output)" }
    }

    public static let all: [Exercise] = [multivendorSwitches, fourRouters]

    // MARK: 1. Four multivendor switches

    public static let multivendorSwitches = Exercise(
        fileName: "cviceni-1-multivendor-switche.netsketch",
        title: "Cvičení 1: komunikace čtyř multivendor switchů",
        build: { store in
            store.snapToGrid = true
            store.gridSize = 20
            store.renameProject(to: "Cvičení 1 – multivendor switche")
            let sw1 = try store.addDevice(templateID: "cisco-catalyst-2960-24", at: CGPoint(x: 420, y: 260), hostname: "SW1-CISCO")
            let sw2 = try store.addDevice(templateID: "dell-s3048-on", at: CGPoint(x: 1300, y: 260), hostname: "SW2-DELL")
            let sw3 = try store.addDevice(templateID: "mikrotik-crs-generic", at: CGPoint(x: 1300, y: 640), hostname: "SW3-MIKROTIK")
            let sw4 = try store.addDevice(templateID: "ubiquiti-unifi-switch-24", at: CGPoint(x: 420, y: 640), hostname: "SW4-UBIQUITI")
            let pc1 = try store.addDevice(templateID: "generic-pc", at: CGPoint(x: 220, y: 960), hostname: "PC1")
            let pc2 = try store.addDevice(templateID: "generic-pc", at: CGPoint(x: 620, y: 960), hostname: "PC2")

            try Exercises.cable(store, "SW1-CISCO", "Gi0/1", "SW2-DELL", "GigabitEthernet 1/1")
            try Exercises.cable(store, "SW2-DELL", "GigabitEthernet 1/2", "SW3-MIKROTIK", "ether1")
            try Exercises.cable(store, "SW3-MIKROTIK", "ether2", "SW4-UBIQUITI", "Port 1")
            try Exercises.cable(store, "PC1", "eth0", "SW1-CISCO", "Fa0/1")
            try Exercises.cable(store, "PC2", "eth0", "SW4-UBIQUITI", "Port 2")

            try Exercises.typeLines(store, sw1, [
                "enable", "configure terminal",
                "interface vlan 1", "ip address 192.168.10.1 255.255.255.0", "no shutdown", "exit",
                "interface gi0/1", "description Trunk na SW2-DELL", "exit",
                "interface fa0/1", "description PC1", "end",
            ])
            try Exercises.typeLines(store, sw2, [
                "enable", "configure",
                "interface vlan 1", "ip address 192.168.10.2/24", "no shutdown", "exit",
                "interface gigabitethernet 1/1", "description Uplink SW1-CISCO", "no shutdown", "exit",
                "interface gigabitethernet 1/2", "description Downlink SW3-MIKROTIK", "no shutdown", "end",
            ])
            try Exercises.typeLines(store, sw3, [
                "/ip address add address=192.168.10.3/24 interface=bridge",
                "/interface ethernet set ether1 comment=SW2-DELL",
                "/interface ethernet set ether2 comment=SW4-UBIQUITI",
            ])
            try Exercises.typeLines(store, sw4, [
                "enable", "configure terminal",
                "interface vlan 1", "ip address 192.168.10.4 255.255.255.0", "exit",
                "interface Port 2", "description PC2", "end",
            ])
            try Exercises.typeLines(store, pc1, ["netsh interface ip set address eth0 static 192.168.10.101 255.255.255.0"])
            try Exercises.typeLines(store, pc2, ["netsh interface ip set address eth0 static 192.168.10.102 255.255.255.0"])

            store.addAnnotation(
                text: """
                Cvičení 1: čtyři switche různých výrobců v jedné síti 192.168.10.0/24 (VLAN 1).
                SW1 .1 (Cisco IOS), SW2 .2 (Dell OS9), SW3 .3 (MikroTik RouterOS), SW4 .4 (Ubiquiti), PC1 .101, PC2 .102.
                Ověření: konzole PC1 -> ping 192.168.10.102, konzole SW1 -> ping 192.168.10.3.
                """,
                at: CGPoint(x: 120, y: 40)
            )
            store.viewMode = .physical
        },
        pings: [
            ("PC1", "192.168.10.102"), ("PC2", "192.168.10.101"),
            ("SW1-CISCO", "192.168.10.2"), ("SW1-CISCO", "192.168.10.3"), ("SW1-CISCO", "192.168.10.4"),
            ("SW2-DELL", "192.168.10.4"), ("SW3-MIKROTIK", "192.168.10.1"), ("SW4-UBIQUITI", "192.168.10.101"),
        ],
        demo: [
            ("PC1", ["ipconfig", "ping 192.168.10.102"]),
            ("SW1-CISCO", ["enable", "show ip interface brief", "ping 192.168.10.3"]),
            ("SW2-DELL", ["enable", "show ip route", "ping 192.168.10.4"]),
            ("SW3-MIKROTIK", ["/ip address print", "/ping 192.168.10.101 count=3"]),
        ]
    )

    // MARK: 2. Four routers with static routing

    public static let fourRouters = Exercise(
        fileName: "cviceni-2-ctyri-routery.netsketch",
        title: "Cvičení 2: čtyři routery a statické směrování",
        build: { store in
            store.snapToGrid = true
            store.gridSize = 20
            store.renameProject(to: "Cvičení 2 – čtyři routery")
            let r1 = try store.addDevice(templateID: "cisco-isr-4321", at: CGPoint(x: 300, y: 300), hostname: "R1-CISCO")
            let r2 = try store.addDevice(templateID: "mikrotik-hap-lite", at: CGPoint(x: 760, y: 300), hostname: "R2-MIKROTIK")
            let r3 = try store.addDevice(templateID: "ubiquiti-udm-pro", at: CGPoint(x: 1260, y: 300), hostname: "R3-UBIQUITI")
            let r4 = try store.addDevice(templateID: "cisco-isr-4321", at: CGPoint(x: 1800, y: 300), hostname: "R4-CISCO")
            let pc1 = try store.addDevice(templateID: "generic-pc", at: CGPoint(x: 300, y: 640), hostname: "PC1")
            let pc2 = try store.addDevice(templateID: "generic-pc", at: CGPoint(x: 1800, y: 640), hostname: "PC2")

            try Exercises.cable(store, "PC1", "eth0", "R1-CISCO", "Gi0/0/0", .straight)
            try Exercises.cable(store, "R1-CISCO", "Gi0/0/1", "R2-MIKROTIK", "ether1", .crossover)
            try Exercises.cable(store, "R2-MIKROTIK", "ether2", "R3-UBIQUITI", "LAN 1", .crossover)
            try Exercises.cable(store, "R3-UBIQUITI", "LAN 2", "R4-CISCO", "Gi0/0/1", .crossover)
            try Exercises.cable(store, "R4-CISCO", "Gi0/0/0", "PC2", "eth0", .straight)

            try Exercises.typeLines(store, r1, [
                "enable", "configure terminal",
                "interface gi0/0/0", "description LAN PC1", "ip address 192.168.1.1 255.255.255.0", "no shutdown", "exit",
                "interface gi0/0/1", "description R2-MIKROTIK", "ip address 10.0.12.1 255.255.255.252", "no shutdown", "exit",
                "ip route 0.0.0.0 0.0.0.0 10.0.12.2", "end",
            ])
            try Exercises.typeLines(store, r2, [
                "/ip address add address=10.0.12.2/30 interface=ether1",
                "/ip address add address=10.0.23.1/30 interface=ether2",
                "/ip route add dst-address=192.168.1.0/24 gateway=10.0.12.1",
                "/ip route add dst-address=192.168.4.0/24 gateway=10.0.23.2",
                "/ip route add dst-address=10.0.34.0/30 gateway=10.0.23.2",
            ])
            try Exercises.typeLines(store, r3, [
                "enable", "configure terminal",
                "interface LAN 1", "ip address 10.0.23.2 255.255.255.252", "exit",
                "interface LAN 2", "ip address 10.0.34.1 255.255.255.252", "exit",
                "ip route 192.168.4.0 255.255.255.0 10.0.34.2",
                "ip route 192.168.1.0 255.255.255.0 10.0.23.1",
                "ip route 10.0.12.0 255.255.255.252 10.0.23.1", "end",
            ])
            try Exercises.typeLines(store, r4, [
                "enable", "configure terminal",
                "interface gi0/0/0", "description LAN PC2", "ip address 192.168.4.1 255.255.255.0", "no shutdown", "exit",
                "interface gi0/0/1", "description R3-UBIQUITI", "ip address 10.0.34.2 255.255.255.252", "no shutdown", "exit",
                "ip route 0.0.0.0 0.0.0.0 10.0.34.1", "end",
            ])
            try Exercises.typeLines(store, pc1, ["netsh interface ip set address eth0 static 192.168.1.10 255.255.255.0 192.168.1.1"])
            try Exercises.typeLines(store, pc2, ["netsh interface ip set address eth0 static 192.168.4.10 255.255.255.0 192.168.4.1"])

            store.addAnnotation(
                text: """
                Cvičení 2: čtyři routery (Cisco, MikroTik, Ubiquiti, Cisco) a statické směrování.
                LAN1 192.168.1.0/24 – R1 – 10.0.12.0/30 – R2 – 10.0.23.0/30 – R3 – 10.0.34.0/30 – R4 – LAN2 192.168.4.0/24.
                R1 a R4 mají výchozí trasu, R2 a R3 statické trasy do obou LAN.
                Ověření: konzole PC1 -> ping 192.168.4.10, tracert 192.168.4.10; konzole R1 -> show ip route.
                """,
                at: CGPoint(x: 120, y: 40)
            )
            store.viewMode = .physical
        },
        pings: [
            ("PC1", "192.168.4.10"), ("PC2", "192.168.1.10"),
            ("R1-CISCO", "10.0.34.2"), ("R2-MIKROTIK", "192.168.4.10"), ("R4-CISCO", "10.0.12.1"),
            ("PC1", "10.0.23.2"),
        ],
        demo: [
            ("PC1", ["ipconfig", "ping 192.168.4.10", "tracert 192.168.4.10"]),
            ("R1-CISCO", ["enable", "show ip route", "show ip interface brief", "ping 192.168.4.10"]),
            ("R2-MIKROTIK", ["/ip address print", "/ip route print", "/ping 192.168.1.10 count=3"]),
            ("R3-UBIQUITI", ["enable", "show ip route", "traceroute 192.168.1.10"]),
        ]
    )

    // MARK: Helpers

    private static func cable(_ store: ProjectStore, _ hostA: String, _ portA: String,
                              _ hostB: String, _ portB: String, _ cableType: CableType = .straight) throws {
        guard let a = store.project.device(hostname: hostA)?.ref(portNamed: portA),
              let b = store.project.device(hostname: hostB)?.ref(portNamed: portB) else {
            throw CommandFailed(hostname: hostA, command: "cable \(portA) - \(hostB) \(portB)", output: "no such port")
        }
        try store.connect(a, b, cable: cableType)
    }

    /// Types the lines into the device's console; any error message aborts the build.
    private static func typeLines(_ store: ProjectStore, _ device: Device, _ lines: [String]) throws {
        let session = CLISession(store: store, deviceID: device.id)
        let failures = ["% ", "%I", "bad command", "invalid value", "missing value", "failure", "Invalid Command",
                        "Usage:", "expected end", "no such item", "not found", "parameter is incorrect"]
        for line in lines {
            let output = session.execute(line)
            if failures.contains(where: { output.contains($0) }) {
                throw CommandFailed(hostname: store.project.device(id: device.id)?.hostname ?? device.hostname,
                                    command: line, output: output)
            }
        }
    }

    /// The project file of a built exercise with stable identifiers: every UUID is replaced, in
    /// order of first appearance, by 00000000-0000-4000-8000-000000000001, ...002, and so on.
    /// The same exercise code therefore always produces the same file.
    public static func fileData(of store: ProjectStore) throws -> Data {
        let data = try store.project.encoded()
        guard var text = String(data: data, encoding: .utf8) else { return data }
        let pattern = try NSRegularExpression(
            pattern: "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}")
        var mapping: [String: String] = [:]
        let whole = NSRange(text.startIndex..., in: text)
        for match in pattern.matches(in: text, range: whole) {
            guard let range = Range(match.range, in: text) else { continue }
            let original = String(text[range])
            if mapping[original] == nil {
                mapping[original] = String(format: "00000000-0000-4000-8000-%012lX", mapping.count + 1)
            }
        }
        for (original, stable) in mapping {
            text = text.replacingOccurrences(of: original, with: stable)
        }
        return Data(text.utf8)
    }

    /// The demo sessions of an exercise as Markdown: each device's prompt, commands and answers.
    public static func demoTranscript(_ exercise: Exercise, in store: ProjectStore) -> String {
        var text = "## \(exercise.title)\n\nSoubor: `examples/\(exercise.fileName)`\n"
        let image = (exercise.fileName as NSString).deletingPathExtension
        text += "\n![\(exercise.title)](../docs/screenshots/\(image)-fyzicky.png)\n"
        for session in exercise.demo {
            guard let device = store.project.device(hostname: session.device) else { continue }
            let cli = CLISession(store: store, deviceID: device.id)
            text += "\n### \(session.device)\n\n```\n"
            for command in session.commands {
                let prompt = cli.prompt
                let output = cli.execute(command)
                text += prompt + (prompt.hasSuffix(" ") ? "" : " ") + command + "\n"
                if !output.isEmpty { text += output + "\n" }
            }
            text += "```\n"
        }
        return text
    }

    /// Runs the exercise's pings in a built project; returns the failures (empty when all pass).
    public static func failedPings(_ exercise: Exercise, in store: ProjectStore) -> [String] {
        let simulator = NetworkSimulator(project: store.project)
        return exercise.pings.compactMap { ping in
            guard let device = store.project.device(hostname: ping.from), let target = IPv4(ping.to) else {
                return "\(ping.from) -> \(ping.to): unknown device or address"
            }
            let result = simulator.ping(from: device.id, to: target)
            return result.success ? nil : "\(ping.from) -> \(ping.to): \(simulator.explain(result))"
        }
    }
}
