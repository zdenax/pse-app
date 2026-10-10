import Foundation
import Testing
import NetSketchCore
@testable import NetSketchCLI

@Suite struct DellOS9Tests {
    private func configured() throws -> (ProjectStore, Device, CLISession) {
        let result = try makeSession(TemplateID.dellS3048, hostname: "DELL1")
        result.2.run("enable", "configure")
        return result
    }

    @Test func promptsFollowOS9() throws {
        let (_, _, cli) = try makeSession(TemplateID.dellS3048, hostname: "DELL1")
        #expect(cli.prompt == "DELL1>")
        cli.execute("enable")
        #expect(cli.prompt == "DELL1#")
        #expect(cli.execute("configure") == "")
        #expect(cli.prompt == "DELL1(conf)#")
        cli.execute("interface gigabitethernet 1/1")
        #expect(cli.prompt == "DELL1(conf-if-gi-1/1)#")
        cli.execute("exit")
        cli.execute("interface vlan 10")
        #expect(cli.prompt == "DELL1(conf-if-vl-10)#")
        cli.execute("end")
        #expect(cli.prompt == "DELL1#")
    }

    @Test func vlanMembershipIsSetInTheVLANInterface() throws {
        let (store, _, cli) = try configured()
        cli.execute("interface vlan 10")
        #expect(try store.device("DELL1").vlans == [VLANEntry(id: 10)])
        cli.run("name USERS", "untagged gigabitethernet 1/1", "tagged gi 1/2")
        #expect(try store.device("DELL1").vlans == [VLANEntry(id: 10, name: "USERS")])
        #expect(try store.port("DELL1", "GigabitEthernet 1/1").vlan == "access 10")
        #expect(try store.port("DELL1", "GigabitEthernet 1/2").vlan == "trunk 10")

        // Tagged in 20 as well, untagged in 10: an OS9 hybrid port.
        cli.run("exit", "interface vlan 20", "tagged gigabitethernet 1/1")
        #expect(try store.port("DELL1", "GigabitEthernet 1/1").vlan == "trunk 20 native 10")

        // Deleting the VLAN removes its memberships too.
        cli.execute("no interface vlan 20")
        #expect(cli.prompt == "DELL1(conf)#")
        #expect(try store.port("DELL1", "GigabitEthernet 1/1").vlan == "access 10")
        #expect(try store.device("DELL1").vlans.map(\.id) == [10])
    }

    @Test func iosVLANSyntaxIsExplained() throws {
        let (store, _, cli) = try configured()
        let before = store.project
        #expect(cli.execute("vlan 10") == Notices.dellVLANCommand)
        cli.execute("interface gigabitethernet 1/3")
        #expect(cli.execute("switchport access vlan 10") == Notices.dellUsesVLANInterface)
        #expect(store.project == before)
    }

    @Test func errorsUseTheOS9Wording() throws {
        let (_, _, cli) = try configured()
        #expect(cli.execute("hostname") == "% Error: Incomplete command.")
        #expect(cli.execute("bogus").hasSuffix("% Error: Invalid input at \"^\" marker."))
    }

    @Test func descriptionAndShutdownOnARange() throws {
        let (store, _, cli) = try configured()
        cli.run("interface range gigabitethernet 1/1 - 1/3", "description Access", "shutdown")
        #expect(cli.prompt.hasPrefix("DELL1(conf-if-range-gi-1/1-1/3)"))
        for number in 1...3 {
            let port = try store.port("DELL1", "GigabitEthernet 1/\(number)")
            #expect(port.description == "Access" && port.adminDown)
        }
        #expect(try !store.port("DELL1", "GigabitEthernet 1/4").adminDown)
    }
}

@Suite struct RouterOSTests {
    @Test func menusAndPrompts() throws {
        let (_, _, cli) = try makeSession(TemplateID.hapLite)
        #expect(cli.prompt == "[admin@R1] > ")
        cli.execute("/interface")
        #expect(cli.prompt == "[admin@R1] /interface> ")
        cli.execute("ethernet")
        #expect(cli.prompt == "[admin@R1] /interface ethernet> ")
        cli.execute("..")
        #expect(cli.prompt == "[admin@R1] /interface> ")
        cli.execute("/")
        #expect(cli.prompt == "[admin@R1] > ")
        #expect(cli.execute("foo") == "bad command name foo (line 1 column 1)")
        cli.execute("/quit")
        #expect(cli.isClosed)
    }

    @Test func commentsAndDisabling() throws {
        let (store, _, cli) = try makeSession(TemplateID.hapLite)
        cli.execute("/interface ethernet")
        cli.execute("set ether1 comment=WAN")
        cli.execute("disable ether2")
        #expect(try store.port("R1", "ether1").description == "WAN")
        #expect(try store.port("R1", "ether2").adminDown)
        cli.execute("comment ether3 \"to the printer\"")
        #expect(try store.port("R1", "ether3").description == "to the printer")
        cli.execute("enable ether2")
        #expect(try !store.port("R1", "ether2").adminDown)

        let listing = cli.execute("print")
        #expect(listing.contains(";;; WAN"))
        #expect(!listing.contains("wlan1"))
        #expect(cli.execute("/interface print").contains("wlan1"))
    }

    @Test func setIsOneUndoStep() throws {
        let (store, _, cli) = try makeSession(TemplateID.hapLite)
        let before = store.project
        cli.execute("/interface set ether1,ether2 comment=LAN disabled=yes")
        #expect(try store.port("R1", "ether2").description == "LAN")
        #expect(try store.port("R1", "ether1").adminDown)
        #expect(store.undo())
        #expect(store.project == before)
    }

    @Test func identity() throws {
        let (store, device, cli) = try makeSession(TemplateID.hapLite)
        cli.execute("/system identity set name=GW")
        #expect(store.project.device(id: device.id)?.hostname == "GW")
        #expect(cli.prompt == "[admin@GW] > ")
        #expect(cli.execute("/system identity print") == "  name: GW")
        #expect(cli.execute("/export").contains("set name=GW"))
    }

    @Test func helpAndCompletion() throws {
        let (_, _, cli) = try makeSession(TemplateID.hapLite)
        #expect(cli.complete("/int") == ["interface"])
        #expect(cli.help("").contains("interface -- Interface configuration"))
        cli.execute("/interface")
        #expect(cli.complete("set eth").contains("ether1"))
    }

    @Test func unknownItemIsReported() throws {
        let (store, _, cli) = try makeSession(TemplateID.hapLite)
        let before = store.project
        #expect(cli.execute("/interface disable ether9") == "input does not match any value of numbers")
        #expect(store.project == before)
    }
}
