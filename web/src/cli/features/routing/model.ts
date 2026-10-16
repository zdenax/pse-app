// Dynamic routing (OSPF, RIP): helpers over the configuration in Device.protocols.ospf / .rip.
// Pure functions of the data, shared by the console (ios.ts) and the simulation (sim.ts).

import type { Device, L3InterfaceID } from "../../../core/model";
import type { OSPFConfig, OSPFNetwork, RIPConfig } from "../../../core/protocols";
import type { DeviceAccess } from "../../model-access";
import { IPv4, IPv4Prefix } from "../../sim/ipv4";

export function emptyOSPF(process: number): OSPFConfig {
  return {
    process,
    routerID: "",
    networks: [],
    interfaceAreas: [],
    passive: [],
    passiveDefault: false,
    costs: [],
    defaultOriginate: false,
    redistributeStatic: false,
    redistributeConnected: false,
    referenceBandwidth: 100,
  };
}

export function emptyRIP(): RIPConfig {
  return {
    version: 1,
    networks: [],
    interfaces: [],
    passive: [],
    passiveDefault: false,
    autoSummary: true,
    defaultOriginate: false,
    redistributeStatic: false,
    redistributeConnected: false,
  };
}

export function updateOSPF(access: DeviceAccess, change: (config: OSPFConfig) => void): void {
  access.updateProtocols((protocols) => {
    if (protocols.ospf) change(protocols.ospf);
  });
}

export function updateRIP(access: DeviceAccess, change: (config: RIPConfig) => void): void {
  access.updateProtocols((protocols) => {
    if (protocols.rip) change(protocols.rip);
  });
}

// MARK: Addresses

/** Cisco `network A.B.C.D W`: does the interface address match? */
export function ospfNetworkMatches(network: OSPFNetwork, address: IPv4): boolean {
  const net = IPv4.parse(network.address);
  const wildcard = IPv4.parse(network.wildcard);
  if (net === null || wildcard === null) return false;
  const care = ~wildcard.value >>> 0;
  return (((net.value ^ address.value) & care) >>> 0) === 0;
}

/** The classful network of an address (A /8, B /16, C /24; D and E as /32). */
export function classfulPrefix(address: IPv4): IPv4Prefix {
  const first = address.value >>> 24;
  const length = first < 128 ? 8 : first < 192 ? 16 : first < 224 ? 24 : 32;
  return new IPv4Prefix(address, length).networkPrefix;
}

/** Bandwidth in Mbit/s from the nominal speed ("100M", "1G", "10G") or, failing that, from the port name. */
export function portBandwidthMbps(portName: string, speed: string): number {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([MGT])/i.exec(speed);
  if (match) {
    const unit = match[2].toUpperCase();
    return Number(match[1]) * (unit === "T" ? 1_000_000 : unit === "G" ? 1000 : 1);
  }
  const name = portName.toLowerCase();
  if (name.startsWith("te")) return 10_000;
  if (name.startsWith("gi")) return 1000;
  if (name.startsWith("fa")) return 100;
  if (name.startsWith("e")) return 10;
  return 100;
}

/** Cost of an interface: `ip ospf cost`, else reference bandwidth / bandwidth (at least 1). */
export function ospfCost(config: OSPFConfig, device: Device, interfaceID: L3InterfaceID): number {
  const fixed = config.costs.find((entry) => entry.interface === interfaceID);
  if (fixed) return fixed.cost;
  if (interfaceID.startsWith("vlan:")) return Math.max(1, Math.floor(config.referenceBandwidth / 1000));
  const portID = interfaceID.slice(5).toUpperCase();
  const port = device.ports.find((candidate) => candidate.id.toUpperCase() === portID);
  const bandwidth = port ? portBandwidthMbps(port.name, port.speed) : 100;
  return Math.max(1, Math.floor(config.referenceBandwidth / bandwidth));
}

// MARK: Passive interfaces

interface PassiveData {
  passive: L3InterfaceID[];
  passiveDefault: boolean;
}

/**
 * With `passive-interface default` the list `passive` holds the exceptions
 * (`no passive-interface X`), otherwise the passive interfaces themselves.
 */
export function isPassive(config: PassiveData, interfaceID: L3InterfaceID): boolean {
  const listed = config.passive.includes(interfaceID);
  return config.passiveDefault ? !listed : listed;
}

export function setPassive(config: PassiveData, interfaceID: L3InterfaceID, passive: boolean): void {
  const listed = config.passiveDefault ? !passive : passive;
  const without = config.passive.filter((id) => id !== interfaceID);
  config.passive = listed ? [...without, interfaceID] : without;
}

/** `<N>` or `A.B.C.D` area as a number (dotted areas are converted). */
export function parseArea(text: string): number | null {
  if (/^[0-9]+$/.test(text)) {
    const value = Number(text);
    return value <= 4294967295 ? value : null;
  }
  const dotted = IPv4.parse(text);
  return dotted === null ? null : dotted.value >>> 0;
}
