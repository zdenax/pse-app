// Lookups on a project and small helpers for devices, ports and links
// (the query parts of Project.swift, Device.swift and Link.swift).
//
// All model values are treated as immutable: nothing here changes its arguments.

import type {
  Annotation,
  CableType,
  Device,
  InterfaceAddress,
  Link,
  LinkBundle,
  LinkEnd,
  LinkStatus,
  Port,
  PortRef,
  Project,
  ViewMode,
} from "./model";
import { projectFormatVersion } from "./model";
import { shortName } from "./port-naming";
import { newUUID } from "./util";

/** A new, empty project of the current format version. */
export function emptyProject(name = "", viewMode: ViewMode = "physical"): Project {
  return { formatVersion: projectFormatVersion, name, devices: [], links: [], bundles: [], annotations: [], viewMode };
}

// MARK: Port references

/** True when both references point at the same port. */
export function sameRef(a: PortRef, b: PortRef): boolean {
  return a.deviceID === b.deviceID && a.portID === b.portID;
}

/** A string usable as a map key for a port reference. */
export function refKey(ref: PortRef): string {
  return `${ref.deviceID}/${ref.portID}`;
}

/**
 * An unordered pair of devices; equal regardless of the order the two ids were given in.
 * Compare pairs with `devicePairKey`.
 */
export interface DevicePair {
  readonly first: string;
  readonly second: string;
}

export function devicePair(x: string, y: string): DevicePair {
  return x <= y ? { first: x, second: y } : { first: y, second: x };
}

/** A string that is equal for equal pairs. */
export function devicePairKey(x: string, y: string): string {
  const pair = devicePair(x, y);
  return `${pair.first}|${pair.second}`;
}

// MARK: Links

/** A new cable with a fresh id; the optional fields take their defaults. */
export function makeLink(
  a: PortRef,
  b: PortRef,
  options: { id?: string; cableType?: CableType; statusA?: LinkStatus; statusB?: LinkStatus; note?: string; bundleID?: string } = {},
): Link {
  const link: Link = {
    id: options.id ?? newUUID(),
    a: { deviceID: a.deviceID, portID: a.portID },
    b: { deviceID: b.deviceID, portID: b.portID },
    cableType: options.cableType ?? "straight",
    statusA: options.statusA ?? "none",
    statusB: options.statusB ?? "none",
    note: options.note ?? "",
  };
  if (options.bundleID !== undefined) link.bundleID = options.bundleID;
  return link;
}

/** The port at the given end. */
export function linkRef(link: Link, end: LinkEnd): PortRef {
  return end === "a" ? link.a : link.b;
}

/** The status dot at the given end. */
export function linkStatus(link: Link, end: LinkEnd): LinkStatus {
  return end === "a" ? link.statusA : link.statusB;
}

/** Which end is plugged into `ref`, if either. */
export function linkEndAt(link: Link, ref: PortRef): LinkEnd | undefined {
  if (sameRef(link.a, ref)) return "a";
  if (sameRef(link.b, ref)) return "b";
  return undefined;
}

/** Which end sits on the device, if either. */
export function linkEndOnDevice(link: Link, deviceID: string): LinkEnd | undefined {
  if (link.a.deviceID === deviceID) return "a";
  if (link.b.deviceID === deviceID) return "b";
  return undefined;
}

/** The port at the other end from `ref`; undefined when `ref` is not an end of this link. */
export function otherEnd(link: Link, ref: PortRef): PortRef | undefined {
  if (sameRef(link.a, ref)) return link.b;
  if (sameRef(link.b, ref)) return link.a;
  return undefined;
}

export function linkTouches(link: Link, deviceID: string): boolean {
  return link.a.deviceID === deviceID || link.b.deviceID === deviceID;
}

/** The two devices the link connects, order-independent (for grouping parallel links). */
export function linkDevicePairKey(link: Link): string {
  return devicePairKey(link.a.deviceID, link.b.deviceID);
}

/** The link without its bundle membership. */
export function withoutBundle(link: Link): Link {
  if (link.bundleID === undefined) return link;
  const { bundleID: _removed, ...rest } = link;
  return rest;
}

// MARK: Devices

export function findPortOf(device: Device, portID: string): Port | undefined {
  return device.ports.find((port) => port.id === portID);
}

/** The port with exactly this full name, or failing that this short name. */
export function portNamed(device: Device, name: string): Port | undefined {
  return device.ports.find((port) => port.name === name) ?? device.ports.find((port) => shortName(port.name) === name);
}

export function portIndexOf(device: Device, portID: string): number | undefined {
  const index = device.ports.findIndex((port) => port.id === portID);
  return index < 0 ? undefined : index;
}

/** Reference to one of the device's ports. */
export function refOf(device: Device, port: Port): PortRef {
  return { deviceID: device.id, portID: port.id };
}

/** Reference to the port called `name` (full or short), if it exists. */
export function refOfPortNamed(device: Device, name: string): PortRef | undefined {
  const port = portNamed(device, name);
  return port ? refOf(device, port) : undefined;
}

/** "Vendor Model". */
export function deviceDisplayModel(device: Device): string {
  return [device.vendor, device.model].filter((part) => part !== "").join(" ");
}

/**
 * True when the device or any of its ports is still unverified
 * (the UI shows the "ověřit podle hardwaru" warning).
 */
export function deviceNeedsVerification(device: Device): boolean {
  return !device.verified || device.ports.some((port) => !port.verified);
}

/** The address of a layer-3 interface ("port:<UUID>" or "vlan:<N>"), if one is set. */
export function addressOf(device: Device, interfaceID: string): InterfaceAddress | undefined {
  return device.addresses.find((entry) => entry.interface === interfaceID);
}

// MARK: Layer-3 interface ids

export type L3Interface = { kind: "port"; portID: string } | { kind: "vlan"; vlan: number };

/** "port:<UUID>". */
export function portInterfaceID(portID: string): string {
  return `port:${portID.toUpperCase()}`;
}

/** "vlan:<N>". */
export function vlanInterfaceID(vlan: number): string {
  return `vlan:${vlan}`;
}

/** Parses "port:<UUID>" or "vlan:<1...4094>"; undefined for anything else. */
export function parseInterfaceID(text: string): L3Interface | undefined {
  if (text.startsWith("port:")) {
    const id = text.slice(5);
    if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
      return { kind: "port", portID: id.toUpperCase() };
    }
  } else if (text.startsWith("vlan:")) {
    const digits = text.slice(5);
    if (/^[+-]?[0-9]+$/.test(digits)) {
      const vlan = Number(digits);
      if (vlan >= 1 && vlan <= 4094) return { kind: "vlan", vlan };
    }
  }
  return undefined;
}

/** The canonical text of an interface id (upper-case UUID, plain VLAN number). */
export function formatInterfaceID(value: L3Interface): string {
  return value.kind === "port" ? portInterfaceID(value.portID) : vlanInterfaceID(value.vlan);
}

// MARK: Project lookups

export function findDevice(project: Project, id: string): Device | undefined {
  return project.devices.find((device) => device.id === id);
}

/** The first device with this hostname (hostnames are not required to be unique). */
export function deviceByHostname(project: Project, hostname: string): Device | undefined {
  return project.devices.find((device) => device.hostname === hostname);
}

export function findPort(project: Project, ref: PortRef): Port | undefined {
  const device = findDevice(project, ref.deviceID);
  return device ? findPortOf(device, ref.portID) : undefined;
}

/** The device and port a reference points at, or undefined when either is missing. */
export function resolveRef(project: Project, ref: PortRef): { device: Device; port: Port } | undefined {
  const device = findDevice(project, ref.deviceID);
  const port = device ? findPortOf(device, ref.portID) : undefined;
  return device && port ? { device, port } : undefined;
}

export function findLink(project: Project, id: string): Link | undefined {
  return project.links.find((link) => link.id === id);
}

/** The cable plugged into the port, if any. */
export function linkAt(project: Project, ref: PortRef): Link | undefined {
  return project.links.find((link) => sameRef(link.a, ref) || sameRef(link.b, ref));
}

export function isPortUsed(project: Project, ref: PortRef): boolean {
  return linkAt(project, ref) !== undefined;
}

/** All cables with at least one end on the device. */
export function linksOfDevice(project: Project, deviceID: string): Link[] {
  return project.links.filter((link) => linkTouches(link, deviceID));
}

/** All cables between two devices, in either direction. */
export function linksBetween(project: Project, first: string, second: string): Link[] {
  const pair = devicePairKey(first, second);
  return project.links.filter((link) => linkDevicePairKey(link) === pair);
}

/** What is plugged into the far end of a cable. */
export interface PortPeer {
  /** The cable. */
  link: Link;
  /** The end of `link` at which the peer sits. */
  end: LinkEnd;
  /** Reference to the peer port. */
  ref: PortRef;
  /** The device at the far end. */
  device: Device;
  /** The port at the far end. */
  port: Port;
}

/** One row of a device's "what is plugged where" list. */
export interface PortConnection {
  /** The local port. */
  port: Port;
  /** The cable in the port, undefined when the port is free. */
  link?: Link;
  /** The far end of the cable, undefined when the port is free. */
  peer?: PortPeer;
}

/** The device and port at the other end of the cable plugged into `ref`. */
export function peerOf(project: Project, ref: PortRef): PortPeer | undefined {
  const link = linkAt(project, ref);
  if (!link) return undefined;
  const near = linkEndAt(link, ref);
  if (!near) return undefined;
  const end: LinkEnd = near === "a" ? "b" : "a";
  const far = resolveRef(project, linkRef(link, end));
  if (!far) return undefined;
  return { link, end, ref: linkRef(link, end), device: far.device, port: far.port };
}

/** Every port of the device with what is plugged into it, in port order. */
export function connectionsOfDevice(project: Project, deviceID: string): PortConnection[] {
  const device = findDevice(project, deviceID);
  if (!device) return [];
  return device.ports.map((port) => {
    const ref = { deviceID, portID: port.id };
    const row: PortConnection = { port };
    const link = linkAt(project, ref);
    if (link) row.link = link;
    const peer = peerOf(project, ref);
    if (peer) row.peer = peer;
    return row;
  });
}

export function findBundle(project: Project, id: string): LinkBundle | undefined {
  return project.bundles.find((bundle) => bundle.id === id);
}

/** The bundle the link belongs to, if any. */
export function bundleOfLink(project: Project, linkID: string): LinkBundle | undefined {
  return project.bundles.find((bundle) => bundle.linkIDs.includes(linkID));
}

export function findAnnotation(project: Project, id: string): Annotation | undefined {
  return project.annotations.find((annotation) => annotation.id === id);
}
