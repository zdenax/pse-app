// Spanning tree and EtherChannel/LACP (stub; filled in by the layer-2 feature).
import type { Project } from "../../../core/model";
import type { SimFeature } from "../../sim/packet";

export const layer2SimFeature: SimFeature = { name: "layer2" };

/** STP state of every switch port of the project, for the canvas: key "deviceID|portID". */
export type STPPortState = "blocking" | "listening" | "learning" | "forwarding" | "disabled";

export function spanningTreePortStates(_project: Project): Map<string, STPPortState> {
  return new Map();
}
