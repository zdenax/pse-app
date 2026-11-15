// Width of the inspector: dragged by the handle on its left edge, remembered in localStorage.
// Dragging below `collapseBelow` hides the panel instead.

import { useSyncExternalStore } from "react";

export const inspectorLimits = { min: 260, max: 560, fallback: 310 } as const;

/** Dragging the inspector narrower than this hides it. */
export const collapseBelow = 200;

const storageKey = "netsketch.inspectorWidth";

export const clampInspectorWidth = (width: number): number =>
  Math.min(inspectorLimits.max, Math.max(inspectorLimits.min, Math.round(width)));

function load(): number {
  try {
    const saved = Number(window.localStorage.getItem(storageKey));
    return saved > 0 ? clampInspectorWidth(saved) : inspectorLimits.fallback;
  } catch {
    // Storage cannot be read: the default width applies.
    return inspectorLimits.fallback;
  }
}

let width: number = typeof window === "undefined" ? inspectorLimits.fallback : load();
const listeners = new Set<() => void>();

export const inspectorLayout = {
  width: (): number => width,
  set(value: number): void {
    width = clampInspectorWidth(value);
    try {
      window.localStorage.setItem(storageKey, String(width));
    } catch {
      // The width is just not remembered.
    }
    listeners.forEach((listener) => listener());
  },
};

export function useInspectorWidth(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => width,
    () => width,
  );
}
