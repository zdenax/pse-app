// A run of similar ports on a device template, e.g. "Fa0/1 ... Fa0/24" (PortGroup.swift).
//
// Port names are `prefix + number + suffix` for every `step`-th number in
// `rangeStart...rangeEnd`, unless explicit `names` are given (they win).
// A placeholder group has no ports at all; it only reserves an empty slot on
// the front panel (e.g. an unpopulated NIM bay).

import type { ConnectorType, PortGroup } from "./model";

/**
 * A port group with every default filled in, as the Swift struct holds it after decoding.
 * The catalog keeps its templates in this form.
 */
export interface CatalogPortGroup extends PortGroup {
  prefix: string;
  rangeStart: number;
  rangeEnd: number;
  step: number;
  suffix: string;
  verified: boolean;
  placeholder: boolean;
}

/** A numbered group: `prefix + n + suffix` for n in `rangeStart...rangeEnd` (every `step`-th). */
export function numberedGroup(options: {
  prefix: string;
  rangeStart: number;
  rangeEnd: number;
  step?: number;
  suffix?: string;
  speed: string;
  connector: ConnectorType;
  verified?: boolean;
  label?: string;
}): CatalogPortGroup {
  const group: CatalogPortGroup = {
    prefix: options.prefix,
    rangeStart: options.rangeStart,
    rangeEnd: options.rangeEnd,
    step: Math.max(1, options.step ?? 1),
    suffix: options.suffix ?? "",
    speed: options.speed,
    connector: options.connector,
    verified: options.verified ?? false,
    placeholder: false,
  };
  if (options.label !== undefined) group.label = options.label;
  return group;
}

/** A group of explicitly named ports, e.g. `["Console"]` or `["WAN", "WAN SFP+"]`. */
export function namedGroup(
  names: string[],
  speed: string,
  connector: ConnectorType,
  verified = false,
  label?: string,
): CatalogPortGroup {
  const group: CatalogPortGroup = {
    prefix: "",
    rangeStart: 1,
    rangeEnd: Math.max(1, names.length),
    step: 1,
    suffix: "",
    names: [...names],
    speed,
    connector,
    verified,
    placeholder: false,
  };
  if (label !== undefined) group.label = label;
  return group;
}

/** An empty module bay that only reserves space on the panel. */
export function placeholderGroup(label: string, connector: ConnectorType = "RJ45", verified = false): CatalogPortGroup {
  return { ...namedGroup([], "", connector, verified, label), placeholder: true };
}

/** The group with every missing field set to its default (the Swift decoding rules). */
export function resolvePortGroup(group: PortGroup): CatalogPortGroup {
  const rangeStart = group.rangeStart ?? 1;
  const resolved: CatalogPortGroup = {
    prefix: group.prefix ?? "",
    rangeStart,
    rangeEnd: group.rangeEnd ?? (group.names ? Math.max(1, group.names.length) : rangeStart),
    step: Math.max(1, group.step ?? 1),
    suffix: group.suffix ?? "",
    speed: group.speed ?? "",
    connector: group.connector,
    verified: group.verified ?? false,
    placeholder: group.placeholder ?? false,
  };
  if (group.names !== undefined) resolved.names = [...group.names];
  if (group.label !== undefined) resolved.label = group.label;
  return resolved;
}

/** True for an empty module bay: it generates no ports, only reserves panel space. */
export function isPlaceholder(group: PortGroup): boolean {
  return group.placeholder === true;
}

/** Generated port names, in panel order. Empty for a placeholder. */
export function portNames(group: PortGroup): string[] {
  if (isPlaceholder(group)) return [];
  if (group.names) return [...group.names];
  const { prefix, rangeStart, rangeEnd, step, suffix } = resolvePortGroup(group);
  const names: string[] = [];
  for (let number = rangeStart; number <= rangeEnd; number += step) {
    names.push(prefix + String(number) + suffix);
  }
  return names;
}

/** Number of ports the group generates. */
export function portCount(group: PortGroup): number {
  return portNames(group).length;
}
