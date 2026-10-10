// Deterministic MAC addresses: the diagram stores none, so one is derived from the port's UUID
// (the same port always gets the same address). Used by STP bridge ids, DHCP bindings, ARP and
// `ipconfig /all`.

function hash(text: string): number {
  // FNV-1a, 32 bits.
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

/** Six bytes; locally administered unicast (x2:...), unique enough for a diagram. */
export function macBytes(id: string): number[] {
  const upper = id.toUpperCase();
  const a = hash(upper);
  const b = hash(upper + "#");
  return [0x02, (a >>> 24) & 0xff, (a >>> 16) & 0xff, (a >>> 8) & 0xff, a & 0xff, b & 0xff];
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}

export type MACFormat = "cisco" | "windows" | "colon";

/** "0212.3456.789a" (Cisco), "02-12-34-56-78-9A" (Windows) or "02:12:34:56:78:9A" (MikroTik, EdgeOS). */
export function macAddress(id: string, format: MACFormat = "colon"): string {
  const bytes = macBytes(id).map(hex);
  switch (format) {
    case "cisco":
      return `${bytes[0]}${bytes[1]}.${bytes[2]}${bytes[3]}.${bytes[4]}${bytes[5]}`;
    case "windows":
      return bytes.join("-").toUpperCase();
    case "colon":
      return bytes.join(":").toUpperCase();
  }
}

/** The bridge MAC of a switch: that of its first port (or of the device id when it has none). */
export function bridgeMAC(device: { id: string; ports: { id: string }[] }, format: MACFormat = "cisco"): string {
  return macAddress(device.ports[0]?.id ?? device.id, format);
}
