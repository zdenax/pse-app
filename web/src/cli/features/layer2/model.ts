// Spanning tree configuration helpers shared by the consoles: reading and editing
// Device.protocols.stp, bridge priority lookup, the port numbers shown as "Prio.Nbr".
// Pure functions over the project data.

import type { Device } from "../../../core/model";
import type { STPConfig, STPMode } from "../../../core/protocols";
import { readSTPConfig } from "../../../core/protocols/layer2";
import type { DeviceAccess } from "../../model-access";

/**
 * A device without stored configuration runs "pvst" (readSTPConfig and the engine in stp.ts);
 * a config that differs from that in nothing is not stored.
 */
export const defaultMode: STPMode = "pvst";

export function stpOf(device: Device | null | undefined): STPConfig | undefined {
  return device?.protocols?.stp;
}

export function emptySTP(mode: STPMode): STPConfig {
  return { mode, disabledVLANs: [], priorities: [], portfast: [], bpduGuard: [], costs: [], portPriorities: [] };
}

export function isDefaultSTP(config: STPConfig): boolean {
  return (
    config.mode === defaultMode &&
    config.disabledVLANs.length === 0 &&
    config.priorities.length === 0 &&
    config.portfast.length === 0 &&
    config.bpduGuard.length === 0 &&
    config.costs.length === 0 &&
    config.portPriorities.length === 0
  );
}

/**
 * Edits the spanning tree configuration of the console's device in one store write; the key is
 * removed when nothing differs from the vendor default, so untouched projects stay untouched.
 */
export function updateSTP(access: DeviceAccess, change: (config: STPConfig) => void): boolean {
  return access.updateProtocols((protocols) => {
    const config = readSTPConfig(protocols.stp) ?? emptySTP(defaultMode);
    change(config);
    protocols.stp = isDefaultSTP(config) ? undefined : config;
  });
}

// MARK: Priorities, costs

/**
 * The configured bridge priority for a VLAN (0 = the instance of MST/RSTP/the MikroTik bridge);
 * undefined when nothing is configured. A VLAN entry wins over the "all VLANs" entry, and in
 * MST mode only the instance 0 entry counts.
 */
export function configuredPriority(config: STPConfig | undefined, vlan: number): number | undefined {
  if (!config) return undefined;
  const mst = config.mode === "mst";
  const exact = mst ? undefined : config.priorities.find((entry) => entry.vlan === vlan);
  return (exact ?? config.priorities.find((entry) => entry.vlan === 0))?.priority;
}

export function setPriority(config: STPConfig, vlan: number, priority: number): void {
  const entry = config.priorities.find((candidate) => candidate.vlan === vlan);
  if (entry) entry.priority = priority;
  else config.priorities.push({ vlan, priority });
  config.priorities.sort((a, b) => a.vlan - b.vlan);
}

export function clearPriority(config: STPConfig, vlan: number): void {
  config.priorities = config.priorities.filter((entry) => entry.vlan !== vlan);
}

/** Sets (or with null removes) the cost override of a port for a VLAN (0 = all). */
export function setCost(config: STPConfig, port: string, vlan: number, cost: number | null): void {
  config.costs = config.costs.filter((entry) => !(entry.port === port && entry.vlan === vlan));
  if (cost !== null) config.costs.push({ port, vlan, cost });
}

export function setPortPriority(config: STPConfig, port: string, vlan: number, priority: number | null): void {
  config.portPriorities = config.portPriorities.filter((entry) => !(entry.port === port && entry.vlan === vlan));
  if (priority !== null) config.portPriorities.push({ port, vlan, priority });
}

/** Adds or removes a port in a list of port ids. */
export function setMember(list: string[], port: string, member: boolean): string[] {
  const rest = list.filter((entry) => entry !== port);
  return member ? [...rest, port] : rest;
}

// MARK: Ports

/** The 1-based number of a port in the panel, shown as the second half of "128.1". */
export function portNumber(device: Device, portID: string): number {
  return device.ports.filter((port) => port.connector !== "console").findIndex((port) => port.id === portID) + 1;
}

/** Bridge priority is a multiple of 4096 (the low 12 bits are the VLAN / instance number). */
export function validBridgePriority(value: number): boolean {
  return value >= 0 && value <= 61440 && value % 4096 === 0;
}

/** RouterOS accepts priority as decimal or 0x hex. */
export function parseNumber(text: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(text)) return parseInt(text.slice(2), 16);
  if (/^[0-9]+$/.test(text)) return parseInt(text, 10);
  return null;
}
