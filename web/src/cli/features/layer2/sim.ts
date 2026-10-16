// Spanning tree and EtherChannel/LACP in the simulation. The tree itself is computed in stp.ts;
// here a blocking port stops forwarding frames, so a loop in the cabling no longer matters:
// reachability follows the layer-2 domains (which a correct tree never splits), the path of a
// packet avoids blocked ports.

import type { Project } from "../../../core/model";
import type { NetworkSimulator } from "../../sim/network-simulator";
import type { SimFeature } from "../../sim/packet";
import { channelPortDown } from "./etherchannel";
import { computeSpanningTree } from "./stp";

/** STP state of every switch port of the project, for the canvas: key "deviceID|portID". */
export type STPPortState = "blocking" | "listening" | "learning" | "forwarding" | "disabled";

export function spanningTreePortStates(project: Project): Map<string, STPPortState> {
  const states = new Map<string, STPPortState>();
  for (const bridge of computeSpanningTree(project).values()) {
    for (const port of bridge.ports) states.set(`${port.deviceID}|${port.portID}`, port.state);
  }
  return states;
}

/** One tree per simulator (the project does not change while it exists). */
const cache = new WeakMap<NetworkSimulator, Map<string, STPPortState>>();

export const layer2SimFeature: SimFeature = {
  name: "layer2",

  /** A static (`on`) EtherChannel member whose bundle did not form carries nothing. */
  portDown(project, device, port) {
    return channelPortDown(project, device, port);
  },

  portForwards(sim, device, port) {
    let states = cache.get(sim);
    if (!states) {
      states = spanningTreePortStates(sim.project);
      cache.set(sim, states);
    }
    return states.get(`${device.id}|${port.id}`) !== "blocking";
  },
};
