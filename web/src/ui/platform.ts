// Platform conventions: Cmd on macOS, Ctrl elsewhere.

export const isMac: boolean =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

/** Name of the command modifier for texts: "Cmd" or "Ctrl". */
export const modName = isMac ? "Cmd" : "Ctrl";

/** Name of the option modifier for texts: "Option" or "Alt". */
export const altName = isMac ? "Option" : "Alt";

/**
 * A shortcut as shown in menus and tooltips: "⌘S" / "⇧⌘S" on the Mac, "Ctrl+S" /
 * "Ctrl+Shift+S" elsewhere.
 */
export function shortcutLabel(key: string, options: { shift?: boolean; alt?: boolean } = {}, mac = isMac): string {
  const upper = key.length === 1 ? key.toUpperCase() : key;
  if (mac) return `${options.alt ? "⌥" : ""}${options.shift ? "⇧" : ""}⌘${upper}`;
  return ["Ctrl", options.alt ? "Alt" : null, options.shift ? "Shift" : null, upper].filter(Boolean).join("+");
}
