// Opening and saving files in the browser. Uses the File System Access API where available
// (Chromium: real "Save" back into the same file), otherwise <input type=file> for opening and a
// download for saving. The rest of the shell talks to this through the ProjectFiles interface,
// so tests can replace it.

/** Opaque handle of a file the browser lets us write to again (FileSystemFileHandle). */
export interface WritableFileHandle {
  readonly name: string;
  createWritable(): Promise<{ write(data: Blob | string): Promise<void>; close(): Promise<void> }>;
  getFile?(): Promise<File>;
}

export interface OpenedFile {
  name: string;
  text: string;
  handle: WritableFileHandle | null;
}

export interface SavedFile {
  name: string;
  handle: WritableFileHandle | null;
}

export type ExportKind = "png" | "pdf" | "svg";

export interface ProjectFiles {
  /** Asks for a project file to open. Resolves to null when cancelled. */
  openProject(): Promise<OpenedFile | null>;
  /**
   * Writes the project. With a handle it is written there silently ("Uložit"); without one the
   * user picks a destination ("Uložit jako…"). Resolves to null when cancelled.
   */
  saveProject(text: string, suggestedName: string, handle: WritableFileHandle | null): Promise<SavedFile | null>;
  /** Writes an exported image or PDF. Resolves to false when cancelled. */
  saveExport(data: Blob, suggestedName: string, kind: ExportKind): Promise<boolean>;
}

export const projectExtension = "netsketch";

// MARK: File System Access API (not in lib.dom yet)

interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}

interface FileSystemAccessWindow {
  showOpenFilePicker?(options: {
    types?: PickerType[];
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
  }): Promise<WritableFileHandle[]>;
  showSaveFilePicker?(options: {
    suggestedName?: string;
    types?: PickerType[];
    excludeAcceptAllOption?: boolean;
  }): Promise<WritableFileHandle>;
}

const projectPickerType: PickerType = {
  description: "Projekt NetSketch",
  accept: { "application/json": [".netsketch", ".json"] },
};

const exportPickerTypes: Record<ExportKind, PickerType> = {
  png: { description: "Obrázek PNG", accept: { "image/png": [".png"] } },
  pdf: { description: "Dokument PDF", accept: { "application/pdf": [".pdf"] } },
  svg: { description: "Vektorový obrázek SVG", accept: { "image/svg+xml": [".svg"] } },
};

function fsa(): FileSystemAccessWindow | null {
  return typeof window === "undefined" ? null : (window as unknown as FileSystemAccessWindow);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** True when the browser can write back into an opened file. */
export function supportsFileSystemAccess(): boolean {
  const api = fsa();
  return !!api && typeof api.showSaveFilePicker === "function" && typeof api.showOpenFilePicker === "function";
}

// MARK: Fallbacks

/** Opens a file through a temporary <input type=file>. */
function pickWithInput(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => finish(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

/** Saves through a download (the browser decides where the file goes). */
export function downloadBlob(data: Blob, fileName: string): void {
  const url = URL.createObjectURL(data);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser time to start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function writeTo(handle: WritableFileHandle, data: Blob | string): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

// MARK: Browser implementation

export const browserFiles: ProjectFiles = {
  async openProject() {
    const api = fsa();
    if (api?.showOpenFilePicker) {
      try {
        const [handle] = await api.showOpenFilePicker({ types: [projectPickerType], multiple: false });
        if (!handle?.getFile) return null;
        const file = await handle.getFile();
        return { name: file.name, text: await file.text(), handle };
      } catch (error) {
        if (isAbort(error)) return null;
        // E.g. no user activation left after a confirm dialog: fall back to the plain picker.
      }
    }
    const file = await pickWithInput(".netsketch,.json,application/json");
    if (!file) return null;
    return { name: file.name, text: await file.text(), handle: null };
  },

  async saveProject(text, suggestedName, handle) {
    if (handle) {
      await writeTo(handle, text);
      return { name: handle.name, handle };
    }
    const api = fsa();
    if (api?.showSaveFilePicker) {
      let picked: WritableFileHandle;
      try {
        picked = await api.showSaveFilePicker({
          suggestedName,
          types: [{ description: projectPickerType.description, accept: { "application/json": [".netsketch"] } }],
        });
      } catch (error) {
        if (isAbort(error)) return null;
        throw error;
      }
      await writeTo(picked, text);
      return { name: picked.name, handle: picked };
    }
    downloadBlob(new Blob([text], { type: "application/json" }), suggestedName);
    return { name: suggestedName, handle: null };
  },

  async saveExport(data, suggestedName, kind) {
    const api = fsa();
    if (api?.showSaveFilePicker) {
      let picked: WritableFileHandle;
      try {
        picked = await api.showSaveFilePicker({ suggestedName, types: [exportPickerTypes[kind]] });
      } catch (error) {
        if (isAbort(error)) return false;
        throw error;
      }
      await writeTo(picked, data);
      return true;
    }
    downloadBlob(data, suggestedName);
    return true;
  },
};
