# Product

<!-- impeccable:product-schema 1 -->

> Inferred from `web/README.md`, the repository docs and the code by an unattended agent (no interview was possible). Every line below is an inference unless it quotes those sources; confirm or correct it.

## Platform

web (the same editor also exists as a native macOS app in the repository root; this file covers only `web/`).

## Users

- **Networking student** (primary, inferred): builds a topology from vendor devices, cables it on the canvas and configures it in device consoles (Cisco IOS, Dell OS9/OS6, MikroTik RouterOS, Ubiquiti, PC), often working through the bundled exercises (`#cviceni-1`, `#cviceni-2`).
- **Teacher / lab author** (inferred): prepares `.netsketch` exercise files, exports diagrams as PNG, PDF or SVG for handouts.

## Product Purpose

NetSketch is a network topology editor with vendor consoles and a network simulation. The web version is "the same application as the macOS version, just written in TypeScript" (README): it opens and saves the same `.netsketch` files and uses the same device catalog. Success: the user builds and verifies a network (ping, traceroute) without fighting the tool.

## Operating Context

- Desktop browsers on Windows, Linux and macOS; long sessions in a computer lab or at home, light and dark system appearance both in use (the shell follows `prefers-color-scheme`).
- Runs from any static host or file server (`base: "./"`); no runtime requests to external services, fonts included.
- Czech UI copy.

## Capabilities and Constraints

- Vite + React 18 + TypeScript; canvas is SVG.
- Behaviour, file format, exports and console output must stay identical to the Swift app; tests compare them byte for byte. Visual changes are limited to on-screen chrome.
- Canvas, device tile and export colours come from `canvas/palette.ts` (port of `Theme.swift`) and are shared with exports.

## Brand Commitments

- Name: **NetSketch**. Brand colours navy `#0B2545`, teal `#13A89E`, sand `#F4F1EA`, slate `#5C6B7A`, accent `#EE6C4D` live on the canvas and device tiles.
- No logo asset in `web/`.

## Product Principles

1. The network on the canvas is the subject; chrome recedes around it.
2. Dense but legible: many devices, ports and fields at once.
3. Parity with the native app is a feature, not a limitation.
4. Accessible in both appearances (visible focus, contrast, keyboard operation of panels).

## Accessibility & Inclusion

WCAG 2.2 AA as the working target (inferred). Visible keyboard focus, keyboard-operable panel handle, colour never the only carrier of state.
