// Value lists and small behaviours of the model enums (Enums.swift, PanelLayout.swift).

import type {
  CableType,
  ConnectorType,
  DeviceCategory,
  LinkEnd,
  LinkStatus,
  PortArrangement,
  ViewMode,
} from "./model";

export const connectorTypes: readonly ConnectorType[] = ["RJ45", "SFP", "SFP+", "QSFP+", "console", "mgmt", "wireless"];

/** In palette order (Swift `DeviceCategory.allCases`). */
export const deviceCategories: readonly DeviceCategory[] = ["switch", "router", "L3 switch", "AP", "PC", "server", "patch panel"];

export const cableTypes: readonly CableType[] = ["straight", "crossover", "console", "fiber"];

export const linkStatuses: readonly LinkStatus[] = ["none", "green", "orange", "red"];

export const linkEnds: readonly LinkEnd[] = ["a", "b"];

export const viewModes: readonly ViewMode[] = ["physical", "logical"];

export const portArrangements: readonly PortArrangement[] = [
  "singleRow",
  "oddTopEvenBottom",
  "evenTopOddBottom",
  "topRowThenBottomRow",
];

/** True for pluggable cages (SFP, SFP+, QSFP+). */
export function isModularConnector(connector: ConnectorType): boolean {
  return connector === "SFP" || connector === "SFP+" || connector === "QSFP+";
}

/** False for wireless interfaces, which have no jack on the panel. */
export function isPhysicalConnector(connector: ConnectorType): boolean {
  return connector !== "wireless";
}

/**
 * Prefix of automatically generated hostnames ("SW1", "R1", "AP1", "PC1", "SRV1", "PP1").
 * L2 and L3 switches share the "SW" numbering.
 */
export function hostnamePrefix(category: DeviceCategory): string {
  switch (category) {
    case "switch":
    case "L3 switch":
      return "SW";
    case "router":
      return "R";
    case "AP":
      return "AP";
    case "PC":
      return "PC";
    case "server":
      return "SRV";
    case "patch panel":
      return "PP";
  }
}

/** The next status in the manual cycle none -> green -> orange -> red -> none. */
export function nextLinkStatus(status: LinkStatus): LinkStatus {
  switch (status) {
    case "none":
      return "green";
    case "green":
      return "orange";
    case "orange":
      return "red";
    case "red":
      return "none";
  }
}

export function oppositeEnd(end: LinkEnd): LinkEnd {
  return end === "a" ? "b" : "a";
}

/** True for the arrangements that need two port rows. */
export function usesTwoRows(arrangement: PortArrangement): boolean {
  return arrangement !== "singleRow";
}
