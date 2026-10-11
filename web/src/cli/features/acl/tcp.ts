// A TCP connection attempt through the simulation (`Test-NetConnection -Port`, `telnet`): a SYN
// travels to the destination, the answer (SYN-ACK or RST) travels back. Both directions pass
// the packet filters like any other packet, so an access list can be tested with ports.

import { Delivery, type NetworkSimulator } from "../../sim/network-simulator";
import { IPv4 } from "../../sim/ipv4";
import type { Packet } from "../../sim/packet";
import { emitPacketTrace } from "../../sim/trace-events";
import { ephemeralStart } from "./rules";

export type TcpOutcome =
  /** The handshake completed. */
  | "open"
  /** The destination answered with a reset: nobody listens on the port. */
  | "refused"
  /** A router answered "unreachable" (administratively prohibited, no route). */
  | "unreachable"
  /** Nothing came back. */
  | "timeout";

export interface TcpProbe {
  outcome: TcpOutcome;
  /** The address the connection was opened from; null when the device has no route. */
  source: IPv4 | null;
  destination: IPv4;
  port: number;
  /** The interface the request left by; "" when there is none. */
  interfaceName: string;
  /** A Czech sentence saying why it did not work ("" for open and refused). */
  explanation: string;
}

/** The client port of a connection: from the ephemeral range, the same for the same connection. */
export function clientPort(from: string, destination: IPv4, port: number): number {
  let hash = port;
  for (const character of `${from}|${destination.description}`) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return ephemeralStart + (hash % 10000);
}

/** Servers listen on every port, routers and switches on SSH and telnet, PCs on none. */
export function listens(sim: NetworkSimulator, deviceID: string, port: number): boolean {
  const category = sim.device(deviceID)?.category;
  if (category === "server") return true;
  if (category === "PC" || category === undefined) return false;
  return port === 22 || port === 23;
}

function tcp(source: IPv4, destination: IPv4, sourcePort: number, destinationPort: number): Packet {
  return { source, destination, protocol: "tcp", icmpType: "", sourcePort, destinationPort, ttl: 255 };
}

export function tcpProbe(sim: NetworkSimulator, from: string, destination: IPv4, port: number): TcpProbe {
  const source = sim.sourceAddress(from, destination);
  const result = (outcome: TcpOutcome, explanation: string, interfaceName = ""): TcpProbe => ({
    outcome,
    source,
    destination,
    port,
    interfaceName,
    explanation,
  });
  if (!source) {
    const failure = new Delivery([], { kind: "noRoute", deviceID: from }).failure;
    return result("timeout", failure ? "NetSketch: spojení se nenavázalo – " + sim.explainFailure(failure, destination) : "");
  }
  const interfaceName = sim.lookup(destination, from)?.interface.name ?? "";
  const sourcePort = clientPort(from, destination, port);
  const request = sim.deliverPacket(from, tcp(source, destination, sourcePort, port));
  const failure = request.failure;
  const trace = (back: Delivery | null, success: boolean): void => {
    emitPacketTrace({
      kind: "tcp",
      deviceID: from,
      forward: request.segments,
      back: back?.segments ?? [],
      success,
      failedAt: request.failure ? (request.lastDevice ?? from) : back?.failure ? (back.lastDevice ?? request.lastDevice) : null,
    });
  };
  if (failure) {
    trace(null, false);
    const prohibited = failure.kind === "dropped" && failure.symbol === "U";
    const remoteNoRoute = failure.kind === "noRoute" && failure.deviceID !== from;
    return result(
      prohibited || remoteNoRoute ? "unreachable" : "timeout",
      "NetSketch: spojení se nenavázalo – " + sim.explainFailure(failure, destination),
      interfaceName,
    );
  }
  const arrived = request.packet ?? tcp(source, destination, sourcePort, port);
  const target = request.lastDevice ?? from;
  const reply = sim.deliverPacket(
    target,
    tcp(arrived.destination, arrived.source, arrived.destinationPort, arrived.sourcePort),
  );
  const open = listens(sim, target, arrived.destinationPort);
  trace(reply, reply.delivered && open);
  if (reply.failure) {
    return result(
      "timeout",
      "NetSketch: požadavek došel, ale odpověď ne – " + sim.explainFailure(reply.failure, arrived.source),
      interfaceName,
    );
  }
  if (open) return result("open", "", interfaceName);
  const name = sim.device(target)?.hostname ?? "?";
  return result(
    "refused",
    `NetSketch: ${name} spojení odmítlo – na portu ${port} nic neposlouchá (servery přijímají všechny porty, ` +
      "routery jen 22 a 23, PC žádný).",
    interfaceName,
  );
}
