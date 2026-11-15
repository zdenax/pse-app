// The left-hand column: a fixed category rail (icons) plus a resizable part with a vendor
// filter and a flat device list. Collapses to just the icon rail past the width limit (an orange
// handle on the right edge drags it, or a double click toggles it). Search ignores the selected
// category. Port of Sources/NetSketch/Views/PaletteView.swift, layout matching the NetLab redesign.

import { memo, useMemo, useState, type DragEvent, type PointerEvent } from "react";
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
import { maxContent, minContent, paletteLayout, usePaletteLayout, type RailCategory } from "./palette-layout";
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

const railGroups: { id: RailCategory; categories: DeviceCategory[]; icon: DeviceCategory; label: string }[] = [
  { id: "switch", categories: ["switch", "L3 switch"], icon: "switch", label: "Switche" },
  { id: "router", categories: ["router"], icon: "router", label: "Routery" },
  { id: "AP", categories: ["AP"], icon: "AP", label: "AP" },
  { id: "PC", categories: ["PC"], icon: "PC", label: "Počítače" },
  { id: "server", categories: ["server"], icon: "server", label: "Servery" },
  { id: "patch panel", categories: ["patch panel"], icon: "patch panel", label: "Patch panely" },
];

/**
 * Paleta: vlevo pevná lišta kategorií, vpravo roztahovací část s výrobci, přepínačem L2/L3 (jen
 * u switchů) a plochým seznamem zařízení. Úchyt na pravém okraji mění šířku; pod limitem se
 * sbalí na lištu ikonek.
 */
export const Palette = memo(function Palette() {
  useStoreVersion();
  const store = useStore();
  const app = useApp();
  const layout = usePaletteLayout();
  const [searchText, setSearchText] = useState("");
  const [vendor, setVendor] = useState<string | null>(null);
  const [vendorOpen, setVendorOpen] = useState(true);
  const [layer, setLayer] = useState<"all" | "switch" | "L3 switch">("all");

  const catalog = store.catalog;
  // Custom templates can change the catalog without a project change.
  useMaybeObservable(catalog);

  const rail = railGroups.find((g) => g.id === layout.category) ?? railGroups[0];

  const removeCustom = (template: DeviceTemplate) => {
    if (!window.confirm(`Smazat vlastní zařízení „${displayName(template.vendor, template.model)}“ z katalogu?\nZařízení už umístěná v projektu zůstanou.`)) return;
    try {
      catalog.removeCustom?.(template.id);
    } catch (error) {
      app.present(error, "Zařízení nelze smazat");
    }
  };

  const categoryTemplates = useMemo(
    () => catalog.templates.filter((tpl) => rail.categories.includes(tpl.category)),
    [catalog.templates, rail],
  );
  const vendors = useMemo(
    () => [...new Set(categoryTemplates.map((tpl) => tpl.vendor))].sort((x, y) => x.localeCompare(y, "cs")),
    [categoryTemplates],
  );
  const activeVendor = vendor !== null && vendors.includes(vendor) ? vendor : null;

  // Hledání hledá ve všech kategoriích a výrobcích najednou. Bez hledání se zobrazí vybraná
  // kategorie, výrobce a vrstva.
  const shown = useMemo(() => {
    const query = searchText.trim();
    if (query !== "") {
      return catalog.templates.filter(
        (tpl) => containsText(tpl.model, query) || containsText(tpl.vendor, query) || containsText(tpl.id, query),
      );
    }
    return categoryTemplates.filter(
      (tpl) => (activeVendor === null || tpl.vendor === activeVendor) && (layer === "all" || rail.id !== "switch" || tpl.category === layer),
    );
  }, [catalog.templates, categoryTemplates, activeVendor, layer, rail, searchText]);

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startContent = layout.iconsOnly ? 0 : layout.content;
    const move = (e: globalThis.PointerEvent) => paletteLayout.drag(startContent + e.clientX - startX);
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };

  return (
    <nav className={layout.iconsOnly ? "palette palette2 icons-only" : "palette palette2"} aria-label="Paleta zařízení">
      <div className="p2-search">
        {layout.iconsOnly ? (
          <button type="button" className="p2-search-icon" title="Hledat zařízení" aria-label="Hledat zařízení" onClick={() => paletteLayout.toggleIcons()}>
            <Icon name="search" size={16} />
          </button>
        ) : (
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
              <button type="button" className="search-clear" title="Zrušit hledání" aria-label="Zrušit hledání" onClick={() => setSearchText("")}>
                <Icon name="clear" size={15} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="p2-body">
        <div className="p2-rail" role="group" aria-label="Kategorie">
          {railGroups.map((group) => (
            <button
              key={group.id}
              type="button"
              aria-pressed={group.id === rail.id}
              className={group.id === rail.id ? "p2-rail-item selected" : "p2-rail-item"}
              title={group.label}
              onClick={() => {
                setLayer("all");
                setVendor(null);
                paletteLayout.setCategory(group.id);
              }}
            >
              <DeviceIcon category={group.icon} size={28} />
              <span>{group.label}</span>
            </button>
          ))}
        </div>

        {!layout.iconsOnly && (
          <div className="p2-content">
            <div className="p2-vendors">
              <button type="button" className="p2-vendors-head" aria-expanded={vendorOpen} onClick={() => setVendorOpen(!vendorOpen)}>
                <Icon name="chevronRight" size={10} className={vendorOpen ? "chevron open" : "chevron"} />
                <span>Výrobci</span>
                {activeVendor && <strong className="p2-vendor-chosen">{activeVendor}</strong>}
              </button>
              {vendorOpen && (
                <ul className="p2-vendor-list">
                  <li>
                    <button type="button" className={activeVendor === null ? "p2-vendor selected" : "p2-vendor"} onClick={() => setVendor(null)}>
                      Všichni
                    </button>
                  </li>
                  {vendors.map((v) => (
                    <li key={v}>
                      <button
                        type="button"
                        className={v === activeVendor ? "p2-vendor selected" : "p2-vendor"}
                        onClick={() => {
                          setVendor(v);
                          setVendorOpen(false);
                        }}
                      >
                        {v === "" ? noVendorTitle : v}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {rail.id === "switch" && (
              <div className="p2-layer" role="group" aria-label="L2 / L3">
                {(["all", "switch", "L3 switch"] as const).map((l) => (
                  <button key={l} type="button" aria-pressed={layer === l} className={layer === l ? "p2-layer-btn selected" : "p2-layer-btn"} onClick={() => setLayer(l)}>
                    {l === "all" ? "Vše" : l === "switch" ? "L2" : "L3"}
                  </button>
                ))}
              </div>
            )}

            <ul className="palette-rows p2-list" aria-label={rail.label}>
              {shown.length === 0 && (
                <li className="palette-empty">
                  <Icon name={catalog.templates.length === 0 ? "file" : "search"} size={26} />
                  <span>{catalog.templates.length === 0 ? "Katalog je prázdný" : "Nic nenalezeno"}</span>
                </li>
              )}
              {shown.map((template) => (
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

            <div className="palette-footer">
              <button type="button" className="push-button wide" title="Přidat do katalogu vlastní zařízení s vlastními porty" onClick={() => app.openDeviceEditor({ kind: "new" })}>
                <Icon name="plus" size={15} />
                Nové zařízení…
              </button>
            </div>
          </div>
        )}
      </div>

      <div
        className="p2-handle"
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={maxContent}
        aria-valuenow={layout.iconsOnly ? 0 : layout.content}
        aria-label="Táhněte pro změnu šířky, dvojklik sbalí na lištu ikonek"
        title="Táhněte pro změnu šířky, dvojklik sbalí na lištu ikonek"
        tabIndex={0}
        onPointerDown={startDrag}
        onDoubleClick={() => paletteLayout.toggleIcons()}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") paletteLayout.drag(layout.iconsOnly ? minContent : layout.content + 20);
          if (event.key === "ArrowLeft") paletteLayout.drag(layout.content - 20 < minContent ? 0 : layout.content - 20);
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") event.preventDefault();
        }}
      >
        <span className="p2-grip" />
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
        <div className="palette-row-detail">{template.vendor === "" ? noVendorTitle : template.vendor}</div>
        <div className="palette-row-detail">{summary}</div>
      </div>
      {needsVerification && <VerifyBadge />}
      <div className="palette-row-actions">
        {template.isCustom && (
          <button type="button" className="icon-button neutral" title="Upravit zařízení" aria-label="Upravit zařízení" onClick={onEdit}>
            <Icon name="note" size={14} />
          </button>
        )}
        <button type="button" className="icon-button neutral" title="Vytvořit vlastní kopii" aria-label="Vytvořit vlastní kopii" onClick={onDuplicate}>
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
