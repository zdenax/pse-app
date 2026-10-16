// MAC and ARP learning in the simulation: every packet followed through the network leaves
// its traces in the tables of model.ts.

import type { SimFeature } from "../../sim/packet";
import { learn } from "./model";

export const macArpSimFeature: SimFeature = {
  name: "mac-arp",

  delivered(sim, _from, delivery) {
    learn(sim, delivery);
  },
};
