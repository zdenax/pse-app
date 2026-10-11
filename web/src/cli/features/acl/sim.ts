// Access lists and firewall filters in the packet path.
//
// Cisco/Dell: the list bound `in` to the ingress interface runs in the inbound hook, the list
// bound `out` to the egress interface in the outbound hook, only for packets the router
// forwards (what the router sends itself is not filtered by its outbound lists). First match
// wins, the end of a list denies; a bound list that does not exist (or has no lines) permits.
//
// MikroTik: chain `forward` for routed packets (seen before source NAT, like RouterOS, when the
// packet is not for the router itself), `input` for packets to the router (local hook) and
// `output` for packets it originates. No match accepts.

import type { Device } from "../../../core/model";
import type { ACLConfig, AccessList } from "../../../core/protocols";
import type { SimInterface } from "../../sim/network-simulator";
import { pass, type HopContext, type Packet, type SimFeature, type Verdict } from "../../sim/packet";
import { evaluateChain, interfaceLabel, ruleProperties, type Chain } from "./firewall";
import { evaluateList, formatEntry } from "./rules";

function configOf(context: HopContext): ACLConfig | null {
  const acl = context.sim.device(context.deviceID)?.protocols?.acl;
  return acl ?? null;
}

function hostname(context: HopContext): string {
  return context.sim.device(context.deviceID)?.hostname ?? "?";
}

// MARK: Cisco / Dell access lists

function listLine(list: AccessList, entry: NonNullable<ReturnType<typeof evaluateList>["entry"]>, dell: boolean): string {
  const style = { dell, standard: list.type === "standard", show: true };
  return `${entry.sequence} ${formatEntry(entry, list.type, style, false)}`;
}

function checkList(
  context: HopContext,
  config: ACLConfig,
  iface: SimInterface,
  direction: "in" | "out",
  packet: Packet,
): Verdict {
  const binding = config.bindings.find((item) => item.interface === iface.id && item.direction === direction);
  if (!binding) return pass(packet);
  const list = config.lists.find((item) => item.name === binding.list);
  if (!list) return pass(packet);
  const verdict = evaluateList(list, packet);
  if (verdict.permit) return pass(packet);
  const dell = context.sim.device(context.deviceID)?.vendor.toLowerCase().includes("dell") ?? false;
  const how = verdict.entry
    ? `řádek „${listLine(list, verdict.entry, dell)}“ ho zakázal`
    : "žádný řádek nevyhověl, zahodil ho implicitní deny na konci seznamu";
  return {
    kind: "drop",
    reason: `${hostname(context)} zahodil paket: access-list ${list.name} na rozhraní ${iface.name}, směr ${direction} – ${how}.`,
    symbol: "U",
    feature: "acl",
  };
}

// MARK: MikroTik firewall

/** Per device: whether the forward chain already ran in the inbound hook for the packet at hand. */
const forwardDone = new WeakMap<object, Map<string, boolean>>();

function markForward(context: HopContext, done: boolean): void {
  let devices = forwardDone.get(context.sim);
  if (!devices) {
    devices = new Map();
    forwardDone.set(context.sim, devices);
  }
  devices.set(context.deviceID, done);
}

function isForwardDone(context: HopContext): boolean {
  return forwardDone.get(context.sim)?.get(context.deviceID) ?? false;
}

function checkChain(
  context: HopContext,
  config: ACLConfig,
  chain: Chain,
  packet: Packet,
  ingress: SimInterface | null,
  egress: SimInterface | null,
): Verdict {
  const hit = evaluateChain(config.firewall, chain, packet, ingress, egress);
  if (!hit || hit.rule.action === "accept") return pass(packet);
  const device: Device | null = context.sim.device(context.deviceID);
  const summary = ruleProperties(hit.rule, (id) => interfaceLabel(device, id))
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  const verb = hit.rule.action === "reject" ? "odmítl (reject)" : "zahodil";
  return {
    kind: "drop",
    reason: `${hostname(context)} ${verb} paket: pravidlo ${hit.index} firewallu v řetězci ${chain} (${summary}).`,
    symbol: hit.rule.action === "reject" ? "U" : ".",
    feature: "firewall",
  };
}

// MARK: The feature

export const aclSimFeature: SimFeature = {
  name: "acl",

  inbound(context, packet) {
    const config = configOf(context);
    if (!config || !context.ingress) return pass(packet);
    const listed = checkList(context, config, context.ingress, "in", packet);
    if (listed.kind === "drop") return listed;
    if (config.firewall.length === 0) return pass(packet);
    // A packet for the router itself meets the input chain later; the rest is forwarded.
    const forwarded = !context.sim.owns(context.deviceID, packet.destination);
    markForward(context, forwarded);
    if (!forwarded) return pass(packet);
    const egress = context.sim.lookup(packet.destination, context.deviceID)?.interface ?? null;
    return checkChain(context, config, "forward", packet, context.ingress, egress);
  },

  outbound(context, packet) {
    const config = configOf(context);
    if (!config) return pass(packet);
    if (context.ingress === null) {
      // Sent by this device itself: no outbound list, but the firewall's output chain.
      return config.firewall.length === 0 ? pass(packet) : checkChain(context, config, "output", packet, null, context.egress);
    }
    if (context.egress) {
      const listed = checkList(context, config, context.egress, "out", packet);
      if (listed.kind === "drop") return listed;
    }
    if (config.firewall.length === 0 || isForwardDone(context)) return pass(packet);
    // Translated on the way in (port forwarding): the forward chain sees it now.
    return checkChain(context, config, "forward", packet, context.ingress, context.egress);
  },

  local(context, packet) {
    const config = configOf(context);
    if (!config || config.firewall.length === 0) return pass(packet);
    return checkChain(context, config, "input", packet, context.ingress, null);
  },
};
