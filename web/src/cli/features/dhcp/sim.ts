// DHCP in the network simulation: what a client's DISCOVER finds and what it gets.
//
// A client sends its DISCOVER into the layer-2 domain of its interface. It is answered by
//  - a server interface in that domain whose address lies in the network of one of the pools of
//    its device (and the pool's interface restriction, if any, matches), or
//  - a relay interface (`ip helper-address`) in that domain, which forwards the request to the
//    server (checked with a UDP 67 packet through the simulation, there and back); the pool is
//    chosen by the network of the relay interface (giaddr).
// The lease is written as a normal address of the client interface (a default gateway too on
// hosts), the interface is marked in `protocols.dhcp.clients` and the server's answer is kept
// in `protocols.dhcp.leases`. Everything is deterministic: see `allocateAddress`.
//
// The packet hooks of the simulation (SimFeature) are not needed: DHCP is a conversation of the
// consoles with the network, not something that transforms packets on the way.

import type { Device, L3InterfaceID } from "../../../core/model";
import type { DHCPLease } from "../../../core/protocols";
import type { DeviceAccess } from "../../model-access";
import { IPv4, IPv4Prefix } from "../../sim/ipv4";
import type { NetworkSimulator, SimInterface } from "../../sim/network-simulator";
import type { Packet, PacketSegment, SimFeature } from "../../sim/packet";
import { emitPacketTrace } from "../../sim/trace-events";
import { allocateAddress, dhcpOf, effectivePools, type EffectivePool, updateDHCP } from "./model";

export const dhcpSimFeature: SimFeature = { name: "dhcp" };

// MARK: Negotiation

/** Where a lease came from relay-wise. */
export interface RelayHop {
  readonly deviceID: string;
  /** The relay interface in the client's network. */
  readonly interface: SimInterface;
  readonly server: IPv4;
}

export interface LeaseOffer {
  readonly serverDeviceID: string;
  /** The DHCP server identifier the client records. */
  readonly server: IPv4;
  readonly pool: EffectivePool;
  readonly address: IPv4;
  /** The address with the length of the pool's network. */
  readonly prefix: IPv4Prefix;
  readonly gateway: string;
  readonly dnsServer: string;
  readonly domainName: string;
  readonly lease: string;
  readonly relay: RelayHop | null;
  /** The server interface (or relay interface) in the client's network. */
  readonly via: SimInterface;
}

export type Negotiation =
  | { readonly kind: "offer"; readonly offer: LeaseOffer }
  | { readonly kind: "failure"; readonly reason: string };

interface Problem {
  /** 3: the most specific (exhausted pool, relay cannot reach the server), 1: a hint. A Czech fragment ending with a period. */
  readonly rank: number;
  readonly text: string;
}

function udpPacket(source: IPv4, destination: IPv4): Packet {
  return { source, destination, protocol: "udp", icmpType: "", sourcePort: 67, destinationPort: 67, ttl: 255 };
}

function nameOf(sim: NetworkSimulator, deviceID: string): string {
  return sim.device(deviceID)?.hostname ?? "?";
}

/** The layer-2 domain of a client interface, or why it has none. */
function clientDomain(
  sim: NetworkSimulator,
  device: Device,
  interfaceID: L3InterfaceID,
): { domain: number } | { problem: string } {
  if (interfaceID.startsWith("vlan:")) {
    const number = Number(interfaceID.slice(5));
    return { domain: sim.domainOfBridge(device.id, number) };
  }
  const port = device.ports.find((candidate) => candidate.id === interfaceID.slice(5));
  if (!port) return { problem: "rozhraní už v diagramu neexistuje." };
  if (port.adminDown) return { problem: `rozhraní ${port.name} je vypnuté (shutdown).` };
  const peer = sim.peer(device.id, port.id);
  if (!peer) return { problem: `k rozhraní ${port.name} není připojen kabel.` };
  if (!sim.isLinkUp(device, port)) {
    return { problem: `protější konec kabelu (${peer.device.hostname} ${peer.port.name}) je vypnutý.` };
  }
  return { domain: sim.domainOfPort(device.id, port.id) };
}

function offerOf(
  pool: EffectivePool,
  address: IPv4,
  serverDeviceID: string,
  server: IPv4,
  relay: RelayHop | null,
  via: SimInterface,
): LeaseOffer {
  const network = pool.network as IPv4Prefix;
  return {
    serverDeviceID,
    server,
    pool,
    address,
    prefix: new IPv4Prefix(address, network.length),
    gateway: pool.defaultRouters[0] ?? "",
    dnsServer: pool.dnsServers.join(" "),
    domainName: pool.domainName,
    lease: pool.lease,
    relay,
    via,
  };
}

function exhausted(sim: NetworkSimulator, deviceID: string, pool: EffectivePool): string {
  const network = pool.network?.description ?? "?";
  const cause = pool.source === "pool" ? "vyloučené (excluded-address) nebo už používané" : "už používané";
  return `pool ${pool.name} na ${nameOf(sim, deviceID)} (${network}) je vyčerpaný – všechny jeho adresy jsou ${cause}.`;
}

/**
 * Plays the DISCOVER of the interface `interfaceID` of the device `clientID` through the
 * network. Writes nothing.
 */
export function negotiate(sim: NetworkSimulator, clientID: string, interfaceID: L3InterfaceID): Negotiation {
  const client = sim.device(clientID);
  if (!client) return { kind: "failure", reason: "zařízení už v diagramu neexistuje." };
  const where = clientDomain(sim, client, interfaceID);
  if ("problem" in where) return { kind: "failure", reason: where.problem };
  const problems: Problem[] = [];

  for (const iface of sim.interfaces) {
    if (iface.domain !== where.domain || iface.deviceID === clientID) continue;
    const device = sim.device(iface.deviceID);
    const config = dhcpOf(device);
    if (!device || !config) continue;
    const label = `${device.hostname} (${iface.name} ${iface.prefix.description})`;

    for (const pool of effectivePools(config)) {
      if (pool.interface !== undefined && pool.interface !== iface.id) continue;
      if (pool.problem !== null) {
        problems.push({ rank: pool.interface === iface.id ? 3 : 2, text: `na ${device.hostname}: ${pool.problem}` });
        continue;
      }
      const network = pool.network as IPv4Prefix;
      if (!network.contains(iface.prefix.address)) {
        problems.push({
          rank: 1,
          text:
            `${label} je ve stejné síti jako klient, ale pool ${pool.name} obsluhuje jinou síť (${network.description}) ` +
            "než je síť tohoto rozhraní.",
        });
        continue;
      }
      const address = allocateAddress(sim.project, config, pool, { deviceID: clientID, interfaceID });
      if (!address) {
        problems.push({ rank: 3, text: exhausted(sim, device.id, pool) });
        continue;
      }
      return { kind: "offer", offer: offerOf(pool, address, device.id, iface.prefix.address, null, iface) };
    }

    for (const relay of config.relays) {
      if (relay.interface !== iface.id || relay.disabled === true) continue;
      const result = viaRelay(sim, clientID, interfaceID, device, iface, relay.server);
      if (result.kind === "offer") return result;
      problems.push({ rank: 3, text: result.reason });
    }
  }

  let best: Problem | null = null;
  for (const problem of problems) if (best === null || problem.rank > best.rank) best = problem;
  if (best) return { kind: "failure", reason: best.text };
  const own = sim.interfacesOf(clientID).find((candidate) => candidate.id === interfaceID);
  const port = interfaceID.startsWith("port:") ? client.ports.find((candidate) => candidate.id === interfaceID.slice(5)) : undefined;
  const name = own?.name ?? port?.name ?? `Vlan${interfaceID.slice(5)}`;
  return {
    kind: "failure",
    reason:
      `v síti rozhraní ${name} (stejný přepínač a VLAN) není žádné zařízení s DHCP poolem pro tuto síť ani relay ` +
      "(ip helper-address), takže DISCOVER nikdo nezodpoví.",
  };
}

/** The request of a client reaches a relay agent, which hands it to the server and back. */
function viaRelay(
  sim: NetworkSimulator,
  clientID: string,
  interfaceID: L3InterfaceID,
  relayDevice: Device,
  relayInterface: SimInterface,
  serverText: string,
): Negotiation {
  const label = `relay ${relayDevice.hostname} (${relayInterface.name})`;
  const serverAddress = IPv4.parse(serverText);
  if (!serverAddress) return { kind: "failure", reason: `${label} má ip helper-address ${serverText}, což není platná adresa.` };
  const giaddr = relayInterface.prefix.address;
  const source = sim.sourceAddress(relayDevice.id, serverAddress) ?? giaddr;
  const forward = sim.deliverPacket(relayDevice.id, udpPacket(source, serverAddress));
  if (forward.failure) {
    return {
      kind: "failure",
      reason: `${label} nedoručí požadavek DHCP serveru ${serverText}: ${sim.explainFailure(forward.failure, serverAddress)}`,
    };
  }
  const serverDeviceID = forward.lastDevice ?? relayDevice.id;
  const serverDevice = sim.device(serverDeviceID);
  const config = dhcpOf(serverDevice);
  const network = relayInterface.prefix.networkPrefix;
  const pool = config ? effectivePools(config).find((candidate) => candidate.network?.contains(giaddr)) : undefined;
  if (!serverDevice || !config || !pool) {
    return {
      kind: "failure",
      reason:
        `${nameOf(sim, serverDeviceID)} (${serverText}) nemá DHCP pool pro síť ${network.description} ` +
        `(podle adresy relay rozhraní ${giaddr.description}).`,
    };
  }
  if (pool.problem !== null) return { kind: "failure", reason: `na ${serverDevice.hostname}: ${pool.problem}` };
  if (serverDeviceID !== relayDevice.id) {
    const back = sim.deliverPacket(serverDeviceID, udpPacket(sim.sourceAddress(serverDeviceID, giaddr) ?? serverAddress, giaddr));
    if (back.failure) {
      return {
        kind: "failure",
        reason:
          `odpověď serveru ${serverDevice.hostname} se nedostane zpět k ${label} (${giaddr.description}): ` +
          `${sim.explainFailure(back.failure, giaddr)}`,
      };
    }
  }
  const address = allocateAddress(sim.project, config, pool, { deviceID: clientID, interfaceID });
  if (!address) return { kind: "failure", reason: exhausted(sim, serverDeviceID, pool) };
  return {
    kind: "offer",
    offer: offerOf(pool, address, serverDeviceID, serverAddress, { deviceID: relayDevice.id, interface: relayInterface, server: serverAddress }, relayInterface),
  };
}

// MARK: Client side

/** True for end devices and layer-2 switches, which keep a default gateway of their own. */
export function usesDefaultGateway(access: DeviceAccess): boolean {
  const category = access.category;
  return category !== "router" && category !== "L3 switch";
}

export function isDHCPClient(access: DeviceAccess, interfaceID: L3InterfaceID): boolean {
  return dhcpOf(access.device)?.clients.includes(interfaceID) ?? false;
}

export function leaseOf(access: DeviceAccess, interfaceID: L3InterfaceID): DHCPLease | undefined {
  return dhcpOf(access.device)?.leases?.find((lease) => lease.interface === interfaceID);
}

/** Marks the interface as one that takes its address from DHCP (no address is requested yet). */
export function markClient(access: DeviceAccess, interfaceID: L3InterfaceID): void {
  if (isDHCPClient(access, interfaceID)) return;
  updateDHCP(access, (config) => {
    config.clients.push(interfaceID);
  });
}

/** The interface goes back to a manual address: forgets the mark and the lease record. */
export function unmarkClient(access: DeviceAccess, interfaceID: L3InterfaceID): void {
  if (!isDHCPClient(access, interfaceID) && leaseOf(access, interfaceID) === undefined) return;
  updateDHCP(access, (config) => {
    config.clients = config.clients.filter((entry) => entry !== interfaceID);
    if (config.leases) config.leases = config.leases.filter((entry) => entry.interface !== interfaceID);
  });
}

export type LeaseOutcome =
  | { readonly kind: "bound"; readonly address: IPv4Prefix; readonly offer: LeaseOffer; readonly serverName: string }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Asks the network for an address for the interface and, when a server answers, writes the
 * lease (one undo step). The interface is marked as a DHCP client either way; on failure
 * the interface keeps whatever it had.
 */
export function acquireLease(access: DeviceAccess, interfaceID: L3InterfaceID): LeaseOutcome {
  const sim = access.simulator;
  const result = negotiate(sim, access.deviceID, interfaceID);
  if (result.kind === "failure") {
    access.transaction(() => markClient(access, interfaceID));
    emitTrace(sim, access.deviceID, null, false);
    return { kind: "failed", reason: result.reason };
  }
  const offer = result.offer;
  const overlap = access.addresses.find((entry) => {
    if (entry.interface === interfaceID) return false;
    const other = IPv4Prefix.fromCIDR(entry.address);
    return other !== null && (other.contains(offer.address) || offer.prefix.contains(other.address));
  });
  if (overlap) {
    access.transaction(() => markClient(access, interfaceID));
    return {
      kind: "failed",
      reason:
        `adresa ${offer.prefix.description} od serveru ${nameOf(sim, offer.serverDeviceID)} se překrývá ` +
        `s jiným rozhraním tohoto zařízení (${overlap.address}), takže ji zařízení nepřijme.`,
    };
  }
  access.transaction(() => {
    access.setAddress(offer.prefix, interfaceID);
    if (usesDefaultGateway(access)) access.setDefaultGateway(IPv4.parse(offer.gateway));
    updateDHCP(access, (config) => {
      if (!config.clients.includes(interfaceID)) config.clients.push(interfaceID);
      const lease: DHCPLease = {
        interface: interfaceID,
        server: offer.server.description,
        gateway: offer.gateway,
        dnsServer: offer.dnsServer,
        ...(offer.domainName !== "" ? { domainName: offer.domainName } : {}),
        ...(offer.lease !== "" ? { lease: offer.lease } : {}),
      };
      config.leases = [...(config.leases ?? []).filter((entry) => entry.interface !== interfaceID), lease];
    });
  });
  emitTrace(access.simulator, access.deviceID, offer, true);
  return { kind: "bound", address: offer.prefix, offer, serverName: nameOf(sim, offer.serverDeviceID) };
}

/** Gives the address back: the interface stays a DHCP client but has no address (one undo step). */
export function releaseLease(access: DeviceAccess, interfaceID: L3InterfaceID): void {
  access.transaction(() => {
    access.setAddress(null, interfaceID);
    if (usesDefaultGateway(access)) access.setDefaultGateway(null);
    updateDHCP(access, (config) => {
      if (config.leases) config.leases = config.leases.filter((entry) => entry.interface !== interfaceID);
    });
  });
}

// MARK: Packet trace

function reversed(segments: readonly PacketSegment[]): PacketSegment[] {
  return [...segments].reverse().map((segment) => ({
    fromDevice: segment.toDevice,
    toDevice: segment.fromDevice,
    links: [...segment.links].reverse().map((link) => ({ linkID: link.linkID, fromDevice: link.toDevice, toDevice: link.fromDevice })),
  }));
}

/** Announces the exchange (DISCOVER there, OFFER back) to whoever animates the canvas. */
function emitTrace(sim: NetworkSimulator, clientID: string, offer: LeaseOffer | null, success: boolean): void {
  try {
    if (!offer) {
      emitPacketTrace({ kind: "dhcp", deviceID: clientID, forward: [], back: [], success: false, failedAt: clientID });
      return;
    }
    // The client now owns its address, so the answering side can address the way back.
    const reply = sim.deliverPacket(offer.relay?.deviceID ?? offer.serverDeviceID, udpPacket(offer.via.prefix.address, offer.address));
    let back = reply.segments;
    if (offer.relay) {
      const onward = sim.deliverPacket(offer.relay.deviceID, udpPacket(offer.via.prefix.address, offer.server));
      back = [...reversed(onward.segments), ...reply.segments];
    }
    emitPacketTrace({ kind: "dhcp", deviceID: clientID, forward: reversed(back), back, success, failedAt: null });
  } catch {
    // Animation is a courtesy; it must never break the console.
  }
}
