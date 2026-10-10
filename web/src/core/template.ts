// A catalog entry: a device model with its port groups and front-panel layout
// (DeviceTemplate.swift).

import type { Device, DeviceTemplate, PanelLayout, Point, Port, PortGroup } from "./model";
import { automaticLayout, normalizeLayout, panelGrid, type PanelGrid } from "./panel-layout";
import { portCount, portNames, resolvePortGroup, type CatalogPortGroup } from "./port-group";
import { newUUID, trimWhitespace } from "./util";

/**
 * A template with every default filled in and a normalized layout, as the Swift struct holds
 * it. The catalog keeps its templates in this form.
 */
export interface CatalogTemplate extends DeviceTemplate {
  portGroups: CatalogPortGroup[];
  layout: PanelLayout;
  verified: boolean;
  isCustom: boolean;
}

/** What `makeTemplate` needs; everything but vendor, model, category and port groups is optional. */
export type TemplateInput = Omit<DeviceTemplate, "id"> & { id?: string };

/**
 * A new template (the Swift initializer).
 *
 * `id` is derived from vendor and model when missing or blank; `layout` is derived from the
 * port groups when missing and normalized either way.
 */
export function makeTemplate(input: TemplateInput): CatalogTemplate {
  const given = trimWhitespace(input.id ?? "");
  return resolveTemplate({ ...input, id: given === "" ? templateSlug(input.vendor, input.model) : given });
}

/**
 * The template with every missing field set to its default and its layout normalized.
 * The id is kept as it is (see `makeTemplate` for the derived one).
 */
export function resolveTemplate(template: DeviceTemplate, isCustom?: boolean): CatalogTemplate {
  const portGroups = template.portGroups.map(resolvePortGroup);
  const result: CatalogTemplate = {
    id: template.id,
    vendor: template.vendor,
    model: template.model,
    category: template.category,
    portGroups,
    layout: normalizeLayout(template.layout ?? automaticLayout(portGroups), portGroups),
    verified: template.verified ?? false,
    isCustom: isCustom ?? template.isCustom ?? false,
  };
  if (template.note !== undefined) result.note = template.note;
  return result;
}

/** "Vendor Model". */
export function templateDisplayName(template: Pick<DeviceTemplate, "vendor" | "model">): string {
  return [template.vendor, template.model].filter((part) => part !== "").join(" ");
}

/** Total number of ports. */
export function templatePortCount(template: Pick<DeviceTemplate, "portGroups">): number {
  return template.portGroups.reduce((sum, group) => sum + portCount(group), 0);
}

/**
 * True when the template or any of its port groups is still unverified
 * (the UI shows the "ověřit podle hardwaru" warning).
 */
export function templateNeedsVerification(template: DeviceTemplate): boolean {
  return template.verified !== true || template.portGroups.some((group) => group.verified !== true);
}

/** The template's layout made consistent with its port groups (derived when missing). */
export function templateLayout(template: Pick<DeviceTemplate, "portGroups" | "layout">): PanelLayout {
  return normalizeLayout(template.layout ?? automaticLayout(template.portGroups), template.portGroups);
}

/** Fresh ports (new UUIDs) for a new device, in group order. */
export function makePorts(template: Pick<DeviceTemplate, "portGroups">): Port[] {
  const ports: Port[] = [];
  template.portGroups.forEach((group: PortGroup, groupIndex) => {
    for (const name of portNames(group)) {
      ports.push({
        id: newUUID(),
        name,
        connector: group.connector,
        speed: group.speed ?? "",
        verified: group.verified ?? false,
        description: "",
        vlan: "",
        groupIndex,
        adminDown: false,
      });
    }
  });
  return ports;
}

/** A new device instance carrying a snapshot of this template's ports and layout. */
export function makeDevice(template: DeviceTemplate, hostname: string, position: Point): Device {
  return {
    id: newUUID(),
    templateID: template.id,
    vendor: template.vendor,
    model: template.model,
    category: template.category,
    hostname,
    position: { x: position.x, y: position.y },
    ports: makePorts(template),
    note: "",
    layout: templateLayout(template),
    verified: template.verified ?? false,
    vlans: [],
    addresses: [],
    defaultGateway: "",
    staticRoutes: [],
  };
}

/** Front panel of the template in cell units (for palette previews). */
export function templatePanelGrid(template: Pick<DeviceTemplate, "portGroups" | "layout">): PanelGrid {
  const indices: number[] = [];
  template.portGroups.forEach((group, groupIndex) => {
    for (let i = portCount(group); i > 0; i--) indices.push(groupIndex);
  });
  return panelGrid(templateLayout(template), indices);
}

/** Lowercase ASCII slug: "Dell EMC" + "S3048-ON" -> "dell-emc-s3048-on". */
export function templateSlug(vendor: string, model: string): string {
  const folded = `${vendor} ${model}`.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  let slug = "";
  let pendingDash = false;
  for (const char of folded) {
    const isAlphanumeric = (char >= "a" && char <= "z") || (char >= "0" && char <= "9");
    if (isAlphanumeric) {
      if (pendingDash && slug !== "") slug += "-";
      slug += char;
      pendingDash = false;
    } else {
      pendingDash = true;
    }
  }
  return slug === "" ? "device" : slug;
}
