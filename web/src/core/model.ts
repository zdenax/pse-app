// The NetSketch data model, exactly as it is stored in .netsketch files (JSON) and in the
// device catalog (devices.json). It mirrors the Swift module NetSketchCore, so both apps open
// the same files. Field names and enum raw values must not change.
//
// Decoding is lenient like in Swift: optional fields may be missing in a file and then take the
// defaults documented here (see project-io.ts, which fills them in).

export type ConnectorType = "RJ45" | "SFP" | "SFP+" | "QSFP+" | "console" | "mgmt" | "wireless";

export type DeviceCategory = "switch" | "router" | "L3 switch" | "AP" | "PC" | "server";

export type CableType = "straight" | "crossover" | "console" | "fiber";

/** Colour of the status dot at one end of a link; toggled manually, never computed. */
export type LinkStatus = "none" | "green" | "orange" | "red";

export type LinkEnd = "a" | "b";

export type ViewMode = "physical" | "logical";

export type PortArrangement = "singleRow" | "oddTopEvenBottom" | "evenTopOddBottom" | "topRowThenBottomRow";

export interface Point {
  x: number;
  y: number;
}

export interface Port {
  /** UUID string (upper case, as Foundation writes it). */
  id: string;
  /** Full interface name, e.g. "Fa0/1" or "GigabitEthernet 1/1". */
  name: string;
  connector: ConnectorType;
  /** Nominal speed ("100M", "1G", ...); "" when not applicable. Default "". */
  speed: string;
  /** Default false. */
  verified: boolean;
  /** Default "". */
  description: string;
  /** Canonical switchport text written by the consoles (see cli/switchport.ts). Default "". */
  vlan: string;
  /** Index of the template port group this port came from. Default 0. */
  groupIndex: number;
  /** Administratively shut down. Default false. */
  adminDown: boolean;
}

export interface VLANEntry {
  id: number;
  /** Default "". */
  name: string;
}

/** "port:<UUID>" for a physical port, "vlan:<N>" for a VLAN interface (SVI / MikroTik bridge). */
export type L3InterfaceID = string;

export interface InterfaceAddress {
  interface: L3InterfaceID;
  /** CIDR, e.g. "192.168.1.1/24". */
  address: string;
}

export interface StaticRoute {
  /** CIDR network, e.g. "10.0.2.0/24" or "0.0.0.0/0". */
  destination: string;
  nextHop: string;
}

export interface PanelSection {
  /** Indices into the template's port groups. In files also `group` (a single index). */
  groups: number[];
  /** Default "singleRow". */
  arrangement: PortArrangement;
  /** Row of a single-row section in a multi-row panel. Optional. */
  row?: number;
  /** Gap after every N columns. Optional. */
  blockColumns?: number;
  /** Caption above the section. Optional. */
  label?: string;
  /** Width (in cells) of a placeholder bay. Optional. */
  placeholderWidth?: number;
}

export interface PanelLayout {
  /** Default 2. */
  rows: number;
  /** Default []: an automatic layout is used. */
  sections: PanelSection[];
}

export interface Device {
  id: string;
  /** Slug of the catalog template. Default "". */
  templateID: string;
  vendor: string;
  model: string;
  category: DeviceCategory;
  hostname: string;
  /** Centre of the device in canvas coordinates. */
  position: Point;
  ports: Port[];
  /** Default "". */
  note: string;
  /** Snapshot of the template's normalized panel layout. */
  layout: PanelLayout;
  /** Default false. */
  verified: boolean;
  /** VLAN table edited through the consoles. Default []. */
  vlans: VLANEntry[];
  /** IPv4 addresses of layer-3 interfaces. Default []; written only when not empty. */
  addresses: InterfaceAddress[];
  /** Default gateway of a PC, server or switch. Default ""; written only when not empty. */
  defaultGateway: string;
  /** Static routes. Default []; written only when not empty. */
  staticRoutes: StaticRoute[];
}

export interface PortRef {
  deviceID: string;
  portID: string;
}

export interface Link {
  id: string;
  a: PortRef;
  b: PortRef;
  cableType: CableType;
  statusA: LinkStatus;
  statusB: LinkStatus;
  /** Default "". */
  note: string;
  /** The bundle (LAG) the link belongs to. Optional. */
  bundleID?: string;
}

export interface LinkBundle {
  id: string;
  label: string;
  linkIDs: string[];
}

export interface Annotation {
  id: string;
  text: string;
  /** Top-left corner of the text. */
  position: Point;
}

export interface Project {
  /** Current format version is 1; newer files are refused. */
  formatVersion: number;
  name: string;
  devices: Device[];
  links: Link[];
  bundles: LinkBundle[];
  annotations: Annotation[];
  viewMode: ViewMode;
}

// MARK: Catalog (devices.json)

export interface PortGroup {
  /** Generated names: prefix + number + suffix for rangeStart...rangeEnd (by step). */
  prefix?: string;
  rangeStart?: number;
  rangeEnd?: number;
  /** Default 1. */
  step?: number;
  suffix?: string;
  /** Explicit names instead of a range. */
  names?: string[];
  speed: string;
  connector: ConnectorType;
  verified?: boolean;
  label?: string;
  /** An empty module bay: no ports, only room on the panel. */
  placeholder?: boolean;
}

export interface DeviceTemplate {
  id: string;
  vendor: string;
  model: string;
  category: DeviceCategory;
  portGroups: PortGroup[];
  layout?: PanelLayout;
  verified?: boolean;
  note?: string;
  isCustom?: boolean;
}

export interface CatalogFile {
  formatVersion?: number;
  templates: DeviceTemplate[];
}

export const projectFormatVersion = 1;
