// Dialog for creating or editing a user-defined device: identity, port groups, front-panel preview.
// Port of DeviceEditorView.swift; the state and validation live in device-editor-model.ts.

import { useState, type ReactNode } from "react";
import { deviceCategories, connectorTypes } from "../core/enums";
import type { DeviceCategory } from "../core/model";
import { portNames } from "../core/port-group";
import { templatePanelGrid } from "../core/template";
import { Icon } from "./icons";
import { Modal } from "./components";
import { categoryName, connectorName, portsText, verifyHint } from "./czech";
import {
  draftProblems,
  draftTemplate,
  groupPreview,
  groupProblem,
  makeDraft,
  newNamedGroup,
  nextRangeGroup,
  speedPresets,
  totalPorts,
  type DeviceDraft,
  type DeviceEditorRequest,
  type PortGroupDraft,
} from "./device-editor-model";
import { errorMessage } from "./app-model";
import { useApp } from "./store-context";

export function DeviceEditorDialog({ request, onClose }: { request: DeviceEditorRequest; onClose: () => void }) {
  const app = useApp();
  const [draft, setDraft] = useState<DeviceDraft>(() => makeDraft(request));
  const [saveError, setSaveError] = useState<string | null>(null);

  const problems = draftProblems(draft);
  const editing = draft.original !== undefined;
  const update = (patch: Partial<DeviceDraft>) => {
    setSaveError(null);
    setDraft((current) => ({ ...current, ...patch }));
  };
  const updateGroup = (key: number, patch: Partial<PortGroupDraft>) =>
    update({ groups: draft.groups.map((group) => (group.key === key ? { ...group, ...patch } : group)) });

  const save = () => {
    if (problems.length > 0) return;
    const catalog = app.store.catalog;
    try {
      if (!catalog.addCustom || !catalog.updateCustom || !catalog.uniqueID) {
        throw new Error("Tento katalog nepodporuje vlastní zařízení.");
      }
      const template = draftTemplate(draft, catalog.uniqueID(draft.vendor, draft.model));
      if (editing) catalog.updateCustom(template);
      else catalog.addCustom(template);
      onClose();
    } catch (error) {
      setSaveError(errorMessage(error));
    }
  };

  const total = totalPorts(draft);
  const status = saveError ?? problems[0] ?? null;

  return (
    <Modal
      title={editing ? "Upravit vlastní zařízení" : "Nové zařízení"}
      className="wide"
      onClose={onClose}
      actions={
        <>
          <div className={status ? "editor-status error" : "editor-status"} title={problems.join("\n")}>
            {status ?? "Zařízení se uloží do vlastního katalogu."}
            {!saveError && problems.length > 1 && <span className="muted"> a další: {problems.length - 1}</span>}
          </div>
          <button type="button" className="push-button" onClick={onClose}>
            Zrušit
          </button>
          <button type="button" className="push-button default" disabled={problems.length > 0} onClick={save}>
            {editing ? "Uložit" : "Přidat do katalogu"}
          </button>
        </>
      }
    >
      <div className="editor-form">
        <Field label="Model">
          <input
            className="text-field"
            data-autofocus
            value={draft.model}
            placeholder="např. Lab Switch 24"
            onChange={(event) => update({ model: event.target.value })}
          />
        </Field>
        <Field label="Výrobce">
          <input
            className="text-field"
            value={draft.vendor}
            placeholder="nepovinné, jen jako text"
            onChange={(event) => update({ vendor: event.target.value })}
          />
        </Field>
        <Field label="Kategorie">
          <select
            className="select-field"
            value={draft.category}
            onChange={(event) => update({ category: event.target.value as DeviceCategory })}
          >
            {deviceCategories.map((category) => (
              <option key={category} value={category}>
                {categoryName(category)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Poznámka">
          <input
            className="text-field"
            value={draft.note}
            placeholder="nepovinné"
            onChange={(event) => update({ note: event.target.value })}
          />
        </Field>
        <Field label="">
          <label className="checkbox" title={`Bez zaškrtnutí se u zařízení a jeho portů zobrazuje upozornění „${verifyHint}“.`}>
            <input
              type="checkbox"
              checked={draft.verified}
              onChange={(event) => update({ verified: event.target.checked })}
            />
            Porty jsem ověřil(a) podle skutečného hardwaru
          </label>
        </Field>
      </div>

      <div className="editor-groups-head">
        <h3>Skupiny portů</h3>
        <span className="muted">Celkem {portsText(total)}</span>
      </div>
      {draft.groups.length === 0 && <p className="muted">Zatím žádná skupina. Přidejte alespoň jednu.</p>}
      {draft.groups.map((group) => (
        <GroupRow
          key={group.key}
          group={group}
          onChange={(patch) => updateGroup(group.key, patch)}
          onRemove={() => update({ groups: draft.groups.filter((candidate) => candidate.key !== group.key) })}
        />
      ))}
      <div className="button-row editor-add">
        <button
          type="button"
          className="push-button small"
          onClick={() => update({ groups: [...draft.groups, nextRangeGroup(draft)] })}
        >
          <Icon name="plus" size={13} />
          Přidat rozsah portů
        </button>
        <button
          type="button"
          className="push-button small"
          onClick={() => update({ groups: [...draft.groups, newNamedGroup()] })}
        >
          <Icon name="plus" size={13} />
          Přidat vyjmenované porty
        </button>
      </div>

      {problems.length === 0 && total > 0 && <PanelPreview draft={draft} />}
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="editor-field">
      <span className="editor-label">{label}</span>
      <span className="editor-control">{children}</span>
    </label>
  );
}

function numberValue(value: number): string {
  return Number.isNaN(value) ? "" : String(value);
}

function parseNumber(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text);
}

/** One editable row of the port-group list, with a live preview of the generated names. */
function GroupRow({
  group,
  onChange,
  onRemove,
}: {
  group: PortGroupDraft;
  onChange: (patch: Partial<PortGroupDraft>) => void;
  onRemove: () => void;
}) {
  const problem = groupProblem(group);
  const speeds = speedPresets.includes(group.speed) ? speedPresets : [...speedPresets, group.speed];
  return (
    <div className="editor-group">
      <div className="editor-group-fields">
        {group.mode === "range" && (
          <>
            <Small label="Prefix">
              <input
                className="text-field small"
                style={{ width: 130 }}
                value={group.prefix}
                placeholder="Gi0/"
                spellCheck={false}
                onChange={(event) => onChange({ prefix: event.target.value })}
              />
            </Small>
            <Small label="Od">
              <input
                className="text-field small"
                style={{ width: 58 }}
                inputMode="numeric"
                value={numberValue(group.from)}
                onChange={(event) => onChange({ from: parseNumber(event.target.value) })}
              />
            </Small>
            <Small label="Do">
              <input
                className="text-field small"
                style={{ width: 58 }}
                inputMode="numeric"
                value={numberValue(group.to)}
                onChange={(event) => onChange({ to: parseNumber(event.target.value) })}
              />
            </Small>
          </>
        )}
        {group.mode === "names" && (
          <Small label="Názvy portů oddělené čárkou" grow>
            <input
              className="text-field small"
              value={group.namesText}
              placeholder="Console, Mgmt"
              spellCheck={false}
              onChange={(event) => onChange({ namesText: event.target.value })}
            />
          </Small>
        )}
        {group.mode === "placeholder" && (
          <Small label="Prázdná pozice" grow>
            <span className="muted">{group.label ?? "modul"}</span>
          </Small>
        )}
        {group.mode !== "placeholder" && (
          <>
            <Small label="Rychlost">
              <select
                className="select-field small"
                style={{ width: 104 }}
                value={group.speed}
                onChange={(event) => onChange({ speed: event.target.value })}
              >
                {speeds.map((speed) => (
                  <option key={speed} value={speed}>
                    {speed === "" ? "neuvedena" : speed}
                  </option>
                ))}
              </select>
            </Small>
            <Small label="Konektor">
              <select
                className="select-field small"
                style={{ width: 120 }}
                value={group.connector}
                onChange={(event) => onChange({ connector: event.target.value as PortGroupDraft["connector"] })}
              >
                {connectorTypes.map((connector) => (
                  <option key={connector} value={connector}>
                    {connectorName(connector)}
                  </option>
                ))}
              </select>
            </Small>
          </>
        )}
        <button type="button" className="icon-button" title="Odebrat skupinu" aria-label="Odebrat skupinu" onClick={onRemove}>
          <Icon name="trash" size={15} />
        </button>
      </div>
      {problem ? (
        <div className="editor-group-note error">{problem}</div>
      ) : (
        <div className="editor-group-note">{groupPreview(group)}</div>
      )}
    </div>
  );
}

function Small({ label, children, grow }: { label: string; children: ReactNode; grow?: boolean }) {
  return (
    <label className={grow ? "editor-small grow" : "editor-small"}>
      <span>{label}</span>
      {children}
    </label>
  );
}

const cell = 18;

/** Front panel drawn from the layout derived from the port groups. */
function PanelPreview({ draft }: { draft: DeviceDraft }) {
  const template = draftTemplate(draft, "preview");
  const grid = templatePanelGrid(template);
  const portLabels = template.portGroups.flatMap(portNames);
  const width = Math.max(1, grid.width) * cell + 16;
  const height = Math.max(1, grid.rows) * cell + 16;
  return (
    <div className="editor-preview">
      <h3>Náhled čelního panelu</h3>
      <div className="editor-preview-scroll">
        <svg width={width} height={height} role="img" aria-label="Náhled čelního panelu">
          <g transform="translate(8 8)">
            {grid.sections
              .filter((section) => section.isPlaceholder)
              .map((section, index) => (
                <g key={`bay-${index}`}>
                  <rect
                    x={section.x * cell}
                    y={0}
                    width={section.width * cell}
                    height={grid.rows * cell}
                    rx={3}
                    className="preview-bay"
                  />
                  <text x={(section.x + section.width / 2) * cell} y={(grid.rows * cell) / 2 + 3} textAnchor="middle" className="preview-label">
                    {section.label ?? "modul"}
                  </text>
                </g>
              ))}
            {grid.slots.map((slot) => (
              <rect
                key={slot.portIndex}
                x={slot.x * cell + 1.5}
                y={slot.row * cell + 1.5}
                width={cell - 3}
                height={cell - 3}
                rx={2}
                className="preview-port"
              >
                <title>{portLabels[slot.portIndex] ?? ""}</title>
              </rect>
            ))}
          </g>
        </svg>
      </div>
      <p className="muted">Rozložení portů na panelu se odvodí automaticky ze skupin.</p>
    </div>
  );
}
