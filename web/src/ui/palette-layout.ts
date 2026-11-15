// Layout of the palette: width of the resizable part, collapse to the icon rail, and the selected
// category. The left category rail is the fixed main part; everything to its right can be dragged
// wider or narrower and collapses to just the icon rail past the limit. Remembered in localStorage.

import { useSyncExternalStore } from "react";

export const railWidth = 76;
export const minContent = 200;
export const maxContent = 460;
const collapseBelow = 120;

export type RailCategory = "switch" | "router" | "AP" | "PC" | "server" | "patch panel";

interface Layout {
  /** Width of the resizable part (without the rail). */
  content: number;
  /** Only the icon rail is shown. */
  iconsOnly: boolean;
  category: RailCategory;
}

const categories: readonly RailCategory[] = ["switch", "router", "AP", "PC", "server", "patch panel"];

function load(): Layout {
  const fallback: Layout = { content: 280, iconsOnly: false, category: "switch" };
  try {
    const parsed = JSON.parse(window.localStorage.getItem("netsketch.palette") ?? "null") as Partial<Layout> | null;
    if (!parsed) return fallback;
    const content = Math.min(maxContent, Math.max(minContent, Number(parsed.content) || fallback.content));
    const category = categories.find((c) => c === parsed.category) ?? "switch";
    return { content, iconsOnly: parsed.iconsOnly === true, category };
  } catch {
    return fallback;
  }
}

let state: Layout = typeof window === "undefined" ? { content: 280, iconsOnly: false, category: "switch" } : load();
const listeners = new Set<() => void>();

function set(change: Partial<Layout>): void {
  state = { ...state, ...change };
  try {
    window.localStorage.setItem("netsketch.palette", JSON.stringify(state));
  } catch {
    // Storage cannot be used: the layout is just not remembered.
  }
  listeners.forEach((l) => l());
}

export const paletteLayout = {
  get: () => state,
  setCategory: (category: RailCategory) => set({ category, iconsOnly: false }),
  toggleIcons: () => set({ iconsOnly: !state.iconsOnly }),
  /** Dragging the handle: `width` is the wanted width of the resizable part. */
  drag(width: number): void {
    if (width < collapseBelow) set({ iconsOnly: true });
    else set({ iconsOnly: false, content: Math.min(maxContent, Math.max(minContent, width)) });
  },
  /** Total width of the palette column in pixels. */
  totalWidth: (layout: Layout = state) => railWidth + (layout.iconsOnly ? 0 : layout.content),
};

export function usePaletteLayout(): Layout {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}
