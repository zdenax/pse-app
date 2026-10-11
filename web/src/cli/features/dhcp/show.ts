// The show commands of the DHCP server on the IOS-style consoles: bindings and pools.

import { padded, trimmingTrailingWhitespace, type ParsedCommand } from "../../command-tree";
import type { IOSEngine } from "../../ios-engine";
import { l3Name } from "../../ios-network";
import { IPv4 } from "../../sim/ipv4";
import { macAddress } from "../../sim/mac";
import { allocateAddress, bindingsOf, dhcpOf, effectivePools, leaseExpiry, spanSize, type Binding } from "./model";

function joined(lines: string[]): string {
  return lines.map(trimmingTrailingWhitespace).join("\n");
}

/** "0102.1234.5678.9a": the IOS client identifier of an Ethernet client (type 01 + MAC). */
function clientIdentifier(macSource: string): string {
  const hex = "01" + macAddress(macSource, "cisco").replace(/\./g, "");
  return `${hex.slice(0, 4)}.${hex.slice(4, 8)}.${hex.slice(8, 12)}.${hex.slice(12)}`;
}

/** The server interface a client's address is reached through, for the Interface column. */
function serverInterfaceName(engine: IOSEngine, binding: Binding): string {
  const access = engine.access;
  const route = access.simulator.lookup(binding.address, access.deviceID);
  return route ? l3Name(engine, route.interface.id) : "";
}

function bindingsOfServer(engine: IOSEngine): Binding[] {
  const device = engine.access.device;
  return device ? bindingsOf(engine.access.store.project, device) : [];
}

/** `show ip dhcp binding [A.B.C.D]`. */
export function showBindings(engine: IOSEngine, command: ParsedCommand): string {
  const only = IPv4.parse(command.text("address") ?? "");
  const rows = bindingsOfServer(engine).filter((binding) => only === null || binding.address.equals(only));
  if (engine.isDell) return showDellBindings(engine, rows);
  const lines = [
    "Bindings from all pools not associated with VRF:",
    "IP address      Client-ID/              Lease expiration        Type       State      Interface",
    "                Hardware address/",
    "                User name",
  ];
  for (const binding of rows) {
    lines.push(
      padded(binding.address.description, 16) +
        padded(clientIdentifier(binding.macSource), 24) +
        padded(leaseExpiry(binding.pool.lease), 24) +
        padded("Automatic", 11) +
        padded("Active", 11) +
        serverInterfaceName(engine, binding),
    );
  }
  return joined(lines);
}

function showDellBindings(engine: IOSEngine, rows: Binding[]): string {
  const lines = [
    "IP Address          Hardware Address        Lease expires            Type",
    "==========          ================        =============            ====",
  ];
  for (const binding of rows) {
    lines.push(
      padded(binding.address.description, 20) +
        padded(macAddress(binding.macSource, "colon").toLowerCase(), 24) +
        padded(leaseExpiry(binding.pool.lease), 25) +
        "Dynamic",
    );
  }
  void engine;
  return joined(lines);
}

/** `show ip dhcp pool [NAME]`. */
export function showPools(engine: IOSEngine, command: ParsedCommand): string {
  const access = engine.access;
  const device = access.device;
  const config = dhcpOf(device);
  if (!device || !config) return "";
  const only = command.text("name");
  const bindings = bindingsOfServer(engine);
  const blocks: string[] = [];
  for (const pool of effectivePools(config)) {
    if (pool.source !== "pool" || (only !== null && pool.name !== only)) continue;
    const leased = bindings.filter((binding) => binding.pool.name === pool.name).length;
    const first = pool.spans[0];
    const last = pool.spans[pool.spans.length - 1];
    const next = pool.network
      ? allocateAddress(access.store.project, config, pool, { deviceID: "", interfaceID: "" })
      : null;
    const lines = [
      `Pool ${pool.name} :`,
      " Utilization mark (high/low)    : 100 / 0",
      " Subnet size (first/next)       : 0 / 0 ",
      ` Total addresses                : ${spanSize(pool.spans)}`,
      ` Leased addresses               : ${leased}`,
      " Pending event                  : none",
    ];
    if (pool.network && first && last) {
      lines.push(
        " 1 subnet is currently in the pool :",
        " Current index        IP address range                    Leased addresses",
        ` ${padded((next ?? new IPv4(last.hi)).description, 20)} ${padded(new IPv4(first.lo).description, 16)} - ` +
          `${padded(new IPv4(last.hi).description, 18)}${leased}`,
      );
    }
    blocks.push(lines.join("\n"));
  }
  return joined(blocks.join("\n\n").split("\n"));
}
