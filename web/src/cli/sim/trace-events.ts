// Packets the consoles send (ping, traceroute, DHCP, ...), announced to whoever listens: the
// canvas animates them. Nothing listens in tests and in the Swift-compatible outputs.

import type { PacketSegment } from "./packet";

export interface PacketTrace {
  /** "ping", "traceroute", "dhcp", "tcp" ... */
  readonly kind: string;
  /** The device whose console sent it. */
  readonly deviceID: string;
  /** The way of the request, then (when it got there) of the reply. */
  readonly forward: PacketSegment[];
  readonly back: PacketSegment[];
  readonly success: boolean;
  /** The device where it was dropped or got lost, if any. */
  readonly failedAt: string | null;
}

type Listener = (trace: PacketTrace) => void;
const listeners = new Set<Listener>();

export function onPacketTrace(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitPacketTrace(trace: PacketTrace): void {
  for (const listener of [...listeners]) {
    try {
      listener(trace);
    } catch {
      // A broken listener must not break the console.
    }
  }
}
