// The command trees of the IOS-style dialects, one per mode. Port of CommandTables.swift.
//
// This is the single definition of the command language: keywords, arguments, help texts and
// handlers. Parsing, abbreviations, error messages, "?" help and Tab completion are all
// derived from these trees by `CommandParser`.

import {
  closedRange,
  CommandHandler,
  CommandNode,
  custom,
  kw,
  line,
  num,
  root,
  splitSpaces,
  vlanList,
  word,
} from "./command-tree";
import * as Handlers from "./ios-handlers";
import * as Network from "./ios-network";
import * as Show from "./ios-show";
import { IOSEngine } from "./ios-engine";
import { Notices } from "./notices";
import type { CLIDialect } from "./session-api";
import { collectIOSFeatures, mergeNodes } from "./features/ios-commands";

/** The commands of the protocol features, by place (see features/ios-commands.ts). */
type Features = ReturnType<typeof collectIOSFeatures>;

/** A command that would need a running network: accepted, answered with the notice. */
function simulated(name: string, help: string): CommandNode {
  return kw(name, help, [line("rest", help, () => Notices.needsSimulation)], () => Notices.needsSimulation);
}

/** A configuration command the diagram has no field for: accepted, nothing is stored. */
function notStored(name: string, help: string, bare = false): CommandNode {
  const report: CommandHandler = (_engine, command) => {
    const first = splitSpaces(command.text("rest") ?? "")[0];
    return Notices.notStored((first === undefined ? [name] : [name, first]).join(" "));
  };
  return kw(name, help, [line("rest", help, report)], bare ? report : null);
}

function notStoredList(entries: [string, string][]): CommandNode[] {
  return entries.map(([name, help]) => notStored(name, help));
}

/** `exit`, `end` and `do` of every configuration mode. */
function configNavigation(dell: boolean, f: Features): CommandNode[] {
  return [
    kw("exit", "Exit from current mode", [], (engine) => Handlers.exitCommand(engine)),
    kw("end", "Exit from configure mode", [], (engine) => Handlers.endConfig(engine)),
    kw("do", "To run exec commands in config mode", doCommands(dell, f)),
  ];
}

// MARK: show

function showCommand(dell: boolean, privileged: boolean, f: Features): CommandNode {
  const interfaceArgument = IOSEngine.interfaceArgument;
  const children: CommandNode[] = [];

  if (privileged) {
    children.push(
      kw(
        "running-config",
        "Current operating configuration",
        [
          kw("interface", "Show interface configuration", [
            custom(interfaceArgument, (engine, command) => Show.showRunningConfigInterface(engine, command)),
          ]),
        ],
        (engine, command) => Show.showRunningConfig(engine, command),
      ),
    );
    children.push(kw("startup-config", "Contents of startup configuration", [], () => Notices.savedInProject));
  }

  const interfaceDetails: CommandNode[] = [
    kw("status", "Show interface line status", [], (engine, command) => Show.showInterfacesStatus(engine, command)),
    kw("description", "Show interface description", [], (engine, command) =>
      Show.showInterfacesDescription(engine, command),
    ),
  ];
  if (!dell) {
    interfaceDetails.push(
      kw("switchport", "Show interface switchport information", [], (engine, command) =>
        Show.showInterfacesSwitchport(engine, command),
      ),
    );
    interfaceDetails.push(
      kw("trunk", "Show interface trunk information", [], (engine, command) =>
        Show.showInterfacesTrunk(engine, command),
      ),
    );
  }
  children.push(
    kw(
      "interfaces",
      "Interface status and configuration",
      [
        ...interfaceDetails,
        custom(interfaceArgument, (engine, command) => Show.showInterfaces(engine, command), "", interfaceDetails),
        simulated("counters", "Show interface counters"),
      ],
      (engine, command) => Show.showInterfaces(engine, command),
    ),
  );

  const vlanChildren: CommandNode[] = [
    kw("id", "VTP VLAN status by VLAN id", [
      num("vlan", closedRange(1, 4094), "A VLAN id", [], (engine, command) => Show.showVLAN(engine, command)),
    ]),
  ];
  if (!dell) {
    vlanChildren.push(
      kw("brief", "VTP all VLAN status in brief", [], (engine, command) => Show.showVLAN(engine, command)),
    );
  }
  children.push(
    kw("vlan", dell ? "VLAN information" : "VTP VLAN status", vlanChildren, (engine, command) =>
      Show.showVLAN(engine, command),
    ),
  );

  if (!dell) {
    children.push(
      kw("cdp", "CDP information", [
        kw(
          "neighbors",
          "CDP neighbor entries",
          [
            kw("detail", "Show detailed information", [], (engine, command) =>
              Show.showCDPNeighbors(engine, command),
            ),
          ],
          (engine, command) => Show.showCDPNeighbors(engine, command),
        ),
      ]),
    );
    children.push(
      kw("etherchannel", "EtherChannel information", [
        kw("summary", "One-line summary per channel-group", [], (engine, command) =>
          Show.showEtherchannelSummary(engine, command),
        ),
      ]),
    );
    children.push(
      kw("inventory", "Show the physical inventory", [], (engine, command) => Show.showInventory(engine, command)),
    );
    children.push(
      kw(
        "ip",
        "IP information",
        mergeNodes(
          [
            kw("interface", "IP interface status and configuration", [
              kw("brief", "Brief summary of IP status and configuration", [], (engine, command) =>
                Show.showIPInterfaceBrief(engine, command),
              ),
            ]),
            kw("route", "IP routing table", [], (engine, command) => Network.showIPRoute(engine, command)),
            simulated("arp", "IP ARP table"),
            simulated("protocols", "IP routing protocol process parameters and statistics"),
            simulated("ospf", "OSPF information"),
            simulated("eigrp", "EIGRP information"),
            simulated("dhcp", "Show items in the DHCP database"),
            simulated("nat", "IP NAT information"),
          ],
          f.showIP,
        ),
      ),
    );
  } else {
    children.push(
      kw(
        "ip",
        "IP information",
        mergeNodes(
          [
            kw("route", "IP routing table", [], (engine, command) => Network.showIPRoute(engine, command)),
            kw("interface", "IP interface status", [
              kw("brief", "Brief summary of IP status and configuration", [], (engine, command) =>
                Show.showIPInterfaceBrief(engine, command),
              ),
            ]),
            simulated("ospf", "OSPF information"),
          ],
          f.showIP,
        ),
      ),
    );
  }

  children.push(
    kw("lldp", "LLDP information", [
      kw("neighbors", "LLDP neighbor entries", [], (engine, command) => Show.showLLDPNeighbors(engine, command)),
    ]),
  );
  children.push(
    kw("version", dell ? "Software version" : "System hardware and software status", [], (engine, command) =>
      Show.showVersion(engine, command),
    ),
  );
  children.push(
    kw("history", "Display the session command history", [], (engine, command) => Show.showHistory(engine, command)),
  );

  children.push(
    simulated("mac", "MAC configuration"),
    simulated("mac-address-table", "MAC forwarding table"),
    simulated("lacp", "Port channel information"),
    simulated("arp", "ARP table"),
  );
  if (!dell) {
    children.push(
      simulated("pagp", "Port channel information"),
      simulated("port-security", "Show secure port information"),
      simulated("vtp", "VTP information"),
      simulated("dtp", "DTP information"),
      simulated("standby", "Hot Standby Router Protocol (HSRP) information"),
    );
  }
  return kw("show", "Show running system information", mergeNodes(children, f.show));
}

// MARK: EXEC

function saveCommands(): CommandNode[] {
  return [
    kw(
      "write",
      "Write running configuration to memory, network, or terminal",
      [
        kw("memory", "Write to NV memory", [], () => Notices.savedInProject),
        kw("erase", "Erase NV memory", [], () => Notices.nothingToErase),
      ],
      () => Notices.savedInProject,
    ),
    kw("copy", "Copy from one file to another", [
      kw("running-config", "Copy from current system configuration", [
        kw("startup-config", "Copy to startup configuration", [], () => Notices.savedInProject),
      ]),
      kw("startup-config", "Copy from startup configuration", [
        kw("running-config", "Update (merge with) current system configuration", [], () => Notices.savedInProject),
      ]),
    ]),
  ];
}

function simulatedExecCommands(): CommandNode[] {
  return [
    kw("ping", "Send echo messages", [
      line("target", "Ping destination address", (engine, command) => Network.ping(engine, command), "A.B.C.D"),
    ]),
    kw("traceroute", "Trace route to destination", [
      line(
        "target",
        "Trace route to destination address",
        (engine, command) => Network.traceroute(engine, command),
        "A.B.C.D",
      ),
    ]),
    simulated("telnet", "Open a telnet connection"),
    simulated("ssh", "Open a secure shell client connection"),
  ];
}

function privilegedOnlyCommands(): CommandNode[] {
  return [
    ...saveCommands(),
    simulated("reload", "Halt and perform a cold restart"),
    simulated("clear", "Reset functions"),
    simulated("debug", "Debugging functions"),
    simulated("undebug", "Disable debugging functions"),
    kw("erase", "Erase a filesystem", [
      kw("startup-config", "Erase contents of configuration memory", [], () => Notices.nothingToErase),
    ]),
  ];
}

/** The commands `do` offers inside configuration modes. */
function doCommands(dell: boolean, f: Features): CommandNode[] {
  return mergeNodes([showCommand(dell, true, f), ...simulatedExecCommands(), ...privilegedOnlyCommands()], [
    ...f.exec,
    ...f.privileged,
  ]);
}

function execCommands(dell: boolean, privileged: boolean, f: Features): CommandNode[] {
  let commands: CommandNode[] = [
    showCommand(dell, privileged, f),
    kw("enable", "Turn on privileged commands", [], (engine) => Handlers.enterPrivileged(engine)),
    kw("disable", "Turn off privileged commands", [], (engine) => Handlers.leavePrivileged(engine)),
    kw("exit", "Exit from the EXEC", [], (engine) => Handlers.exitCommand(engine)),
    kw("logout", "Exit from the EXEC", [], (engine) => Handlers.exitCommand(engine)),
    kw("terminal", "Set terminal line parameters", [
      line("rest", "Terminal parameters (accepted, the console has no paging)", () => ""),
    ]),
  ];
  commands.push(...simulatedExecCommands());
  if (privileged) {
    commands.push(
      kw(
        "configure",
        "Enter configuration mode",
        [kw("terminal", "Configure from the terminal", [], (engine) => Handlers.enterGlobalConfig(engine))],
        (engine) => Handlers.enterGlobalConfig(engine),
      ),
    );
    commands.push(...privilegedOnlyCommands());
  }
  commands = mergeNodes(commands, privileged ? [...f.exec, ...f.privileged] : f.exec);
  return commands;
}

// MARK: Global configuration

function interfaceCommand(): CommandNode {
  return kw("interface", "Select an interface to configure", [
    kw("range", "interface range command", [
      custom(IOSEngine.interfaceRangeArgument, (engine, command) => Handlers.enterInterface(engine, command)),
    ]),
    custom(IOSEngine.interfaceArgument, (engine, command) => Handlers.enterInterface(engine, command)),
  ]);
}

function globalConfigCommands(dell: boolean, f: Features): CommandNode[] {
  const unsupported: [string, string][] = [
    ["ipv6", "Global IPv6 configuration commands"],
    ["enable", "Modify enable password parameters"],
    ["username", "Establish User Name Authentication"],
    ["service", "Modify use of network based services"],
    ["router", "Enable a routing process"],
    ["logging", "Modify message logging facilities"],
    ["ntp", "Configure NTP"],
    ["snmp-server", "Modify SNMP engine parameters"],
    ["clock", "Configure time-of-day clock"],
    ["aaa", "Authentication, Authorization and Accounting"],
    ["lldp", "Global LLDP configuration subcommands"],
  ];
  if (dell) {
    unsupported.push(
      ["management", "Management interface commands"],
      ["stack-unit", "Stack unit configuration"],
      ["boot", "Modify system boot parameters"],
    );
  } else {
    unsupported.push(
      ["access-list", "Add an access list entry"],
      ["vtp", "Configure global VTP state"],
      ["cdp", "Global CDP configuration subcommands"],
      ["crypto", "Encryption module"],
      ["monitor", "Monitoring different system events"],
      ["mac", "Global MAC configuration subcommands"],
      ["errdisable", "Error disable"],
      ["port-channel", "EtherChannel configuration"],
      ["boot", "Modify system boot parameters"],
    );
  }

  let negated: CommandNode[] = [
    kw("hostname", "Set system's network name", [], (engine) => Handlers.resetHostname(engine)),
    globalIPCommand(true, f),
    kw("interface", "Select an interface to configure", [
      custom(IOSEngine.interfaceArgument, (engine, command) => Handlers.removeInterface(engine, command)),
    ]),
  ];
  let commands: CommandNode[] = [
    kw("hostname", "Set system's network name", [
      word("name", "This system's network name", (engine, command) => Handlers.setHostname(engine, command)),
    ]),
    globalIPCommand(false, f),
    interfaceCommand(),
    kw("line", "Configure a terminal line", [
      line("rest", "Line to configure (console, vty, aux)", (engine, command) => Handlers.enterLine(engine, command)),
    ]),
    kw("banner", "Define a login banner", [
      line("rest", "Banner type and delimited text", (engine, command) => Handlers.bannerCommand(engine, command)),
    ]),
  ];

  if (dell) {
    // OS9 has no `vlan N` command; say how it is done instead of a bare parser error.
    commands.push(
      kw("vlan", "", [line("rest", "", () => Notices.dellVLANCommand)], () => Notices.dellVLANCommand, true),
    );
  } else {
    commands.push(
      kw("vlan", "Vlan commands", [
        vlanList("vlans", "ISL VLAN IDs 1-4094", (engine, command) => Handlers.enterVLANConfig(engine, command)),
      ]),
    );
    negated.push(
      kw("vlan", "Vlan commands", [
        vlanList("vlans", "ISL VLAN IDs 1-4094", (engine, command) => Handlers.deleteVLANs(engine, command)),
      ]),
    );
    commands.push(
      kw("default", "Set a command to its defaults", [
        kw("interface", "Select an interface to configure", [
          custom(IOSEngine.interfaceArgument, (engine, command) => Handlers.defaultInterface(engine, command)),
        ]),
      ]),
    );
  }

  commands.push(...notStoredList(unsupported));
  negated.push(...notStoredList(unsupported));
  negated.push(notStored("banner", "Define a login banner"));
  negated = mergeNodes(negated, f.globalNo);
  commands = mergeNodes(commands, f.global);
  commands.push(kw("no", "Negate a command or set its defaults", negated));
  commands.push(...configNavigation(dell, f));
  return commands;
}

// MARK: Interface configuration

function interfaceConfigCommands(dell: boolean, f: Features): CommandNode[] {
  const unsupported: [string, string][] = [
    ["ipv6", "IPv6 interface subcommands"],
    ["speed", "Configure speed operation"],
    ["duplex", "Configure duplex operation"],
    ["mtu", "Set the interface Maximum Transmission Unit (MTU)"],
    ["lldp", "LLDP interface subcommands"],
  ];
  if (dell) {
    unsupported.push(
      ["portmode", "Set port mode (hybrid)"],
      ["flowcontrol", "Configure flow control"],
      ["negotiation", "Select autonegotiation mode"],
    );
  } else {
    unsupported.push(
      ["mdix", "Set Media Dependent Interface with Crossover"],
      ["cdp", "CDP interface subcommands"],
      ["storm-control", "storm configuration"],
      ["power", "Power configuration"],
      ["negotiation", "Select autonegotiation mode"],
      ["encapsulation", "Set encapsulation type for an interface"],
    );
  }

  let commands: CommandNode[] = [
    kw("description", "Interface specific description", [
      line("text", "Up to 240 characters describing this interface", (engine, command) =>
        Handlers.setDescription(engine, command),
      ),
    ]),
    kw("shutdown", "Shutdown the selected interface", [], (engine) => Handlers.setShutdown(engine, true)),
    interfaceIPCommand(false, f),
  ];
  let negated: CommandNode[] = [
    interfaceIPCommand(true, f),
    kw(
      "description",
      "Interface specific description",
      [line("text", "Description text (ignored)", (engine) => Handlers.clearDescription(engine))],
      (engine) => Handlers.clearDescription(engine),
    ),
    kw("shutdown", "Shutdown the selected interface", [], (engine) => Handlers.setShutdown(engine, false)),
  ];

  if (dell) {
    // OS9: `switchport` only puts the port into Layer 2 mode; VLANs are set elsewhere.
    commands.push(
      kw("switchport", "Configure Layer 2 mode", [line("rest", "", () => Notices.dellUsesVLANInterface)], () => ""),
    );
    negated.push(kw("switchport", "Configure Layer 2 mode", [], () => Notices.routedPortNotModelled));
    commands.push(
      kw("port-channel-protocol", "Select port-channel protocol (LACP)", [
        line("rest", "Protocol", () => Notices.lagIsDrawn),
      ]),
    );
  } else {
    commands.push(switchportCommand());
    negated.push(noSwitchportCommand());
    const lag: CommandHandler = () => Notices.lagIsDrawn;
    commands.push(
      kw("channel-group", "Etherchannel/port bundling configuration", [
        num("group", closedRange(1, 4096), "Channel group number", [
          kw("mode", "Etherchannel Mode of the interface", [
            kw("active", "Enable LACP unconditionally", [], lag),
            kw("passive", "Enable LACP only if a LACP device is detected", [], lag),
            kw("on", "Enable Etherchannel only", [], lag),
            kw("auto", "Enable PAgP only if a PAgP device is detected", [], lag),
            kw("desirable", "Enable PAgP unconditionally", [], lag),
          ]),
        ]),
      ]),
    );
    negated.push(kw("channel-group", "Etherchannel/port bundling configuration", [], lag));
  }

  commands.push(...notStoredList(unsupported));
  negated.push(...notStoredList(unsupported));
  negated = mergeNodes(negated, f.interfaceNo);
  commands = mergeNodes(commands, f.interface);
  commands.push(kw("no", "Negate a command or set its defaults", negated));
  commands.push(...configNavigation(dell, f));
  return commands;
}

function switchportCommand(): CommandNode {
  return kw(
    "switchport",
    "Set switching mode characteristics",
    [
      kw("mode", "Set trunking mode of the interface", [
        kw("access", "Set trunking mode to ACCESS unconditionally", [], (engine) =>
          Handlers.setSwitchportMode(engine, "access"),
        ),
        kw("trunk", "Set trunking mode to TRUNK unconditionally", [], (engine) =>
          Handlers.setSwitchportMode(engine, "trunk"),
        ),
        kw("dynamic", "Set trunking mode to dynamically negotiate access or trunk mode", [
          kw("auto", "Set trunking mode dynamic negotiation parameter to AUTO", [], () => Notices.dynamicTrunking),
          kw(
            "desirable",
            "Set trunking mode dynamic negotiation parameter to DESIRABLE",
            [],
            () => Notices.dynamicTrunking,
          ),
        ]),
      ]),
      kw("access", "Set access mode characteristics of the interface", [
        kw("vlan", "Set VLAN when interface is in access mode", [
          num("vlan", closedRange(1, 4094), "VLAN ID of the VLAN when this port is in access mode", [], (engine, command) =>
            Handlers.setAccessVLAN(engine, command),
          ),
        ]),
      ]),
      kw("trunk", "Set trunking characteristics of the interface", [
        kw("allowed", "Set allowed VLAN characteristics when interface is in trunking mode", [
          kw("vlan", "Set allowed VLANs when interface is in trunking mode", [
            vlanList("vlans", "VLAN IDs of the allowed VLANs when this port is in trunking mode", (engine, command) =>
              Handlers.setAllowedVLANs(engine, "replace", command),
            ),
            kw("add", "add VLANs to the current list", [
              vlanList("vlans", "VLAN IDs to add", (engine, command) => Handlers.setAllowedVLANs(engine, "add", command)),
            ]),
            kw("remove", "remove VLANs from the current list", [
              vlanList("vlans", "VLAN IDs to remove", (engine, command) =>
                Handlers.setAllowedVLANs(engine, "remove", command),
              ),
            ]),
            kw("except", "all VLANs except the following", [
              vlanList("vlans", "VLAN IDs to leave out", (engine, command) =>
                Handlers.setAllowedVLANs(engine, "except", command),
              ),
            ]),
            kw("all", "all VLANs", [], (engine, command) => Handlers.setAllowedVLANs(engine, "all", command)),
            kw("none", "no VLANs", [], (engine, command) => Handlers.setAllowedVLANs(engine, "none", command)),
          ]),
        ]),
        kw("native", "Set trunking native characteristics when interface is in trunking mode", [
          kw("vlan", "Set native VLAN when interface is in trunking mode", [
            num(
              "vlan",
              closedRange(1, 4094),
              "VLAN ID of the native VLAN when this port is in trunking mode",
              [],
              (engine, command) => Handlers.setNativeVLAN(engine, command),
            ),
          ]),
        ]),
        kw("encapsulation", "Set trunking encapsulation when interface is in trunking mode", [
          // 802.1Q is the only encapsulation the diagram knows, so there is nothing to store.
          kw("dot1q", "Interface uses only 802.1q trunking encapsulation when trunking", [], () => ""),
        ]),
      ]),
      notStored("nonegotiate", "Device will not engage in negotiation protocol on this interface", true),
      notStored("port-security", "Security related command", true),
      notStored("voice", "Voice appliance attributes"),
    ],
    () => "",
  );
}

function noSwitchportCommand(): CommandNode {
  const resetAccess: CommandHandler = (engine) =>
    Handlers.updateSwitchport(engine, null, (config) => {
      config.accessVLAN = 1;
    });
  const resetAllowed: CommandHandler = (engine) =>
    Handlers.updateSwitchport(engine, null, (config) => {
      config.allowedVLANs = null;
    });
  const resetNative: CommandHandler = (engine) =>
    Handlers.updateSwitchport(engine, null, (config) => {
      config.nativeVLAN = 1;
    });
  return kw(
    "switchport",
    "Set switching mode characteristics",
    [
      kw(
        "mode",
        "Set trunking mode of the interface",
        [line("rest", "Mode (ignored)", (engine) => Handlers.setSwitchportMode(engine, "unset"))],
        (engine) => Handlers.setSwitchportMode(engine, "unset"),
      ),
      kw("access", "Set access mode characteristics of the interface", [
        kw("vlan", "Set VLAN when interface is in access mode", [line("rest", "VLAN (ignored)", resetAccess)], resetAccess),
      ]),
      kw("trunk", "Set trunking characteristics of the interface", [
        kw("allowed", "Set allowed VLAN characteristics when interface is in trunking mode", [
          kw(
            "vlan",
            "Set allowed VLANs when interface is in trunking mode",
            [line("rest", "VLANs (ignored)", resetAllowed)],
            resetAllowed,
          ),
        ]),
        kw("native", "Set trunking native characteristics when interface is in trunking mode", [
          kw(
            "vlan",
            "Set native VLAN when interface is in trunking mode",
            [line("rest", "VLAN (ignored)", resetNative)],
            resetNative,
          ),
        ]),
        kw("encapsulation", "Set trunking encapsulation when interface is in trunking mode", [], () => ""),
      ]),
      notStored("nonegotiate", "Device will not engage in negotiation protocol on this interface", true),
      notStored("port-security", "Security related command", true),
      notStored("voice", "Voice appliance attributes"),
    ],
    () => Notices.routedPortNotModelled,
  );
}

// MARK: VLAN configuration

function vlanConfigCommands(dell: boolean, f: Features): CommandNode[] {
  return [
    kw("name", "Ascii name of the VLAN", [
      word("name", "The ascii name for the VLAN", (engine, command) => Handlers.setVLANName(engine, command)),
    ]),
    kw("no", "Negate a command or set its defaults", [
      kw("name", "Ascii name of the VLAN", [], (engine) => Handlers.resetVLANName(engine)),
      notStored("state", "Operational state of the VLAN"),
      notStored("shutdown", "Shutdown VLAN switching", true),
    ]),
    notStored("state", "Operational state of the VLAN"),
    notStored("shutdown", "Shutdown VLAN switching", true),
    notStored("mtu", "VLAN Maximum Transmission Unit"),
    ...configNavigation(dell, f),
  ];
}

function vlanInterfaceCommands(f: Features): CommandNode[] {
  const range = IOSEngine.interfaceRangeArgument;
  return [
    kw("name", "Set the VLAN name", [
      word("name", "VLAN name (up to 32 characters)", (engine, command) => Handlers.setVLANName(engine, command)),
    ]),
    kw("tagged", "Add tagged member interfaces", [
      custom(range, (engine, command) => Handlers.dellChangeMembership(engine, "tagged", command)),
    ]),
    kw("untagged", "Add untagged member interfaces", [
      custom(range, (engine, command) => Handlers.dellChangeMembership(engine, "untagged", command)),
    ]),
    kw("no", "Negate a command or set its defaults", [
      kw(
        "name",
        "Set the VLAN name",
        [line("rest", "VLAN name (ignored)", (engine) => Handlers.resetVLANName(engine))],
        (engine) => Handlers.resetVLANName(engine),
      ),
      kw("tagged", "Remove tagged member interfaces", [
        custom(range, (engine, command) => Handlers.dellChangeMembership(engine, "noTagged", command)),
      ]),
      kw("untagged", "Remove untagged member interfaces", [
        custom(range, (engine, command) => Handlers.dellChangeMembership(engine, "noUntagged", command)),
      ]),
      // VLAN interfaces are always up in the simulation while a port carries the VLAN.
      kw("shutdown", "Shutdown the VLAN interface", [], () => ""),
      interfaceIPCommand(true, f),
      notStored("description", "VLAN interface description", true),
    ]),
    notStored("shutdown", "Shutdown the VLAN interface", true),
    interfaceIPCommand(false, f),
    notStored("description", "VLAN interface description"),
    notStored("mtu", "Set the interface Maximum Transmission Unit (MTU)"),
    ...configNavigation(true, f),
  ];
}

// MARK: IP

/** What `ip ...` / `no ip ...` says about the subcommands the diagram has no field for. */
const ipNotStored: CommandHandler = (_engine, command) => {
  const first = splitSpaces(command.text("rest") ?? "")[0] ?? "";
  return Notices.notStored(first === "" ? "ip" : "ip " + first);
};

/** `ip address A.B.C.D M.M.M.M` (or `A.B.C.D/NN`) of an interface; other `ip` subcommands
 * are accepted and not stored. */
function interfaceIPCommand(negated: boolean, f: Features): CommandNode {
  let address: CommandNode;
  if (negated) {
    address = kw(
      "address",
      "Set the IP address of an interface",
      [line("rest", "Address (ignored)", (engine) => Network.clearIPAddress(engine))],
      (engine) => Network.clearIPAddress(engine),
    );
  } else {
    address = kw("address", "Set the IP address of an interface", [
      line(
        "address",
        "IP address and mask (A.B.C.D M.M.M.M or A.B.C.D/NN)",
        (engine, command) => Network.setIPAddress(engine, command),
        "A.B.C.D",
      ),
    ]);
  }
  return kw(
    "ip",
    "Interface Internet Protocol config commands",
    mergeNodes([address, line("rest", "Other IP subcommands (accepted, not stored)", ipNotStored)], negated ? f.interfaceNoIP : f.interfaceIP),
  );
}

/** Global `ip route`, `ip default-gateway`, `ip routing`; the rest is accepted and not stored. */
function globalIPCommand(negated: boolean, f: Features): CommandNode {
  const route = kw("route", "Establish static routes", [
    line(
      "route",
      "Destination prefix, mask and next hop",
      (engine, command) =>
        negated ? Network.removeStaticRoute(engine, command) : Network.addStaticRoute(engine, command),
      "A.B.C.D",
    ),
  ]);
  let gateway: CommandNode;
  if (negated) {
    gateway = kw(
      "default-gateway",
      "Specify default gateway (if not routing IP)",
      [line("rest", "Gateway (ignored)", (engine) => Network.clearDefaultGateway(engine))],
      (engine) => Network.clearDefaultGateway(engine),
    );
  } else {
    gateway = kw("default-gateway", "Specify default gateway (if not routing IP)", [
      word(
        "gateway",
        "IP address of default gateway",
        (engine, command) => Network.setDefaultGateway(engine, command),
        "A.B.C.D",
      ),
    ]);
  }
  return kw(
    "ip",
    "Global IP configuration subcommands",
    mergeNodes(
      [
        route,
        gateway,
        // Routers and layer-3 switches always route in the simulation.
        kw("routing", "Enable IP routing", [], () => ""),
        line("rest", "Other IP subcommands (accepted, not stored)", ipNotStored),
      ],
      negated ? f.globalNoIP : f.globalIP,
    ),
  );
}

/** IOS `interface vlan N`. */
function sviCommands(f: Features): CommandNode[] {
  return [
    interfaceIPCommand(false, f),
    kw("no", "Negate a command or set its defaults", [
      interfaceIPCommand(true, f),
      // VLAN interfaces are always up in the simulation while a port carries the VLAN.
      kw("shutdown", "Shutdown the selected interface", [], () => ""),
      notStored("description", "Interface specific description", true),
    ]),
    notStored("shutdown", "Shutdown the selected interface", true),
    notStored("description", "Interface specific description"),
    notStored("mtu", "Set the interface Maximum Transmission Unit (MTU)"),
    ...configNavigation(false, f),
  ];
}

// MARK: Line configuration

function lineConfigCommands(dell: boolean, f: Features): CommandNode[] {
  // Entering the mode already said that nothing is stored; the sub-commands stay silent.
  return [line("rest", "Line configuration command (accepted, not stored)", () => ""), ...configNavigation(dell, f)];
}

/** The command trees of one dialect, one per mode. */
export class CommandTables {
  readonly userExec: CommandNode;
  readonly privilegedExec: CommandNode;
  readonly globalConfig: CommandNode;
  readonly interfaceConfig: CommandNode;
  /** IOS `vlan N` mode. */
  readonly vlanConfig: CommandNode;
  /** Dell OS9 `interface vlan N` mode. */
  readonly vlanInterfaceConfig: CommandNode;
  /** IOS `interface vlan N` mode (switch virtual interface). */
  readonly sviConfig: CommandNode;
  readonly lineConfig: CommandNode;
  /** The configuration modes of the protocol features (`router ospf`, `ip dhcp pool`, ...). */
  readonly featureModes: Map<string, CommandNode>;

  constructor(dialect: CLIDialect) {
    const dell = dialect === "dellOS9";
    const f = collectIOSFeatures(dialect);
    this.userExec = root(execCommands(dell, false, f));
    this.privilegedExec = root(execCommands(dell, true, f));
    this.globalConfig = root(globalConfigCommands(dell, f));
    this.interfaceConfig = root(interfaceConfigCommands(dell, f));
    this.vlanConfig = root(vlanConfigCommands(dell, f));
    this.vlanInterfaceConfig = root(vlanInterfaceCommands(f));
    this.sviConfig = root(sviCommands(f));
    this.lineConfig = root(lineConfigCommands(dell, f));
    this.featureModes = new Map(
      Object.entries(f.modes).map(([name, nodes]) => [name, root([...nodes, ...configNavigation(dell, f)])]),
    );
  }
}
