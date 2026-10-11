// Where the protocol features plug into the command prompt of PCs and servers (e.g. DHCP
// `ipconfig /renew` is handled in host-engine.ts itself; new commands such as
// `Test-NetConnection` come from here). A feature command replaces a base command of the same
// name (e.g. the "not simulated" `telnet`).

import type { DeviceAccess } from "../model-access";
import { aclHost } from "./acl/host";
import { dhcpHost } from "./dhcp/host";
import { realismHost } from "./realism/host";

export interface HostContext {
  readonly access: DeviceAccess;
  readonly hostname: string;
}

export interface HostFeatureCommand {
  /** Lower-case command name as typed (Windows commands are case-insensitive). */
  readonly name: string;
  readonly help: string;
  run(context: HostContext, words: string[]): string;
}

export type HostFeature = () => HostFeatureCommand[];

export const hostFeatures: readonly HostFeature[] = [dhcpHost, aclHost, realismHost];

export function collectHostCommands(): HostFeatureCommand[] {
  return hostFeatures.flatMap((feature) => feature());
}
