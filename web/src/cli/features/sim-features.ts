// The features of the network simulation, in pipeline order (see sim/packet.ts): inbound hooks
// run in this order, outbound hooks in the reverse order. ACL before NAT gives the Cisco order
// "ingress ACL -> NAT outside->inside" and "NAT inside->outside -> egress ACL".

import type { SimFeature } from "../sim/packet";
import { aclSimFeature } from "./acl/sim";
import { dhcpSimFeature } from "./dhcp/sim";
import { layer2SimFeature } from "./layer2/sim";
import { natSimFeature } from "./nat/sim";
import { routingSimFeature } from "./routing/sim";

export const simFeatures: readonly SimFeature[] = [
  layer2SimFeature,
  routingSimFeature,
  dhcpSimFeature,
  aclSimFeature,
  natSimFeature,
];
