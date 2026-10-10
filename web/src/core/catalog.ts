// The device catalog: built-in templates plus the user's custom templates (DeviceCatalog.swift).
//
// Sources (all JSON, `{"formatVersion": 1, "templates": [...]}`; a bare array is accepted too):
// - built-in: devices.json shared with the Swift app (Sources/NetSketchCore/Resources);
// - override: optional text that REPLACES the built-in file when it is valid;
// - custom: optional storage written by `addCustom` / `updateCustom` / `removeCustom`.
//
// The core never touches browser storage itself; the UI injects a storage (e.g. localStorage).

import bundledCatalog from "../../../Sources/NetSketchCore/Resources/devices.json";
import { connectorTypes, deviceCategories } from "./enums";
import { CatalogError } from "./errors";
import {
  DecodeError,
  optional,
  parseJSON,
  readArray,
  readBool,
  readEnum,
  readInt,
  readObject,
  readString,
  required,
  type Reader,
} from "./json-decode";
import { writeJSON, type JSONObject } from "./json-writer";
import type { DeviceCategory, DeviceTemplate, PortGroup } from "./model";
import { panelLayoutJSON, readPanelLayout } from "./project-io";
import type { CatalogAPI } from "./store-api";
import { makeTemplate, resolveTemplate, templateSlug, type CatalogTemplate } from "./template";
import { resolvePortGroup, type CatalogPortGroup } from "./port-group";
import { trimWhitespace, trimWhitespaceAndNewlines } from "./util";

/** Version written into catalog files. */
export const catalogFileFormatVersion = 1;

/** Text storage of the custom templates (the UI passes a localStorage adapter). */
export interface CatalogStorage {
  /** The stored text, or null when nothing is stored yet. */
  load(): string | null;
  /** Replaces the stored text; may throw (then the catalog stays unchanged). */
  save(text: string): void;
  /** Keeps an unreadable stored text before it is overwritten (optional). */
  backup?(text: string): void;
}

/** Where the built-in templates came from. */
export type BuiltInSource = "bundle" | "override" | "provided";

export interface CatalogOptions {
  /** Persistence of the custom templates; without it they live in memory only. */
  storage?: CatalogStorage | null;
  /** A catalog text that replaces the bundled devices.json when it is valid. */
  override?: Pick<CatalogStorage, "load"> | null;
  /** Explicit built-in templates (tests, previews); nothing is loaded then. */
  builtIn?: DeviceTemplate[];
  /** Explicit custom templates, used together with `builtIn`. */
  custom?: DeviceTemplate[];
}

/** The templates of one category, for the device palette. */
export interface TemplateGroup {
  category: DeviceCategory;
  templates: CatalogTemplate[];
}

export class Catalog implements CatalogAPI {
  private _builtIn: CatalogTemplate[] = [];
  private _custom: CatalogTemplate[] = [];
  private _builtInSource: BuiltInSource = "bundle";
  private _loadIssues: string[] = [];
  private _version = 0;
  private readonly listeners = new Set<() => void>();
  private readonly storage: CatalogStorage | null;
  private readonly override: Pick<CatalogStorage, "load"> | null;
  /** The custom text that could not be read; kept as a backup before it is overwritten. */
  private unreadableCustomText: string | null = null;
  private cachedTemplates: CatalogTemplate[] | null = null;
  private cachedGroups: TemplateGroup[] | null = null;

  /**
   * Loads the bundled catalog (or the override) and the stored custom templates.
   * With `builtIn` the catalog holds exactly the given templates and reads nothing.
   */
  constructor(options: CatalogOptions = {}) {
    this.storage = options.storage ?? null;
    this.override = options.override ?? null;
    if (options.builtIn) {
      this._builtIn = options.builtIn.map((template) => resolveTemplate(template, false));
      this._custom = (options.custom ?? []).map((template) => resolveTemplate(template, true));
      this._builtInSource = "provided";
    } else {
      this.reload();
    }
  }

  // MARK: Observation

  /** Increases with every change (for useSyncExternalStore). */
  get version(): number {
    return this._version;
  }

  /** Calls `listener` after every change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    this.cachedTemplates = null;
    this.cachedGroups = null;
    this._version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  // MARK: Lookup

  /** Built-in (or override) templates, in file order. */
  get builtIn(): CatalogTemplate[] {
    return this._builtIn;
  }

  /** User templates, in the order they were added. */
  get custom(): CatalogTemplate[] {
    return this._custom;
  }

  get builtInSource(): BuiltInSource {
    return this._builtInSource;
  }

  /** Problems met while loading (unreadable override or custom text, duplicate ids), in Czech. */
  get loadIssues(): string[] {
    return this._loadIssues;
  }

  /** Built-in templates followed by custom ones. */
  get templates(): CatalogTemplate[] {
    this.cachedTemplates ??= [...this._builtIn, ...this._custom];
    return this.cachedTemplates;
  }

  template(id: string): CatalogTemplate | undefined {
    return this._builtIn.find((template) => template.id === id) ?? this._custom.find((template) => template.id === id);
  }

  templatesIn(category: DeviceCategory): CatalogTemplate[] {
    return this.templates.filter((template) => template.category === category);
  }

  /** Templates grouped by category in palette order; empty categories are omitted. */
  get groups(): TemplateGroup[] {
    this.cachedGroups ??= deviceCategories.flatMap((category) => {
      const templates = this.templatesIn(category);
      return templates.length === 0 ? [] : [{ category, templates }];
    });
    return this.cachedGroups;
  }

  /** An id derived from vendor and model that no template uses yet ("acme-x1", "acme-x1-2", ...). */
  uniqueID(vendor: string, model: string): string {
    const base = templateSlug(vendor, model);
    let candidate = base;
    let counter = 2;
    while (this.template(candidate) !== undefined) {
      candidate = `${base}-${counter}`;
      counter += 1;
    }
    return candidate;
  }

  // MARK: Loading

  /** Re-reads the built-in catalog (override first, bundle otherwise) and the custom templates. */
  reload(): void {
    const issues: string[] = [];
    let loaded: CatalogTemplate[] | null = null;
    let source: BuiltInSource = "bundle";

    if (this.override) {
      try {
        const text = this.override.load();
        if (text !== null) {
          loaded = decodeTemplates(text);
          source = "override";
        }
      } catch (error) {
        issues.push(`Náhradní katalog zařízení nelze načíst, použije se vestavěný. Podrobnosti: ${detailOf(error)}`);
      }
    }
    if (loaded === null) {
      try {
        loaded = decodeTemplatesValue(bundledCatalog as unknown);
      } catch (error) {
        issues.push(`Vestavěný katalog zařízení (devices.json) nelze načíst. Podrobnosti: ${detailOf(error)}`);
      }
    }
    this._builtIn = unique(loaded ?? [], false, new Set(), issues);
    this._builtInSource = source;

    let customLoaded: CatalogTemplate[] = [];
    this.unreadableCustomText = null;
    if (this.storage) {
      let text: string | null = null;
      try {
        text = this.storage.load();
        if (text !== null) customLoaded = decodeTemplates(text);
      } catch (error) {
        this.unreadableCustomText = text;
        issues.push(`Uložená vlastní zařízení nelze načíst a byla vynechána. Podrobnosti: ${detailOf(error)}`);
      }
    }
    this._custom = unique(customLoaded, true, new Set(this._builtIn.map((template) => template.id)), issues);
    this._loadIssues = issues;
    this.changed();
  }

  /** Replaces the built-in templates with the contents of a catalog JSON text (throws `DecodeError`). */
  loadBuiltIn(text: string): void {
    const issues: string[] = [];
    this._builtIn = unique(decodeTemplates(text), false, new Set(), issues);
    this._builtInSource = "provided";
    this._custom = this._custom.filter((candidate) => !this._builtIn.some((template) => template.id === candidate.id));
    this._loadIssues = [...this._loadIssues, ...issues];
    this.changed();
  }

  // MARK: Custom templates

  /**
   * Adds a user template and saves the custom templates.
   *
   * The stored copy has `isCustom == true` and a normalized layout; an empty id is replaced
   * by `uniqueID(vendor, model)`. Throws `CatalogError` "duplicateID" when the id is taken and
   * "invalidTemplate" when the model name is empty; storage errors are rethrown.
   */
  addCustom(template: DeviceTemplate): CatalogTemplate {
    let entry = validated(template);
    if (trimWhitespace(entry.id) === "") entry = { ...entry, id: this.uniqueID(entry.vendor, entry.model) };
    if (this.template(entry.id) !== undefined) throw new CatalogError("duplicateID", entry.id);
    this.replaceCustom([...this._custom, entry]);
    return entry;
  }

  /**
   * Replaces the custom template with the same id and saves the custom templates.
   * Devices already placed keep their own snapshot and are not affected.
   */
  updateCustom(template: DeviceTemplate): CatalogTemplate {
    const entry = validated(template);
    const index = this._custom.findIndex((candidate) => candidate.id === entry.id);
    if (index < 0) throw this.missingCustom(entry.id);
    const updated = [...this._custom];
    updated[index] = entry;
    this.replaceCustom(updated);
    return entry;
  }

  /** Removes a custom template and saves the custom templates. */
  removeCustom(id: string): void {
    if (!this._custom.some((template) => template.id === id)) throw this.missingCustom(id);
    this.replaceCustom(this._custom.filter((template) => template.id !== id));
  }

  private missingCustom(id: string): CatalogError {
    return this._builtIn.some((template) => template.id === id)
      ? new CatalogError("notCustom", id)
      : new CatalogError("unknownTemplate", id);
  }

  /** Writes first, then publishes, so a failed save leaves the catalog unchanged. */
  private replaceCustom(updated: CatalogTemplate[]): void {
    if (this.storage) {
      if (this.unreadableCustomText !== null && this.storage.backup) {
        // Keep the user's unreadable text instead of silently overwriting it.
        this.storage.backup(this.unreadableCustomText);
      }
      this.storage.save(encodeTemplates(updated));
      this.unreadableCustomText = null;
    }
    this._custom = updated;
    this.changed();
  }
}

// MARK: Helpers

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validated(template: DeviceTemplate): CatalogTemplate {
  if (trimWhitespaceAndNewlines(template.model) === "") throw new CatalogError("invalidTemplate");
  return resolveTemplate(template, true);
}

/** Drops templates whose id is already taken (reporting them) and prepares the rest. */
function unique(
  templates: readonly DeviceTemplate[],
  isCustom: boolean,
  taken: Set<string>,
  issues: string[],
): CatalogTemplate[] {
  const seen = new Set(taken);
  const result: CatalogTemplate[] = [];
  for (const template of templates) {
    if (seen.has(template.id)) {
      issues.push(`Šablona zařízení s duplicitním identifikátorem „${template.id}“ byla vynechána.`);
      continue;
    }
    seen.add(template.id);
    result.push(resolveTemplate(template, isCustom));
  }
  return result;
}

// MARK: Catalog JSON

const readPortGroup: Reader<PortGroup> = (value, path) => {
  const c = readObject(value, path);
  const names = optional(c, "names", path, readArray(readString));
  const rangeStart = optional(c, "rangeStart", path, readInt) ?? 1;
  const group: PortGroup = {
    prefix: optional(c, "prefix", path, readString) ?? "",
    rangeStart,
    rangeEnd: optional(c, "rangeEnd", path, readInt) ?? (names ? Math.max(1, names.length) : rangeStart),
    step: Math.max(1, optional(c, "step", path, readInt) ?? 1),
    suffix: optional(c, "suffix", path, readString) ?? "",
    speed: optional(c, "speed", path, readString) ?? "",
    connector: required(c, "connector", path, readEnum(connectorTypes)),
    verified: optional(c, "verified", path, readBool) ?? false,
    placeholder: optional(c, "placeholder", path, readBool) ?? false,
  };
  if (names !== undefined) group.names = names;
  const label = optional(c, "label", path, readString);
  if (label !== undefined) group.label = label;
  return group;
};

/** A template; the id is derived from vendor and model when missing. */
const readTemplate: Reader<CatalogTemplate> = (value, path) => {
  const c = readObject(value, path);
  const vendor = optional(c, "vendor", path, readString) ?? "";
  const model = required(c, "model", path, readString);
  const portGroups = optional(c, "portGroups", path, readArray(readPortGroup)) ?? [];
  const id = optional(c, "id", path, readString);
  const category = required(c, "category", path, readEnum(deviceCategories));
  const layout = optional(c, "layout", path, readPanelLayout);
  const verified = optional(c, "verified", path, readBool) ?? false;
  const note = optional(c, "note", path, readString);
  const isCustom = optional(c, "isCustom", path, readBool) ?? false;
  return makeTemplate({ id, vendor, model, category, portGroups, layout, verified, note, isCustom });
};

const readCatalogFile: Reader<CatalogTemplate[]> = (value, path) => {
  const c = readObject(value, path);
  optional(c, "formatVersion", path, readInt);
  return required(c, "templates", path, readArray(readTemplate));
};

/** Decodes templates from a parsed catalog document (`{"templates": [...]}` or a bare array). */
export function decodeTemplatesValue(value: unknown): CatalogTemplate[] {
  try {
    return readCatalogFile(value, []);
  } catch (error) {
    if (error instanceof DecodeError && Array.isArray(value)) {
      try {
        return readArray(readTemplate)(value, []);
      } catch {
        // Report the error of the wrapped form, like Swift.
      }
    }
    throw error;
  }
}

/** Decodes templates from catalog JSON text; throws `DecodeError` (with a Czech message). */
export function decodeTemplates(text: string): CatalogTemplate[] {
  return decodeTemplatesValue(parseJSON(text));
}

/** Encodes templates as a catalog JSON document (pretty-printed, sorted keys, like Swift). */
export function encodeTemplates(templates: readonly DeviceTemplate[]): string {
  return writeJSON({
    formatVersion: catalogFileFormatVersion,
    templates: templates.map((template) => templateJSON(resolveTemplate(template))),
  });
}

function templateJSON(template: CatalogTemplate): JSONObject {
  return {
    id: template.id,
    vendor: template.vendor,
    model: template.model,
    category: template.category,
    portGroups: template.portGroups.map(portGroupJSON),
    layout: panelLayoutJSON(template.layout),
    verified: template.verified,
    note: template.note,
    isCustom: template.isCustom,
  };
}

/** `step` only when not 1, `suffix` only when not empty, `placeholder` only when true. */
function portGroupJSON(group: CatalogPortGroup): JSONObject {
  const resolved = resolvePortGroup(group);
  return {
    prefix: resolved.prefix,
    rangeStart: resolved.rangeStart,
    rangeEnd: resolved.rangeEnd,
    step: resolved.step !== 1 ? resolved.step : undefined,
    suffix: resolved.suffix !== "" ? resolved.suffix : undefined,
    names: resolved.names ? [...resolved.names] : undefined,
    speed: resolved.speed,
    connector: resolved.connector,
    verified: resolved.verified,
    label: resolved.label,
    placeholder: resolved.placeholder ? true : undefined,
  };
}
