import Foundation
import NetSketchCore

/// The command prompt of an end device (PC, server), in the style of the Packet Tracer
/// "Command Prompt": `C:\>`.
///
/// It shows the adapters with their cabling and address, sets the address and the default
/// gateway (`netsh interface ip set address ...`, the Windows syntax) and runs `ping` and
/// `tracert` through `NetworkSimulator`. Commands that need more than the simulation offers
/// (arp, netstat, nslookup, ...) answer with the simulation notice.
final class HostEngine: ConsoleEngine {
    private let access: DeviceAccess
    private(set) var isClosed = false
    private var lastHostname: String

    init(access: DeviceAccess) {
        self.access = access
        self.lastHostname = access.hostname
    }

    private struct Command {
        let name: String
        let help: String
        let run: (HostEngine, [String]) -> String
    }

    private static let commands: [Command] = [
        Command(name: "help", help: "Display the available commands") { engine, _ in engine.helpText() },
        Command(name: "ipconfig", help: "Display the IP configuration of the network adapters") { engine, words in
            engine.ipconfig(words)
        },
        Command(name: "netsh",
                help: "Set an address: netsh interface ip set address eth0 static 192.168.1.10 255.255.255.0 192.168.1.1") {
            engine, words in engine.netsh(words)
        },
        Command(name: "hostname", help: "Display the name of this computer") { engine, words in
            words.isEmpty ? engine.hostname : "hostname: too many arguments"
        },
        Command(name: "getmac", help: "Display the MAC addresses of the adapters") { _, _ in
            "NetSketch: MAC adresy diagram neukládá."
        },
        Command(name: "ver", help: "Display the system version") { engine, _ in engine.version() },
        Command(name: "cls", help: "Clear the screen") { _, _ in "" },
        Command(name: "exit", help: "Quit the command prompt") { engine, _ in
            engine.isClosed = true
            return ""
        },
        Command(name: "ping", help: "Send echo messages") { engine, words in engine.ping(words) },
        Command(name: "tracert", help: "Trace the route to a destination") { engine, words in engine.tracert(words) },
        Command(name: "arp", help: "Display the ARP table") { _, _ in Notices.needsSimulation },
        Command(name: "netstat", help: "Display network connections") { _, _ in Notices.needsSimulation },
        Command(name: "nslookup", help: "Query a DNS server") { _, _ in Notices.needsSimulation },
        Command(name: "telnet", help: "Open a telnet connection") { _, _ in Notices.needsSimulation },
        Command(name: "ssh", help: "Open a secure shell connection") { _, _ in Notices.needsSimulation },
        Command(name: "ftp", help: "Transfer files to and from an FTP server") { _, _ in Notices.needsSimulation },
    ]

    // MARK: Banner and prompt

    var hostname: String {
        if let device = access.device { lastHostname = device.hostname }
        return lastHostname
    }

    var banner: String {
        let model = [access.vendor, access.model].filter { !$0.isEmpty }.joined(separator: " ")
        return Notices.banner(hostname: hostname, model: model, dialect: "příkazový řádek", unknownCLI: false)
    }

    var prompt: String { "C:\\>" }

    // MARK: Execution

    func execute(_ line: String) -> String {
        if line.contains(where: \.isNewline) {
            let outputs = line.split(whereSeparator: \.isNewline).map { execute(String($0)) }
            return outputs.filter { !$0.isEmpty }.joined(separator: "\n")
        }
        guard !isClosed else { return "" }
        guard access.exists else {
            isClosed = true
            return Notices.deviceGone
        }
        guard line.count <= CLILimits.maxLineLength else { return Notices.lineTooLong }

        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return "" }
        if trimmed.hasSuffix("?") {
            return help(String(line[..<(line.lastIndex(of: "?") ?? line.endIndex)]))
        }
        let words = trimmed.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        // Commands are case-insensitive and must be typed in full, as on Windows.
        guard let command = HostEngine.commands.first(where: { $0.name == words[0].lowercased() }) else {
            return "Invalid Command."
        }
        return command.run(self, Array(words.dropFirst()))
    }

    // MARK: Output

    private func helpText() -> String {
        let width = HostEngine.commands.map(\.name.count).max() ?? 0
        return HostEngine.commands.map { $0.name.padded(width) + "  " + $0.help }.joined(separator: "\n")
    }

    private func version() -> String {
        let model = [access.vendor, access.model].filter { !$0.isEmpty }.joined(separator: " ")
        return [
            "NetSketch Command Prompt (\(model.isEmpty ? "-" : model))",
            Notices.versionStatic,
        ].joined(separator: "\n")
    }

    private func ipconfig(_ arguments: [String]) -> String {
        if let option = arguments.first, !["/all", "-all"].contains(option.lowercased()) {
            return "Error: unrecognized or incomplete command line option \"\(option)\"."
        }
        let detailed = !arguments.isEmpty
        var lines: [String] = []
        for port in access.interfaces {
            let kind = port.connector == .wireless ? "Wireless LAN adapter" : "Ethernet adapter"
            lines.append("")
            lines.append("\(kind) \(port.name):")
            lines.append("")
            switch port.linkState {
            case .adminDown:
                lines.append(HostEngine.field("Media State", "Media disabled"))
            case .down:
                lines.append(HostEngine.field("Media State", "Media disconnected"))
            case .up:
                lines.append(HostEngine.field("Media State", "Media connected"))
            }
            if let peer = port.peer {
                lines.append(HostEngine.field("Cabled to", "\(peer.hostname) \(PortNaming.shortName(peer.portName))"))
            }
            if let prefix = access.address(of: .port(port.id)) {
                lines.append(HostEngine.field("IPv4 Address", prefix.address.description))
                lines.append(HostEngine.field("Subnet Mask", prefix.mask.description))
            } else {
                lines.append(HostEngine.field("IPv4 Address", "0.0.0.0"))
                lines.append(HostEngine.field("Subnet Mask", "0.0.0.0"))
            }
            lines.append(HostEngine.field("Default Gateway", IPv4(access.defaultGateway)?.description ?? "0.0.0.0"))
            let description = port.description.split(whereSeparator: \.isNewline).joined(separator: " ")
            if !description.isEmpty { lines.append(HostEngine.field("Description", description)) }
            if detailed {
                lines.append(HostEngine.field("Connector", port.connector.rawValue))
                if !port.speed.isEmpty { lines.append(HostEngine.field("Speed", port.speed)) }
            }
        }
        if lines.isEmpty { lines.append("No network adapters.") }
        return lines.joined(separator: "\n")
    }

    // MARK: Addresses

    private static let netshUsage =
        "Usage: netsh interface ip set address <adapter> static <address> <mask> [<gateway>]\n"
        + "       netsh interface ip set address <adapter> dhcp"

    /// `netsh interface ip set address "eth0" static 192.168.1.10 255.255.255.0 192.168.1.1`.
    /// `ipv4` may stand for `ip`, and the keywords `name=`, `source=`, `address=`, `mask=` and
    /// `gateway=` of the long form are accepted as well.
    private func netsh(_ arguments: [String]) -> String {
        let words = arguments.map { word -> String in
            var text = word
            for key in ["name=", "source=", "address=", "mask=", "gateway="] where text.lowercased().hasPrefix(key) {
                text = String(text.dropFirst(key.count))
            }
            return text.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        }
        let lower = words.map { $0.lowercased() }
        guard lower.count >= 5, lower[0] == "interface", ["ip", "ipv4"].contains(lower[1]), lower[2] == "set",
              lower[3] == "address" else { return HostEngine.netshUsage }
        let rest = Array(words.dropFirst(4))
        guard let adapterName = rest.first,
              let port = access.interfaces.first(where: { $0.name.lowercased() == adapterName.lowercased() }) else {
            return "The interface \"\(rest.first ?? "")\" was not found. Adapters: "
                + access.interfaces.map(\.name).joined(separator: ", ")
        }
        let mode = rest.count > 1 ? rest[1].lowercased() : ""
        if mode == "dhcp" { return Notices.dhcpNotSimulated }
        guard mode == "static", rest.count >= 4 else { return HostEngine.netshUsage }
        guard let prefix = IPv4Prefix(address: rest[2], mask: rest[3]) ?? IPv4Prefix(cidr: rest[2]),
              prefix.isHostAddress else {
            return "The parameter is incorrect: \(rest[2]) \(rest[3])"
        }
        var gateway: IPv4?
        if rest.count >= 5 {
            guard let value = IPv4(rest[4]), prefix.contains(value) else {
                return "The default gateway \(rest[4]) is not in the network \(prefix.networkPrefix)."
            }
            gateway = value
        }
        access.transaction {
            access.setAddress(prefix, on: .port(port.id))
            if rest.count >= 5 { access.setDefaultGateway(gateway) }
        }
        if let owner = access.addressConflict(prefix.address, except: .port(port.id)) {
            return Notices.duplicateAddress(prefix.address.description, owner)
        }
        return "Ok."
    }

    // MARK: ping and tracert

    private func ping(_ arguments: [String]) -> String {
        guard let target = arguments.first(where: { !$0.hasPrefix("-") }) else {
            return "Usage: ping [-n count] target_name"
        }
        guard let destination = IPv4(target) else {
            return "Ping request could not find host \(target). Please check the name and try again."
        }
        var count = 4
        if let index = arguments.firstIndex(of: "-n"), index + 1 < arguments.count,
           let value = Int(arguments[index + 1]), (1...100).contains(value) {
            count = value
        }
        let simulator = access.simulator
        let result = simulator.ping(from: access.deviceID, to: destination)
        var lines = ["", "Pinging \(destination) with 32 bytes of data:", ""]
        let reply: String
        if result.success {
            let targetCategory = simulator.interfaces.first { $0.prefix.address == destination }
                .flatMap { simulator.device($0.deviceID)?.category }
            let isEndDevice = targetCategory.map { $0 == .pc || $0 == .server } ?? true
            let initial = isEndDevice ? 128 : 255
            let ttl = max(1, initial - max(0, result.hopCount - 1))
            reply = "Reply from \(destination): bytes=32 time<1ms TTL=\(ttl)"
        } else if case .noRoute(let router)? = result.forward.failure, router != access.deviceID,
                  let gateway = result.forward.hops.last {
            reply = "Reply from \(gateway): Destination host unreachable."
        } else {
            reply = "Request timed out."
        }
        lines.append(contentsOf: Array(repeating: reply, count: count))
        let received = result.success ? count : 0
        lines.append("")
        lines.append("Ping statistics for \(destination):")
        lines.append("    Packets: Sent = \(count), Received = \(received), Lost = \(count - received) (\((count - received) * 100 / count)% loss),")
        if result.success {
            lines.append("Approximate round trip times in milli-seconds:")
            lines.append("    Minimum = 0ms, Maximum = 0ms, Average = 0ms")
        } else {
            let reason = simulator.explain(result)
            if !reason.isEmpty { lines.append(reason) }
        }
        return lines.joined(separator: "\n")
    }

    private func tracert(_ arguments: [String]) -> String {
        guard let target = arguments.first(where: { !$0.hasPrefix("-") }) else {
            return "Usage: tracert target_name"
        }
        guard let destination = IPv4(target) else {
            return "Unable to resolve target system name \(target)."
        }
        let simulator = access.simulator
        let delivery = simulator.deliver(from: access.deviceID, to: destination)
        var lines = ["", "Tracing route to \(destination) over a maximum of 30 hops:", ""]
        for (index, hop) in delivery.hops.enumerated() {
            lines.append("\(index + 1)".leftPadded(3) + "   0 ms      0 ms      0 ms      \(hop)")
        }
        if delivery.delivered {
            lines.append("")
            lines.append("Trace complete.")
        } else {
            lines.append("\(delivery.hops.count + 1)".leftPadded(3) + "   *         *         *         Request timed out.")
            let reason = simulator.explain(simulator.ping(from: access.deviceID, to: destination))
            if !reason.isEmpty { lines.append(reason) }
        }
        return lines.joined(separator: "\n")
    }

    /// "   Media State . . . . . . . . . : value", the dotted layout of Windows ipconfig.
    private static func field(_ name: String, _ value: String) -> String {
        let dotted = String((name + String(repeating: " .", count: 20)).prefix(33)).trimmingTrailingWhitespace()
        return "   " + dotted.padded(34) + ": " + value
    }

    // MARK: Help and completion

    func help(_ partial: String) -> String {
        guard access.exists, !isClosed, partial.count <= CLILimits.maxLineLength else { return "" }
        let words = partial.split(whereSeparator: { $0.isWhitespace })
        if words.count > 1 || (words.count == 1 && partial.last?.isWhitespace == true) {
            return "NetSketch: k parametrům příkazů není nápověda, zkuste „help“."
        }
        let prefix = words.first.map { $0.lowercased() } ?? ""
        let matches = HostEngine.commands.filter { $0.name.hasPrefix(prefix) }
        guard !matches.isEmpty else { return "Invalid Command." }
        let width = matches.map(\.name.count).max() ?? 0
        return matches.map { "  " + $0.name.padded(width) + "  " + $0.help }.joined(separator: "\n")
    }

    func complete(_ partial: String) -> [String] {
        guard access.exists, !isClosed, partial.count <= CLILimits.maxLineLength else { return [] }
        let words = partial.split(whereSeparator: { $0.isWhitespace })
        guard words.count <= 1, partial.last?.isWhitespace != true else { return [] }
        let prefix = words.first.map { $0.lowercased() } ?? ""
        return HostEngine.commands.map(\.name).filter { $0.hasPrefix(prefix) }.sorted()
    }
}
