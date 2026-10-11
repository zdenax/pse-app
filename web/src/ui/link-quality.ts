// The "Zpoždění" and "Ztrátovost" fields of the cable inspector: parsing what was typed and
// writing it to the store. One committed edit is one store call, hence one undo step.

import type { Link } from "../core/model";
import type { ProjectStoreAPI } from "../core/store-api";

export type LinkQualityField = "delay" | "loss";

/** Largest delay the inspector accepts, in ms (a satellite hop is about 600). */
export const maxLinkDelay = 10_000;
export const maxLinkLoss = 100;

/**
 * A non-negative number as typed ("20", "0,5", " 12.5 "); empty text is 0 (no setting).
 * Null when it is not a number or is negative.
 */
export function parseQualityText(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return 0;
  if (!/^\d*\.?\d+$|^\d+\.$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** The text a field shows for a value: empty when the setting is not used. */
export function qualityText(value: number | undefined): string {
  return value === undefined || value <= 0 ? "" : String(value);
}

/**
 * Stores the typed delay or loss of a cable (the other value is kept). Returns false when the text
 * is not a valid number, so the field falls back to the stored value. Values beyond the limits
 * are clamped.
 */
export function commitLinkQuality(store: ProjectStoreAPI, link: Link, field: LinkQualityField, text: string): boolean {
  const value = parseQualityText(text);
  if (value === null) return false;
  const current = store.project.links.find((candidate) => candidate.id === link.id) ?? link;
  const next = {
    delay: current.delay ?? 0,
    loss: current.loss ?? 0,
    [field]: Math.min(value, field === "delay" ? maxLinkDelay : maxLinkLoss),
  };
  if (next.delay === (current.delay ?? 0) && next.loss === (current.loss ?? 0)) return true;
  store.setLinkQuality(link.id, next);
  return true;
}
