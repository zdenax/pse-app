// User-facing texts of the canvas (Czech), kept in one place (port of CanvasStrings.swift), and
// the hover tag lines (tooltipLines of CanvasNSView.swift).

import type { CableType, ConnectorType, LinkStatus, PortRef, Project } from "../core/model";
import { shortName } from "../core/port-naming";
import { bundleOfLink, findBundle, findLink, linkRef, linkStatus, peerOf, resolveRef } from "../core/project";
import { czechPlural } from "../core/util";
import type { CanvasHit } from "./scene";

export const CanvasStrings = {
  verifyAgainstHardware: "Ověřit podle hardwaru",
  emptyProject: "Prázdný projekt",
  emptyCanvasHint: "Přetáhněte zařízení z palety na plátno",
  pendingHint: "Klikněte na cílový port. Esc zruší.",
  newAnnotationPlaceholder: "Poznámka",
  canvasLabel: "Plátno topologie",

  menuRename: "Přejmenovat",
  menuDelete: "Odstranit",
  menuEditText: "Upravit text",
  menuDeleteCable: "Odstranit kabel",
  menuCableType: "Typ kabelu",
  menuBundle: "Sloučit do svazku (LAG)",
  menuUnbundle: "Zrušit svazek",
  menuRenameBundle: "Přejmenovat svazek",
  menuAddAnnotation: "Přidat poznámku",
  menuSelectAll: "Vybrat vše",
  menuZoomToFit: "Přizpůsobit zobrazení",
  menuActualSize: "Skutečná velikost",
  menuStatusA: "Stav konce A",
  menuStatusB: "Stav konce B",
  menuOpenConsole: "Otevřít konzoli",
  operationFailed: "Operaci nelze provést.",
} as const;

export function cableName(type: CableType): string {
  switch (type) {
    case "straight":
      return "Přímý";
    case "crossover":
      return "Křížený";
    case "console":
      return "Konzolový";
    case "fiber":
      return "Optický";
  }
}

export function statusName(status: LinkStatus): string {
  switch (status) {
    case "none":
      return "bez označení";
    case "green":
      return "zelená";
    case "orange":
      return "oranžová";
    case "red":
      return "červená";
  }
}

export function connectorName(connector: ConnectorType): string {
  switch (connector) {
    case "RJ45":
      return "RJ45";
    case "SFP":
      return "SFP";
    case "SFP+":
      return "SFP+";
    case "QSFP+":
      return "QSFP+";
    case "console":
      return "konzole";
    case "mgmt":
      return "management";
    case "wireless":
      return "bezdrátové rozhraní";
  }
}

/** "SW1 Fa0/1" for messages and tooltips. */
export function portTitle(ref: PortRef, project: Project): string {
  const resolved = resolveRef(project, ref);
  if (!resolved) return "port";
  return `${resolved.device.hostname} ${shortName(resolved.port.name)}`;
}

function cablesCount(count: number): string {
  return `${count} ${czechPlural(count, "kabel", "kabely", "kabelů")}`;
}

const dot = " · ";

/** Lines of the hover tag for an element; the first line is the title. Empty: no tag. */
export function tooltipLines(hit: CanvasHit, project: Project): string[] {
  switch (hit.kind) {
    case "port": {
      const resolved = resolveRef(project, hit.ref);
      if (!resolved) return [];
      const port = resolved.port;
      const short = shortName(port.name);
      const lines = [short === port.name ? port.name : `${port.name} (${short})`];
      const facts = [connectorName(port.connector)];
      if (port.speed !== "") facts.push(port.speed);
      const peer = peerOf(project, hit.ref);
      facts.push(peer ? `zapojeno do ${peer.device.hostname} ${shortName(peer.port.name)}` : "volný");
      lines.push(facts.join(dot));
      const extra: string[] = [];
      if (port.vlan !== "") extra.push(`VLAN ${port.vlan}`);
      if (port.description !== "") extra.push(port.description);
      if (port.adminDown) extra.push("vypnutý (shutdown)");
      if (extra.length > 0) lines.push(extra.join(dot));
      if (!port.verified) lines.push(CanvasStrings.verifyAgainstHardware);
      return lines;
    }
    case "warning":
      return [CanvasStrings.verifyAgainstHardware];
    case "statusDot": {
      const link = findLink(project, hit.linkID);
      if (!link) return [];
      return [
        `Stav konce ${portTitle(linkRef(link, hit.end), project)}: ${statusName(linkStatus(link, hit.end))}`,
        "Kliknutím přepnete.",
      ];
    }
    case "link": {
      const first = hit.ids[0];
      const link = first !== undefined ? findLink(project, first) : undefined;
      if (!link) return [];
      if (hit.ids.length > 1) {
        const label = bundleOfLink(project, link.id)?.label ?? "";
        return [`Svazek ${label}`, cablesCount(hit.ids.length)];
      }
      const lines = [`${portTitle(link.a, project)} – ${portTitle(link.b, project)}`];
      const facts = [`${cableName(link.cableType)} kabel`];
      const bundle = bundleOfLink(project, link.id);
      if (bundle) facts.push(`svazek ${bundle.label}`);
      lines.push(facts.join(dot));
      if (link.note !== "") lines.push(link.note);
      return lines;
    }
    case "bundleLabel": {
      const label = findBundle(project, hit.bundleID)?.label ?? "";
      return [`Svazek ${label}`, `${cablesCount(hit.linkIDs.length)}${dot}dvojklikem přejmenujete`];
    }
    default:
      return [];
  }
}

/** Capitalizes the first letter ("zelená" -> "Zelená"). */
export function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
