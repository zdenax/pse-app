// PC and server command prompt: `Test-NetConnection` (PowerShell style) and `telnet` open a TCP
// connection through the simulation, so access lists and firewalls can be tested with ports.

import { IPv4 } from "../../sim/ipv4";
import type { HostContext, HostFeature, HostFeatureCommand } from "../host-commands";
import { tcpProbe } from "./tcp";

const wellKnownPorts: Record<string, number> = { http: 80, rdp: 3389, smb: 445, winrm: 5985 };

/** `Name : value` rows with the names padded to the longest one, as PowerShell lists properties. */
function properties(rows: [string, string][]): string[] {
  const width = Math.max(...rows.map(([name]) => name.length));
  return rows.map(([name, value]) => `${name.padEnd(width)} : ${value}`);
}

interface Options {
  computer: string | null;
  port: number | null;
  quiet: boolean;
  error: string | null;
}

function parseOptions(words: string[]): Options {
  const options: Options = { computer: null, port: null, quiet: false, error: null };
  const names = ["computername", "port", "commontcpport", "informationlevel"];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (!word.startsWith("-")) {
      if (options.computer !== null) {
        options.error = `A positional parameter cannot be found that accepts argument '${word}'.`;
      } else {
        options.computer = word;
      }
      continue;
    }
    const lower = word.slice(1).toLowerCase();
    const matches = names.filter((name) => name.startsWith(lower));
    const name = names.includes(lower) ? lower : matches.length === 1 ? matches[0] : null;
    if (name === null) {
      options.error = `A parameter cannot be found that matches parameter name '${word.slice(1)}'.`;
      continue;
    }
    const value = words[index + 1];
    if (value === undefined) {
      options.error = `Missing an argument for parameter '${name}'. Specify a parameter of type 'System.String' and try again.`;
      continue;
    }
    index += 1;
    if (name === "computername") {
      options.computer = value;
    } else if (name === "port") {
      const port = /^[0-9]{1,5}$/.test(value) ? Number(value) : -1;
      if (port < 0 || port > 65535) {
        options.error = `Cannot validate argument on parameter 'Port'. The ${value} argument is not valid.`;
      } else {
        options.port = port;
      }
    } else if (name === "commontcpport") {
      const port = wellKnownPorts[value.toLowerCase()];
      if (port === undefined) {
        options.error = `Cannot validate argument on parameter 'CommonTCPPort'. The argument "${value}" does not belong to the set "HTTP,RDP,SMB,WINRM".`;
      } else {
        options.port = port;
      }
    } else {
      options.quiet = value.toLowerCase() === "quiet";
    }
  }
  return options;
}

function testNetConnection(context: HostContext, words: string[]): string {
  const options = parseOptions(words);
  if (options.error !== null) return `Test-NetConnection : ${options.error}`;
  if (options.computer === null) {
    return "Test-NetConnection : Missing ComputerName. Example: Test-NetConnection 10.0.0.5 -Port 80";
  }
  const address = IPv4.parse(options.computer);
  if (!address) {
    return `WARNING: Name resolution of ${options.computer} failed\nNetSketch: jména se nepřekládají, zadejte IP adresu.`;
  }
  const simulator = context.access.simulator;
  const from = context.access.deviceID;
  const probe = options.port === null ? null : tcpProbe(simulator, from, address, options.port);
  const ping = simulator.ping(from, address);
  const open = probe !== null && probe.outcome === "open";
  if (options.quiet) return (probe ? open : ping.success) ? "True" : "False";

  const source = ping.source?.description ?? probe?.source?.description ?? "0.0.0.0";
  const alias = simulator.lookup(address, from)?.interface.name ?? "";
  const lines: string[] = [];
  if (probe && !open) lines.push(`WARNING: TCP connect to (${address.description} : ${options.port}) failed`);
  if (!ping.success && !open) {
    const failure = ping.forward.failure;
    const status =
      failure?.kind === "dropped" && failure.symbol === "U"
        ? "DestinationProhibited"
        : failure?.kind === "noRoute" && failure.deviceID !== from
          ? "DestinationNetworkUnreachable"
          : "TimedOut";
    lines.push(`WARNING: Ping to ${address.description} failed with status: ${status}`);
  }
  const rows: [string, string][] = [
    ["ComputerName", options.computer],
    ["RemoteAddress", address.description],
  ];
  if (probe) rows.push(["RemotePort", `${options.port}`]);
  rows.push(["InterfaceAlias", alias], ["SourceAddress", source]);
  if (!open) rows.push(["PingSucceeded", ping.success ? "True" : "False"], ["PingReplyDetails (RTT)", "0 ms"]);
  if (probe) rows.push(["TcpTestSucceeded", open ? "True" : "False"]);
  lines.push("", ...properties(rows), "");
  const explanation = probe ? probe.explanation : simulator.explain(ping);
  if (explanation !== "") lines.push(explanation);
  return lines.join("\n");
}

function telnet(context: HostContext, words: string[]): string {
  const target = words[0];
  if (target === undefined) return "Usage: telnet <host> [port]";
  const address = IPv4.parse(target);
  if (!address) return `Connecting To ${target}...Could not open connection to the host, on port 23: Connect failed`;
  const portText = words[1] ?? "23";
  const port = /^[0-9]{1,5}$/.test(portText) ? Number(portText) : -1;
  if (port < 0 || port > 65535) return `${portText}: bad port number`;
  const probe = tcpProbe(context.access.simulator, context.access.deviceID, address, port);
  if (probe.outcome === "open") {
    return [
      `Connecting To ${address.description}...`,
      "NetSketch: spojení se navázalo; obsah relace se nesimuluje, spojení se hned zavírá.",
      "Connection to host lost.",
    ].join("\n");
  }
  const lines = [
    `Connecting To ${address.description}...Could not open connection to the host, on port ${port}: Connect failed`,
  ];
  if (probe.explanation !== "") lines.push(probe.explanation);
  return lines.join("\n");
}

export const aclHost: HostFeature = (): HostFeatureCommand[] => [
  {
    name: "test-netconnection",
    help: "Test a TCP port or ping: Test-NetConnection 10.0.0.5 -Port 80",
    run: testNetConnection,
  },
  { name: "tnc", help: "Alias of Test-NetConnection", run: testNetConnection },
  { name: "telnet", help: "Open a TCP connection: telnet 10.0.0.5 [port]", run: telnet },
];
