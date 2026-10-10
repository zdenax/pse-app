// Floating console windows: draggable, resizable, several at once (one per device).
// Port of ConsoleWindowController / ConsoleViewController (Sources/NetSketch/Console).
// The look follows ConsoleStyle: dark navy terminal, teal prompt, tinted "%" diagnostics.

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ConsoleManager, ConsoleWindowState } from "./console-manager";
import {
  consoleKeyFor,
  isDiagnosticLine,
  isMultiLinePaste,
  type ConsoleChunk,
  type ConsoleModel,
} from "./console-model";
import { Icon } from "./icons";
import { useApp, useIsomorphicLayoutEffect, useObservable, useStoreVersion } from "./store-context";

/** All open console windows, back to front. */
export function ConsoleWindows() {
  const app = useApp();
  const manager = app.consoles;
  useObservable(manager);
  // Titles and prompts follow the project (renames, mode changes made elsewhere).
  const projectVersion = useStoreVersion();
  const stack = manager.windows;
  // Render in opening order and stack with z-index: moving a DOM node to raise it would take
  // away its keyboard focus and pointer capture.
  const ordered = [...stack].sort((a, b) => a.serial - b.serial);

  return (
    <div className="console-layer">
      {ordered.map((window) => {
        const model = manager.model(window.deviceID);
        if (!model) return null;
        const depth = stack.indexOf(window);
        return (
          <ConsoleWindow
            key={window.deviceID}
            manager={manager}
            state={window}
            model={model}
            title={manager.title(window.deviceID)}
            zIndex={depth + 1}
            isFront={depth === stack.length - 1}
            projectVersion={projectVersion}
          />
        );
      })}
    </div>
  );
}

type DragKind = "move" | "resize";

interface DragState {
  kind: DragKind;
  pointerID: number;
  startX: number;
  startY: number;
  frame: { x: number; y: number; width: number; height: number };
}

const scrollKeys = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"]);

const ConsoleWindow = memo(function ConsoleWindow({
  manager,
  state,
  model,
  title,
  zIndex,
  isFront,
}: {
  manager: ConsoleManager;
  state: ConsoleWindowState;
  model: ConsoleModel;
  title: string;
  zIndex: number;
  isFront: boolean;
  /** Only re-renders the window (live prompt) when the project changes. */
  projectVersion: number;
}) {
  useObservable(model);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const caretToEnd = useRef(false);
  const drag = useRef<DragState | null>(null);
  const deviceID = state.deviceID;

  const focusInput = useCallback(() => {
    const element = inputRef.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    const end = element.value.length;
    element.setSelectionRange(end, end);
  }, []);

  // Focus on open and whenever the window is brought to the front by a command.
  useEffect(() => {
    focusInput();
  }, [state.focusToken, focusInput]);

  // Keep the newest output in view.
  const chunks = model.chunks;
  useIsomorphicLayoutEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [chunks, model.generation]);

  useIsomorphicLayoutEffect(() => {
    if (!caretToEnd.current) return;
    caretToEnd.current = false;
    const element = inputRef.current;
    if (element) element.setSelectionRange(element.value.length, element.value.length);
  }, [input]);

  const replaceInput = (text: string) => {
    caretToEnd.current = true;
    setInput(text);
  };

  /** After a command: an `exit` at the top level closes the window and drops the session. */
  const afterCommand = () => {
    if (model.isClosed) manager.sessionEnded(deviceID);
  };

  const handleKey = (event: ReactKeyboardEvent, hasSelection: boolean): boolean => {
    if (event.nativeEvent.isComposing) return false;
    const key = consoleKeyFor(event, hasSelection);
    if (!key) return false;
    event.preventDefault();
    event.stopPropagation();
    switch (key) {
      case "enter": {
        const line = input;
        replaceInput("");
        model.submit(line);
        afterCommand();
        break;
      }
      case "tab":
        replaceInput(model.complete(input));
        break;
      case "help":
        model.showHelp(input);
        break;
      case "historyUp": {
        const line = model.historyPrevious(input);
        if (line !== null) replaceInput(line);
        break;
      }
      case "historyDown": {
        const line = model.historyNext();
        if (line !== null) replaceInput(line);
        break;
      }
      case "interrupt":
        model.interrupt(input);
        replaceInput("");
        break;
      case "end":
        replaceInput("");
        model.end();
        afterCommand();
        break;
      case "pageUp":
        scrollRef.current?.scrollBy({ top: -(scrollRef.current.clientHeight - 24) });
        break;
      case "pageDown":
        scrollRef.current?.scrollBy({ top: scrollRef.current.clientHeight - 24 });
        break;
    }
    return true;
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const element = event.currentTarget;
    const hasSelection = (element.selectionEnd ?? 0) > (element.selectionStart ?? 0);
    if (!handleKey(event, hasSelection)) {
      // Plain typing must not reach the main window's shortcuts (Delete, Cmd+A...).
      event.stopPropagation();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text/plain");
    if (!isMultiLinePaste(text)) return;
    event.preventDefault();
    replaceInput(model.paste(text, input));
    afterCommand();
  };

  /** The scrollback is read-only: typing there continues in the input line. */
  const onScrollbackKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (scrollKeys.has(event.key) && !event.ctrlKey && !event.metaKey) return;
    if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return;
    const selection = window.getSelection();
    const hasSelection = !!selection && !selection.isCollapsed;
    // Ctrl-C over selected output copies it (Windows, Linux); Cmd shortcuts stay with the browser.
    if (hasSelection && event.ctrlKey && event.key.toLowerCase() === "c") return;
    if ((event.metaKey || event.ctrlKey) && !handlesControlKey(event)) return;
    focusInput();
    if (!handleKey(event, false)) event.stopPropagation();
  };

  const onScrollbackMouseUp = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) focusInput();
  };

  // MARK: Moving and resizing

  const onPointerDown = (kind: DragKind) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if (kind === "move" && (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      kind,
      pointerID: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      frame: { x: state.x, y: state.y, width: state.width, height: state.height },
    };
    manager.bringToFront(deviceID);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointerID !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    const viewWidth = window.innerWidth;
    const viewHeight = window.innerHeight;
    if (current.kind === "move") {
      // Keep the title bar reachable.
      const x = Math.min(Math.max(current.frame.x + dx, 80 - current.frame.width), viewWidth - 80);
      const y = Math.min(Math.max(current.frame.y + dy, 0), viewHeight - 32);
      manager.setFrame(deviceID, { ...current.frame, x, y });
    } else {
      manager.setFrame(deviceID, {
        ...current.frame,
        width: Math.min(current.frame.width + dx, viewWidth - current.frame.x),
        height: Math.min(current.frame.height + dy, viewHeight - current.frame.y),
      });
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointerID === event.pointerId) {
      drag.current = null;
      focusInput();
    }
  };

  const titleID = `console-title-${deviceID}`;

  return (
    <div
      className={isFront ? "console-window front" : "console-window"}
      role="dialog"
      aria-labelledby={titleID}
      style={{ left: state.x, top: state.y, width: state.width, height: state.height, zIndex }}
      onPointerDownCapture={() => manager.bringToFront(deviceID)}
    >
      <div
        className="console-titlebar"
        onPointerDown={onPointerDown("move")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={focusInput}
      >
        <button
          type="button"
          className="console-close"
          title="Zavřít okno (relace konzole zůstane zachována)"
          aria-label="Zavřít konzoli"
          onClick={() => manager.close(deviceID)}
        >
          <Icon name="close" size={10} />
        </button>
        <span className="console-title" id={titleID}>
          {title}
        </span>
      </div>

      <div
        className="console-scrollback"
        ref={scrollRef}
        tabIndex={-1}
        role="log"
        aria-label="Výstup konzole"
        onKeyDown={onScrollbackKeyDown}
        onMouseUp={onScrollbackMouseUp}
      >
        {chunks.map((chunk, index) => (
          <ChunkView key={`${model.generation}-${index}`} chunk={chunk} />
        ))}
      </div>

      <div className="console-inputline" onClick={focusInput}>
        <span className="console-prompt">{model.prompt}</span>
        <input
          ref={inputRef}
          className="console-input"
          type="text"
          value={input}
          aria-label="Příkazový řádek"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onInputKeyDown}
          onPaste={onPaste}
        />
      </div>

      <div className="console-footer" title={model.footerText}>
        {model.footerText}
      </div>

      <div
        className="console-resize"
        aria-hidden="true"
        onPointerDown={onPointerDown("resize")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    </div>
  );
});

/** Ctrl-C/Z/P/N keep their console meaning even when typed with the scrollback focused. */
function handlesControlKey(event: ReactKeyboardEvent): boolean {
  if (!event.ctrlKey || event.metaKey || event.altKey) return false;
  return ["c", "z", "p", "n"].includes(event.key.toLowerCase());
}

/** One scrollback chunk; immutable, so it renders once. */
const ChunkView = memo(function ChunkView({ chunk }: { chunk: ConsoleChunk }) {
  switch (chunk.kind) {
    case "banner":
    case "notice":
      return <div className="chunk dim">{chunk.text}</div>;
    case "echo":
      return (
        <div className="chunk">
          <span className="prompt">{chunk.prompt}</span>
          <span className="command">{chunk.text}</span>
        </div>
      );
    case "output": {
      const lines = chunk.text.split("\n");
      return (
        <div className="chunk">
          {lines.map((line, index) => (
            <span key={index} className={isDiagnosticLine(line) ? "error" : undefined}>
              {line}
              {index < lines.length - 1 ? "\n" : ""}
            </span>
          ))}
        </div>
      );
    }
  }
});
