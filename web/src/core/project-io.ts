// Reading and writing ".netsketch" files, and the consistency check of a project
// (the Codable and validation parts of Project.swift and the model files).
//
// Decoding is lenient exactly like the Swift `init(from:)` implementations: optional fields
// may be missing (or null) and take their defaults; required ones must be present.
// Encoding reproduces Foundation's JSONEncoder output byte for byte (see json-writer.ts).

import { cableTypes, connectorTypes, deviceCategories, linkEnds, linkStatuses, portArrangements, viewModes } from "./enums";
import { EditError } from "./errors";
import {
  DecodeError,
  optional,
  parseJSON,
  readArray,
  readBool,
  readDouble,
  readEnum,
  readInt,
  readObject,
  readString,
  readUUID,
  required,
  type Reader,
} from "./json-decode";
import { writeJSON, type JSONObject, type JSONValue } from "./json-writer";
import type {
  Annotation,
  Device,
  InterfaceAddress,
  Link,
  LinkBundle,
  LinkEnd,
  PanelLayout,
  PanelSection,
  Point,
  Port,
  PortRef,
  Project,
  StaticRoute,
  VLANEntry,
} from "./model";
import { projectFormatVersion } from "./model";
import { cloneProtocols, isEmptyProtocols, readProtocols } from "./protocols";
import { makePanelLayout, makePanelSection } from "./panel-layout";
import {
  findBundle,
  findDevice,
  findLink,
  findPort,
  formatInterfaceID,
  linkDevicePairKey,
  linkRef,
  parseInterfaceID,
  refKey,
  resolveRef,
} from "./project";
import { czechPlural } from "./util";

/** File extension without the dot. */
export const projectFileExtension = "netsketch";

// MARK: Decoding

/**
 * Decodes a project from ".netsketch" JSON text. The result is not validated; see
 * `validateProject` and `repairProject`.
 *
 * Throws `EditError` with code "invalidFile" (not JSON, or not a project) or "newerFormat"
 * (written by a newer version of the app).
 */
export function decodeProject(text: string): Project {
  try {
    return readProject(parseJSON(text), []);
  } catch (error) {
    if (error instanceof DecodeError) {
      throw new EditError("invalidFile", { detail: error.message }, undefined, { cause: error });
    }
    throw error;
  }
}

/** Decodes a project from an already parsed JSON value; throws like `decodeProject`. */
export function decodeProjectValue(value: unknown): Project {
  try {
    return readProject(value, []);
  } catch (error) {
    if (error instanceof DecodeError) {
      throw new EditError("invalidFile", { detail: error.message }, undefined, { cause: error });
    }
    throw error;
  }
}

const readProject: Reader<Project> = (value, path) => {
  const c = readObject(value, path);
  const formatVersion = optional(c, "formatVersion", path, readInt) ?? 1;
  if (formatVersion > projectFormatVersion) {
    throw new EditError("newerFormat", { foundVersion: formatVersion, supportedVersion: projectFormatVersion });
  }
  return {
    formatVersion,
    name: optional(c, "name", path, readString) ?? "",
    devices: optional(c, "devices", path, readArray(readDevice)) ?? [],
    links: optional(c, "links", path, readArray(readLink)) ?? [],
    bundles: optional(c, "bundles", path, readArray(readBundle)) ?? [],
    annotations: optional(c, "annotations", path, readArray(readAnnotation)) ?? [],
    // Swift keeps nil for files that never stored a view mode and shows them physically.
    viewMode: optional(c, "viewMode", path, readEnum(viewModes)) ?? "physical",
  };
};

/** JSON form of a canvas point: `{"x": 120, "y": 80}`. */
const readPoint: Reader<Point> = (value, path) => {
  const c = readObject(value, path);
  return { x: required(c, "x", path, readDouble), y: required(c, "y", path, readDouble) };
};

const readPort: Reader<Port> = (value, path) => {
  const c = readObject(value, path);
  return {
    id: required(c, "id", path, readUUID),
    name: required(c, "name", path, readString),
    connector: required(c, "connector", path, readEnum(connectorTypes)),
    speed: optional(c, "speed", path, readString) ?? "",
    verified: optional(c, "verified", path, readBool) ?? false,
    description: optional(c, "description", path, readString) ?? "",
    vlan: optional(c, "vlan", path, readString) ?? "",
    groupIndex: optional(c, "groupIndex", path, readInt) ?? 0,
    adminDown: optional(c, "adminDown", path, readBool) ?? false,
  };
};

const readVLAN: Reader<VLANEntry> = (value, path) => {
  const c = readObject(value, path);
  return { id: required(c, "id", path, readInt), name: optional(c, "name", path, readString) ?? "" };
};

/** "port:<UUID>" or "vlan:<N>", returned in canonical form. */
const readInterfaceID: Reader<string> = (value, path) => {
  const parsed = parseInterfaceID(readString(value, path));
  if (!parsed) throw new DecodeError("dataCorrupted", path);
  return formatInterfaceID(parsed);
};

const readAddress: Reader<InterfaceAddress> = (value, path) => {
  const c = readObject(value, path);
  return { interface: required(c, "interface", path, readInterfaceID), address: required(c, "address", path, readString) };
};

const readRoute: Reader<StaticRoute> = (value, path) => {
  const c = readObject(value, path);
  return { destination: required(c, "destination", path, readString), nextHop: required(c, "nextHop", path, readString) };
};

/** A panel section; `group` (a single index) is accepted instead of `groups`. */
export const readPanelSection: Reader<PanelSection> = (value, path) => {
  const c = readObject(value, path);
  let groups = optional(c, "groups", path, readArray(readInt));
  if (groups === undefined) {
    const single = optional(c, "group", path, readInt);
    groups = single === undefined ? [] : [single];
  }
  return makePanelSection(groups, {
    arrangement: optional(c, "arrangement", path, readEnum(portArrangements)) ?? "singleRow",
    row: optional(c, "row", path, readInt),
    blockColumns: optional(c, "blockColumns", path, readInt),
    label: optional(c, "label", path, readString),
    placeholderWidth: optional(c, "placeholderWidth", path, readDouble),
  });
};

export const readPanelLayout: Reader<PanelLayout> = (value, path) => {
  const c = readObject(value, path);
  return makePanelLayout(
    optional(c, "rows", path, readInt) ?? 1,
    optional(c, "sections", path, readArray(readPanelSection)) ?? [],
  );
};

const readDevice: Reader<Device> = (value, path) => {
  const c = readObject(value, path);
  return {
    id: required(c, "id", path, readUUID),
    templateID: optional(c, "templateID", path, readString) ?? "",
    vendor: optional(c, "vendor", path, readString) ?? "",
    model: optional(c, "model", path, readString) ?? "",
    category: required(c, "category", path, readEnum(deviceCategories)),
    hostname: required(c, "hostname", path, readString),
    position: required(c, "position", path, readPoint),
    ports: optional(c, "ports", path, readArray(readPort)) ?? [],
    note: optional(c, "note", path, readString) ?? "",
    layout: optional(c, "layout", path, readPanelLayout) ?? makePanelLayout(),
    verified: optional(c, "verified", path, readBool) ?? false,
    vlans: optional(c, "vlans", path, readArray(readVLAN)) ?? [],
    addresses: optional(c, "addresses", path, readArray(readAddress)) ?? [],
    defaultGateway: optional(c, "defaultGateway", path, readString) ?? "",
    staticRoutes: optional(c, "staticRoutes", path, readArray(readRoute)) ?? [],
    ...protocolsField(c.protocols),
  };
};

/** `protocols` (web only) is kept only when something is configured. */
function protocolsField(raw: unknown): { protocols?: Device["protocols"] } {
  const protocols = readProtocols(raw);
  return isEmptyProtocols(protocols) ? {} : { protocols };
}

const readPortRef: Reader<PortRef> = (value, path) => {
  const c = readObject(value, path);
  return { deviceID: required(c, "deviceID", path, readUUID), portID: required(c, "portID", path, readUUID) };
};

const readLink: Reader<Link> = (value, path) => {
  const c = readObject(value, path);
  const link: Link = {
    id: required(c, "id", path, readUUID),
    a: required(c, "a", path, readPortRef),
    b: required(c, "b", path, readPortRef),
    cableType: optional(c, "cableType", path, readEnum(cableTypes)) ?? "straight",
    statusA: optional(c, "statusA", path, readEnum(linkStatuses)) ?? "none",
    statusB: optional(c, "statusB", path, readEnum(linkStatuses)) ?? "none",
    note: optional(c, "note", path, readString) ?? "",
  };
  const bundleID = optional(c, "bundleID", path, readUUID);
  if (bundleID !== undefined) link.bundleID = bundleID;
  const delay = optional(c, "delay", path, readDouble);
  if (delay !== undefined && Number.isFinite(delay) && delay > 0) link.delay = delay;
  const loss = optional(c, "loss", path, readDouble);
  if (loss !== undefined && Number.isFinite(loss) && loss > 0) link.loss = Math.min(loss, 100);
  return link;
};

const readBundle: Reader<LinkBundle> = (value, path) => {
  const c = readObject(value, path);
  return {
    id: required(c, "id", path, readUUID),
    label: required(c, "label", path, readString),
    linkIDs: required(c, "linkIDs", path, readArray(readUUID)),
  };
};

const readAnnotation: Reader<Annotation> = (value, path) => {
  const c = readObject(value, path);
  return {
    id: required(c, "id", path, readUUID),
    text: optional(c, "text", path, readString) ?? "",
    position: required(c, "position", path, readPoint),
  };
};

// MARK: Encoding

/** Pretty-printed JSON with sorted keys, byte-identical to what the Swift app writes. */
export function encodeProject(project: Project): string {
  return writeJSON(projectJSON(project));
}

/** The JSON object of a project (keys exactly as the Swift encoder writes them). */
export function projectJSON(project: Project): JSONObject {
  return {
    formatVersion: project.formatVersion,
    name: project.name,
    devices: project.devices.map(deviceJSON),
    links: project.links.map(linkJSON),
    bundles: project.bundles.map((bundle) => ({ id: bundle.id, label: bundle.label, linkIDs: [...bundle.linkIDs] })),
    annotations: project.annotations.map((annotation) => ({
      id: annotation.id,
      text: annotation.text,
      position: pointJSON(annotation.position),
    })),
    viewMode: project.viewMode,
  };
}

function pointJSON(point: Point): JSONObject {
  return { x: point.x, y: point.y };
}

/** The IP configuration is written only when it is not empty, like in Swift. */
function deviceJSON(device: Device): JSONObject {
  const json: JSONObject = {
    id: device.id,
    templateID: device.templateID,
    vendor: device.vendor,
    model: device.model,
    category: device.category,
    hostname: device.hostname,
    position: pointJSON(device.position),
    ports: device.ports.map(portJSON),
    note: device.note,
    layout: panelLayoutJSON(device.layout),
    verified: device.verified,
    vlans: device.vlans.map((vlan) => ({ id: vlan.id, name: vlan.name })),
  };
  if (device.addresses.length > 0) {
    json.addresses = device.addresses.map((entry) => ({ interface: entry.interface, address: entry.address }));
  }
  if (device.defaultGateway !== "") json.defaultGateway = device.defaultGateway;
  if (device.staticRoutes.length > 0) {
    json.staticRoutes = device.staticRoutes.map((route) => ({ destination: route.destination, nextHop: route.nextHop }));
  }
  if (!isEmptyProtocols(device.protocols)) {
    json.protocols = cloneProtocols(device.protocols) as unknown as JSONObject;
  }
  return json;
}

function portJSON(port: Port): JSONObject {
  return {
    id: port.id,
    name: port.name,
    connector: port.connector,
    speed: port.speed,
    verified: port.verified,
    description: port.description,
    vlan: port.vlan,
    groupIndex: port.groupIndex,
    adminDown: port.adminDown,
  };
}

/** `rows` and `sections`; the optional section fields only when set. */
export function panelLayoutJSON(layout: PanelLayout): JSONObject {
  return {
    rows: layout.rows,
    sections: layout.sections.map(
      (section): JSONObject => ({
        groups: [...section.groups],
        arrangement: section.arrangement,
        row: section.row,
        blockColumns: section.blockColumns,
        label: section.label,
        placeholderWidth: section.placeholderWidth,
      }),
    ),
  };
}

function linkJSON(link: Link): JSONObject {
  const ref = (value: PortRef): JSONValue => ({ deviceID: value.deviceID, portID: value.portID });
  return {
    id: link.id,
    a: ref(link.a),
    b: ref(link.b),
    cableType: link.cableType,
    statusA: link.statusA,
    statusB: link.statusB,
    note: link.note,
    bundleID: link.bundleID,
    delay: link.delay !== undefined && link.delay > 0 ? link.delay : undefined,
    loss: link.loss !== undefined && link.loss > 0 ? link.loss : undefined,
  };
}

// MARK: Consistency

/** An internal inconsistency found by `validateProject`. */
export type ProjectIssue =
  /** Two devices, links, bundles or annotations share an id (or two ports of one device do). */
  | { kind: "duplicateID"; id: string }
  /** A link end points at a device or port that does not exist. */
  | { kind: "danglingPortRef"; linkID: string; end: LinkEnd }
  /** Both ends of a link are on the same device. */
  | { kind: "linkWithinDevice"; linkID: string }
  /** More than one link is plugged into the port. */
  | { kind: "portUsedTwice"; ref: PortRef }
  /** A bundle lists a link that does not exist. */
  | { kind: "bundleMissingLink"; bundleID: string; linkID: string }
  /** A bundle has fewer than two member links. */
  | { kind: "bundleTooSmall"; bundleID: string }
  /** The members of a bundle do not all connect the same pair of devices. */
  | { kind: "bundleNotParallel"; bundleID: string }
  /** `Link.bundleID` and `LinkBundle.linkIDs` disagree about this link. */
  | { kind: "bundleMembershipMismatch"; linkID: string };

/**
 * Checks internal consistency. An empty result means every `PortRef` resolves,
 * no port carries two cables and bundles agree with their links.
 */
export function validateProject(project: Project): ProjectIssue[] {
  const issues: ProjectIssue[] = [];

  const ids = new Set<string>();
  const check = (id: string): void => {
    if (ids.has(id)) issues.push({ kind: "duplicateID", id });
    else ids.add(id);
  };
  for (const device of project.devices) {
    check(device.id);
    const portIDs = new Set<string>();
    for (const port of device.ports) {
      if (portIDs.has(port.id)) issues.push({ kind: "duplicateID", id: port.id });
      else portIDs.add(port.id);
    }
  }
  project.links.forEach((link) => check(link.id));
  project.bundles.forEach((bundle) => check(bundle.id));
  project.annotations.forEach((annotation) => check(annotation.id));

  const usedPorts = new Set<string>();
  for (const link of project.links) {
    for (const end of linkEnds) {
      const ref = linkRef(link, end);
      if (findPort(project, ref) === undefined) {
        issues.push({ kind: "danglingPortRef", linkID: link.id, end });
      } else if (usedPorts.has(refKey(ref))) {
        issues.push({ kind: "portUsedTwice", ref: { deviceID: ref.deviceID, portID: ref.portID } });
      } else {
        usedPorts.add(refKey(ref));
      }
    }
    if (link.a.deviceID === link.b.deviceID) issues.push({ kind: "linkWithinDevice", linkID: link.id });
  }

  const membership = new Map<string, string>();
  for (const bundle of project.bundles) {
    const pairs = new Set<string>();
    let members = 0;
    for (const linkID of bundle.linkIDs) {
      const link = findLink(project, linkID);
      if (!link) {
        issues.push({ kind: "bundleMissingLink", bundleID: bundle.id, linkID });
        continue;
      }
      members += 1;
      pairs.add(linkDevicePairKey(link));
      if (membership.has(linkID)) issues.push({ kind: "bundleMembershipMismatch", linkID });
      membership.set(linkID, bundle.id);
    }
    if (members < 2) issues.push({ kind: "bundleTooSmall", bundleID: bundle.id });
    if (pairs.size > 1) issues.push({ kind: "bundleNotParallel", bundleID: bundle.id });
  }
  for (const link of project.links) {
    if (link.bundleID !== membership.get(link.id)) issues.push({ kind: "bundleMembershipMismatch", linkID: link.id });
  }
  return issues;
}

/**
 * A consistent copy: duplicate ids, broken links and broken bundles are dropped
 * (the first occurrence wins). `validateProject(repairProject(p))` is always empty.
 */
export function repairProject(project: Project): Project {
  const ids = new Set<string>();
  const devices = project.devices.flatMap((device) => {
    if (ids.has(device.id)) return [];
    ids.add(device.id);
    const portIDs = new Set<string>();
    const ports = device.ports.filter((port) => {
      if (portIDs.has(port.id)) return false;
      portIDs.add(port.id);
      return true;
    });
    return [ports.length === device.ports.length ? device : { ...device, ports }];
  });
  const annotations = project.annotations.filter((annotation) => {
    if (ids.has(annotation.id)) return false;
    ids.add(annotation.id);
    return true;
  });

  const partial: Project = { ...project, devices, annotations };
  const usedPorts = new Set<string>();
  const links = project.links.filter((link) => {
    if (
      ids.has(link.id) ||
      link.a.deviceID === link.b.deviceID ||
      findPort(partial, link.a) === undefined ||
      findPort(partial, link.b) === undefined ||
      usedPorts.has(refKey(link.a)) ||
      usedPorts.has(refKey(link.b))
    ) {
      return false;
    }
    ids.add(link.id);
    usedPorts.add(refKey(link.a));
    usedPorts.add(refKey(link.b));
    return true;
  });

  const withLinks: Project = { ...partial, links };
  const membership = new Map<string, string>();
  const bundles = project.bundles.flatMap((bundle) => {
    if (ids.has(bundle.id)) return [];
    let pair: string | undefined;
    const members: string[] = [];
    for (const linkID of bundle.linkIDs) {
      const link = membership.has(linkID) || members.includes(linkID) ? undefined : findLink(withLinks, linkID);
      if (!link) continue;
      if (pair !== undefined && pair !== linkDevicePairKey(link)) continue;
      pair = linkDevicePairKey(link);
      members.push(linkID);
    }
    if (members.length < 2) return [];
    ids.add(bundle.id);
    members.forEach((linkID) => membership.set(linkID, bundle.id));
    return [members.length === bundle.linkIDs.length ? bundle : { ...bundle, linkIDs: members }];
  });

  const repairedLinks = links.map((link): Link => {
    const bundleID = membership.get(link.id);
    if (bundleID === link.bundleID) return link;
    const { bundleID: _old, ...rest } = link;
    return bundleID === undefined ? rest : { ...rest, bundleID };
  });

  return { ...project, devices, links: repairedLinks, bundles, annotations };
}

// MARK: Czech texts

/** One Czech phrase per kind of inconsistency (CzechText.describe in the Swift app). */
export function describeIssue(issue: ProjectIssue): string {
  switch (issue.kind) {
    case "duplicateID":
      return "dva objekty se stejným identifikátorem";
    case "danglingPortRef":
      return "kabel vedoucí do neexistujícího portu";
    case "linkWithinDevice":
      return "kabel s oběma konci na jednom zařízení";
    case "portUsedTwice":
      return "port se dvěma kabely";
    case "bundleMissingLink":
      return "svazek s neexistujícím kabelem";
    case "bundleTooSmall":
      return "svazek s méně než dvěma kabely";
    case "bundleNotParallel":
      return "svazek s kabely mezi různými zařízeními";
    case "bundleMembershipMismatch":
      return "nesoulad mezi svazkem a jeho kabely";
  }
}

/**
 * A Czech sentence for one inconsistency, naming the objects when `project` (the project the
 * issue was found in) knows them, e.g. "Port se dvěma kabely (Fa0/1 na zařízení SW1)."
 */
export function issueSentence(issue: ProjectIssue, project?: Project): string {
  const phrase = describeIssue(issue);
  const detail = project ? issueDetail(issue, project) : undefined;
  return phrase.charAt(0).toUpperCase() + phrase.slice(1) + (detail ? ` (${detail})` : "") + ".";
}

function issueDetail(issue: ProjectIssue, project: Project): string | undefined {
  const hostnames = (linkID: string): string | undefined => {
    const link = findLink(project, linkID);
    if (!link) return undefined;
    const a = findDevice(project, link.a.deviceID)?.hostname ?? "?";
    const b = findDevice(project, link.b.deviceID)?.hostname ?? "?";
    return a === b ? a : `${a} – ${b}`;
  };
  const bundleLabel = (bundleID: string): string | undefined => {
    const label = findBundle(project, bundleID)?.label;
    return label ? `svazek ${label}` : undefined;
  };
  switch (issue.kind) {
    case "duplicateID":
      return issue.id;
    case "danglingPortRef": {
      const link = findLink(project, issue.linkID);
      const near = link ? findDevice(project, linkRef(link, issue.end === "a" ? "b" : "a").deviceID) : undefined;
      return near ? `kabel ze zařízení ${near.hostname}` : undefined;
    }
    case "linkWithinDevice":
      return hostnames(issue.linkID);
    case "portUsedTwice": {
      const resolved = resolveRef(project, issue.ref);
      return resolved ? `${resolved.port.name} na zařízení ${resolved.device.hostname}` : undefined;
    }
    case "bundleMissingLink":
    case "bundleTooSmall":
    case "bundleNotParallel":
      return bundleLabel(issue.bundleID);
    case "bundleMembershipMismatch":
      return hostnames(issue.linkID);
  }
}

/**
 * The message the Swift app shows after repairing a file: "Při otevření bylo opraveno
 * 3 nekonzistence (port se dvěma kabely, ...). Chybné objekty byly vynechány; ..."
 * Empty for no issues.
 */
export function repairSummary(issues: readonly ProjectIssue[]): string {
  if (issues.length === 0) return "";
  const kinds: string[] = [];
  for (const issue of issues) {
    const text = describeIssue(issue);
    if (!kinds.includes(text)) kinds.push(text);
  }
  return (
    `Při otevření bylo opraveno ${issues.length} ` +
    czechPlural(issues.length, "nekonzistence", "nekonzistence", "nekonzistencí") +
    ` (${kinds.join(", ")}). ` +
    "Chybné objekty byly vynechány; původní soubor se změní až po uložení."
  );
}
