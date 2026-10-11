// The contract between the consoles (src/cli) and the user interface (src/ui).
// It mirrors the public API of the Swift module NetSketchCLI (CLISession, CLI).

/** "edgeOS": Ubiquiti EdgeRouter and USG (web version only). */
export type CLIDialect = "ios" | "dellOS9" | "routerOS" | "generic" | "host" | "edgeOS";

/** One console of one device. The UI talks to consoles only through this interface. */
export interface ConsoleSession {
  readonly deviceID: string;
  readonly dialect: CLIDialect;
  /** Greeting printed when the console opens. */
  readonly banner: string;
  /** Prompt for the next line, e.g. "SW1(config-if)#", "[admin@R1] > ", "C:\\>". */
  readonly prompt: string;
  /** True after `exit`/`quit` at the top level, or when the device was deleted. */
  readonly isClosed: boolean;
  /** Runs one line (or a pasted block) and returns what the device prints ("" for nothing). */
  execute(line: string): string;
  /** Words that may continue the partial line (Tab completion). */
  complete(partial: string): string[];
  /** The "?" help for a partial line. */
  help(partial: string): string;
}
