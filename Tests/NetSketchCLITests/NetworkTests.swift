import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import Testing
import NetSketchCore
@testable import NetSketchCLI

/// Two devices of `templateA`/`templateB` named A and B, cabled `portA` - `portB`.
private func pair(_ templateA: String, _ portA: String, _ templateB: String, _ portB: String) throws
    -> (ProjectStore, CLISession, CLISession) {
    let store = makeStore()
    let a = try store.addDevice(templateID: templateA, at: .zero, hostname: "A")
    let b = try store.addDevice(templateID: templateB, at: CGPoint(x: 600, y: 0), hostname: "B")
    try store.connect(store.ref("A", portA), store.ref("B", portB))
    return (store, CLISession(store: store, deviceID: a.id), CLISession(store: store, deviceID: b.id))
}

@Suite struct IPv4Tests {
    @Test func parsing() {
        #expect(IPv4("192.168.1.10")?.description == "192.168.1.10")
        #expect(IPv4("192.168.1") == nil && IPv4("256.1.1.1") == nil && IPv4("1.2.3.x") == nil)
        #expect(IPv4("255.255.255.252")?.prefixLength == 30)
        #expect(IPv4("255.0.255.0")?.prefixLength == nil)
        let prefix = IPv4Prefix(address: "10.0.12.1", mask: "255.255.255.252")
        #expect(prefix?.description == "10.0.12.1/30")
        #expect(prefix?.network.description == "10.0.12.0")
        #expect(prefix?.contains(IPv4("10.0.12.2")!) == true)
        #expect(prefix?.contains(IPv4("10.0.12.4")!) == false)
        #expect(IPv4Prefix(cidr: "10.0.12.0/30")?.isHostAddress == false)
        #expect(IPv4Prefix(cidr: "0.0.0.0/0")?.length == 0)
    }
}

@Suite struct IOSNetworkTests {
    @Test func routersPingOverACable() throws {
        let (store, r1, r2) = try pair(TemplateID.isr4321, "Gi0/0/0", TemplateID.isr4321, "Gi0/0/0")
        r1.run("enable", "configure terminal", "interface gi0/0/0", "ip address 10.0.0.1 255.255.255.252", "end")
        r2.run("enable", "configure terminal", "interface gi0/0/0", "ip address 10.0.0.2 255.255.255.252", "end")
        let device = try store.device("A")
        #expect(device.addresses.count == 1)
        #expect(device.addresses.first?.address == "10.0.0.1/30")

        let ping = r1.execute("ping 10.0.0.2")
        #expect(ping.contains("!!!!!"))
        #expect(ping.contains("Success rate is 100 percent (5/5)"))

        // Shutting the far end down breaks the link.
        r2.run("configure terminal", "interface gi0/0/0", "shutdown", "end")
        let failed = r1.execute("ping 10.0.0.2")
        #expect(failed.contains("....."))
        #expect(failed.contains("Success rate is 0 percent (0/5)"))
        #expect(failed.contains("NetSketch:"))
    }

    @Test func addressValidation() throws {
        let (store, cli, _) = try pair(TemplateID.isr4321, "Gi0/0/0", TemplateID.isr4321, "Gi0/0/0")
        cli.run("enable", "configure terminal", "interface gi0/0/0")
        #expect(cli.execute("ip address 10.0.0.1 255.0.255.0").hasPrefix("%"))
        #expect(cli.execute("ip address 10.0.0.0 255.255.255.0").hasPrefix("Bad mask"))
        #expect(cli.execute("ip address 10.0.0.1 255.255.255.0") == "")
        cli.execute("interface gi0/0/1")
        #expect(cli.execute("ip address 10.0.0.5 255.255.255.0").contains("overlaps"))
        cli.execute("interface gi0/0/0")
        cli.execute("no ip address")
        #expect(try store.device("A").addresses.isEmpty)
    }

    @Test func switchPortsTakeNoAddressButTheSVIDoes() throws {
        let (store, sw, pc) = try pair(TemplateID.c2960_24, "Fa0/1", TemplateID.pc, "eth0")
        sw.run("enable", "configure terminal", "interface fa0/2")
        #expect(sw.execute("ip address 10.0.0.1 255.255.255.0") == Notices.switchPortHasNoAddress)
        sw.run("exit", "interface vlan 1", "ip address 192.168.1.2 255.255.255.0", "no shutdown", "end")
        #expect(try store.device("A").addresses == [InterfaceAddress(interface: .vlan(1), address: "192.168.1.2/24")])
        #expect(pc.execute("netsh interface ip set address eth0 static 192.168.1.10 255.255.255.0") == "Ok.")
        #expect(sw.execute("ping 192.168.1.10").contains("!!!!!"))
        #expect(pc.execute("ping 192.168.1.2").contains("Reply from 192.168.1.2"))
        let config = sw.execute("show running-config")
        #expect(config.contains("interface Vlan1\n ip address 192.168.1.2 255.255.255.0"))
        #expect(sw.execute("show ip interface brief").contains("192.168.1.2"))
    }

    @Test func vlansSeparateAndTrunksJoin() throws {
        // PC1 - SW1 (VLAN 10) == trunk == SW2 (VLAN 10 / 20) - PC2, PC3.
        let store = makeStore()
        try store.addDevice(templateID: TemplateID.c2960_24, at: .zero, hostname: "SW1")
        try store.addDevice(templateID: TemplateID.c2960_24, at: CGPoint(x: 600, y: 0), hostname: "SW2")
        let pc1 = try store.addDevice(templateID: TemplateID.pc, at: CGPoint(x: 0, y: 400), hostname: "PC1")
        try store.addDevice(templateID: TemplateID.pc, at: CGPoint(x: 400, y: 400), hostname: "PC2")
        try store.addDevice(templateID: TemplateID.pc, at: CGPoint(x: 800, y: 400), hostname: "PC3")
        try store.connect(store.ref("SW1", "Gi0/1"), store.ref("SW2", "Gi0/1"))
        try store.connect(store.ref("PC1", "eth0"), store.ref("SW1", "Fa0/1"))
        try store.connect(store.ref("PC2", "eth0"), store.ref("SW2", "Fa0/1"))
        try store.connect(store.ref("PC3", "eth0"), store.ref("SW2", "Fa0/2"))
        for (name, address) in [("PC1", "10.0.0.1"), ("PC2", "10.0.0.2"), ("PC3", "10.0.0.3")] {
            let device = try store.device(name)
            let cli = CLISession(store: store, deviceID: device.id)
            cli.execute("netsh interface ip set address eth0 static \(address) 255.255.255.0")
        }
        let console = CLISession(store: store, deviceID: pc1.id)
        // Everything in VLAN 1: all reachable.
        #expect(console.execute("ping 10.0.0.3").contains("Reply from"))

        let sw1 = try CLISession(store: store, deviceID: store.device("SW1").id)
        let sw2 = try CLISession(store: store, deviceID: store.device("SW2").id)
        sw1.run("enable", "configure terminal", "interface fa0/1", "switchport mode access", "switchport access vlan 10", "end")
        sw2.run("enable", "configure terminal", "interface fa0/1", "switchport mode access", "switchport access vlan 10",
                "interface fa0/2", "switchport mode access", "switchport access vlan 20", "end")
        // The uplink still carries VLAN 1 only (access port): VLAN 10 does not cross it.
        #expect(console.execute("ping 10.0.0.2").contains("Request timed out."))
        sw1.run("configure terminal", "interface gi0/1", "switchport mode trunk", "end")
        sw2.run("configure terminal", "interface gi0/1", "switchport mode trunk", "end")
        #expect(console.execute("ping 10.0.0.2").contains("Reply from 10.0.0.2"))
        // VLAN 20 is another network: no reply.
        #expect(console.execute("ping 10.0.0.3").contains("Request timed out."))
        // A trunk that does not allow VLAN 10 cuts it again.
        sw2.run("configure terminal", "interface gi0/1", "switchport trunk allowed vlan 20", "end")
        #expect(console.execute("ping 10.0.0.2").contains("Request timed out."))
    }

    @Test func staticRoutesAndShowIPRoute() throws {
        let store = makeStore()
        let r1 = try store.addDevice(templateID: TemplateID.isr4321, at: .zero, hostname: "R1")
        let r2 = try store.addDevice(templateID: TemplateID.isr4321, at: CGPoint(x: 600, y: 0), hostname: "R2")
        let pc = try store.addDevice(templateID: TemplateID.pc, at: CGPoint(x: 0, y: 400), hostname: "PC1")
        try store.connect(store.ref("R1", "Gi0/0/1"), store.ref("R2", "Gi0/0/1"))
        try store.connect(store.ref("PC1", "eth0"), store.ref("R1", "Gi0/0/0"))
        let one = CLISession(store: store, deviceID: r1.id)
        let two = CLISession(store: store, deviceID: r2.id)
        let host = CLISession(store: store, deviceID: pc.id)
        one.run("enable", "configure terminal",
                "interface gi0/0/0", "ip address 192.168.1.1 255.255.255.0",
                "interface gi0/0/1", "ip address 10.0.12.1 255.255.255.252", "end")
        two.run("enable", "configure terminal", "interface gi0/0/1", "ip address 10.0.12.2 255.255.255.252",
                "interface gi0/0/0", "ip address 192.168.2.1 255.255.255.0", "end")
        host.execute("netsh interface ip set address eth0 static 192.168.1.10 255.255.255.0 192.168.1.1")

        // R2 does not know the way back to 192.168.1.0/24 yet.
        let failed = host.execute("ping 10.0.12.2")
        #expect(failed.contains("Request timed out."))
        #expect(failed.contains("odpověď ne"))

        two.run("configure terminal", "ip route 192.168.1.0 255.255.255.0 10.0.12.1", "end")
        #expect(host.execute("ping 10.0.12.2").contains("Reply from 10.0.12.2"))
        let routes = two.execute("show ip route")
        #expect(routes.contains("S        192.168.1.0/24 [1/0] via 10.0.12.1"))
        #expect(routes.contains("C        10.0.12.0/30 is directly connected, GigabitEthernet0/0/1"))
        #expect(two.execute("show running-config").contains("ip route 192.168.1.0 255.255.255.0 10.0.12.1"))
        let trace = host.execute("tracert 10.0.12.2")
        #expect(trace.contains("192.168.1.1"))
        #expect(trace.contains("Trace complete."))

        two.run("configure terminal", "no ip route 192.168.1.0 255.255.255.0", "end")
        #expect(try store.device("R2").staticRoutes.isEmpty)
    }

    @Test func dellAddressesAndRoutes() throws {
        let (store, dell, pc) = try pair(TemplateID.dellS3048, "GigabitEthernet 1/1", TemplateID.pc, "eth0")
        dell.run("enable", "configure", "interface vlan 1", "ip address 172.16.0.1/24", "no shutdown", "exit",
                 "ip route 10.9.0.0/16 172.16.0.254", "end")
        let device = try store.device("A")
        #expect(device.addresses == [InterfaceAddress(interface: .vlan(1), address: "172.16.0.1/24")])
        #expect(device.staticRoutes == [StaticRoute(destination: "10.9.0.0/16", nextHop: "172.16.0.254")])
        pc.execute("netsh interface ip set address eth0 static 172.16.0.10 255.255.255.0")
        #expect(dell.execute("ping 172.16.0.10").contains("Success rate is 100.0 percent (5/5)"))
        let config = dell.execute("show running-config")
        #expect(config.contains(" ip address 172.16.0.1/24"))
        #expect(config.contains("ip route 10.9.0.0/16 172.16.0.254"))
    }

    @Test func eachAddressCommandIsOneUndoStep() throws {
        let (store, cli, _) = try pair(TemplateID.isr4321, "Gi0/0/0", TemplateID.pc, "eth0")
        cli.run("enable", "configure terminal", "interface gi0/0/0")
        let before = store.project
        cli.execute("ip address 10.0.0.1 255.255.255.0")
        #expect(store.undo())
        #expect(store.project == before)
    }
}

@Suite struct HostConsoleTests {
    @Test func promptAndAdapters() throws {
        let (store, pc, _) = try pair(TemplateID.pc, "eth0", TemplateID.c2960_24, "Fa0/3")
        #expect(pc.dialect == .host)
        #expect(pc.prompt == "C:\\>")
        var ipconfig = pc.execute("ipconfig")
        #expect(ipconfig.contains("Ethernet adapter eth0:"))
        #expect(ipconfig.contains("Media connected"))
        #expect(ipconfig.contains("B Fa0/3"))
        #expect(ipconfig.contains("0.0.0.0"))

        #expect(pc.execute("netsh interface ip set address eth0 static 10.1.1.5 255.255.255.0 10.1.1.1") == "Ok.")
        let device = try store.device("A")
        #expect(device.addresses.first?.address == "10.1.1.5/24")
        #expect(device.defaultGateway == "10.1.1.1")
        ipconfig = pc.execute("ipconfig")
        #expect(ipconfig.contains("10.1.1.5"))
        #expect(ipconfig.contains("255.255.255.0"))
        #expect(ipconfig.contains("10.1.1.1"))
        #expect(pc.execute("netsh interface ip set address eth0 static 10.1.1.6 255.255.255.0 10.2.2.2").contains("not in the network"))
        #expect(pc.execute("dir") == "Invalid Command.")
        #expect(pc.complete("ip") == ["ipconfig"])
        #expect(pc.help("").contains("ping"))
        pc.execute("exit")
        #expect(pc.isClosed)
    }

    @Test func pingWithoutAddressExplainsWhy() throws {
        let (_, pc, _) = try pair(TemplateID.pc, "eth0", TemplateID.pc, "eth0")
        let output = pc.execute("ping 10.0.0.2")
        #expect(output.contains("Request timed out."))
        #expect(output.contains("NetSketch:"))
    }
}

@Suite struct ExerciseTests {
    @Test(arguments: Exercises.all.map(\.fileName))
    func exerciseBuildsAndPings(fileName: String) throws {
        let exercise = try #require(Exercises.all.first { $0.fileName == fileName })
        let store = makeStore()
        try exercise.build(store)
        #expect(Exercises.failedPings(exercise, in: store) == [])
        // Saved and opened again it still works.
        let data = try store.project.encoded()
        let reopened = makeStore()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("NetSketchExercise-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent(fileName)
        try data.write(to: url)
        try reopened.open(url)
        #expect(Exercises.failedPings(exercise, in: reopened) == [])
    }

    @Test(arguments: Exercises.all.map(\.fileName))
    func exerciseFileIsDeterministic(fileName: String) throws {
        let exercise = try #require(Exercises.all.first { $0.fileName == fileName })
        let first = makeStore()
        let second = makeStore()
        try exercise.build(first)
        try exercise.build(second)
        #expect(try Exercises.fileData(of: first) == Exercises.fileData(of: second))
    }

    /// The files in examples/ (written by NetSketchExamples, committed by CI) open and work.
    @Test(arguments: Exercises.all.map(\.fileName))
    func committedExerciseFileWorks(fileName: String) throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("examples").appendingPathComponent(fileName)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        let exercise = try #require(Exercises.all.first { $0.fileName == fileName })
        let store = makeStore()
        try store.open(url)
        #expect(store.openIssues.isEmpty)
        #expect(Exercises.failedPings(exercise, in: store) == [])
    }

    @Test func pcConsoleShowsTheRouteThroughTheRouters() throws {
        let store = makeStore()
        try Exercises.fourRouters.build(store)
        let pc = try CLISession(store: store, deviceID: store.device("PC1").id)
        let trace = pc.execute("tracert 192.168.4.10")
        for hop in ["192.168.1.1", "10.0.12.2", "10.0.23.2", "10.0.34.2", "192.168.4.10"] {
            #expect(trace.contains(hop), "\(hop)")
        }
        #expect(pc.execute("ping 192.168.4.10").contains("Reply from 192.168.4.10"))
    }
}
