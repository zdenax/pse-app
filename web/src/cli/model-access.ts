// The only place of the CLI that touches the ProjectStore. Port of ModelAccess.swift (NetSketchCLI).

import type {
  ConnectorType,
  Device,
  DeviceCategory,
  InterfaceAddress,
  L3InterfaceID,
  Link,
  Port,
  PortRef,
  Project,
  StaticRoute,
  VLANEntry,
} from "../core/model";
import type { ProjectStoreAPI } from "../core/store-api";
import { cloneProtocols, type DeviceProtocols } from "../core/protocols";
import { IPv4, IPv4Prefix } from "./sim/ipv4";
import { NetworkSimulator } from "./sim/network-simulator";
import { SwitchportConfig } from "./switchport";

/** What is plugged into the far end of a port's cable. */
export interface PeerSnapshot {
  readonly hostname: string;
  readonly vendor: string;
  readonly model: string;
  readonly category: DeviceCategory;
  readonly portName: string;
  readonly adminDown: boolean;
}

/** Static link state of a port. Derived ONLY from the diagram: the shutdown flags of both
 * ends and whether a cable is drawn. Nothing is negotiated or simulated.
 * - adminDown: the port itself is shut down.
 * - up: a cable is drawn and neither end is shut down.
 * - down: no cable, or the far end is shut down. */
export type StaticLinkState = "adminDown" | "up" | "down";

/** A read-only copy of one interface of the console's device. */
export interface PortSnapshot {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly vlanText: string;
  readonly adminDown: boolean;
  readonly speed: string;
  readonly connector: ConnectorType;
  readonly peer: PeerSnapshot | null;
  readonly linkState: StaticLinkState;
  /** The parsed switchport configuration, null when `vlanText` is not in the canonical format. */
  readonly switchport: SwitchportConfig | null;
  /** Management ports are not switched ports: they take no VLAN configuration. */
  readonly isSwitchport: boolean;
}

/** The stored fields of a PortSnapshot; the computed ones follow from them. */
export type PortSnapshotFields = Pick<
  PortSnapshot,
  "id" | "name" | "description" | "vlanText" | "adminDown" | "speed" | "connector" | "peer"
>;

/** Builds a PortSnapshot whose computed members are getters, as in Swift. */
export function makePortSnapshot(fields: PortSnapshotFields): PortSnapshot {
  return {
    ...fields,
    get linkState(): StaticLinkState {
      if (fields.adminDown) return "adminDown";
      if (!fields.peer) return "down";
      return fields.peer.adminDown ? "down" : "up";
    },
    get switchport(): SwitchportConfig | null {
      return SwitchportConfig.parse(fields.vlanText);
    },
    get isSwitchport(): boolean {
      return fields.connector !== "mgmt";
    },
  };
}

/** A bundle (LAG) drawn in the diagram that the console's device takes part in. */
export interface BundleSnapshot {
  readonly label: string;
  /** Names of this device's member ports. */
  readonly localPorts: string[];
  readonly peerHostname: string;
  readonly peerPorts: string[];
}

// MARK: - L3 interface ids ("port:<UUID>" / "vlan:<N>")

export type L3Interface = { kind: "port"; id: string } | { kind: "vlan"; number: number };

export function l3Port(portID: string): L3InterfaceID {
  return "port:" + portID;
}

export function l3VLAN(number: number): L3InterfaceID {
  return `vlan:${number}`;
}

/** Decodes an L3InterfaceID like Swift `L3InterfaceID(string:)`; null for anything else. */
export function parseL3Interface(text: L3InterfaceID): L3Interface | null {
  if (text.startsWith("port:")) {
    const id = text.slice(5);
    return id === "" ? null : { kind: "port", id };
  }
  if (text.startsWith("vlan:")) {
    const digits = text.slice(5);
    if (!/^[+-]?[0-9]+$/.test(digits)) return null;
    const number = Number(digits);
    return number >= 1 && number <= 4094 ? { kind: "vlan", number } : null;
  }
  return null;
}

// MARK: - Project lookups (NetSketchCore Project/Device/Link helpers)

export function projectDevice(project: Project, id: string): Device | null {
  return project.devices.find((device) => device.id === id) ?? null;
}

export function devicePort(device: Device, id: string): Port | null {
  return device.ports.find((port) => port.id === id) ?? null;
}

function sameRef(a: PortRef, b: PortRef): boolean {
  return a.deviceID === b.deviceID && a.portID === b.portID;
}

/** The device and port a reference points at, or null when either is missing. */
export function resolvePortRef(project: Project, ref: PortRef): { device: Device; port: Port } | null {
  const device = projectDevice(project, ref.deviceID);
  const port = device ? devicePort(device, ref.portID) : null;
  return device && port ? { device, port } : null;
}

/** The device and port at the other end of the cable plugged into `ref`. */
export function portPeer(project: Project, ref: PortRef): { link: Link; device: Device; port: Port } | null {
  const link = project.links.find((candidate) => sameRef(candidate.a, ref) || sameRef(candidate.b, ref));
  if (!link) return null;
  const far = sameRef(link.a, ref) ? link.b : link.a;
  const resolved = resolvePortRef(project, far);
  return resolved ? { link, ...resolved } : null;
}

/** The DeviceAccess of the console's device. */
export class DeviceAccess {
  constructor(
    readonly store: ProjectStoreAPI,
    readonly deviceID: string,
  ) {}

  get device(): Device | null {
    return projectDevice(this.store.project, this.deviceID);
  }

  get exists(): boolean {
    return this.device !== null;
  }

  get hostname(): string {
    return this.device?.hostname ?? "";
  }

  get vendor(): string {
    return this.device?.vendor ?? "";
  }

  get model(): string {
    return this.device?.model ?? "";
  }

  get category(): DeviceCategory | null {
    return this.device?.category ?? null;
  }

  /** The interfaces of the device: every port except serial console jacks, in panel order. */
  get interfaces(): PortSnapshot[] {
    const device = this.device;
    if (!device) return [];
    const project = this.store.project;
    return device.ports
      .filter((port) => port.connector !== "console")
      .map((port) => {
        const far = portPeer(project, { deviceID: device.id, portID: port.id });
        const peer: PeerSnapshot | null = far
          ? {
              hostname: far.device.hostname,
              vendor: far.device.vendor,
              model: far.device.model,
              category: far.device.category,
              portName: far.port.name,
              adminDown: far.port.adminDown,
            }
          : null;
        return makePortSnapshot({
          id: port.id,
          name: port.name,
          description: port.description,
          vlanText: port.vlan,
          adminDown: port.adminDown,
          speed: port.speed,
          connector: port.connector,
          peer,
        });
      });
  }

  interface(id: string): PortSnapshot | null {
    return this.interfaces.find((port) => port.id === id) ?? null;
  }

  /** The VLAN table as stored (VLAN 1 is implicit and normally absent), sorted by number. */
  get vlans(): VLANEntry[] {
    return [...(this.device?.vlans ?? [])].sort((a, b) => a.id - b.id).map((entry) => ({ ...entry }));
  }

  /** Bundles with at least one member link on this device, in project order. */
  get bundles(): BundleSnapshot[] {
    const device = this.device;
    if (!device) return [];
    const project = this.store.project;
    const result: BundleSnapshot[] = [];
    for (const bundle of project.bundles) {
      const local: string[] = [];
      const remote: string[] = [];
      let peerName = "";
      for (const linkID of bundle.linkIDs) {
        const link = project.links.find((candidate) => candidate.id === linkID);
        if (!link) continue;
        const end = link.a.deviceID === device.id ? "a" : link.b.deviceID === device.id ? "b" : null;
        if (end === null) continue;
        const near = resolvePortRef(project, end === "a" ? link.a : link.b);
        const far = resolvePortRef(project, end === "a" ? link.b : link.a);
        if (!near || !far) continue;
        local.push(near.port.name);
        remote.push(far.port.name);
        peerName = far.device.hostname;
      }
      if (local.length > 0) {
        result.push({ label: bundle.label, localPorts: local, peerHostname: peerName, peerPorts: remote });
      }
    }
    return result;
  }

  // MARK: Writes

  /** Runs `body` as ONE undo step. */
  transaction(body: () => void): void {
    this.store.beginUndoGroup();
    try {
      body();
    } finally {
      this.store.endUndoGroup();
    }
  }

  private attempt(write: () => void): boolean {
    try {
      write();
      return true;
    } catch {
      return false;
    }
  }

  private ref(port: string): PortRef {
    return { deviceID: this.deviceID, portID: port };
  }

  /** Renames the device. Returns false when the store refused (empty name, device gone). */
  rename(hostname: string): boolean {
    return this.attempt(() => this.store.renameDevice(this.deviceID, hostname));
  }

  setDescription(text: string, port: string): boolean {
    return this.attempt(() => this.store.setPortDescription(this.ref(port), text));
  }

  setVLANText(text: string, port: string): boolean {
    return this.attempt(() => this.store.setPortVLAN(this.ref(port), text));
  }

  setAdminDown(down: boolean, port: string): boolean {
    return this.attempt(() => this.store.setPortAdminDown(this.ref(port), down));
  }

  setVLANs(vlans: VLANEntry[]): boolean {
    return this.attempt(() => this.store.setVLANs(this.deviceID, vlans));
  }

  // MARK: IP configuration

  get addresses(): InterfaceAddress[] {
    return this.device?.addresses ?? [];
  }

  get defaultGateway(): string {
    return this.device?.defaultGateway ?? "";
  }

  get staticRoutes(): StaticRoute[] {
    return this.device?.staticRoutes ?? [];
  }

  /** The address of a layer-3 interface, parsed; null when none (or a malformed one) is set. */
  address(interfaceID: L3InterfaceID): IPv4Prefix | null {
    const entry = this.device?.addresses.find((candidate) => candidate.interface === interfaceID);
    return entry ? IPv4Prefix.fromCIDR(entry.address) : null;
  }

  /** Sets (or with null removes) the address of an interface. */
  setAddress(prefix: IPv4Prefix | null, interfaceID: L3InterfaceID): boolean {
    return this.attempt(() =>
      this.store.setAddress(this.deviceID, interfaceID, prefix === null ? null : prefix.description),
    );
  }

  setDefaultGateway(gateway: IPv4 | null): boolean {
    return this.attempt(() => this.store.setDefaultGateway(this.deviceID, gateway === null ? "" : gateway.description));
  }

  setStaticRoutes(routes: StaticRoute[]): boolean {
    return this.attempt(() => this.store.setStaticRoutes(this.deviceID, routes));
  }

  // MARK: Protocols (DHCP, ACL, NAT, OSPF, RIP, STP, LACP)

  /** A copy of the protocol configuration; edit it and write it back with `setProtocols`. */
  get protocols(): DeviceProtocols {
    return cloneProtocols(this.device?.protocols);
  }

  setProtocols(protocols: DeviceProtocols): boolean {
    return this.attempt(() => this.store.setProtocols(this.deviceID, protocols));
  }

  /** Reads, changes and writes back the protocol configuration (one undo step). */
  updateProtocols(change: (protocols: DeviceProtocols) => void): boolean {
    const protocols = this.protocols;
    change(protocols);
    return this.setProtocols(protocols);
  }

  /** Another device's interface that already uses `address`, as "hostname interface". */
  addressConflict(address: IPv4, interfaceID: L3InterfaceID): string | null {
    for (const other of this.store.project.devices) {
      for (const entry of other.addresses) {
        const prefix = IPv4Prefix.fromCIDR(entry.address);
        if (!prefix || prefix.address.value !== address.value) continue;
        if (other.id === this.deviceID && entry.interface === interfaceID) continue;
        return other.hostname;
      }
    }
    return null;
  }

  /** The network simulation of the current project. */
  get simulator(): NetworkSimulator {
    return new NetworkSimulator(this.store.project);
  }
}
