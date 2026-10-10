// Czech user-facing texts for the model's enums, plus small text helpers used by the shell.
// Port of Sources/NetSketch/Support/CzechText.swift (the parts the web shell needs).

import type {
  CableType,
  ConnectorType,
  DeviceCategory,
  DeviceTemplate,
  LinkStatus,
  PortGroup,
  ViewMode,
} from "../core/model";

export const categoryOrder: DeviceCategory[] = ["switch", "router", "L3 switch", "AP", "PC", "server"];

/** Singular, e.g. for the inspector. */
export function categoryName(category: DeviceCategory): string {
  switch (category) {
    case "switch":
      return "Switch";
    case "router":
      return "Router";
    case "L3 switch":
      return "L3 switch";
    case "AP":
      return "Access point";
    case "PC":
      return "Počítač";
    case "server":
      return "Server";
  }
}

/** Plural, for palette section headers. */
export function categoryPlural(category: DeviceCategory): string {
  switch (category) {
    case "switch":
      return "Switche";
    case "router":
      return "Routery";
    case "L3 switch":
      return "L3 switche";
    case "AP":
      return "Access pointy";
    case "PC":
      return "Počítače";
    case "server":
      return "Servery";
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
      return "Konzole";
    case "mgmt":
      return "Management";
    case "wireless":
      return "Wi-Fi";
  }
}

export const cableTypes: CableType[] = ["straight", "crossover", "console", "fiber"];

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

/** Longer form for menus and tooltips. */
export function cableDescription(type: CableType): string {
  switch (type) {
    case "straight":
      return "Přímý kabel (straight-through)";
    case "crossover":
      return "Křížený kabel (crossover)";
    case "console":
      return "Konzolový kabel (rollover)";
    case "fiber":
      return "Optický kabel";
  }
}

export const linkStatuses: LinkStatus[] = ["none", "green", "orange", "red"];

export function linkStatusName(status: LinkStatus): string {
  switch (status) {
    case "none":
      return "Žádný";
    case "green":
      return "Zelená";
    case "orange":
      return "Oranžová";
    case "red":
      return "Červená";
  }
}

export function viewModeName(mode: ViewMode): string {
  return mode === "physical" ? "Fyzický" : "Logický";
}

export const verifyHint = "Ověřit podle hardwaru";

/** Czech plural form: 1 / 2-4 / other. */
export function plural(count: number, one: string, few: string, many: string): string {
  if (count === 1) return one;
  if (count >= 2 && count <= 4) return few;
  return many;
}

/** "1 port", "3 porty", "24 portů". */
export function portsText(count: number): string {
  return `${count} ${plural(count, "port", "porty", "portů")}`;
}

/** "1 kabel", "2 kabely", "5 kabelů". */
export function cablesText(count: number): string {
  return `${count} ${plural(count, "kabel", "kabely", "kabelů")}`;
}

export function devicesText(count: number): string {
  return `${count} zařízení`;
}

/** "1 poznámka", "2 poznámky", "5 poznámek". */
export function notesText(count: number): string {
  return `${count} ${plural(count, "poznámka", "poznámky", "poznámek")}`;
}

// MARK: Port names (mirrors PortGroup / PortNaming of NetSketchCore)

/** Generated port names of a catalog port group, in panel order. Empty for a placeholder. */
export function portNames(group: PortGroup): string[] {
  if (group.placeholder) return [];
  if (group.names) return group.names;
  const start = group.rangeStart ?? 1;
  const end = group.rangeEnd ?? start;
  const step = Math.max(1, group.step ?? 1);
  const prefix = group.prefix ?? "";
  const suffix = group.suffix ?? "";
  const names: string[] = [];
  for (let n = start; n <= end; n += step) names.push(prefix + String(n) + suffix);
  return names;
}

export function templatePortCount(template: DeviceTemplate): number {
  return template.portGroups.reduce((sum, group) => sum + portNames(group).length, 0);
}

/** True when the template or any of its port groups is still unverified. */
export function templateNeedsVerification(template: DeviceTemplate): boolean {
  return !template.verified || template.portGroups.some((group) => !group.verified);
}

/** "Vendor Model". */
export function displayName(vendor: string, model: string): string {
  return [vendor, model].filter((part) => part !== "").join(" ");
}

const shortNameRules: [string, string][] = [
  ["TwentyFiveGigabitEthernet", "Twe"],
  ["HundredGigabitEthernet", "Hu"],
  ["FortyGigabitEthernet", "Fo"],
  ["TenGigabitEthernet", "Te"],
  ["FiveGigabitEthernet", "Fi"],
  ["TwoGigabitEthernet", "Tw"],
  ["ManagementEthernet", "Ma"],
  ["GigabitEthernet", "Gi"],
  ["TwentyFiveGigE", "Twe"],
  ["FastEthernet", "Fa"],
  ["Port-channel", "Po"],
  ["HundredGigE", "Hu"],
  ["FortyGigE", "Fo"],
  ["Loopback", "Lo"],
  ["Ethernet", "Eth"],
  ["TenGigE", "Te"],
  ["Serial", "Se"],
  ["Vlan", "Vl"],
];

/** Short form of an interface name: "GigabitEthernet 1/1" -> "Gi1/1", "Fa0/1" stays. */
export function shortPortName(name: string): string {
  const trimmed = name.trim();
  for (const [long, short] of shortNameRules) {
    if (trimmed.length < long.length || trimmed.slice(0, long.length).toLowerCase() !== long.toLowerCase()) {
      continue;
    }
    const tail = trimmed.slice(long.length).replace(/^ +/, "");
    if (tail.length > 0 && tail[0] >= "0" && tail[0] <= "9") return short + tail;
  }
  return trimmed;
}

/**
 * Short port summary of a template for the palette, e.g. "24× Fa, 2× Gi".
 * Console and management ports are left out; they would only add noise.
 */
export function portSummary(template: DeviceTemplate): string {
  const parts: { label: string; count: number }[] = [];
  for (const group of template.portGroups) {
    if (group.placeholder) continue;
    if (group.connector === "console" || group.connector === "mgmt") continue;
    const count = portNames(group).length;
    if (count <= 0) continue;
    const label = summaryLabel(group);
    const last = parts[parts.length - 1];
    if (last && last.label === label) {
      last.count += count;
    } else {
      parts.push({ label, count });
    }
  }
  if (parts.length === 0) return portsText(templatePortCount(template));
  return parts.map((part) => `${part.count}× ${part.label}`).join(", ");
}

/** The letters in front of the port number ("Fa", "Gi", "ether"), or the connector name. */
function summaryLabel(group: PortGroup): string {
  if (group.connector === "wireless") return connectorName("wireless");
  const first = portNames(group)[0];
  if (group.names || first === undefined) return connectorName(group.connector);
  const short = shortPortName(first);
  let letters = "";
  for (const ch of short) {
    if (ch >= "0" && ch <= "9") break;
    letters += ch;
  }
  letters = letters.replace(/^[ /\-_.]+|[ /\-_.]+$/g, "");
  return letters === "" ? connectorName(group.connector) : letters;
}

// MARK: Search

/** Case- and diacritic-insensitive form for searching ("Počítače" ~ "pocitace"). */
export function foldForSearch(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("cs");
}

/** Like Foundation's localizedStandardContains: case and diacritics are ignored. */
export function containsText(haystack: string, query: string): boolean {
  return foldForSearch(haystack).includes(foldForSearch(query));
}

// MARK: File names

/** `name` ending in `.ext`; other dots are left alone ("Cvičení 3.1" stays a name). */
export function withExtension(name: string, ext: string): string {
  if (ext === "") return name;
  return name.toLowerCase().endsWith("." + ext.toLowerCase()) ? name : `${name}.${ext}`;
}

/** File name without its last extension. */
export function withoutExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
