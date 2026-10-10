// Errors of the editing engine and the catalog (EditError.swift, CatalogError in
// DeviceCatalog.swift). Unlike the Swift core, the errors carry their Czech message
// (the texts of CzechText.swift in the Swift app), ready for the UI.

import type { PortRef, Project } from "./model";
import { resolveRef } from "./project";
import type { EditErrorCode } from "./store-api";

/** What an `EditError` is about; which fields are set depends on the code. */
export interface EditErrorDetails {
  /** The device, link, bundle, annotation or template id (`unknown*`, `linkAlreadyBundled`). */
  id?: string;
  /** The port (`unknownPort`, `portInUse`). */
  ref?: PortRef;
  /** Why the file could not be read (`invalidFile`), a Czech fragment. */
  detail?: string;
  /** Format version found in the file (`newerFormat`). */
  foundVersion?: number;
  /** Highest format version this build reads (`newerFormat`). */
  supportedVersion?: number;
}

/**
 * Why an editing operation (or opening a file) was refused. The project is unchanged when
 * an operation throws. `message` is a Czech sentence.
 */
export class EditError extends Error {
  readonly code: EditErrorCode;
  readonly id?: string;
  readonly ref?: PortRef;
  readonly detail?: string;
  readonly foundVersion?: number;
  readonly supportedVersion?: number;

  /** `project` lets the message name the port of a `portInUse` error. */
  constructor(code: EditErrorCode, details: EditErrorDetails = {}, project?: Project, options?: ErrorOptions) {
    super(editErrorMessage(code, details, project), options);
    this.name = "EditError";
    this.code = code;
    if (details.id !== undefined) this.id = details.id;
    if (details.ref !== undefined) this.ref = { deviceID: details.ref.deviceID, portID: details.ref.portID };
    if (details.detail !== undefined) this.detail = details.detail;
    if (details.foundVersion !== undefined) this.foundVersion = details.foundVersion;
    if (details.supportedVersion !== undefined) this.supportedVersion = details.supportedVersion;
  }
}

/** The Czech message of an edit error (CzechText.message(for: EditError) in the Swift app). */
export function editErrorMessage(code: EditErrorCode, details: EditErrorDetails = {}, project?: Project): string {
  switch (code) {
    case "unknownTemplate":
      return `Šablona zařízení „${details.id ?? ""}“ v katalogu neexistuje.`;
    case "unknownDevice":
      return "Zařízení už v projektu není.";
    case "unknownPort":
      return "Port nebo jeho zařízení už v projektu není.";
    case "unknownLink":
      return "Kabel už v projektu není.";
    case "unknownBundle":
      return "Svazek už v projektu není.";
    case "unknownAnnotation":
      return "Poznámka už v projektu není.";
    case "emptyName":
      return "Název nesmí být prázdný.";
    case "samePort":
      return "Kabel nelze zapojit oběma konci do stejného portu.";
    case "sameDevice":
      return "Kabel nelze zapojit oběma konci do stejného zařízení.";
    case "portInUse":
      return `V portu už kabel je (${describePort(details.ref, project)}). Do jednoho portu lze zapojit jen jeden kabel.`;
    case "bundleNeedsTwoLinks":
      return "Svazek (LAG) potřebuje alespoň dva kabely.";
    case "bundleNeedsSameDevices":
      return "Do svazku (LAG) lze seskupit jen kabely mezi stejnou dvojicí zařízení.";
    case "linkAlreadyBundled":
      return "Některý z vybraných kabelů už patří do jiného svazku. Nejprve ten svazek zrušte.";
    case "invalidFile":
      return (
        "Soubor není platný projekt NetSketch (obsah se nepodařilo načíst)." +
        (details.detail ? ` Podrobnosti: ${details.detail}` : "")
      );
    case "newerFormat":
      return (
        `Soubor je ve formátu verze ${details.foundVersion ?? "?"}, ` +
        `tato verze aplikace umí nejvýše verzi ${details.supportedVersion ?? "?"}.`
      );
  }
}

/** "port Fa0/1 na zařízení SW1", or just "port" when the reference does not resolve. */
function describePort(ref: PortRef | undefined, project: Project | undefined): string {
  const resolved = ref && project ? resolveRef(project, ref) : undefined;
  return resolved ? `port ${resolved.port.name} na zařízení ${resolved.device.hostname}` : "port";
}

export type CatalogErrorCode = "duplicateID" | "unknownTemplate" | "notCustom" | "invalidTemplate";

/** Why a catalog operation was refused. `message` is a Czech sentence. */
export class CatalogError extends Error {
  readonly code: CatalogErrorCode;
  /** The template id the error is about (empty for `invalidTemplate`). */
  readonly id: string;

  constructor(code: CatalogErrorCode, id = "") {
    super(catalogErrorMessage(code, id));
    this.name = "CatalogError";
    this.code = code;
    this.id = id;
  }
}

/** The Czech message of a catalog error (CzechText.message(for: CatalogError) in the Swift app). */
export function catalogErrorMessage(code: CatalogErrorCode, id: string): string {
  switch (code) {
    case "duplicateID":
      return `Zařízení s identifikátorem „${id}“ už v katalogu je. Změňte výrobce nebo model.`;
    case "unknownTemplate":
      return `Vlastní zařízení „${id}“ v katalogu není.`;
    case "notCustom":
      return `Zařízení „${id}“ je vestavěné a nelze ho měnit ani mazat.`;
    case "invalidTemplate":
      return "Zařízení nelze uložit: chybí název modelu.";
  }
}
