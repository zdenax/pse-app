// State and validation of the custom-device editor (DeviceEditorModel in DeviceEditorView.swift).

import type { ConnectorType, DeviceCategory, DeviceTemplate } from "../core/model";
import { isPlaceholder, portNames as namesOfGroup } from "../core/port-group";
import { resolveTemplate, type CatalogTemplate } from "../core/template";
import { trimWhitespaceAndNewlines } from "../core/util";
import { portsText } from "./czech";

/** Upper bound for the number of ports of one device; anything above is almost certainly a typo. */
export const maxPorts = 256;

export const speedPresets = ["", "10M", "100M", "1G", "2.5G", "5G", "10G", "25G", "40G", "100G"];

export type GroupMode = "range" | "names" | "placeholder";

/** What the editor was opened for. */
export type DeviceEditorRequest =
  | { kind: "new" }
  | { kind: "edit"; template: DeviceTemplate }
  | { kind: "duplicate"; template: DeviceTemplate };

/** Editable form of one port group. */
export interface PortGroupDraft {
  /** Stable key for React lists. */
  key: number;
  mode: GroupMode;
  prefix: string;
  from: number;
  to: number;
  namesText: string;
  speed: string;
  connector: ConnectorType;
  // Carried over untouched from an existing group; the editor has no controls for them.
  step: number;
  suffix: string;
  label?: string;
}

export interface DeviceDraft {
  model: string;
  vendor: string;
  category: DeviceCategory;
  note: string;
  verified: boolean;
  groups: PortGroupDraft[];
  /** The template changed in place; undefined when a new one is created. */
  original?: DeviceTemplate;
}

let nextKey = 1;

export function newGroupDraft(partial: Partial<PortGroupDraft> = {}): PortGroupDraft {
  return {
    key: nextKey++,
    mode: "range",
    prefix: "Gi0/",
    from: 1,
    to: 8,
    namesText: "",
    speed: "1G",
    connector: "RJ45",
    step: 1,
    suffix: "",
    ...partial,
  };
}

/** Names typed in the "names" mode, trimmed, empty entries dropped. */
export function explicitNames(group: PortGroupDraft): string[] {
  return group.namesText
    .split(/[,;\n]/)
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

function draftFromTemplate(template: DeviceTemplate): PortGroupDraft[] {
  return template.portGroups.map((group) => {
    const placeholder = isPlaceholder(group);
    const mode: GroupMode = placeholder ? "placeholder" : group.names ? "names" : "range";
    const draft = newGroupDraft({
      mode,
      prefix: group.prefix ?? "",
      from: group.rangeStart ?? 1,
      to: group.rangeEnd ?? group.rangeStart ?? 1,
      namesText: group.names ? group.names.join(", ") : "",
      speed: group.speed,
      connector: group.connector,
      step: Math.max(1, group.step ?? 1),
      suffix: group.suffix ?? "",
    });
    if (group.label !== undefined) draft.label = group.label;
    return draft;
  });
}

export function makeDraft(request: DeviceEditorRequest): DeviceDraft {
  if (request.kind === "new") {
    return {
      model: "",
      vendor: "",
      category: "switch",
      note: "",
      verified: false,
      groups: [
        newGroupDraft({ prefix: "Gi0/", from: 1, to: 24 }),
        newGroupDraft({ mode: "names", namesText: "Console", speed: "", connector: "console" }),
      ],
    };
  }
  const template = request.template;
  const draft: DeviceDraft = {
    model: template.model,
    vendor: template.vendor,
    category: template.category,
    note: template.note ?? "",
    verified: template.verified === true && template.portGroups.every((group) => group.verified === true),
    groups: draftFromTemplate(template),
  };
  if (request.kind === "edit") {
    draft.original = template;
  } else {
    draft.model = template.model + (template.isCustom ? " (kopie)" : " (vlastní)");
    draft.verified = false;
  }
  return draft;
}

/** A new numbered range that continues after the last one, so it does not collide with it. */
export function nextRangeGroup(draft: DeviceDraft): PortGroupDraft {
  const last = [...draft.groups].reverse().find((group) => group.mode === "range");
  if (!last) return newGroupDraft();
  return newGroupDraft({ prefix: last.prefix, from: last.to + 1, to: last.to + 4, speed: last.speed, connector: last.connector });
}

/** An empty list of explicitly named ports. */
export function newNamedGroup(): PortGroupDraft {
  return newGroupDraft({ mode: "names", namesText: "", speed: "", connector: "console" });
}

/** The port group the draft stands for. */
function toPortGroup(group: PortGroupDraft, verified: boolean): DeviceTemplate["portGroups"][number] {
  switch (group.mode) {
    case "placeholder":
      return { speed: "", connector: group.connector, verified, label: group.label ?? "", placeholder: true, names: [] };
    case "names": {
      const result: DeviceTemplate["portGroups"][number] = {
        names: explicitNames(group),
        speed: group.speed,
        connector: group.connector,
        verified,
      };
      if (group.label !== undefined) result.label = group.label;
      return result;
    }
    case "range": {
      const result: DeviceTemplate["portGroups"][number] = {
        prefix: group.prefix,
        rangeStart: Math.min(group.from, group.to),
        rangeEnd: Math.max(group.from, group.to),
        step: group.step,
        suffix: group.suffix,
        speed: group.speed,
        connector: group.connector,
        verified,
      };
      if (group.label !== undefined) result.label = group.label;
      return result;
    }
  }
}

/** Generated port names of one row; empty when the row is invalid. */
export function groupPortNames(group: PortGroupDraft): string[] {
  switch (group.mode) {
    case "placeholder":
      return [];
    case "names":
      return explicitNames(group);
    case "range":
      if (group.from > group.to || group.from < 0 || group.to - group.from >= maxPorts * Math.max(1, group.step)) return [];
      return namesOfGroup(toPortGroup(group, false));
  }
}

/** "Fa0/1 … Fa0/24, 24 portů" */
export function groupPreview(group: PortGroupDraft): string {
  if (group.mode === "placeholder") return "Prázdná pozice pro modul, bez portů";
  const names = groupPortNames(group);
  if (names.length === 0) return "žádné porty";
  const first = names[0];
  const last = names[names.length - 1];
  const list = names.length === 1 ? first : names.length === 2 ? `${first}, ${last}` : `${first} … ${last}`;
  return `${list}, ${portsText(names.length)}`;
}

/** What is wrong with this row alone; null when it is fine. */
export function groupProblem(group: PortGroupDraft): string | null {
  switch (group.mode) {
    case "placeholder":
      return null;
    case "names":
      return explicitNames(group).length === 0 ? "Zadejte alespoň jeden název portu." : null;
    case "range":
      if (!Number.isInteger(group.from) || !Number.isInteger(group.to)) return "Zadejte celá čísla „od“ a „do“.";
      if (group.from < 0 || group.to < 0) return "Čísla portů nesmí být záporná.";
      if (group.from > group.to) return "Rozsah „od“ musí být menší nebo roven „do“.";
      if (group.to - group.from >= maxPorts * Math.max(1, group.step)) {
        return `Rozsah je příliš velký (nejvýše ${maxPorts} portů).`;
      }
      return null;
  }
}

export function totalPorts(draft: DeviceDraft): number {
  return draft.groups.reduce((sum, group) => sum + groupPortNames(group).length, 0);
}

/** Port names that occur more than once across all groups. */
export function duplicateNames(draft: DeviceDraft): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const name of draft.groups.flatMap(groupPortNames)) {
    if (seen.has(name) && !duplicates.includes(name)) duplicates.push(name);
    seen.add(name);
  }
  return duplicates;
}

/** Everything that blocks saving, in the order the user should fix it. */
export function draftProblems(draft: DeviceDraft): string[] {
  const result: string[] = [];
  if (trimWhitespaceAndNewlines(draft.model) === "") result.push("Vyplňte název modelu.");
  draft.groups.forEach((group, index) => {
    const problem = groupProblem(group);
    if (problem) result.push(`Skupina ${index + 1}: ${problem}`);
  });
  if (result.length === 0) {
    const total = totalPorts(draft);
    if (total === 0) result.push("Zařízení musí mít alespoň jeden port.");
    else if (total > maxPorts) result.push(`Zařízení má ${total} portů, nejvýše je povoleno ${maxPorts}.`);
  }
  const duplicates = duplicateNames(draft);
  if (duplicates.length > 0) {
    const shown = duplicates.slice(0, 4).join(", ");
    result.push(`Názvy portů se opakují: ${shown}${duplicates.length > 4 ? " …" : ""}.`);
  }
  return result;
}

/** The template to store. `newID` is used when a new entry is created. */
export function draftTemplate(draft: DeviceDraft, newID: string): CatalogTemplate {
  const portGroups = draft.groups.map((group) => toPortGroup(group, draft.verified));
  // Keep a hand-tuned panel layout only while the ports themselves are unchanged.
  const original = draft.original;
  const keepLayout =
    original !== undefined &&
    original.portGroups.length === portGroups.length &&
    original.portGroups.every((group, index) => sameNames(namesOfGroup(group), namesOfGroup(portGroups[index])));
  const note = draft.note.trim();
  const template: DeviceTemplate = {
    id: original?.id ?? newID,
    vendor: draft.vendor.trim(),
    model: draft.model.trim(),
    category: draft.category,
    portGroups,
    verified: draft.verified,
    isCustom: true,
  };
  if (keepLayout && original?.layout) template.layout = original.layout;
  if (note !== "") template.note = note;
  return resolveTemplate(template, true);
}

function sameNames(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}
