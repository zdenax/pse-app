// The left-hand column: the device catalog grouped by category, with search.
// Rows are dragged onto the canvas; a double click (or Enter) adds the device at a free spot.
// Port of Sources/NetSketch/Views/PaletteView.swift.

import { memo, useMemo, useState, type DragEvent } from "react";
import type { DeviceCategory, DeviceTemplate } from "../core/model";
import {
  categoryName,
  categoryPlural,
  containsText,
  displayName,
  portSummary,
  portsText,
  templateNeedsVerification,
  templatePortCount,
  verifyHint,
} from "./czech";
import { Chip, VerifyBadge } from "./components";
import { DeviceIcon } from "./DeviceIcon";
import { Icon } from "./icons";
import { useApp, useMaybeObservable, useStore, useStoreVersion } from "./store-context";

/** dataTransfer type of a palette drag; the value is the template id. */
export const templateDragType = "application/x-netsketch-template";
/** Plain-text payload prefix, the same as the Mac app's (`netsketch-template:<id>`). */
export const templateDragPrefix = "netsketch-template:";

/** Reads the template id of a palette drag, if the drag is one. */
export function templateIDFromDrag(dataTransfer: DataTransfer): string | null {
  const id = dataTransfer.getData(templateDragType);
  if (id) return id;
  const text = dataTransfer.getData("text/plain");
  if (text.startsWith(templateDragPrefix) && text.length > templateDragPrefix.length) {
    return text.slice(templateDragPrefix.length);
  }
  return null;
}

export interface TemplateGroup {
  category: DeviceCategory;
  templates: DeviceTemplate[];
}

/** Groups narrowed down by a search query (category names match whole groups). */
export function filterGroups(groups: TemplateGroup[], searchText: string): TemplateGroup[] {
  const query = searchText.trim();
  if (query === "") return groups;
  const result: TemplateGroup[] = [];
  for (const group of groups) {
    const categoryMatches =
      containsText(categoryPlural(group.category), query) || containsText(categoryName(group.category), query);
    const members = categoryMatches
      ? group.templates
      : group.templates.filter(
          (template) =>
            containsText(template.model, query) ||
            containsText(template.vendor, query) ||
            containsText(template.id, query),
        );
    if (members.length > 0) result.push({ category: group.category, templates: members });
  }
  return result;
}

export interface VendorGroup {
  /** Empty when the template has no vendor. */
  vendor: string;
  categories: TemplateGroup[];
}

/** Vendors alphabetically (no vendor last), each with its templates grouped by category in palette order. */
export function groupByVendor(groups: TemplateGroup[]): VendorGroup[] {
  const byVendor = new Map<string, TemplateGroup[]>();
  for (const group of groups) {
    for (const template of group.templates) {
      const key = template.vendor.trim();
      const categories = byVendor.get(key) ?? [];
      const category = categories.find((entry) => entry.category === group.category);
      if (category) category.templates.push(template);
      else categories.push({ category: group.category, templates: [template] });
      byVendor.set(key, categories);
    }
  }
  return [...byVendor.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "cs")))
    .map(([vendor, categories]) => ({ vendor, categories }));
}

/** Vendors narrowed down by a search query (a vendor name matches the whole vendor). */
export function filterVendorGroups(groups: VendorGroup[], searchText: string): VendorGroup[] {
  const query = searchText.trim();
  if (query === "") return groups;
  const result: VendorGroup[] = [];
  for (const group of groups) {
    if (containsText(group.vendor, query)) {
      result.push(group);
      continue;
    }
    const categories = filterGroups(group.categories, searchText);
    if (categories.length > 0) result.push({ vendor: group.vendor, categories });
  }
  return result;
}

const noVendorTitle = "Bez výrobce";

export const Palette = memo(function Palette() {
  useStoreVersion();
  const store = useStore();
  const app = useApp();
  const [searchText, setSearchText] = useState("");
  // Keys: the vendor for a vendor section, "vendor/category" for a category inside it.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const catalog = store.catalog;
  // Custom templates can change the catalog without a project change.
  useMaybeObservable(catalog);
  const allGroups = catalog.groups;
  const vendorGroups = useMemo(() => groupByVendor(allGroups), [allGroups]);
  const groups = useMemo(() => filterVendorGroups(vendorGroups, searchText), [vendorGroups, searchText]);
  const isSearching = searchText.trim() !== "";

  const removeCustom = (template: DeviceTemplate) => {
    if (!window.confirm(`Smazat vlastní zařízení „${displayName(template.vendor, template.model)}“ z katalogu?\nZařízení už umístěná v projektu zůstanou.`)) return;
    try {
      catalog.removeCustom?.(template.id);
    } catch (error) {
      app.present(error, "Zařízení nelze smazat");
    }
  };

  const toggle = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <nav className="palette" aria-label="Paleta zařízení">
      <div className="search-field">
        <Icon name="search" size={15} />
        <input
          type="search"
          value={searchText}
          placeholder="Hledat zařízení"
          aria-label="Hledat zařízení"
          spellCheck={false}
          onChange={(event) => setSearchText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && searchText !== "") {
              event.preventDefault();
              setSearchText("");
            }
          }}
        />
        {searchText !== "" && (
          <button
            type="button"
            className="search-clear"
            title="Zrušit hledání"
            aria-label="Zrušit hledání"
            onClick={() => setSearchText("")}
          >
            <Icon name="clear" size={15} />
          </button>
        )}
      </div>

      <div className="palette-list">
        {groups.length === 0 && (
          <div className="palette-empty">
            <Icon name={catalog.templates.length === 0 ? "file" : "search"} size={26} />
            <span>{catalog.templates.length === 0 ? "Katalog je prázdný" : "Nic nenalezeno"}</span>
          </div>
        )}
        {groups.map((vendorGroup) => {
          const vendorKey = vendorGroup.vendor;
          const vendorCollapsed = collapsed.has(vendorKey) && !isSearching;
          const vendorListID = `palette-vendor-${vendorKey.replace(/\s+/g, "-") || "none"}`;
          const vendorCount = vendorGroup.categories.reduce((sum, entry) => sum + entry.templates.length, 0);
          return (
            <section key={vendorKey} className="palette-vendor">
              <button
                type="button"
                className="palette-vendor-header"
                aria-expanded={!vendorCollapsed}
                aria-controls={vendorListID}
                disabled={isSearching}
                onClick={() => toggle(vendorKey)}
              >
                <Icon name="chevronRight" size={10} className={vendorCollapsed ? "chevron" : "chevron open"} />
                <span className="palette-vendor-title">{vendorKey === "" ? noVendorTitle : vendorKey}</span>
                <span className="palette-group-count">{vendorCount}</span>
              </button>
              {!vendorCollapsed && (
                <div id={vendorListID}>
                  {vendorGroup.categories.map((group) => {
                    const categoryKey = `${vendorKey}/${group.category}`;
                    const isCollapsed = collapsed.has(categoryKey) && !isSearching;
                    const listID = `palette-group-${vendorListID}-${group.category.replace(/\s+/g, "-")}`;
                    return (
                      <section key={group.category} className="palette-group">
                        <button
                          type="button"
                          className="palette-group-header"
                          aria-expanded={!isCollapsed}
                          aria-controls={listID}
                          disabled={isSearching}
                          onClick={() => toggle(categoryKey)}
                        >
                          <Icon name="chevronRight" size={10} className={isCollapsed ? "chevron" : "chevron open"} />
                          <span className="palette-group-title">{categoryPlural(group.category).toLocaleUpperCase("cs")}</span>
                          <span className="palette-group-count">{group.templates.length}</span>
                        </button>
                        {!isCollapsed && (
                          <ul className="palette-rows" id={listID}>
                            {group.templates.map((template) => (
                              <PaletteRow
                                key={template.id}
                                template={template}
                                onAdd={() => app.addDevice(template.id)}
                                onEdit={() => app.openDeviceEditor({ kind: "edit", template })}
                                onDuplicate={() => app.openDeviceEditor({ kind: "duplicate", template })}
                                onRemove={() => removeCustom(template)}
                              />
                            ))}
                          </ul>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <div className="palette-footer">
        <button
          type="button"
          className="push-button wide"
          title="Přidat do katalogu vlastní zařízení s vlastními porty"
          onClick={() => app.openDeviceEditor({ kind: "new" })}
        >
          <Icon name="plus" size={15} />
          Nové zařízení…
        </button>
      </div>
    </nav>
  );
});

/** One catalog entry: icon, model, vendor, port summary, "verify" marker. */
function PaletteRow({
  template,
  onAdd,
  onEdit,
  onDuplicate,
  onRemove,
}: {
  template: DeviceTemplate;
  onAdd: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const needsVerification = templateNeedsVerification(template);
  const summary = portSummary(template);
  const tooltip = [
    displayName(template.vendor, template.model),
    `${portsText(templatePortCount(template))}: ${summary}`,
    template.note ? template.note : null,
    needsVerification ? verifyHint + "." : null,
    "Přetáhněte na plátno nebo dvakrát klikněte.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const onDragStart = (event: DragEvent<HTMLLIElement>) => {
    event.dataTransfer.setData(templateDragType, template.id);
    event.dataTransfer.setData("text/plain", templateDragPrefix + template.id);
    event.dataTransfer.effectAllowed = "copy";
    const preview = dragPreview(event.currentTarget);
    if (preview) {
      event.dataTransfer.setDragImage(preview, 20, 20);
      setTimeout(() => preview.remove(), 0);
    }
  };

  return (
    <li
      className="palette-row"
      tabIndex={0}
      draggable
      title={tooltip}
      aria-label={`${displayName(template.vendor, template.model)}, ${summary}${needsVerification ? ", " + verifyHint.toLowerCase() : ""}`}
      onDoubleClick={onAdd}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onAdd();
        }
      }}
      onDragStart={onDragStart}
    >
      <DeviceIcon category={template.category} size={32} />
      <div className="palette-row-text">
        <div className="palette-row-model">
          <span className="palette-model-name">{template.model}</span>
          {template.isCustom && <Chip text="vlastní" tone="teal" />}
        </div>
        <div className="palette-row-detail">{summary}</div>
      </div>
      {needsVerification && <VerifyBadge />}
      <div className="palette-row-actions">
        {template.isCustom && (
          <button type="button" className="icon-button neutral" title="Upravit zařízení" aria-label="Upravit zařízení" onClick={onEdit}>
            <Icon name="note" size={14} />
          </button>
        )}
        <button
          type="button"
          className="icon-button neutral"
          title="Vytvořit vlastní kopii"
          aria-label="Vytvořit vlastní kopii"
          onClick={onDuplicate}
        >
          <Icon name="noteAdd" size={14} />
        </button>
        {template.isCustom && (
          <button type="button" className="icon-button" title="Smazat zařízení z katalogu" aria-label="Smazat zařízení z katalogu" onClick={onRemove}>
            <Icon name="trash" size={14} />
          </button>
        )}
      </div>
    </li>
  );
}

/** A compact drag image (icon and model) built from the row; removed right after the drag starts. */
function dragPreview(row: HTMLElement): HTMLElement | null {
  const icon = row.querySelector("svg.device-icon");
  const model = row.querySelector(".palette-model-name");
  if (!icon || !model) return null;
  const preview = document.createElement("div");
  preview.className = "drag-preview";
  preview.appendChild(icon.cloneNode(true));
  const label = document.createElement("span");
  label.textContent = model.textContent;
  preview.appendChild(label);
  document.body.appendChild(preview);
  return preview;
}
