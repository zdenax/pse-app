import Foundation

/// The command trees of the IOS-style dialects, one per mode.
///
/// This is the single definition of the command language: keywords, arguments, help texts and
/// handlers. Parsing, abbreviations, error messages, "?" help and Tab completion are all
/// derived from these trees by `CommandParser`.
struct CommandTables {
    let userExec: CommandNode
    let privilegedExec: CommandNode
    let globalConfig: CommandNode
    let interfaceConfig: CommandNode
    /// IOS `vlan N` mode.
    let vlanConfig: CommandNode
    /// Dell OS9 `interface vlan N` mode.
    let vlanInterfaceConfig: CommandNode
    let lineConfig: CommandNode

    init(dialect: CLIDialect) {
        let dell = dialect == .dellOS9
        userExec = root(CommandTables.execCommands(dell: dell, privileged: false))
        privilegedExec = root(CommandTables.execCommands(dell: dell, privileged: true))
        globalConfig = root(CommandTables.globalConfigCommands(dell: dell))
        interfaceConfig = root(CommandTables.interfaceConfigCommands(dell: dell))
        vlanConfig = root(CommandTables.vlanConfigCommands(dell: dell))
        vlanInterfaceConfig = root(CommandTables.vlanInterfaceCommands())
        lineConfig = root(CommandTables.lineConfigCommands(dell: dell))
    }

    // MARK: Building blocks

    /// A command that would need a running network: accepted, answered with the notice.
    private static func simulated(_ name: String, _ help: String) -> CommandNode {
        kw(name, help, [line("rest", help, run: { _, _ in Notices.needsSimulation })],
           run: { _, _ in Notices.needsSimulation })
    }

    /// A configuration command the diagram has no field for: accepted, nothing is stored.
    private static func notStored(_ name: String, _ help: String, bare: Bool = false) -> CommandNode {
        let report: CommandHandler = { _, command in
            let first = (command.text("rest") ?? "").split(separator: " ").first.map(String.init)
            return Notices.notStored(([name] + (first.map { [$0] } ?? [])).joined(separator: " "))
        }
        return kw(name, help, [line("rest", help, run: report)], run: bare ? report : nil)
    }

    private static func notStored(_ entries: [(String, String)]) -> [CommandNode] {
        entries.map { notStored($0.0, $0.1) }
    }

    /// `exit`, `end` and `do` of every configuration mode.
    private static func configNavigation(dell: Bool) -> [CommandNode] {
        [
            kw("exit", "Exit from current mode", run: { engine, _ in engine.exitCommand() }),
            kw("end", "Exit from configure mode", run: { engine, _ in engine.endConfig() }),
            kw("do", "To run exec commands in config mode", doCommands(dell: dell)),
        ]
    }

    // MARK: show

    private static func showCommand(dell: Bool, privileged: Bool) -> CommandNode {
        let interface = IOSEngine.interfaceArgument
        var children: [CommandNode] = []

        if privileged {
            children.append(kw("running-config", "Current operating configuration", [
                kw("interface", "Show interface configuration", [
                    custom(interface, run: { engine, command in engine.showRunningConfigInterface(command) }),
                ]),
            ], run: { engine, command in engine.showRunningConfig(command) }))
            children.append(kw("startup-config", "Contents of startup configuration",
                               run: { _, _ in Notices.savedInProject }))
        }

        var interfaceDetails: [CommandNode] = [
            kw("status", "Show interface line status", run: { engine, command in engine.showInterfacesStatus(command) }),
            kw("description", "Show interface description", run: { engine, command in engine.showInterfacesDescription(command) }),
        ]
        if !dell {
            interfaceDetails.append(kw("switchport", "Show interface switchport information",
                                       run: { engine, command in engine.showInterfacesSwitchport(command) }))
            interfaceDetails.append(kw("trunk", "Show interface trunk information",
                                       run: { engine, command in engine.showInterfacesTrunk(command) }))
        }
        children.append(kw(
            "interfaces", "Interface status and configuration",
            interfaceDetails + [
                custom(interface, "", interfaceDetails, run: { engine, command in engine.showInterfaces(command) }),
                simulated("counters", "Show interface counters"),
            ],
            run: { engine, command in engine.showInterfaces(command) }
        ))

        var vlanChildren = [
            kw("id", "VTP VLAN status by VLAN id", [
                num("vlan", 1...4094, "A VLAN id", run: { engine, command in engine.showVLAN(command) }),
            ]),
        ]
        if !dell {
            vlanChildren.append(kw("brief", "VTP all VLAN status in brief", run: { engine, command in engine.showVLAN(command) }))
        }
        children.append(kw("vlan", dell ? "VLAN information" : "VTP VLAN status", vlanChildren,
                           run: { engine, command in engine.showVLAN(command) }))

        if !dell {
            children.append(kw("cdp", "CDP information", [
                kw("neighbors", "CDP neighbor entries", [
                    kw("detail", "Show detailed information", run: { engine, command in engine.showCDPNeighbors(command) }),
                ], run: { engine, command in engine.showCDPNeighbors(command) }),
            ]))
            children.append(kw("etherchannel", "EtherChannel information", [
                kw("summary", "One-line summary per channel-group",
                   run: { engine, command in engine.showEtherchannelSummary(command) }),
            ]))
            children.append(kw("inventory", "Show the physical inventory", run: { engine, command in engine.showInventory(command) }))
            children.append(kw("ip", "IP information", [
                kw("interface", "IP interface status and configuration", [
                    kw("brief", "Brief summary of IP status and configuration",
                       run: { engine, command in engine.showIPInterfaceBrief(command) }),
                ]),
                simulated("route", "IP routing table"),
                simulated("arp", "IP ARP table"),
                simulated("protocols", "IP routing protocol process parameters and statistics"),
                simulated("ospf", "OSPF information"),
                simulated("eigrp", "EIGRP information"),
                simulated("dhcp", "Show items in the DHCP database"),
                simulated("nat", "IP NAT information"),
            ]))
        } else {
            children.append(kw("ip", "IP information", [
                simulated("route", "IP routing table"),
                simulated("interface", "IP interface status"),
                simulated("ospf", "OSPF information"),
            ]))
        }

        children.append(kw("lldp", "LLDP information", [
            kw("neighbors", "LLDP neighbor entries", run: { engine, command in engine.showLLDPNeighbors(command) }),
        ]))
        children.append(kw("version", dell ? "Software version" : "System hardware and software status",
                           run: { engine, command in engine.showVersion(command) }))
        children.append(kw("history", "Display the session command history", run: { engine, command in engine.showHistory(command) }))

        children.append(contentsOf: [
            simulated("spanning-tree", "Spanning tree topology"),
            simulated("mac", "MAC configuration"),
            simulated("mac-address-table", "MAC forwarding table"),
            simulated("lacp", "Port channel information"),
            simulated("arp", "ARP table"),
        ])
        if !dell {
            children.append(contentsOf: [
                simulated("pagp", "Port channel information"),
                simulated("port-security", "Show secure port information"),
                simulated("vtp", "VTP information"),
                simulated("dtp", "DTP information"),
                simulated("standby", "Hot Standby Router Protocol (HSRP) information"),
            ])
        }
        return kw("show", "Show running system information", children)
    }

    // MARK: EXEC

    private static func saveCommands() -> [CommandNode] {
        [
            kw("write", "Write running configuration to memory, network, or terminal", [
                kw("memory", "Write to NV memory", run: { _, _ in Notices.savedInProject }),
                kw("erase", "Erase NV memory", run: { _, _ in Notices.nothingToErase }),
            ], run: { _, _ in Notices.savedInProject }),
            kw("copy", "Copy from one file to another", [
                kw("running-config", "Copy from current system configuration", [
                    kw("startup-config", "Copy to startup configuration", run: { _, _ in Notices.savedInProject }),
                ]),
                kw("startup-config", "Copy from startup configuration", [
                    kw("running-config", "Update (merge with) current system configuration",
                       run: { _, _ in Notices.savedInProject }),
                ]),
            ]),
        ]
    }

    private static func simulatedExecCommands() -> [CommandNode] {
        [
            simulated("ping", "Send echo messages"),
            simulated("traceroute", "Trace route to destination"),
            simulated("telnet", "Open a telnet connection"),
            simulated("ssh", "Open a secure shell client connection"),
        ]
    }

    private static func privilegedOnlyCommands() -> [CommandNode] {
        saveCommands() + [
            simulated("reload", "Halt and perform a cold restart"),
            simulated("clear", "Reset functions"),
            simulated("debug", "Debugging functions"),
            simulated("undebug", "Disable debugging functions"),
            kw("erase", "Erase a filesystem", [
                kw("startup-config", "Erase contents of configuration memory", run: { _, _ in Notices.nothingToErase }),
            ]),
        ]
    }

    /// The commands `do` offers inside configuration modes.
    private static func doCommands(dell: Bool) -> [CommandNode] {
        [showCommand(dell: dell, privileged: true)] + simulatedExecCommands() + privilegedOnlyCommands()
    }

    private static func execCommands(dell: Bool, privileged: Bool) -> [CommandNode] {
        var commands: [CommandNode] = [
            showCommand(dell: dell, privileged: privileged),
            kw("enable", "Turn on privileged commands", run: { engine, _ in engine.enterPrivileged() }),
            kw("disable", "Turn off privileged commands", run: { engine, _ in engine.leavePrivileged() }),
            kw("exit", "Exit from the EXEC", run: { engine, _ in engine.exitCommand() }),
            kw("logout", "Exit from the EXEC", run: { engine, _ in engine.exitCommand() }),
            kw("terminal", "Set terminal line parameters", [
                line("rest", "Terminal parameters (accepted, the console has no paging)", run: { _, _ in "" }),
            ]),
        ]
        commands.append(contentsOf: simulatedExecCommands())
        if privileged {
            commands.append(kw("configure", "Enter configuration mode", [
                kw("terminal", "Configure from the terminal", run: { engine, _ in engine.enterGlobalConfig() }),
            ], run: { engine, _ in engine.enterGlobalConfig() }))
            commands.append(contentsOf: privilegedOnlyCommands())
        }
        return commands
    }

    // MARK: Global configuration

    private static func interfaceCommand(dell: Bool) -> CommandNode {
        kw("interface", "Select an interface to configure", [
            kw("range", "interface range command", [
                custom(IOSEngine.interfaceRangeArgument, run: { engine, command in engine.enterInterface(command) }),
            ]),
            custom(IOSEngine.interfaceArgument, run: { engine, command in engine.enterInterface(command) }),
        ])
    }

    private static func globalConfigCommands(dell: Bool) -> [CommandNode] {
        var unsupported: [(String, String)] = [
            ("ip", "Global IP configuration subcommands"),
            ("ipv6", "Global IPv6 configuration commands"),
            ("enable", "Modify enable password parameters"),
            ("username", "Establish User Name Authentication"),
            ("service", "Modify use of network based services"),
            ("router", "Enable a routing process"),
            ("logging", "Modify message logging facilities"),
            ("ntp", "Configure NTP"),
            ("snmp-server", "Modify SNMP engine parameters"),
            ("clock", "Configure time-of-day clock"),
            ("aaa", "Authentication, Authorization and Accounting"),
            ("lldp", "Global LLDP configuration subcommands"),
        ]
        if dell {
            unsupported.append(contentsOf: [
                ("protocol", "Enter protocol configuration mode"),
                ("management", "Management interface commands"),
                ("stack-unit", "Stack unit configuration"),
                ("boot", "Modify system boot parameters"),
            ])
        } else {
            unsupported.append(contentsOf: [
                ("spanning-tree", "Spanning Tree Subsystem"),
                ("access-list", "Add an access list entry"),
                ("vtp", "Configure global VTP state"),
                ("cdp", "Global CDP configuration subcommands"),
                ("crypto", "Encryption module"),
                ("monitor", "Monitoring different system events"),
                ("mac", "Global MAC configuration subcommands"),
                ("errdisable", "Error disable"),
                ("port-channel", "EtherChannel configuration"),
                ("boot", "Modify system boot parameters"),
            ])
        }

        var negated: [CommandNode] = [
            kw("hostname", "Set system's network name", run: { engine, _ in engine.resetHostname() }),
            kw("interface", "Select an interface to configure", [
                custom(IOSEngine.interfaceArgument, run: { engine, command in engine.removeInterface(command) }),
            ]),
        ]
        var commands: [CommandNode] = [
            kw("hostname", "Set system's network name", [
                word("name", "This system's network name", run: { engine, command in engine.setHostname(command) }),
            ]),
            interfaceCommand(dell: dell),
            kw("line", "Configure a terminal line", [
                line("rest", "Line to configure (console, vty, aux)", run: { engine, command in engine.enterLine(command) }),
            ]),
            kw("banner", "Define a login banner", [
                line("rest", "Banner type and delimited text", run: { engine, command in engine.bannerCommand(command) }),
            ]),
        ]

        if dell {
            // OS9 has no `vlan N` command; say how it is done instead of a bare parser error.
            commands.append(kw("vlan", "", [line("rest", "", run: { _, _ in Notices.dellVLANCommand })],
                               hidden: true, run: { _, _ in Notices.dellVLANCommand }))
        } else {
            commands.append(kw("vlan", "Vlan commands", [
                vlanList("vlans", "ISL VLAN IDs 1-4094", run: { engine, command in engine.enterVLANConfig(command) }),
            ]))
            negated.append(kw("vlan", "Vlan commands", [
                vlanList("vlans", "ISL VLAN IDs 1-4094", run: { engine, command in engine.deleteVLANs(command) }),
            ]))
            commands.append(kw("default", "Set a command to its defaults", [
                kw("interface", "Select an interface to configure", [
                    custom(IOSEngine.interfaceArgument, run: { engine, command in engine.defaultInterface(command) }),
                ]),
            ]))
        }

        commands.append(contentsOf: notStored(unsupported))
        negated.append(contentsOf: notStored(unsupported))
        negated.append(notStored("banner", "Define a login banner"))
        commands.append(kw("no", "Negate a command or set its defaults", negated))
        commands.append(contentsOf: configNavigation(dell: dell))
        return commands
    }

    // MARK: Interface configuration

    private static func interfaceConfigCommands(dell: Bool) -> [CommandNode] {
        var unsupported: [(String, String)] = [
            ("ip", "Interface Internet Protocol config commands"),
            ("ipv6", "IPv6 interface subcommands"),
            ("speed", "Configure speed operation"),
            ("duplex", "Configure duplex operation"),
            ("mtu", "Set the interface Maximum Transmission Unit (MTU)"),
            ("lldp", "LLDP interface subcommands"),
        ]
        if dell {
            unsupported.append(contentsOf: [
                ("portmode", "Set port mode (hybrid)"),
                ("flowcontrol", "Configure flow control"),
                ("negotiation", "Select autonegotiation mode"),
                ("spanning-tree", "Spanning Tree subsystem"),
            ])
        } else {
            unsupported.append(contentsOf: [
                ("spanning-tree", "Spanning Tree Subsystem"),
                ("mdix", "Set Media Dependent Interface with Crossover"),
                ("cdp", "CDP interface subcommands"),
                ("storm-control", "storm configuration"),
                ("power", "Power configuration"),
                ("negotiation", "Select autonegotiation mode"),
                ("encapsulation", "Set encapsulation type for an interface"),
            ])
        }

        var commands: [CommandNode] = [
            kw("description", "Interface specific description", [
                line("text", "Up to 240 characters describing this interface",
                     run: { engine, command in engine.setDescription(command) }),
            ]),
            kw("shutdown", "Shutdown the selected interface", run: { engine, _ in engine.setShutdown(true) }),
        ]
        var negated: [CommandNode] = [
            kw("description", "Interface specific description", [
                line("text", "Description text (ignored)", run: { engine, _ in engine.clearDescription() }),
            ], run: { engine, _ in engine.clearDescription() }),
            kw("shutdown", "Shutdown the selected interface", run: { engine, _ in engine.setShutdown(false) }),
        ]

        if dell {
            // OS9: `switchport` only puts the port into Layer 2 mode; VLANs are set elsewhere.
            commands.append(kw("switchport", "Configure Layer 2 mode", [
                line("rest", "", run: { _, _ in Notices.dellUsesVLANInterface }),
            ], run: { _, _ in "" }))
            negated.append(kw("switchport", "Configure Layer 2 mode", run: { _, _ in Notices.routedPortNotModelled }))
            commands.append(kw("port-channel-protocol", "Select port-channel protocol (LACP)", [
                line("rest", "Protocol", run: { _, _ in Notices.lagIsDrawn }),
            ]))
        } else {
            commands.append(switchportCommand())
            negated.append(noSwitchportCommand())
            let lag: CommandHandler = { _, _ in Notices.lagIsDrawn }
            commands.append(kw("channel-group", "Etherchannel/port bundling configuration", [
                num("group", 1...4096, "Channel group number", [
                    kw("mode", "Etherchannel Mode of the interface", [
                        kw("active", "Enable LACP unconditionally", run: lag),
                        kw("passive", "Enable LACP only if a LACP device is detected", run: lag),
                        kw("on", "Enable Etherchannel only", run: lag),
                        kw("auto", "Enable PAgP only if a PAgP device is detected", run: lag),
                        kw("desirable", "Enable PAgP unconditionally", run: lag),
                    ]),
                ]),
            ]))
            negated.append(kw("channel-group", "Etherchannel/port bundling configuration", run: lag))
        }

        commands.append(contentsOf: notStored(unsupported))
        negated.append(contentsOf: notStored(unsupported))
        commands.append(kw("no", "Negate a command or set its defaults", negated))
        commands.append(contentsOf: configNavigation(dell: dell))
        return commands
    }

    private static func switchportCommand() -> CommandNode {
        kw("switchport", "Set switching mode characteristics", [
            kw("mode", "Set trunking mode of the interface", [
                kw("access", "Set trunking mode to ACCESS unconditionally",
                   run: { engine, _ in engine.setSwitchportMode(.access) }),
                kw("trunk", "Set trunking mode to TRUNK unconditionally",
                   run: { engine, _ in engine.setSwitchportMode(.trunk) }),
                kw("dynamic", "Set trunking mode to dynamically negotiate access or trunk mode", [
                    kw("auto", "Set trunking mode dynamic negotiation parameter to AUTO",
                       run: { _, _ in Notices.dynamicTrunking }),
                    kw("desirable", "Set trunking mode dynamic negotiation parameter to DESIRABLE",
                       run: { _, _ in Notices.dynamicTrunking }),
                ]),
            ]),
            kw("access", "Set access mode characteristics of the interface", [
                kw("vlan", "Set VLAN when interface is in access mode", [
                    num("vlan", 1...4094, "VLAN ID of the VLAN when this port is in access mode",
                        run: { engine, command in engine.setAccessVLAN(command) }),
                ]),
            ]),
            kw("trunk", "Set trunking characteristics of the interface", [
                kw("allowed", "Set allowed VLAN characteristics when interface is in trunking mode", [
                    kw("vlan", "Set allowed VLANs when interface is in trunking mode", [
                        vlanList("vlans", "VLAN IDs of the allowed VLANs when this port is in trunking mode",
                                 run: { engine, command in engine.setAllowedVLANs(.replace, command) }),
                        kw("add", "add VLANs to the current list", [
                            vlanList("vlans", "VLAN IDs to add", run: { engine, command in engine.setAllowedVLANs(.add, command) }),
                        ]),
                        kw("remove", "remove VLANs from the current list", [
                            vlanList("vlans", "VLAN IDs to remove", run: { engine, command in engine.setAllowedVLANs(.remove, command) }),
                        ]),
                        kw("except", "all VLANs except the following", [
                            vlanList("vlans", "VLAN IDs to leave out", run: { engine, command in engine.setAllowedVLANs(.except, command) }),
                        ]),
                        kw("all", "all VLANs", run: { engine, command in engine.setAllowedVLANs(.all, command) }),
                        kw("none", "no VLANs", run: { engine, command in engine.setAllowedVLANs(.none, command) }),
                    ]),
                ]),
                kw("native", "Set trunking native characteristics when interface is in trunking mode", [
                    kw("vlan", "Set native VLAN when interface is in trunking mode", [
                        num("vlan", 1...4094, "VLAN ID of the native VLAN when this port is in trunking mode",
                            run: { engine, command in engine.setNativeVLAN(command) }),
                    ]),
                ]),
                kw("encapsulation", "Set trunking encapsulation when interface is in trunking mode", [
                    // 802.1Q is the only encapsulation the diagram knows, so there is nothing to store.
                    kw("dot1q", "Interface uses only 802.1q trunking encapsulation when trunking", run: { _, _ in "" }),
                ]),
            ]),
            notStored("nonegotiate", "Device will not engage in negotiation protocol on this interface", bare: true),
            notStored("port-security", "Security related command", bare: true),
            notStored("voice", "Voice appliance attributes"),
        ], run: { _, _ in "" })
    }

    private static func noSwitchportCommand() -> CommandNode {
        kw("switchport", "Set switching mode characteristics", [
            kw("mode", "Set trunking mode of the interface", [
                line("rest", "Mode (ignored)", run: { engine, _ in engine.setSwitchportMode(.unset) }),
            ], run: { engine, _ in engine.setSwitchportMode(.unset) }),
            kw("access", "Set access mode characteristics of the interface", [
                kw("vlan", "Set VLAN when interface is in access mode", [
                    line("rest", "VLAN (ignored)", run: { engine, _ in engine.updateSwitchport { $0.accessVLAN = 1 } }),
                ], run: { engine, _ in engine.updateSwitchport { $0.accessVLAN = 1 } }),
            ]),
            kw("trunk", "Set trunking characteristics of the interface", [
                kw("allowed", "Set allowed VLAN characteristics when interface is in trunking mode", [
                    kw("vlan", "Set allowed VLANs when interface is in trunking mode", [
                        line("rest", "VLANs (ignored)", run: { engine, _ in engine.updateSwitchport { $0.allowedVLANs = nil } }),
                    ], run: { engine, _ in engine.updateSwitchport { $0.allowedVLANs = nil } }),
                ]),
                kw("native", "Set trunking native characteristics when interface is in trunking mode", [
                    kw("vlan", "Set native VLAN when interface is in trunking mode", [
                        line("rest", "VLAN (ignored)", run: { engine, _ in engine.updateSwitchport { $0.nativeVLAN = 1 } }),
                    ], run: { engine, _ in engine.updateSwitchport { $0.nativeVLAN = 1 } }),
                ]),
                kw("encapsulation", "Set trunking encapsulation when interface is in trunking mode", run: { _, _ in "" }),
            ]),
            notStored("nonegotiate", "Device will not engage in negotiation protocol on this interface", bare: true),
            notStored("port-security", "Security related command", bare: true),
            notStored("voice", "Voice appliance attributes"),
        ], run: { _, _ in Notices.routedPortNotModelled })
    }

    // MARK: VLAN configuration

    private static func vlanConfigCommands(dell: Bool) -> [CommandNode] {
        [
            kw("name", "Ascii name of the VLAN", [
                word("name", "The ascii name for the VLAN", run: { engine, command in engine.setVLANName(command) }),
            ]),
            kw("no", "Negate a command or set its defaults", [
                kw("name", "Ascii name of the VLAN", run: { engine, _ in engine.resetVLANName() }),
                notStored("state", "Operational state of the VLAN"),
                notStored("shutdown", "Shutdown VLAN switching", bare: true),
            ]),
            notStored("state", "Operational state of the VLAN"),
            notStored("shutdown", "Shutdown VLAN switching", bare: true),
            notStored("mtu", "VLAN Maximum Transmission Unit"),
        ] + configNavigation(dell: dell)
    }

    private static func vlanInterfaceCommands() -> [CommandNode] {
        let range = IOSEngine.interfaceRangeArgument
        return [
            kw("name", "Set the VLAN name", [
                word("name", "VLAN name (up to 32 characters)", run: { engine, command in engine.setVLANName(command) }),
            ]),
            kw("tagged", "Add tagged member interfaces", [
                custom(range, run: { engine, command in engine.dellChangeMembership(.tagged, command) }),
            ]),
            kw("untagged", "Add untagged member interfaces", [
                custom(range, run: { engine, command in engine.dellChangeMembership(.untagged, command) }),
            ]),
            kw("no", "Negate a command or set its defaults", [
                kw("name", "Set the VLAN name", [
                    line("rest", "VLAN name (ignored)", run: { engine, _ in engine.resetVLANName() }),
                ], run: { engine, _ in engine.resetVLANName() }),
                kw("tagged", "Remove tagged member interfaces", [
                    custom(range, run: { engine, command in engine.dellChangeMembership(.noTagged, command) }),
                ]),
                kw("untagged", "Remove untagged member interfaces", [
                    custom(range, run: { engine, command in engine.dellChangeMembership(.noUntagged, command) }),
                ]),
                notStored("shutdown", "Shutdown the VLAN interface", bare: true),
                notStored("ip", "Interface Internet Protocol config commands"),
                notStored("description", "VLAN interface description", bare: true),
            ]),
            notStored("shutdown", "Shutdown the VLAN interface", bare: true),
            notStored("ip", "Interface Internet Protocol config commands"),
            notStored("description", "VLAN interface description"),
            notStored("mtu", "Set the interface Maximum Transmission Unit (MTU)"),
        ] + configNavigation(dell: true)
    }

    // MARK: Line configuration

    private static func lineConfigCommands(dell: Bool) -> [CommandNode] {
        // Entering the mode already said that nothing is stored; the sub-commands stay silent.
        [
            line("rest", "Line configuration command (accepted, not stored)", run: { _, _ in "" }),
        ] + configNavigation(dell: dell)
    }
}
