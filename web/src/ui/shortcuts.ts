// Keyboard shortcuts of the main window, as in the Mac app's menus (AppCommands.swift) and its
// key interception (AppModel.intercept). The mapping is a pure function so it can be tested;
// App.tsx installs the window listener and runs the commands.

export type ShortcutCommand =
  | "new"
  | "open"
  | "save"
  | "saveAs"
  | "undo"
  | "redo"
  | "console"
  | "viewPhysical"
  | "viewLogical"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "zoomFit"
  | "delete"
  | "selectAll"
  | "bundle"
  | "unbundle"
  | "addNote";

/** The parts of a keyboard event the mapping looks at (a DOM KeyboardEvent fits). */
export interface ShortcutKeyEvent {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The letter of a key press, independent of Shift and of non-Latin layouts. */
function letterOf(event: ShortcutKeyEvent): string | null {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  return null;
}

/**
 * Digits by physical key: on a Czech keyboard Cmd/Ctrl + the "1" key reports key "+", so the
 * key code decides (Digit1 or Numpad1).
 */
function digitOf(event: ShortcutKeyEvent): string | null {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(event.code);
  return match ? match[1] : null;
}

/**
 * The command for a key press, or null.
 * `editingText`: a text field has the keyboard focus. Then Delete, Cmd+A and Cmd+Z belong to
 * the field, while document commands (save, open, zoom...) still work.
 */
export function shortcutFor(event: ShortcutKeyEvent, isMac: boolean, editingText: boolean): ShortcutCommand | null {
  // The console opens with Alt+T (Option+T on the Mac): browsers keep Ctrl/Cmd+T for a new tab and
  // never see this one. AltGr (reported as Ctrl+Alt) is left alone. In a text field the Mac types a
  // character with Option+T, so the field keeps it there.
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && letterOf(event) === "t") {
    return isMac && editingText ? null : "console";
  }
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;

  if (!mod) {
    const isDelete = event.key === "Delete" || event.key === "Backspace";
    if (isDelete && !event.metaKey && !event.ctrlKey && !event.altKey && !editingText) return "delete";
    return null;
  }
  if (event.altKey) return null;

  const digit = digitOf(event);
  if (digit !== null) {
    switch (digit) {
      case "1":
        return "viewPhysical";
      case "2":
        return "viewLogical";
      case "0":
        return "zoomReset";
      case "9":
        return "zoomFit";
      default:
        return null;
    }
  }
  if (event.code === "NumpadAdd" || event.key === "+" || event.key === "=") return "zoomIn";
  if (event.code === "NumpadSubtract" || event.key === "-" || event.key === "−") return "zoomOut";

  const letter = letterOf(event);
  switch (letter) {
    case "n":
      return event.shiftKey ? null : "new";
    case "o":
      return event.shiftKey ? null : "open";
    case "s":
      return event.shiftKey ? "saveAs" : "save";
    case "z":
      if (editingText) return null;
      return event.shiftKey ? "redo" : "undo";
    case "y":
      // Ctrl+Y is the usual redo outside the Mac.
      return !isMac && !event.shiftKey && !editingText ? "redo" : null;
    case "a":
      return editingText || event.shiftKey ? null : "selectAll";
    case "g":
      return event.shiftKey ? "unbundle" : "bundle";
    case "m":
      return event.shiftKey ? "addNote" : null;
    default:
      return null;
  }
}

/** True when the focused element takes typed text (inputs, text areas, selects, editable content). */
export function isEditingText(element: Element | null): boolean {
  if (!element || typeof HTMLElement === "undefined") return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "range", "color", "file", "image", "reset", "submit"].includes(
      element.type,
    );
  }
  return element instanceof HTMLElement && element.isContentEditable;
}
