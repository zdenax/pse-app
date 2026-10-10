import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import Testing
import NetSketchCore
@testable import NetSketchCLI

@Suite struct DialectTests {
    @Test func dialectFollowsVendor() {
        #expect(CLI.dialect(vendor: "Cisco", model: "Catalyst 2960-24", category: .switch) == .ios)
        #expect(CLI.dialect(vendor: "Dell EMC", model: "S3048-ON", category: .l3switch) == .dellOS9)
        #expect(CLI.dialect(vendor: "MikroTik", model: "hAP lite", category: .router) == .routerOS)
        #expect(CLI.dialect(vendor: "Ubiquiti", model: "UDM Pro", category: .router) == .generic)
        #expect(CLI.dialect(vendor: "", model: "", category: .switch) == .generic)
    }

    @Test func everythingButAccessPointsHasAConsole() throws {
        let store = makeStore()
        let supported = [TemplateID.c2960_24, TemplateID.c3650, TemplateID.isr4321, TemplateID.dellS3048,
                         TemplateID.hapLite, TemplateID.udmPro, TemplateID.pc, TemplateID.server]
        for id in supported {
            let device = try store.addDevice(templateID: id, at: .zero)
            #expect(CLI.supportsConsole(device), "\(id)")
        }
        let accessPoint = try store.addDevice(templateID: TemplateID.accessPoint, at: .zero)
        #expect(!CLI.supportsConsole(accessPoint))
        #expect(CLI.dialect(vendor: "Generic", model: "PC", category: .pc) == .host)
    }

    @Test func sessionPicksTheEngineOfTheDialect() throws {
        #expect(try makeSession(TemplateID.c2960_24).2.dialect == .ios)
        #expect(try makeSession(TemplateID.dellS3048).2.dialect == .dellOS9)
        #expect(try makeSession(TemplateID.hapLite).2.dialect == .routerOS)
        let (_, _, generic) = try makeSession(TemplateID.udmPro)
        #expect(generic.dialect == .generic)
        #expect(generic.banner.contains("obecnou syntaxi ve stylu Cisco IOS"))
        #expect(generic.prompt == "R1>")
    }
}

@Suite struct IOSModeTests {
    @Test func modesAndPrompts() throws {
        let (_, _, cli) = try makeSession(TemplateID.c2960_24)
        #expect(cli.banner.contains("SW1"))
        #expect(cli.prompt == "SW1>")
        cli.execute("enable")
        #expect(cli.prompt == "SW1#")
        #expect(cli.execute("configure terminal") == "Enter configuration commands, one per line.  End with CNTL/Z.")
        #expect(cli.prompt == "SW1(config)#")
        cli.execute("interface fa0/1")
        #expect(cli.prompt == "SW1(config-if)#")
        cli.execute("exit")
        #expect(cli.prompt == "SW1(config)#")
        cli.execute("interface range fa0/1 - 4")
        #expect(cli.prompt == "SW1(config-if-range)#")
        cli.execute("end")
        #expect(cli.prompt == "SW1#")
        cli.execute("disable")
        #expect(cli.prompt == "SW1>")
        #expect(!cli.isClosed)
        cli.execute("exit")
        #expect(cli.isClosed)
        #expect(cli.execute("enable") == "")
    }

    @Test func abbreviationsAndCtrlZ() throws {
        let (_, _, cli) = try makeSession(TemplateID.c2960_24)
        cli.run("en", "conf t", "int gi0/2")
        #expect(cli.prompt == "SW1(config-if)#")
        cli.execute("\u{1A}")
        #expect(cli.prompt == "SW1#")
    }

    @Test func parserErrors() throws {
        let (_, _, cli) = try makeSession(TemplateID.c2960_24)
        cli.execute("enable")
        // The caret sits under the first character that fits no command; the prompt "SW1#" is 4 wide.
        #expect(cli.execute("foo") == "    ^\n% Invalid input detected at '^' marker.")
        #expect(cli.execute("e") == "% Ambiguous command:  \"e\"")
        #expect(cli.execute("show") == "% Incomplete command.")
        #expect(cli.execute("   ") == "")
    }

    @Test func helpAndCompletion() throws {
        let (_, _, cli) = try makeSession(TemplateID.c2960_24)
        #expect(cli.help("").contains("enable"))
        #expect(!cli.help("").contains("configure"))
        #expect(cli.help("sh") == "show")
        #expect(cli.complete("sh") == ["show"])
        cli.execute("enable")
        #expect(cli.complete("conf") == ["configure"])
        #expect(cli.complete("show run") == ["running-config"])
        // "?" typed at the end of a line asks for help instead of running the command.
        #expect(cli.execute("conf?") == "configure")
        #expect(cli.prompt == "SW1#")
    }

    @Test func pastedBlockRunsLineByLine() throws {
        let (store, _, cli) = try makeSession(TemplateID.c2960_24)
        cli.execute("enable\nconfigure terminal\nhostname CORE\ninterface fa0/3\ndescription Tiskarna\nend")
        #expect(cli.prompt == "CORE#")
        #expect(try store.port("CORE", "Fa0/3").description == "Tiskarna")
    }

    @Test func overlongLineIsRefused() throws {
        let (_, _, cli) = try makeSession(TemplateID.c2960_24)
        let line = String(repeating: "x", count: CLILimits.maxLineLength + 1)
        #expect(cli.execute(line) == Notices.lineTooLong)
    }
}

@Suite struct IOSConfigTests {
    private func configured(_ templateID: String = TemplateID.c2960_24) throws -> (ProjectStore, Device, CLISession) {
        let result = try makeSession(templateID)
        result.2.run("enable", "configure terminal")
        return result
    }

    @Test func hostnameRenamesTheDevice() throws {
        let (store, device, cli) = try configured()
        cli.execute("hostname CORE")
        #expect(store.project.device(id: device.id)?.hostname == "CORE")
        #expect(cli.prompt == "CORE(config)#")
        // A rename on the canvas shows up in the prompt at once.
        try store.renameDevice(id: device.id, to: "EDGE")
        #expect(cli.prompt == "EDGE(config)#")
        cli.execute("no hostname")
        #expect(store.project.device(id: device.id)?.hostname == "Switch")
    }

    @Test func descriptionAndShutdown() throws {
        let (store, _, cli) = try configured()
        cli.run("interface fa0/1", "description Uplink na SW2", "shutdown")
        var port = try store.port("SW1", "Fa0/1")
        #expect(port.description == "Uplink na SW2")
        #expect(port.adminDown)
        cli.run("no shutdown", "no description")
        port = try store.port("SW1", "Fa0/1")
        #expect(port.description == "")
        #expect(!port.adminDown)
    }

    @Test func accessPortCreatesTheVLAN() throws {
        let (store, _, cli) = try configured()
        cli.execute("interface fa0/5")
        cli.execute("switchport mode access")
        let output = cli.execute("switchport access vlan 10")
        #expect(output == "% Access VLAN does not exist. Creating vlan 10")
        #expect(try store.port("SW1", "Fa0/5").vlan == "access 10")
        #expect(try store.device("SW1").vlans == [VLANEntry(id: 10)])
        // The second port finds the VLAN already there.
        cli.execute("interface fa0/6")
        #expect(cli.execute("switchport access vlan 10") == "")
        #expect(try store.port("SW1", "Fa0/6").vlan == "10")
    }

    @Test func trunkSettingsInAnyOrder() throws {
        let (store, _, cli) = try configured()
        cli.run(
            "interface gi0/1",
            "switchport trunk native vlan 99",
            "switchport trunk allowed vlan 10,20,30-32",
            "switchport mode trunk"
        )
        #expect(try store.port("SW1", "Gi0/1").vlan == "trunk 10,20,30-32 native 99")
        cli.execute("switchport trunk allowed vlan remove 31")
        #expect(try store.port("SW1", "Gi0/1").vlan == "trunk 10,20,30,32 native 99")
        cli.execute("switchport trunk allowed vlan add 40")
        #expect(try store.port("SW1", "Gi0/1").vlan == "trunk 10,20,30,32,40 native 99")
        cli.run("no switchport trunk native vlan", "switchport trunk allowed vlan all")
        #expect(try store.port("SW1", "Gi0/1").vlan == "trunk")
        // Leaving trunk mode keeps nothing that would change the meaning.
        cli.execute("switchport mode access")
        #expect(try store.port("SW1", "Gi0/1").vlan == "access 1")
    }

    @Test func dynamicTrunkingIsNotSimulated() throws {
        let (store, _, cli) = try configured()
        cli.execute("interface fa0/1")
        #expect(cli.execute("switchport mode dynamic desirable") == Notices.dynamicTrunking)
        #expect(try store.port("SW1", "Fa0/1").vlan == "")
    }

    @Test func handTypedVLANTextIsReplacedWithANotice() throws {
        let (store, _, cli) = try configured()
        try store.setPortVLAN(store.ref("SW1", "Fa0/7"), "tiskárny, patro 2")
        cli.execute("interface fa0/7")
        let output = cli.execute("switchport mode access")
        #expect(output.hasPrefix("NetSketch:"))
        #expect(output.contains("tiskárny, patro 2"))
        #expect(try store.port("SW1", "Fa0/7").vlan == "access 1")
    }

    @Test func rangeIsOneUndoStep() throws {
        let (store, _, cli) = try configured()
        cli.execute("interface range fa0/1 - 4 , gi0/2")
        let before = store.project
        cli.execute("shutdown")
        for name in ["Fa0/1", "Fa0/2", "Fa0/3", "Fa0/4", "Gi0/2"] {
            #expect(try store.port("SW1", name).adminDown, "\(name)")
        }
        #expect(try !store.port("SW1", "Fa0/5").adminDown)
        #expect(store.undo())
        #expect(store.project == before)
    }

    @Test func vlanDatabase() throws {
        let (store, _, cli) = try configured()
        cli.execute("vlan 20")
        #expect(cli.prompt == "SW1(config-vlan)#")
        cli.execute("name SERVERS")
        #expect(try store.device("SW1").vlans == [VLANEntry(id: 20, name: "SERVERS")])
        #expect(cli.execute("vlan 1") == "")
        #expect(cli.execute("name X") == "%Default VLAN 1 may not have its name changed.")
        // A global command typed in a sub-mode runs and leaves the sub-mode.
        cli.execute("no vlan 20")
        #expect(cli.prompt == "SW1(config)#")
        #expect(try store.device("SW1").vlans.isEmpty)
        #expect(cli.execute("no vlan 1") == "%Default VLAN 1 may not be deleted.")
    }

    @Test func globalCommandFromInterfaceMode() throws {
        let (store, _, cli) = try configured()
        cli.execute("interface fa0/1")
        cli.execute("hostname ACCESS1")
        #expect(cli.prompt == "ACCESS1(config)#")
        #expect(try store.device("ACCESS1").hostname == "ACCESS1")
        cli.execute("interface fa0/1")
        // An error deep inside an interface command stays an interface error.
        let output = cli.execute("switchport mode bogus")
        #expect(output.hasSuffix("% Invalid input detected at '^' marker."))
        #expect(cli.prompt == "ACCESS1(config-if)#")
    }

    @Test func virtualInterfaces() throws {
        let (_, _, cli) = try configured()
        #expect(cli.execute("interface port-channel 1") == Notices.lagIsDrawn)
        #expect(cli.prompt == "SW1(config)#")
        // A switch has VLAN interfaces (SVI), a router has none in the diagram.
        #expect(cli.execute("interface vlan 10") == "")
        #expect(cli.prompt == "SW1(config-if)#")
        let (_, _, router) = try configured(TemplateID.isr4321)
        #expect(router.execute("interface vlan 10") == Notices.virtualInterface)
    }

    @Test func unknownPortNumberIsAnError() throws {
        let (_, _, cli) = try configured()
        let output = cli.execute("interface fa0/99")
        #expect(output.hasSuffix("% Invalid input detected at '^' marker."))
        #expect(cli.prompt == "SW1(config)#")
    }

    @Test func notStoredCommandsSaySo() throws {
        let (store, _, cli) = try configured()
        let before = store.project
        #expect(cli.execute("ip domain-name lab.local").hasPrefix("NetSketch:"))
        #expect(cli.execute("ip routing") == "")
        #expect(cli.execute("do telnet 10.0.0.1") == Notices.needsSimulation)
        #expect(cli.execute("do write memory") == Notices.savedInProject)
        #expect(store.project == before)
    }

    @Test func defaultInterface() throws {
        let (store, _, cli) = try configured()
        cli.run("interface fa0/2", "description X", "switchport access vlan 30", "shutdown", "exit")
        #expect(cli.execute("default interface fa0/2") == "Interface FastEthernet0/2 set to default configuration")
        let port = try store.port("SW1", "Fa0/2")
        #expect(port.description == "" && port.vlan == "" && !port.adminDown)
    }
}

@Suite struct IOSShowTests {
    @Test func runningConfigFollowsTheDiagram() throws {
        let (store, _, cli) = try makeSession(TemplateID.c2960_24)
        cli.run("enable", "configure terminal", "vlan 10", "name USERS", "interface fa0/1",
                "description Uplink", "switchport mode access", "switchport access vlan 10", "end")
        // A change made in the inspector is visible without reopening the console.
        try store.setPortDescription(store.ref("SW1", "Fa0/2"), "Tiskárna")

        let config = cli.execute("show running-config")
        #expect(config.hasPrefix("Building configuration..."))
        #expect(config.contains("hostname SW1"))
        #expect(config.contains("vlan 10\n name USERS"))
        #expect(config.contains("interface FastEthernet0/1\n description Uplink\n switchport access vlan 10\n switchport mode access"))
        #expect(config.contains("interface FastEthernet0/2\n description Tiskárna"))
        #expect(!config.contains("Console"))
        #expect(config.hasSuffix("end"))
    }

    @Test func linkStateComesFromTheCabling() throws {
        let store = makeStore()
        try store.addDevice(templateID: TemplateID.c2960_24, at: .zero)
        try store.addDevice(templateID: TemplateID.c2960_24, at: CGPoint(x: 400, y: 0))
        try store.connect(store.ref("SW1", "Fa0/1"), store.ref("SW2", "Fa0/1"))
        let sw1 = try store.device("SW1")
        let cli = CLISession(store: store, deviceID: sw1.id)

        #expect(cli.execute("show interfaces fa0/1").hasPrefix("FastEthernet0/1 is up, line protocol is up (connected)"))
        #expect(cli.execute("show interfaces fa0/2").hasPrefix("FastEthernet0/2 is down, line protocol is down (notconnect)"))
        // The far end shut down: the link goes down here too.
        try store.setPortAdminDown(store.ref("SW2", "Fa0/1"), true)
        #expect(cli.execute("show interfaces fa0/1").hasPrefix("FastEthernet0/1 is down"))
    }

    @Test func historyKeepsTheCommands() throws {
        let (_, _, cli) = try makeSession(TemplateID.c2960_24)
        cli.run("enable", "show version")
        let history = cli.execute("show history")
        #expect(history.contains("enable"))
        #expect(history.contains("show version"))
    }
}

@Suite struct SessionLifecycleTests {
    @Test func deletedDeviceEndsTheSession() throws {
        let (store, device, cli) = try makeSession(TemplateID.c2960_24)
        try store.removeDevice(id: device.id)
        #expect(cli.execute("enable") == Notices.deviceGone)
        #expect(cli.isClosed)
        #expect(cli.prompt == "SW1>")
        #expect(cli.complete("en").isEmpty)
    }

    @Test func undoAfterCLIChange() throws {
        let (store, _, cli) = try makeSession(TemplateID.c2960_24)
        cli.run("enable", "configure terminal", "interface fa0/1")
        let before = store.project
        cli.execute("description A")
        cli.execute("description B")
        #expect(store.undo())
        #expect(try store.port("SW1", "Fa0/1").description == "A")
        #expect(store.undo())
        #expect(store.project == before)
    }
}
