// Public API of the consoles and the network simulation (the TypeScript NetSketchCLI).

export type { CLIDialect, ConsoleSession } from "./session-api";
export { CLI, CLISession, allDialects } from "./session";
export type { ConsoleEngine } from "./session";
export { Exercises, CommandFailed } from "./exercises";
export type { Exercise } from "./exercises";
export { IPv4, IPv4Prefix } from "./sim/ipv4";
export { NetworkSimulator, Delivery, PingResult } from "./sim/network-simulator";
export type { RouteKind, SimFailure, SimInterface, SimRoute } from "./sim/network-simulator";
export { HostEngine } from "./host-engine";
export { RouterOSEngine } from "./routeros-engine";
