---
name: NetSketch (web)
description: Network topology editor, chrome labelled like a structured-cabling plan.
colors:
  cable-blue: "#1f5cc8"
  cable-blue-hover: "#194ca6"
  destructive: "#b8312a"
  rack-graphite: "#1b1f24"
  rack-raised: "#2a3038"
  rack-line: "#3a414a"
  rack-fg: "#eef1f4"
  rack-muted: "#aab3bd"
  label-stock: "#f2f4f6"
  label-card: "#e7eaee"
  label-surface: "#ffffff"
  sidebar: "#eceff2"
  inspector: "#f7f8fa"
  ink: "#15191e"
  ink-muted: "#4f5964"
  rule: "#cdd3da"
  rule-strong: "#9aa3ad"
  control-border: "#bcc4cd"
  dark-background: "#121518"
  dark-surface: "#181b20"
  dark-card: "#1c2025"
  dark-foreground: "#e8ebef"
  dark-rule: "#2f353d"
  dark-cable-blue: "#7aa7ff"
typography:
  title:
    fontFamily: "Barlow Semi Condensed, Barlow, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.2
  body-dense:
    fontFamily: "Barlow, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.35
  label:
    fontFamily: "Barlow Semi Condensed, Barlow, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
  mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, Liberation Mono, monospace"
    fontSize: "13px"
rounded:
  tag: "2px"
  sm: "3px"
  md: "4px"
  container: "6px"
---

# Design System: NetSketch (web)

The editor's chrome uses the "kabelážní plán" (cabling plan) system of the NetLab redesign, adapted to NetSketch: no NetLab layer, no roles, no status strip. Tokens live in `src/ui/styles.css`; light and dark differ only in the `:root` and `prefers-color-scheme: dark` token blocks.

## Overview

- A **graphite toolbar** (50px, full width, the same graphite in both appearances) on top. Inside it the derived tokens switch to dark values; menus opened from it switch back to page colours.
- **Label-stock neutrals** below: sidebar (palette), canvas, inspector separated by 1px rules and tonal steps, not shadows.
- Nearly square corners: tags 2px, controls 3px, segmented groups 4px, menus, modals and console windows 6px.
- **Barlow** for UI text, **Barlow Semi Condensed** 600 for titles, section labels, vendor/category headers and tags; system mono for ports, addresses and the console. Self-hosted via `@fontsource` (bundled by Vite, every subset the package ships, including latin-ext for Czech), no CDN. Sentence case, no uppercase tracking.
- Tabular figures for counts, zoom percent and shortcuts.

## Colours

- **Cable blue** (`--primary`): primary button, focus ring and halo, links (peer ports), selected state ring, "vlastní" tag.
- **Destructive** (`--destructive`): errors, "shutdown" toggle when on, delete icons.
- **Rack graphite** (`--rack*`): the toolbar and console window frames.
- **Inherited, unchanged** (NetSketch brand, shared with the native app and exports): canvas (`canvas/palette.ts`, `--canvas-bg`, `--grid-dot`, `--ink`, `--panel-*`), cable strokes, canvas status dots, device tiles (`--tile-*`), annotation colours and console text colours (`--console-text/command/prompt/error/dim`). Palette and inspector icons use the same tile colours as the canvas so a device looks the same everywhere. Do not use them for new chrome.

## Components

- **Buttons:** 3px radius, 1px border, min-height 28px. Primary is cable blue; secondary is surface with a stronger border and an 8% blue wash on hover. Disabled 45% opacity. 120ms colour transitions.
- **Toolbar buttons:** transparent, rack-muted; pressed toggles get a raised fill with a 1px inset rule.
- **Fields:** 1px control border, 3px radius; focus turns the border blue with a 3px halo.
- **Tags (`.chip`, `.toggle-chip`):** squared 2px label, condensed 600, 1px border at 32% of its own colour.
- **Inspector:** resizable from a handle on its left edge (260 to 560px, remembered in `localStorage` under `netsketch.inspectorWidth`, capped at 45vw); dragging below 200px, double-click or ArrowRight at the minimum width hides it, and a vertical "Zobrazit inspektor" tab on the canvas's right edge restores it.
- **Console windows:** graphite frame and title bar, 6px radius; text colours unchanged.
- **Modals:** 6px radius, modal shadow, 160ms ease-out entrance (off under reduced motion).

## Elevation

Flat by default. Shadows only on things that float: menus, popovers, the drag preview, modals and console windows.

## Don'ts

- Don't change `canvas/palette.ts`, `canvas/export.ts` or `exporters.ts` colours for looks: they are shared with exports and the Swift app.
- Don't use round pill badges or radii above 6px.
- Don't fetch fonts or assets at runtime.
