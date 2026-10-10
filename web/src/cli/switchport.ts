// The switchport configuration of one port, stored in the free-text `Port.vlan` field.
// Port of SwitchportConfig.swift (NetSketchCLI).
//
// Canonical text format (the ONLY format the CLI writes; documented for the inspector too):
//
//     ""                        no switchport configuration (access VLAN 1, mode not set)
//     "10"                      switchport access vlan 10            (mode not set)
//     "access 10"               switchport mode access + switchport access vlan 10
//     "trunk"                   switchport mode trunk                (all VLANs, native 1)
//     "trunk 10,20,30-40"       ... + switchport trunk allowed vlan 10,20,30-40
//     "trunk native 99"         ... + switchport trunk native vlan 99
//     "trunk 10,20 native 99"   both
//     "trunk none"              ... + switchport trunk allowed vlan none
//
// Settings of the mode that is currently NOT active are kept behind a semicolon, so that the
// order in which the commands are typed does not matter:
//
//     "trunk 10,20; access 30"          mode trunk, access VLAN 30 remembered
//     "access 30; trunk 10,20 native 99"   mode access, trunk settings remembered
//     "30; trunk 10,20"                 mode not set, both remembered
//
// The first clause decides the mode: a bare number means "mode not set". Keywords are
// case-insensitive and extra spaces are ignored when reading. Anything else (for example a
// note typed by hand into the inspector) is NOT canonical: `parse` returns null and the CLI
// shows the text unchanged in a remark line instead of interpreting it.

import { charCount, splitWords, trimWhitespacesAndNewlines, VLANListParser } from "./command-tree";

/** `unset`: no `switchport mode` line (IOS default). */
export type SwitchportMode = "unset" | "access" | "trunk";

export class SwitchportConfig {
  mode: SwitchportMode = "unset";
  accessVLAN = 1;
  /** VLANs allowed on the trunk; null means all (1-4094), an empty array means none. */
  allowedVLANs: number[] | null = null;
  nativeVLAN = 1;

  /** 1...4094 */
  static readonly allVLANs = { lowerBound: 1, upperBound: 4094, count: 4094 } as const;

  /** Every VLAN id 1...4094, in order. */
  static allVLANList(): number[] {
    return Array.from({ length: SwitchportConfig.allVLANs.count }, (_, index) => index + 1);
  }

  constructor(init?: Partial<Pick<SwitchportConfig, "mode" | "accessVLAN" | "allowedVLANs" | "nativeVLAN">>) {
    if (init) {
      if (init.mode !== undefined) this.mode = init.mode;
      if (init.accessVLAN !== undefined) this.accessVLAN = init.accessVLAN;
      if (init.allowedVLANs !== undefined) this.allowedVLANs = init.allowedVLANs === null ? null : [...init.allowedVLANs];
      if (init.nativeVLAN !== undefined) this.nativeVLAN = init.nativeVLAN;
    }
  }

  /** A copy (Swift structs are values). */
  clone(): SwitchportConfig {
    return new SwitchportConfig(this);
  }

  /** Overwrites every field with the ones of `other` (Swift `config = other` on an inout value). */
  assign(other: SwitchportConfig): void {
    this.mode = other.mode;
    this.accessVLAN = other.accessVLAN;
    this.allowedVLANs = other.allowedVLANs === null ? null : [...other.allowedVLANs];
    this.nativeVLAN = other.nativeVLAN;
  }

  equals(other: SwitchportConfig): boolean {
    if (this.mode !== other.mode || this.accessVLAN !== other.accessVLAN || this.nativeVLAN !== other.nativeVLAN) {
      return false;
    }
    if (this.allowedVLANs === null || other.allowedVLANs === null) return this.allowedVLANs === other.allowedVLANs;
    return (
      this.allowedVLANs.length === other.allowedVLANs.length &&
      this.allowedVLANs.every((value, index) => value === other.allowedVLANs![index])
    );
  }

  get hasTrunkSettings(): boolean {
    return this.allowedVLANs !== null || this.nativeVLAN !== 1;
  }

  get isDefault(): boolean {
    return this.equals(new SwitchportConfig());
  }

  /** The VLANs a trunk carries according to the configuration (all when unrestricted). */
  allows(vlan: number): boolean {
    if (this.allowedVLANs === null) return true;
    return this.allowedVLANs.includes(vlan);
  }

  // MARK: Writing

  /** The canonical text for `Port.vlan`. */
  get canonicalText(): string {
    switch (this.mode) {
      case "unset":
        if (!this.hasTrunkSettings) return this.accessVLAN === 1 ? "" : `${this.accessVLAN}`;
        return `${this.accessVLAN}; ${this.trunkClause}`;
      case "access":
        return this.hasTrunkSettings ? `access ${this.accessVLAN}; ${this.trunkClause}` : `access ${this.accessVLAN}`;
      case "trunk":
        return this.accessVLAN === 1 ? this.trunkClause : `${this.trunkClause}; access ${this.accessVLAN}`;
    }
  }

  private get trunkClause(): string {
    let text = "trunk";
    if (this.allowedVLANs !== null) {
      text += this.allowedVLANs.length === 0 ? " none" : " " + VLANListParser.format(this.allowedVLANs);
    }
    if (this.nativeVLAN !== 1) text += ` native ${this.nativeVLAN}`;
    return text;
  }

  // MARK: Reading

  /** Parses canonical text. Returns null for anything that is not in the documented format. */
  static parse(text: string): SwitchportConfig | null {
    const trimmed = trimWhitespacesAndNewlines(text);
    if (trimmed === "") return new SwitchportConfig();
    if (charCount(trimmed) > 600) return null;

    const clauses = trimmed
      .toLowerCase()
      .split(";")
      .map((clause) => splitWords(clause));
    if (clauses.length < 1 || clauses.length > 2 || !clauses.every((clause) => clause.length > 0)) return null;

    const config = new SwitchportConfig();
    const first = clauses[0];
    switch (first[0]) {
      case "access":
        config.mode = "access";
        if (!config.readAccess(first)) return null;
        break;
      case "trunk":
        config.mode = "trunk";
        if (!config.readTrunk(first)) return null;
        break;
      default: {
        const vlan = first.length === 1 ? SwitchportConfig.vlanID(first[0]) : null;
        if (vlan === null) return null;
        config.mode = "unset";
        config.accessVLAN = vlan;
      }
    }

    if (clauses.length === 2) {
      const second = clauses[1];
      if (config.mode === "trunk" && second[0] === "access") {
        // The remembered access VLAN must be explicit here.
        if (second.length !== 2 || !config.readAccess(second)) return null;
      } else if ((config.mode === "access" || config.mode === "unset") && second[0] === "trunk") {
        if (!config.readTrunk(second)) return null;
      } else {
        return null;
      }
    }
    return config;
  }

  /** Reads `access [N]`. */
  private readAccess(words: string[]): boolean {
    switch (words.length) {
      case 1:
        this.accessVLAN = 1;
        return true;
      case 2: {
        const vlan = SwitchportConfig.vlanID(words[1]);
        if (vlan === null) return false;
        this.accessVLAN = vlan;
        return true;
      }
      default:
        return false;
    }
  }

  /** Reads `trunk [LIST|all|none] [native N]`. */
  private readTrunk(words: string[]): boolean {
    let rest = words.slice(1);
    const next = rest[0];
    if (next !== undefined && next !== "native") {
      switch (next) {
        case "all":
          this.allowedVLANs = null;
          break;
        case "none":
          this.allowedVLANs = [];
          break;
        default: {
          const list = VLANListParser.parse(next);
          if (list === null) return false;
          this.allowedVLANs = list.length === SwitchportConfig.allVLANs.count ? null : list;
        }
      }
      rest = rest.slice(1);
    }
    if (rest[0] === "native") {
      rest = rest.slice(1);
      const vlanWord = rest[0];
      const vlan = vlanWord === undefined ? null : SwitchportConfig.vlanID(vlanWord);
      if (vlan === null) return false;
      this.nativeVLAN = vlan;
      rest = rest.slice(1);
    }
    return rest.length === 0;
  }

  private static vlanID(text: string): number | null {
    if (!/^[0-9]{1,4}$/.test(text)) return null;
    const value = Number(text);
    return value >= 1 && value <= 4094 ? value : null;
  }
}
