// dhcp: menus of the MikroTik RouterOS console.
//
//   /ip pool                    add name= ranges=, print, remove
//   /ip dhcp-server             add name= interface= address-pool= [lease-time=] [disabled=], print,
//                               set, remove, enable, disable
//   /ip dhcp-server network     add address= gateway= dns-server= [domain=], print, remove
//   /ip dhcp-server lease       print (the clients of the project that got an address here)
//   /ip dhcp-client             add interface=, print, remove, renew, release
//   /ip dhcp-relay              add interface= dhcp-server= [name=] [disabled=], print, remove, enable, disable
//
// As on RouterOS a server and a relay are created disabled (`disabled=no` or `enable` turns them on).

import type { DHCPConfig, RouterOSDHCP } from "../../../core/protocols";
import { leftPadded, padded, trimmingTrailingWhitespace } from "../../command-tree";
import { IPv4, IPv4Prefix } from "../../sim/ipv4";
import { macAddress } from "../../sim/mac";
import type { RouterOSContext, RouterOSFeature, RouterOSFeatureCommand, RouterOSFeatureMenu, RouterOSWord } from "../routeros-menus";
import { bindingsOf, dhcpOf, parseSpans, updateDHCP } from "./model";
import { acquireLease, isDHCPClient, releaseLease, unmarkClient } from "./sim";

const missing = (key: string): string => `missing value(s) of argument(s) ${key}`;
const invalid = (key: string): string => `invalid value for argument ${key}`;

function ros(config: DHCPConfig | undefined): RouterOSDHCP {
  return config?.routerOS ?? { pools: [], servers: [], networks: [] };
}

function rosOf(context: RouterOSContext): RouterOSDHCP {
  return ros(dhcpOf(context.access.device));
}

/** Writes the RouterOS tables back (one store write). */
function editROS(context: RouterOSContext, change: (tables: RouterOSDHCP) => void): void {
  updateDHCP(context.access, (config) => {
    const tables = config.routerOS ?? { pools: [], servers: [], networks: [] };
    change(tables);
    config.routerOS = tables;
  });
}

function yesNo(value: string): boolean | null {
  const lower = value.toLowerCase();
  if (lower === "yes" || lower === "true") return true;
  if (lower === "no" || lower === "false") return false;
  return null;
}

/** "ether2" or "0,1" or a list name: the indices of the items. */
function items(context: RouterOSContext, args: RouterOSWord[], names: string[]): { items: number[] } | { message: string } {
  if (args.length === 1 && !args[0].text.includes("=") && !args[0].text.startsWith("[")) {
    const index = names.indexOf(args[0].text);
    if (index >= 0) return { items: [index] };
  }
  const result = context.itemNumbers(args, names.length);
  return result.kind === "items" ? { items: result.items } : { message: result.message };
}

function table(flags: string, headers: [string, number][], rows: string[][]): string {
  const lines = [" #   " + headers.map(([title, width]) => padded(title, width)).join(" ")];
  if (flags !== "") lines.unshift(flags);
  rows.forEach((row, index) => {
    lines.push(
      leftPadded(`${index}`, 2) + " " + row[0] + " " + headers.map(([, width], column) => padded(row[column + 1] ?? "", width)).join(" "),
    );
  });
  return lines.map(trimmingTrailingWhitespace).join("\n");
}

function command(name: string, help: string, run: RouterOSFeatureCommand["run"]): RouterOSFeatureCommand {
  return { name, help, run };
}

function noArguments(args: RouterOSWord[], context: RouterOSContext, then: () => string): string {
  return args.length > 0 ? context.endOfCommand(args[0]) : then();
}

// MARK: /ip pool

function poolMenu(): RouterOSFeatureMenu {
  return {
    path: ["ip", "pool"],
    help: "IP address pools",
    commands: [
      command("add", "Create a new item", (context, args) => {
        const named = context.named(args, ["name", "ranges"]);
        if (named.kind === "failure") return named.message;
        const name = named.values.get("name");
        const ranges = named.values.get("ranges");
        if (name === undefined || name === "") return missing("name");
        if (ranges === undefined) return missing("ranges");
        if (parseSpans(ranges) === null) return invalid("ranges");
        if (rosOf(context).pools.some((pool) => pool.name === name)) return "failure: pool with this name already exists";
        editROS(context, (tables) => {
          tables.pools.push({ name, ranges });
        });
        return "";
      }),
      command("print", "Print values of item properties", (context, args) =>
        noArguments(args, context, () =>
          table(
            "Flags: X - disabled",
            [
              ["NAME", 20],
              ["RANGES", 30],
            ],
            rosOf(context).pools.map((pool) => [" ", pool.name, pool.ranges]),
          ),
        ),
      ),
      command("remove", "Remove item", (context, args) => {
        const tables = rosOf(context);
        const chosen = items(context, args, tables.pools.map((pool) => pool.name));
        if ("message" in chosen) return chosen.message;
        const names = chosen.items.map((index) => tables.pools[index].name);
        if (tables.servers.some((server) => names.includes(server.addressPool))) {
          return "failure: pool is used by a dhcp-server";
        }
        editROS(context, (current) => {
          current.pools = current.pools.filter((pool) => !names.includes(pool.name));
        });
        return "";
      }),
    ],
    export: (context) =>
      rosOf(context).pools.map(
        (pool) => `add name=${context.exportValue(pool.name)} ranges=${context.exportValue(pool.ranges)}`,
      ),
  };
}

// MARK: /ip dhcp-server

function serverMenu(): RouterOSFeatureMenu {
  const serverNote = (name: string): string =>
    `NetSketch: DHCP server ${name} je po add vypnutý (disabled=yes, jako na RouterOS); zapněte ho příkazem „/ip dhcp-server enable ${name}“.`;
  const toggle = (disabled: boolean): RouterOSFeatureCommand["run"] => (context, args) => {
    const tables = rosOf(context);
    const chosen = items(context, args, tables.servers.map((server) => server.name));
    if ("message" in chosen) return chosen.message;
    editROS(context, (current) => {
      for (const index of chosen.items) current.servers[index].disabled = disabled;
    });
    return "";
  };
  return {
    path: ["ip", "dhcp-server"],
    help: "DHCP server",
    commands: [
      command("add", "Create a new item", (context, args) => {
        const named = context.named(args, ["name", "interface", "address-pool", "lease-time", "disabled"]);
        if (named.kind === "failure") return named.message;
        const values = named.values;
        const interfaceText = values.get("interface");
        if (interfaceText === undefined) return missing("interface");
        const lookup = context.l3Interface(interfaceText);
        if (lookup.kind === "failure") return lookup.message;
        const tables = rosOf(context);
        const pool = values.get("address-pool") ?? "static-only";
        if (pool !== "static-only" && !tables.pools.some((entry) => entry.name === pool)) {
          return "input does not match any value of address-pool";
        }
        let disabled = true;
        const disabledText = values.get("disabled");
        if (disabledText !== undefined) {
          const parsed = yesNo(disabledText);
          if (parsed === null) return invalid("disabled");
          disabled = parsed;
        }
        let number = tables.servers.length + 1;
        while (tables.servers.some((server) => server.name === `dhcp${number}`)) number += 1;
        const name = values.get("name") ?? `dhcp${number}`;
        if (tables.servers.some((server) => server.name === name)) return "failure: dhcp server with this name already exists";
        editROS(context, (current) => {
          current.servers.push({
            name,
            interface: lookup.id,
            addressPool: pool,
            leaseTime: values.get("lease-time") ?? "10m",
            disabled,
          });
        });
        return disabled ? serverNote(name) : "";
      }),
      command("set", "Change item properties", (context, args) => {
        const first = args[0];
        if (first === undefined) return missing("numbers");
        const tables = rosOf(context);
        const chosen = items(context, [first], tables.servers.map((server) => server.name));
        if ("message" in chosen) return chosen.message;
        const named = context.named(args.slice(1), ["disabled", "lease-time", "address-pool"]);
        if (named.kind === "failure") return named.message;
        const disabledText = named.values.get("disabled");
        const disabled = disabledText === undefined ? undefined : yesNo(disabledText);
        if (disabled === null) return invalid("disabled");
        const pool = named.values.get("address-pool");
        if (pool !== undefined && pool !== "static-only" && !tables.pools.some((entry) => entry.name === pool)) {
          return "input does not match any value of address-pool";
        }
        editROS(context, (current) => {
          for (const index of chosen.items) {
            const server = current.servers[index];
            if (disabled !== undefined) server.disabled = disabled;
            if (pool !== undefined) server.addressPool = pool;
            const lease = named.values.get("lease-time");
            if (lease !== undefined) server.leaseTime = lease;
          }
        });
        return "";
      }),
      command("print", "Print values of item properties", (context, args) =>
        noArguments(args, context, () =>
          table(
            "Flags: X - disabled, I - invalid",
            [
              ["NAME", 12],
              ["INTERFACE", 12],
              ["ADDRESS-POOL", 16],
              ["LEASE-TIME", 10],
            ],
            rosOf(context).servers.map((server) => [
              server.disabled ? "X" : " ",
              server.name,
              context.interfaceName(server.interface) ?? "unknown",
              server.addressPool,
              server.leaseTime,
            ]),
          ),
        ),
      ),
      command("remove", "Remove item", (context, args) => {
        const tables = rosOf(context);
        const chosen = items(context, args, tables.servers.map((server) => server.name));
        if ("message" in chosen) return chosen.message;
        editROS(context, (current) => {
          current.servers = current.servers.filter((_, index) => !chosen.items.includes(index));
        });
        return "";
      }),
      command("enable", "Enable items", toggle(false)),
      command("disable", "Disable items", toggle(true)),
    ],
    export: (context) =>
      rosOf(context).servers.map((server) => {
        const parts = [
          `address-pool=${context.exportValue(server.addressPool)}`,
          `disabled=${server.disabled ? "yes" : "no"}`,
          `interface=${context.exportValue(context.interfaceName(server.interface) ?? "unknown")}`,
        ];
        if (server.leaseTime !== "10m") parts.push(`lease-time=${context.exportValue(server.leaseTime)}`);
        parts.push(`name=${context.exportValue(server.name)}`);
        return "add " + parts.join(" ");
      }),
  };
}

// MARK: /ip dhcp-server network

function networkMenu(): RouterOSFeatureMenu {
  return {
    path: ["ip", "dhcp-server", "network"],
    help: "DHCP network parameters",
    commands: [
      command("add", "Create a new item", (context, args) => {
        const named = context.named(args, ["address", "gateway", "dns-server", "domain"]);
        if (named.kind === "failure") return named.message;
        const addressText = named.values.get("address");
        if (addressText === undefined) return missing("address");
        const prefix = IPv4Prefix.fromCIDR(addressText);
        if (prefix === null) return invalid("address");
        const gateway = named.values.get("gateway") ?? "";
        if (gateway !== "" && IPv4.parse(gateway) === null) return invalid("gateway");
        const dns = (named.values.get("dns-server") ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
        if (dns.some((entry) => IPv4.parse(entry) === null)) return invalid("dns-server");
        const address = prefix.networkPrefix.description;
        if (rosOf(context).networks.some((entry) => entry.address === address)) return "failure: network with this address already exists";
        const domain = named.values.get("domain");
        editROS(context, (current) => {
          current.networks.push({ address, gateway, dnsServer: dns.join(" "), ...(domain ? { domain } : {}) });
        });
        return "";
      }),
      command("print", "Print values of item properties", (context, args) =>
        noArguments(args, context, () =>
          table(
            "",
            [
              ["ADDRESS", 19],
              ["GATEWAY", 15],
              ["DNS-SERVER", 20],
            ],
            rosOf(context).networks.map((entry) => [" ", entry.address, entry.gateway, entry.dnsServer.split(" ").join(",")]),
          ),
        ),
      ),
      command("remove", "Remove item", (context, args) => {
        const tables = rosOf(context);
        const chosen = items(context, args, tables.networks.map((entry) => entry.address));
        if ("message" in chosen) return chosen.message;
        editROS(context, (current) => {
          current.networks = current.networks.filter((_, index) => !chosen.items.includes(index));
        });
        return "";
      }),
    ],
    export: (context) =>
      rosOf(context).networks.map((entry) => {
        const parts = [`address=${context.exportValue(entry.address)}`];
        if (entry.dnsServer !== "") parts.push(`dns-server=${context.exportValue(entry.dnsServer.split(" ").join(","))}`);
        if (entry.domain) parts.push(`domain=${context.exportValue(entry.domain)}`);
        if (entry.gateway !== "") parts.push(`gateway=${context.exportValue(entry.gateway)}`);
        return "add " + parts.join(" ");
      }),
  };
}

// MARK: /ip dhcp-server lease

function leaseMenu(): RouterOSFeatureMenu {
  return {
    path: ["ip", "dhcp-server", "lease"],
    help: "DHCP leases",
    commands: [
      command("print", "Print values of item properties", (context, args) =>
        noArguments(args, context, () => {
          const device = context.access.device;
          const rows = (device ? bindingsOf(context.access.store.project, device) : [])
            .filter((binding) => binding.pool.source === "routerOS")
            .map((binding) => [
              "D",
              binding.address.description,
              macAddress(binding.macSource, "colon"),
              binding.client.hostname,
              binding.pool.name,
              "bound",
            ]);
          return table(
            "Flags: X - disabled, R - radius, D - dynamic, B - blocked",
            [
              ["ADDRESS", 16],
              ["MAC-ADDRESS", 17],
              ["HOST-NAME", 10],
              ["SERVER", 8],
              ["STATUS", 6],
            ],
            rows,
          );
        }),
      ),
    ],
  };
}

// MARK: /ip dhcp-client

function clientMenu(): RouterOSFeatureMenu {
  const select = (context: RouterOSContext, args: RouterOSWord[]): { ids: string[] } | { message: string } => {
    const clients = dhcpOf(context.access.device)?.clients ?? [];
    const names = clients.map((id) => context.interfaceName(id) ?? "unknown");
    const chosen = items(context, args, names);
    return "message" in chosen ? chosen : { ids: chosen.items.map((index) => clients[index]) };
  };
  return {
    path: ["ip", "dhcp-client"],
    help: "DHCP client",
    commands: [
      command("add", "Create a new item", (context, args) => {
        const named = context.named(args, ["interface", "disabled", "add-default-route", "use-peer-dns", "comment"]);
        if (named.kind === "failure") return named.message;
        const interfaceText = named.values.get("interface");
        if (interfaceText === undefined) return missing("interface");
        const lookup = context.l3Interface(interfaceText);
        if (lookup.kind === "failure") return lookup.message;
        if (isDHCPClient(context.access, lookup.id)) return "failure: dhcp client on this interface already exists";
        const access = context.access;
        let message = "";
        access.transaction(() => {
          // A manual address makes way for the lease.
          access.setAddress(null, lookup.id);
          const outcome = acquireLease(access, lookup.id);
          if (outcome.kind === "failed") {
            message = `NetSketch: DHCP klient na ${lookup.name} zatím nemá adresu (status searching...) – ${outcome.reason}`;
          }
        });
        return message;
      }),
      command("print", "Print values of item properties", (context, args) =>
        noArguments(args, context, () => {
          const clients = dhcpOf(context.access.device)?.clients ?? [];
          return table(
            "Flags: X - disabled, I - invalid",
            [
              ["INTERFACE", 18],
              ["USE-PEER-DNS", 12],
              ["ADD-DEFAULT-ROUTE", 17],
              ["STATUS", 12],
              ["ADDRESS", 18],
            ],
            clients.map((id) => {
              const address = context.access.address(id);
              return [
                " ",
                context.interfaceName(id) ?? "unknown",
                "yes",
                "yes",
                address ? "bound" : "searching...",
                address ? address.description : "",
              ];
            }),
          );
        }),
      ),
      command("remove", "Remove item", (context, args) => {
        const chosen = select(context, args);
        if ("message" in chosen) return chosen.message;
        context.access.transaction(() => {
          for (const id of chosen.ids) {
            releaseLease(context.access, id);
            unmarkClient(context.access, id);
          }
        });
        return "";
      }),
      command("renew", "Renew the lease", (context, args) => {
        const chosen = select(context, args);
        if ("message" in chosen) return chosen.message;
        const messages: string[] = [];
        context.access.transaction(() => {
          for (const id of chosen.ids) {
            const outcome = acquireLease(context.access, id);
            if (outcome.kind === "failed") messages.push(`NetSketch: DHCP klient nedostal adresu – ${outcome.reason}`);
          }
        });
        return messages.join("\n");
      }),
      command("release", "Release the lease", (context, args) => {
        const chosen = select(context, args);
        if ("message" in chosen) return chosen.message;
        context.access.transaction(() => {
          for (const id of chosen.ids) releaseLease(context.access, id);
        });
        return "";
      }),
    ],
    export: (context) =>
      (dhcpOf(context.access.device)?.clients ?? []).map(
        (id) => `add disabled=no interface=${context.exportValue(context.interfaceName(id) ?? "unknown")}`,
      ),
  };
}

// MARK: /ip dhcp-relay

function relayMenu(): RouterOSFeatureMenu {
  const relaysOf = (context: RouterOSContext) => dhcpOf(context.access.device)?.relays ?? [];
  const toggle = (disabled: boolean): RouterOSFeatureCommand["run"] => (context, args) => {
    const relays = relaysOf(context);
    const chosen = items(context, args, relays.map((relay) => relay.name ?? ""));
    if ("message" in chosen) return chosen.message;
    updateDHCP(context.access, (config) => {
      for (const index of chosen.items) {
        const relay = config.relays[index];
        if (disabled) relay.disabled = true;
        else delete relay.disabled;
      }
    });
    return "";
  };
  return {
    path: ["ip", "dhcp-relay"],
    help: "DHCP relay",
    commands: [
      command("add", "Create a new item", (context, args) => {
        const named = context.named(args, ["name", "interface", "dhcp-server", "local-address", "disabled"]);
        if (named.kind === "failure") return named.message;
        const interfaceText = named.values.get("interface");
        if (interfaceText === undefined) return missing("interface");
        const lookup = context.l3Interface(interfaceText);
        if (lookup.kind === "failure") return lookup.message;
        const server = named.values.get("dhcp-server");
        if (server === undefined) return missing("dhcp-server");
        if (IPv4.parse(server) === null) return invalid("dhcp-server");
        let disabled = true;
        const disabledText = named.values.get("disabled");
        if (disabledText !== undefined) {
          const parsed = yesNo(disabledText);
          if (parsed === null) return invalid("disabled");
          disabled = parsed;
        }
        const relays = relaysOf(context);
        let number = relays.length + 1;
        while (relays.some((relay) => relay.name === `relay${number}`)) number += 1;
        const name = named.values.get("name") ?? `relay${number}`;
        if (relays.some((relay) => relay.name === name)) return "failure: dhcp relay with this name already exists";
        updateDHCP(context.access, (config) => {
          config.relays.push({ interface: lookup.id, server, name, ...(disabled ? { disabled: true } : {}) });
        });
        return disabled
          ? `NetSketch: relay ${name} je po add vypnutý (disabled=yes, jako na RouterOS); zapněte ho příkazem „/ip dhcp-relay enable ${name}“.`
          : "";
      }),
      command("print", "Print values of item properties", (context, args) =>
        noArguments(args, context, () =>
          table(
            "Flags: X - disabled, I - invalid",
            [
              ["NAME", 10],
              ["INTERFACE", 12],
              ["DHCP-SERVER", 16],
            ],
            relaysOf(context).map((relay) => [
              relay.disabled ? "X" : " ",
              relay.name ?? "",
              context.interfaceName(relay.interface) ?? "unknown",
              relay.server,
            ]),
          ),
        ),
      ),
      command("remove", "Remove item", (context, args) => {
        const relays = relaysOf(context);
        const chosen = items(context, args, relays.map((relay) => relay.name ?? ""));
        if ("message" in chosen) return chosen.message;
        updateDHCP(context.access, (config) => {
          config.relays = config.relays.filter((_, index) => !chosen.items.includes(index));
        });
        return "";
      }),
      command("enable", "Enable items", toggle(false)),
      command("disable", "Disable items", toggle(true)),
    ],
    export: (context) =>
      relaysOf(context).map(
        (relay) =>
          `add dhcp-server=${context.exportValue(relay.server)} disabled=${relay.disabled ? "yes" : "no"} ` +
          `interface=${context.exportValue(context.interfaceName(relay.interface) ?? "unknown")} ` +
          `name=${context.exportValue(relay.name ?? "")}`,
      ),
  };
}

export const dhcpRouterOS: RouterOSFeature = () => [
  poolMenu(),
  serverMenu(),
  networkMenu(),
  leaseMenu(),
  clientMenu(),
  relayMenu(),
];

