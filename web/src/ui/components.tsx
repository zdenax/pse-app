// Small building blocks shared by the palette, the inspector and the toolbar.
// Port of Sources/NetSketch/Views/Components.swift plus web-only helpers (menu button, modal).

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { CableType, LinkStatus } from "../core/model";
import { cableDescription, linkStatuses, linkStatusName, verifyHint } from "./czech";
import { Icon } from "./icons";
import { useIsomorphicLayoutEffect } from "./store-context";

// MARK: CommitTextField

export interface CommitTextFieldProps {
  value: string;
  /** Returns false when the value was refused; the field then falls back to `value`. */
  onCommit: (text: string) => boolean;
  placeholder?: string;
  /** Accessible name (defaults to the placeholder). */
  label?: string;
  multiline?: boolean;
  minRows?: number;
  maxRows?: number;
  className?: string;
  title?: string;
  /** Use the monospaced font. */
  mono?: boolean;
  /** Keyboard hint of touch devices, e.g. "decimal" for numbers. */
  inputMode?: "text" | "numeric" | "decimal";
}

/**
 * A text field that edits a local draft and reports the value once, when editing ends (Enter,
 * focus loss, or the field going away). One edit is therefore one undo step in the store, and
 * values changed elsewhere (console, undo) show up immediately. Escape restores the value.
 * Multi-line fields take a new line with Shift+Enter or Alt/Option+Enter.
 */
export function CommitTextField(props: CommitTextFieldProps) {
  const { value, placeholder, label, multiline, minRows = 2, maxRows = 8, className, title, mono, inputMode } = props;
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(draft);
  const valueRef = useRef(value);
  const commitRef = useRef(props.onCommit);
  draftRef.current = draft;
  valueRef.current = value;
  commitRef.current = props.onCommit;

  // Values changed elsewhere replace the draft.
  useEffect(() => {
    setDraft(value);
    draftRef.current = value;
  }, [value]);

  const commit = () => {
    if (draftRef.current === valueRef.current) return;
    if (!commitRef.current(draftRef.current)) {
      setDraft(valueRef.current);
      draftRef.current = valueRef.current;
    }
  };

  // Commit a pending edit when the field goes away (selection changed, inspector hidden).
  useEffect(() => () => commit(), []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setDraft(valueRef.current);
      draftRef.current = valueRef.current;
      return;
    }
    if (event.key === "Enter") {
      if (multiline && (event.shiftKey || event.altKey)) {
        if (event.altKey) {
          // Alt/Option+Enter inserts a new line like Option+Return in the Mac app.
          event.preventDefault();
          const target = event.currentTarget;
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          const next = target.value.slice(0, start) + "\n" + target.value.slice(end);
          setDraft(next);
          draftRef.current = next;
          requestAnimationFrame(() => target.setSelectionRange(start + 1, start + 1));
        }
        return;
      }
      event.preventDefault();
      commit();
    }
  };

  const common = {
    className: ["text-field", mono ? "mono" : "", className ?? ""].filter(Boolean).join(" "),
    value: draft,
    placeholder,
    title,
    inputMode,
    "aria-label": label ?? placeholder,
    spellCheck: false,
    onKeyDown,
    onBlur: commit,
  };

  if (multiline) {
    const lines = draft.split("\n").length;
    const rows = Math.min(Math.max(lines, minRows), maxRows);
    return (
      <textarea
        {...common}
        rows={rows}
        onChange={(event) => {
          setDraft(event.target.value);
          draftRef.current = event.target.value;
        }}
      />
    );
  }
  return (
    <input
      {...common}
      type="text"
      onChange={(event) => {
        setDraft(event.target.value);
        draftRef.current = event.target.value;
      }}
    />
  );
}

// MARK: Badges and layout

/** The "check against the hardware" marker for unverified catalog data. */
export function VerifyBadge({ help = verifyHint, size = 15 }: { help?: string; size?: number }) {
  return (
    <span className="verify-badge" title={help} role="img" aria-label={help}>
      <Icon name="warning" size={size} />
    </span>
  );
}

/** Small colored tag, e.g. "vlastní" or "shutdown". */
export function Chip({ text, tone = "slate" }: { text: string; tone?: "slate" | "teal" | "accent" }) {
  return <span className={`chip chip-${tone}`}>{text}</span>;
}

/** A titled block of the inspector. */
export function InspectorSection({
  title,
  children,
  accessory,
}: {
  title: string;
  children: ReactNode;
  accessory?: ReactNode;
}) {
  const id = useId();
  return (
    <section className="inspector-section" aria-labelledby={id}>
      <div className="section-title-row">
        <h3 className="section-title" id={id}>
          {title.toLocaleUpperCase("cs")}
        </h3>
        {accessory}
      </div>
      {children}
    </section>
  );
}

/** A caption on the left, a value on the right. */
export function InspectorRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="inspector-row">
      <span className="inspector-row-label">{label}</span>
      <div className="inspector-row-value">{children}</div>
    </div>
  );
}

/** A caption and a hint text in the secondary color. */
export function Hint({ children }: { children: ReactNode }) {
  return <p className="hint">{children}</p>;
}

/** Warning line with the verify badge. */
export function VerifyNote({ children }: { children: ReactNode }) {
  return (
    <div className="verify-note">
      <VerifyBadge />
      <span>{children}</span>
    </div>
  );
}

// MARK: Status dots

export function StatusDot({ status, size = 13 }: { status: LinkStatus; size?: number }) {
  return <span className={`status-dot status-${status}`} style={{ width: size, height: size }} aria-hidden="true" />;
}

/** Four dots to pick the status of one cable end. */
export function StatusPicker({
  status,
  onChange,
  label,
}: {
  status: LinkStatus;
  onChange: (status: LinkStatus) => void;
  label: string;
}) {
  return (
    <div className="status-picker" role="radiogroup" aria-label={label}>
      {linkStatuses.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={option === status}
          className={option === status ? "status-option selected" : "status-option"}
          title={linkStatusName(option)}
          aria-label={"Stav: " + linkStatusName(option)}
          onClick={() => onChange(option)}
        >
          <StatusDot status={option} />
        </button>
      ))}
    </div>
  );
}

// MARK: Cable swatch

/**
 * A short line sample of a cable type, matching the canvas: straight = solid ink, crossover =
 * dashed ink, console = thin light blue, fiber = accent dash-dot.
 */
export function CableSwatch({ type, width = 30, height = 12 }: { type: CableType; width?: number; height?: number }) {
  const look = {
    straight: { cls: "cable-ink", stroke: 2, dash: undefined as string | undefined, cap: "round" as const },
    crossover: { cls: "cable-ink", stroke: 2, dash: "5 3", cap: "butt" as const },
    console: { cls: "cable-console", stroke: 1.4, dash: undefined, cap: "round" as const },
    fiber: { cls: "cable-fiber", stroke: 2.4, dash: "7 2.5 2 2.5", cap: "butt" as const },
  }[type];
  return (
    <svg className="cable-swatch" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <title>{cableDescription(type)}</title>
      <line
        className={look.cls}
        x1={2}
        y1={height / 2}
        x2={width - 2}
        y2={height / 2}
        strokeWidth={look.stroke}
        strokeDasharray={look.dash}
        strokeLinecap={look.cap}
      />
    </svg>
  );
}

// MARK: Menu button

export interface MenuItem {
  label: string;
  onSelect: () => void;
  shortcut?: string;
  disabled?: boolean;
  title?: string;
  /** Draw a separator above this item. */
  separatorBefore?: boolean;
  checked?: boolean;
}

/** A button that opens a small dropdown menu (role="menu"), closed by Escape or a click outside. */
export function MenuButton({
  label,
  title,
  items,
  children,
  className,
  align = "start",
}: {
  label: string;
  title?: string;
  items: MenuItem[];
  children: ReactNode;
  className?: string;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuID = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])");
    first?.focus();
  }, [open]);

  const focusItem = (direction: 1 | -1) => {
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = (index + direction + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(-1);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className={`menu-root ${className ?? ""}`} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={open ? "tool-button menu-button open" : "tool-button menu-button"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuID : undefined}
        aria-label={label}
        title={title}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children}
      </button>
      {open && (
        <div
          className={`menu-popup align-${align}`}
          role="menu"
          id={menuID}
          aria-label={label}
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => (
            <div key={index} role="none">
              {item.separatorBefore && <div className="menu-separator" role="separator" />}
              <button
                type="button"
                role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                aria-checked={item.checked}
                className="menu-item"
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  setOpen(false);
                  buttonRef.current?.focus();
                  item.onSelect();
                }}
              >
                <span className="menu-check" aria-hidden="true">
                  {item.checked ? "✓" : ""}
                </span>
                <span className="menu-label">{item.label}</span>
                {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// MARK: Modal

/** A small modal dialog (alert style). Escape and the default button close it. */
export function Modal({
  title,
  children,
  onClose,
  actions,
  role = "dialog",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  actions?: ReactNode;
  role?: "dialog" | "alertdialog";
}) {
  const titleID = useId();
  const bodyID = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<Element | null>(null);

  useIsomorphicLayoutEffect(() => {
    previousFocus.current = document.activeElement;
    const target =
      dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      dialogRef.current?.querySelector<HTMLElement>("button");
    target?.focus();
    return () => {
      if (previousFocus.current instanceof HTMLElement) previousFocus.current.focus();
    };
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      // Keep the focus inside the dialog.
      const focusable = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex='-1'])",
        ) ?? []),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    // Shortcuts of the main window do not apply while a dialog is open.
    event.stopPropagation();
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role={role}
        aria-modal="true"
        aria-labelledby={titleID}
        aria-describedby={bodyID}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <h2 className="modal-title" id={titleID}>
          {title}
        </h2>
        <div className="modal-body" id={bodyID}>
          {children}
        </div>
        <div className="modal-actions">
          {actions ?? (
            <button type="button" className="push-button default" data-autofocus onClick={onClose}>
              OK
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
