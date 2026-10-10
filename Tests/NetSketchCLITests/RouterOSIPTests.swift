import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import Testing
import NetSketchCore
@testable import NetSketchCLI

@Suite struct RouterOSIPTests {
    private static let crs = "mikrotik-crs-generic"

    /// hAP lite routers with the given hostnames, side by side, and a console on each.
    private func makeRouters(_ hostnames: [String]) throws -> (ProjectStore, [CLISession]) {
        let store = makeStore()
        var sessions: [CLISession] = []
        for (index, hostname) in hostnames.enumerated() {
            let device = try store.addDevice(templateID: TemplateID.hapLite,
                                             at: CGPoint(x: CGFloat(100 + 200 * index), y: 100), hostname: hostname)
            sessions.append(CLISession(store: store, deviceID: device.id))
        }
        return (store, sessions)
    }

    // MARK: /ip address

    @Test func addPrintAndRemoveAddresses() throws {
        let (store, _, cli) = try makeSession(TemplateID.hapLite)
        #expect(cli.execute("/ip address add address=192.168.88.1/24 interface=ether2") == "")
        let ether2 = try store.port("R1", "ether2")
        #expect(try store.device("R1").addresses == [InterfaceAddress(interface: .port(ether2.id), address: "192.168.88.1/24")])

        // Interface names are matched case-insensitively, argument names may be abbreviated.
        #expect(cli.execute("/ip address add addr=10.0.0.1/30 int=ETHER1") == "")
        let listing = cli.execute("/ip address print")
        #expect(listing.hasPrefix("Flags: X - disabled, I - invalid, D - dynamic\n #   ADDRESS            NETWORK         INTERFACE"))
        #expect(listing.contains("\n 0   192.168.88.1/24    192.168.88.0    ether2"))
        #expect(listing.contains("\n 1   10.0.0.1/30        10.0.0.0        ether1"))

        // One address per interface: a second add replaces the first one.
        let replaced = cli.execute("/ip address add address=192.168.88.5/24 interface=ether2")
        #expect(replaced.hasPrefix("NetSketch:"))
        #expect(try store.device("R1").addresses.map(\.address) == ["192.168.88.5/24", "10.0.0.1/30"])
        #expect(cli.execute("/ip address add address=192.168.88.5/24 interface=ether2").hasPrefix("failure:"))

        let export = cli.execute("/export")
        #expect(export.contains("/ip address\nadd address=192.168.88.5/24 interface=ether2\nadd address=10.0.0.1/30 interface=ether1"))
        #expect(cli.execute("/ip address export").contains("add address=10.0.0.1/30 interface=ether1"))
        #expect(!cli.execute("/ip route export").contains("/ip address"))

        cli.execute("/ip address")
        #expect(cli.execute("remove 0") == "")
        #expect(try store.device("R1").addresses.map(\.address) == ["10.0.0.1/30"])
        #expect(cli.execute("remove numbers=0") == "")
        #expect(try store.device("R1").addresses.isEmpty)
    }

    @Test func badValuesAreRefused() throws {
        let (store, _, cli) = try makeSession(TemplateID.hapLite)
        let before = store.project
        #expect(cli.execute("/ip address add interface=ether2") == "missing value(s) of argument(s) address")
        #expect(cli.execute("/ip address add address=192.168.88.1/24") == "missing value(s) of argument(s) interface")
        #expect(cli.execute("/ip address add address=300.1.1.1/24 interface=ether2") == "invalid value for argument address")
        #expect(cli.execute("/ip address add address=192.168.88.1/33 interface=ether2") == "invalid value for argument address")
        // The network and the broadcast address are not host addresses.
        #expect(cli.execute("/ip address add address=192.168.88.0/24 interface=ether2").hasPrefix("invalid value for argument address"))
        #expect(cli.execute("/ip address add address=192.168.88.255/24 interface=ether2").hasPrefix("invalid value for argument address"))
        #expect(cli.execute("/ip address add address=192.168.88.1/24 interface=ether9") == "input does not match any value of interface")
        // A router has no bridge in NetSketch.
        #expect(cli.execute("/ip address add address=192.168.88.1/24 interface=bridge").hasPrefix("input does not match any value of interface"))
        #expect(cli.execute("/ip address add address=192.168.88.1/24 interface=ether2 mtu=1500") == "expected end of command (line 1 column 58)")
        #expect(cli.execute("/ip address remove 0") == "no such item")
        #expect(cli.execute("/ip address remove x") == "input does not match any value of numbers")
        #expect(cli.execute("/ip address remove") == "missing value(s) of argument(s) numbers")

        #expect(cli.execute("/ip route add dst-address=10.0.2.0/24") == "missing value(s) of argument(s) gateway")
        #expect(cli.execute("/ip route add dst-address=10.0.2.0/33 gateway=10.0.0.2") == "invalid value for argument dst-address")
        #expect(cli.execute("/ip route add dst-address=10.0.2.0/24 gateway=10.0.0") == "invalid value for argument gateway")
        #expect(cli.execute("/ip route add gateway=ether1").hasPrefix("invalid value for argument gateway\nNetSketch:"))
        #expect(cli.execute("/ip route remove 0") == "no such item")

        #expect(cli.execute("/ping 10.0.0") == "invalid value for argument address")
        #expect(cli.execute("/ping") == "missing value(s) of argument(s) address")
        #expect(cli.execute("/ping 10.0.0.2 count=0") == "invalid value for argument count")
        #expect(cli.execute("/ping 10.0.0.2 count=many") == "invalid value for argument count")
        #expect(store.project == before)
    }

    @Test func addressWithoutPrefixLengthIsAHostRoute() throws {
        let (store, _, cli) = try makeSession(TemplateID.hapLite)
        #expect(cli.execute("/ip address add address=10.1.1.1 interface=ether3").hasPrefix("NetSketch:"))
        #expect(try store.device("R1").addresses.map(\.address) == ["10.1.1.1/32"])
    }

    @Test func duplicateAddressIsReported() throws {
        let (store, sessions) = try makeRouters(["R1", "R2"])
        sessions[0].execute("/ip address add address=10.0.0.1/30 interface=ether1")
        let output = sessions[1].execute("/ip address add address=10.0.0.1/30 interface=ether1")
        #expect(output.hasPrefix("NetSketch:") && output.contains("R1"))
        // Stored all the same, as RouterOS does.
        #expect(try store.device("R2").addresses.map(\.address) == ["10.0.0.1/30"])
    }

    @Test func switchAddressBelongsToTheBridge() throws {
        let (store, _, cli) = try makeSession(RouterOSIPTests.crs, hostname: "SW1")
        let before = store.project
        #expect(cli.execute("/ip address add address=192.168.88.2/24 interface=ether1")
            == "NetSketch: na přepínači nastavte adresu na interface=bridge.")
        #expect(store.project == before)

        #expect(cli.execute("/ip address add address=192.168.88.2/24 interface=bridge") == "")
        #expect(try store.device("SW1").addresses == [InterfaceAddress(interface: .vlan(1), address: "192.168.88.2/24")])
        #expect(cli.execute("/ip address print").contains("\n 0   192.168.88.2/24    192.168.88.0    bridge"))
        #expect(cli.execute("/export").contains("add address=192.168.88.2/24 interface=bridge"))
        // bridge1 is the same bridge.
        #expect(cli.execute("/ip address add address=192.168.88.3/24 interface=bridge1").hasPrefix("NetSketch:"))
        #expect(try store.device("SW1").addresses == [InterfaceAddress(interface: .vlan(1), address: "192.168.88.3/24")])
    }

    @Test func routerPingsTheSwitchBridge() throws {
        let store = makeStore()
        let router = try store.addDevice(templateID: TemplateID.hapLite, at: CGPoint(x: 100, y: 100), hostname: "R1")
        let crs = try store.addDevice(templateID: RouterOSIPTests.crs, at: CGPoint(x: 300, y: 100), hostname: "SW1")
        try store.connect(store.ref("R1", "ether2"), store.ref("SW1", "ether5"))
        CLISession(store: store, deviceID: crs.id).execute("/ip address add address=192.168.88.2/24 interface=bridge")
        let cli = CLISession(store: store, deviceID: router.id)
        cli.execute("/ip address add address=192.168.88.1/24 interface=ether2")
        #expect(cli.execute("/ping 192.168.88.2 count=1").contains("sent=1 received=1 packet-loss=0%"))
        let routes = CLISession(store: store, deviceID: crs.id).execute("/ip route print")
        #expect(routes.contains("ADC  192.168.88.0/24    192.168.88.2    bridge"))
    }

    // MARK: /ip route

    @Test func addPrintAndRemoveRoutes() throws {
        let (store, sessions) = try makeRouters(["R1", "R2"])
        try store.connect(store.ref("R1", "ether1"), store.ref("R2", "ether1"))
        let cli = sessions[0]
        cli.execute("/ip address add address=10.0.12.1/30 interface=ether1")
        sessions[1].execute("/ip address add address=10.0.12.2/30 interface=ether1")

        #expect(cli.execute("/ip route add dst-address=10.0.2.0/24 gateway=10.0.12.2") == "")
        #expect(cli.execute("/ip route add gateway=10.0.12.2") == "")
        // Stored even though the gateway is not on a connected network (yet).
        #expect(cli.execute("/ip route add dst-address=172.16.0.0/16 gateway=192.168.5.1").hasPrefix("NetSketch:"))
        // Host bits of the destination are dropped.
        #expect(cli.execute("/ip route add dst-address=10.0.3.7/24 gateway=10.0.12.2") == "")
        #expect(cli.execute("/ip route add dst-address=10.0.3.0/24 gateway=10.0.12.2") == "failure: already have such route")
        #expect(try store.device("R1").staticRoutes == [
            StaticRoute(destination: "10.0.2.0/24", nextHop: "10.0.12.2"),
            StaticRoute(destination: "0.0.0.0/0", nextHop: "10.0.12.2"),
            StaticRoute(destination: "172.16.0.0/16", nextHop: "192.168.5.1"),
            StaticRoute(destination: "10.0.3.0/24", nextHop: "10.0.12.2"),
        ])

        let listing = cli.execute("/ip route print").components(separatedBy: "\n")
        #expect(listing.count == 8)
        #expect(listing[0] == "Flags: X - disabled, A - active, D - dynamic, C - connect, S - static")
        #expect(listing[1] == " #      DST-ADDRESS        PREF-SRC        GATEWAY            DISTANCE")
        #expect(listing[2] == " 0 ADC  10.0.12.0/30       10.0.12.1       ether1                    0")
        #expect(listing[3] == " 1 A S  10.0.2.0/24                        10.0.12.2                 1")
        #expect(listing[4].hasPrefix(" 2 A S  0.0.0.0/0 "))
        #expect(listing[5].hasPrefix(" 3 A S  10.0.3.0/24 "))
        // The inactive route comes last, without the A flag.
        #expect(listing[6] == " 4   S  172.16.0.0/16                      192.168.5.1               1")
        #expect(listing[7].hasPrefix("NetSketch:"))

        let export = cli.execute("/ip route export")
        #expect(export.contains("/ip route\nadd dst-address=10.0.2.0/24 gateway=10.0.12.2\nadd dst-address=0.0.0.0/0 gateway=10.0.12.2"))
        #expect(!export.contains("/ip address"))
        #expect(cli.execute("/export").contains("add dst-address=172.16.0.0/16 gateway=192.168.5.1"))

        // A connected route cannot be removed; nothing changes then.
        let before = store.project
        #expect(cli.execute("/ip route remove 0,1").hasPrefix("failure: cannot remove dynamic route"))
        #expect(store.project == before)

        // Numbers as printed: 1 = 10.0.2.0/24, 4 = the inactive 172.16.0.0/16.
        #expect(cli.execute("/ip route remove 1,4") == "")
        #expect(try store.device("R1").staticRoutes == [
            StaticRoute(destination: "0.0.0.0/0", nextHop: "10.0.12.2"),
            StaticRoute(destination: "10.0.3.0/24", nextHop: "10.0.12.2"),
        ])
        #expect(store.undo())
        #expect(store.project == before)
    }

    // MARK: /ping

    @Test func pingBetweenTwoCabledRouters() throws {
        let (store, sessions) = try makeRouters(["R1", "R2"])
        try store.connect(store.ref("R1", "ether1"), store.ref("R2", "ether1"))
        sessions[0].execute("/ip address add address=10.0.0.1/30 interface=ether1")
        sessions[1].execute("/ip address add address=10.0.0.2/30 interface=ether1")

        let lines = sessions[0].execute("/ping 10.0.0.2").components(separatedBy: "\n")
        #expect(lines == [
            "  SEQ HOST                                     SIZE TTL TIME       STATUS",
            "    0 10.0.0.2                                   56  64 0ms",
            "    1 10.0.0.2                                   56  64 0ms",
            "    2 10.0.0.2                                   56  64 0ms",
            "    3 10.0.0.2                                   56  64 0ms",
            "    sent=4 received=4 packet-loss=0% min-rtt=0ms avg-rtt=0ms max-rtt=0ms",
        ])
        let back = sessions[1].execute("/ping address=10.0.0.1 count=2")
        #expect(back.contains("sent=2 received=2 packet-loss=0%"))
        #expect(!back.contains("NetSketch:"))
        // At most 20 packets, with a notice.
        let many = sessions[1].execute("/ping 10.0.0.1 count=50")
        #expect(many.contains("sent=20 received=20"))
        #expect(many.hasSuffix(".") && many.contains("NetSketch:"))
    }

    @Test func pingWithoutCableFailsWithAnExplanation() throws {
        let (_, sessions) = try makeRouters(["R1", "R2"])
        sessions[0].execute("/ip address add address=10.0.0.1/30 interface=ether1")
        sessions[1].execute("/ip address add address=10.0.0.2/30 interface=ether1")

        let output = sessions[0].execute("/ping 10.0.0.2 count=2")
        let lines = output.components(separatedBy: "\n")
        #expect(lines.count == 5)
        #expect(lines[1] == "    0 10.0.0.2                                                   timeout")
        #expect(lines[3] == "    sent=2 received=0 packet-loss=100%")
        #expect(lines[4].hasPrefix("NetSketch:"))
    }

    @Test func pingAcrossAThirdRouterNeedsStaticRoutes() throws {
        let (store, sessions) = try makeRouters(["R1", "R2", "R3"])
        try store.connect(store.ref("R1", "ether1"), store.ref("R2", "ether1"))
        try store.connect(store.ref("R2", "ether2"), store.ref("R3", "ether1"))
        let (r1, r2, r3) = (sessions[0], sessions[1], sessions[2])
        r1.execute("/ip address add address=10.0.12.1/30 interface=ether1")
        r2.execute("/ip address add address=10.0.12.2/30 interface=ether1")
        r2.execute("/ip address add address=10.0.23.1/30 interface=ether2")
        r3.execute("/ip address add address=10.0.23.2/30 interface=ether1")

        // Without routes R1 does not know the far network.
        let failed = r1.execute("/ping 10.0.23.2 count=1")
        #expect(failed.contains("packet-loss=100%"))
        #expect(failed.contains("NetSketch:"))

        #expect(r1.execute("/ip route add dst-address=10.0.23.0/30 gateway=10.0.12.2") == "")
        // The request arrives now, the reply does not: R3 has no way back yet.
        #expect(r1.execute("/ping 10.0.23.2 count=1").contains("packet-loss=100%"))
        #expect(r3.execute("/ip route add dst-address=10.0.12.0/30 gateway=10.0.23.1") == "")

        let output = r1.execute("/ping 10.0.23.2 count=1")
        #expect(output.contains("    0 10.0.23.2                                  56  63 0ms"))
        #expect(output.contains("sent=1 received=1 packet-loss=0%"))
        #expect(r3.execute("/ping 10.0.12.1 count=1").contains("received=1"))
    }

    // MARK: Undo, help and completion

    @Test func eachCommandIsOneUndoStep() throws {
        let (store, _, cli) = try makeSession(TemplateID.hapLite)
        let before = store.project
        cli.execute("/ip address add address=192.168.88.1/24 interface=ether2")
        #expect(store.project != before)
        #expect(store.undo())
        #expect(store.project == before)

        cli.execute("/ip address add address=192.168.88.1/24 interface=ether2")
        cli.execute("/ip address add address=10.0.0.1/30 interface=ether1")
        let twoAddresses = store.project
        cli.execute("/ip address remove 0,1")
        #expect(try store.device("R1").addresses.isEmpty)
        #expect(store.undo())
        #expect(store.project == twoAddresses)
    }

    @Test func helpAndCompletion() throws {
        let (_, _, cli) = try makeSession(TemplateID.hapLite)
        #expect(cli.complete("/ip ad") == ["address"])
        #expect(cli.complete("/ip r") == ["route"])
        #expect(cli.complete("/pi") == ["ping"])
        #expect(cli.help("").contains("ip -- IP options"))
        #expect(cli.help("/ip address ").contains("add -- Create a new item"))
        #expect(cli.help("/ip address add ").contains("interface= -- Interface name"))
        #expect(cli.complete("/ip address add addr") == ["address="])
        let names = cli.complete("/ip address add address=10.0.0.1/24 interface=eth")
        #expect(names.contains("interface=ether1") && !names.contains("interface=wlan1"))
        #expect(cli.complete("/ip route add g") == ["gateway="])
        #expect(cli.complete("/ip route add d") == ["dst-address="])
        #expect(cli.complete("/ping 10.0.0.1 c") == ["count="])

        cli.execute("/ip address add address=192.168.88.1/24 interface=ether2")
        #expect(cli.help("/ip address remove ").contains("0 -- 192.168.88.1/24 ether2"))

        let (_, _, crs) = try makeSession(RouterOSIPTests.crs, hostname: "SW1")
        #expect(crs.complete("/ip address add interface=") == ["interface=bridge"])
    }
}
