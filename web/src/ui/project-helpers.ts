// Read-only queries over a Project that the shell needs and the store API does not offer
// (the Swift ProjectStore has them as conveniences: connections(ofDevice:), bundle(ofLink:), ...).

import type { Annotation, Device, Link, LinkBundle, Point, Port, PortRef, Project } from "../core/model";
import type { SelectionItem } from "../core/store-api";

export function findDevice(project: Project, id: string): Device | undefined {
  return project.devices.find((device) => device.id === id);
}

export function findLink(project: Project, id: string): Link | undefined {
  return project.links.find((link) => link.id === id);
}

export function findAnnotation(project: Project, id: string): Annotation | undefined {
  return project.annotations.find((annotation) => annotation.id === id);
}

export function findBundle(project: Project, id: string): LinkBundle | undefined {
  return project.bundles.find((bundle) => bundle.id === id);
}

export interface ResolvedPort {
  device: Device;
  port: Port;
}

export function resolvePort(project: Project, ref: PortRef): ResolvedPort | null {
  const device = findDevice(project, ref.deviceID);
  const port = device?.ports.find((candidate) => candidate.id === ref.portID);
  return device && port ? { device, port } : null;
}

/** One port of a device with the cable plugged into it and what is at the other end. */
export interface PortConnection {
  port: Port;
  link: Link | null;
  peer: ResolvedPort | null;
}

export function connectionsOfDevice(project: Project, device: Device): PortConnection[] {
  const byPort = new Map<string, { link: Link; peer: PortRef }>();
  for (const link of project.links) {
    if (link.a.deviceID === device.id) byPort.set(link.a.portID, { link, peer: link.b });
    if (link.b.deviceID === device.id) byPort.set(link.b.portID, { link, peer: link.a });
  }
  return device.ports.map((port) => {
    const entry = byPort.get(port.id);
    if (!entry) return { port, link: null, peer: null };
    return { port, link: entry.link, peer: resolvePort(project, entry.peer) };
  });
}

/** The bundle (LAG) a link belongs to, if any. */
export function bundleOfLink(project: Project, linkID: string): LinkBundle | undefined {
  const link = findLink(project, linkID);
  if (link?.bundleID) {
    const bundle = findBundle(project, link.bundleID);
    if (bundle) return bundle;
  }
  return project.bundles.find((bundle) => bundle.linkIDs.includes(linkID));
}

export function selectedIDs(selection: SelectionItem[], kind: SelectionItem["kind"]): string[] {
  return selection.filter((item) => item.kind === kind).map((item) => item.id);
}

/** True when the device or any of its ports is still unverified. */
export function deviceNeedsVerification(device: Device): boolean {
  return !device.verified || device.ports.some((port) => !port.verified);
}

/** Steps diagonally away from `point` until nothing sits (almost) exactly there. */
export function freeSpot(project: Project, point: Point): Point {
  const isClose = (a: Point, b: Point) => Math.abs(a.x - b.x) < 30 && Math.abs(a.y - b.y) < 30;
  let candidate = { ...point };
  for (let i = 0; i < 40; i++) {
    const occupied =
      project.devices.some((device) => isClose(device.position, candidate)) ||
      project.annotations.some((annotation) => isClose(annotation.position, candidate));
    if (!occupied) break;
    candidate = { x: candidate.x + 40, y: candidate.y + 40 };
  }
  return candidate;
}

/** Display name of a layer-3 interface: "Vlan10" (or "bridge" on MikroTik) or the port name. */
export function interfaceName(device: Device, interfaceID: string): string {
  if (interfaceID.startsWith("vlan:")) {
    const number = interfaceID.slice("vlan:".length);
    return device.vendor.toLowerCase().includes("mikrotik") ? "bridge" : `Vlan${number}`;
  }
  if (interfaceID.startsWith("port:")) {
    const id = interfaceID.slice("port:".length);
    return device.ports.find((port) => port.id.toUpperCase() === id.toUpperCase())?.name ?? "?";
  }
  return interfaceID;
}
