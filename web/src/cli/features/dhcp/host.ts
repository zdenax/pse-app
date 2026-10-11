// dhcp: the Windows-style DHCP client of the PC/server command prompt. HostEngine hands
// `ipconfig /renew`, `ipconfig /release` and `netsh interface ip set address <adapter> dhcp`
// to the functions below; no command of its own is added.

import type { HostFeature } from "../host-commands";
import type { DeviceAccess, PortSnapshot } from "../../model-access";
import { macAddress } from "../../sim/mac";
import { dhcpOf } from "./model";
import { acquireLease, isDHCPClient, leaseOf, markClient, releaseLease, unmarkClient, usesDefaultGateway } from "./sim";

export const dhcpHost: HostFeature = () => [];

const noAdapter = "The operation failed as no adapter is in the state permissible for this operation.";

function interfaceOf(port: PortSnapshot): string {
  return `port:${port.id}`;
}

function matches(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(name);
}

/** The adapters an `ipconfig` option names (all of them without a name; `*` is a wildcard). */
function targets(access: DeviceAccess, nameWords: string[]): PortSnapshot[] {
  const interfaces = access.interfaces;
  if (nameWords.length === 0) return interfaces;
  const pattern = nameWords.join(" ").replace(/^"(.*)"$/, "$1");
  return interfaces.filter((port) => matches(pattern, port.name));
}

function hasAddress(access: DeviceAccess, port: PortSnapshot): boolean {
  return access.address(interfaceOf(port)) !== null;
}

/**
 * `ipconfig /renew [adapter]` and `ipconfig /release [adapter]`. `listing` prints the adapters
 * as plain `ipconfig` does; it follows the messages when something was done.
 */
export function dhcpIpconfig(
  access: DeviceAccess,
  option: "/renew" | "/release",
  nameWords: string[],
  listing: () => string,
): string {
  const renew = option === "/renew";
  const chosen = targets(access, nameWords).filter((port) =>
    renew ? isDHCPClient(access, interfaceOf(port)) || !hasAddress(access, port) : isDHCPClient(access, interfaceOf(port)) && hasAddress(access, port),
  );
  if (chosen.length === 0) return noAdapter;
  const messages: string[] = [];
  let changed = false;
  access.transaction(() => {
    for (const port of chosen) {
      const id = interfaceOf(port);
      if (!renew) {
        if (port.linkState !== "up") {
          messages.push(`No operation can be performed on ${port.name} while it has its media disconnected.`);
          continue;
        }
        releaseLease(access, id);
        changed = true;
        continue;
      }
      const outcome = acquireLease(access, id);
      if (outcome.kind === "bound") {
        changed = true;
        continue;
      }
      messages.push(
        port.linkState === "up"
          ? `An error occurred while renewing interface ${port.name} : unable to contact your DHCP server. Request has timed out.`
          : `No operation can be performed on ${port.name} while it has its media disconnected.`,
        `NetSketch: DHCP neuspělo – ${outcome.reason}`,
      );
    }
  });
  if (!changed) return messages.join("\n");
  return [...messages, "Windows IP Configuration", listing()].join("\n");
}

/** `netsh interface ip set address <adapter> dhcp`: DHCP on, the static address off, then a lease. */
export function enableDHCP(access: DeviceAccess, port: PortSnapshot): string {
  const id = interfaceOf(port);
  const wasClient = isDHCPClient(access, id);
  let failure: string | null = null;
  access.transaction(() => {
    if (!wasClient) {
      access.setAddress(null, id);
      if (usesDefaultGateway(access)) access.setDefaultGateway(null);
    }
    markClient(access, id);
    const outcome = acquireLease(access, id);
    if (outcome.kind === "failed") failure = outcome.reason;
  });
  if (failure === null) return "Ok.";
  return (
    "Ok.\n" +
    `NetSketch: DHCP je zapnuto, ale adresu zatím nikdo nepřidělil – ${failure} ` +
    "Po opravě sítě použijte „ipconfig /renew“."
  );
}

/** A static address replaces DHCP on the adapter: forgets the DHCP mark (no-op for static adapters). */
export function disableDHCP(access: DeviceAccess, interfaceID: string): void {
  unmarkClient(access, interfaceID);
}

/** Extra rows of `ipconfig /all` for an adapter: [name, value]. */
export function dhcpDetailFields(access: DeviceAccess, port: PortSnapshot): [string, string][] {
  const id = interfaceOf(port);
  const enabled = isDHCPClient(access, id);
  const rows: [string, string][] = [
    ["Physical Address", macAddress(port.id, "windows")],
    ["DHCP Enabled", enabled ? "Yes" : "No"],
  ];
  const lease = enabled ? leaseOf(access, id) : undefined;
  if (lease && dhcpOf(access.device) && hasAddress(access, port)) {
    if (lease.domainName) rows.push(["Connection-specific DNS Suffix", lease.domainName]);
    rows.push(["DHCP Server", lease.server]);
    if (lease.dnsServer !== "") rows.push(["DNS Servers", lease.dnsServer.split(" ").join(", ")]);
  }
  return rows;
}
