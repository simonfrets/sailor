/**
 * The seam between rule gates and process execution.
 *
 * This module imports nothing, so tests and alternative runners can depend on
 * the vocabulary without pulling in `node:child_process`. It deliberately
 * exports runtime values as well as types: `verbatimModuleSyntax` erases a
 * types-only module at every import site, which would leave it reported as
 * zero-percent covered.
 */

/**
 * A command is always an executable plus an argument vector. There is no
 * shell-string form anywhere in this package, which is the mechanism that keeps
 * shell metacharacters inert rather than something an escaping routine has to
 * get right.
 */
export interface CommandSpec {
  readonly executable: string;
  readonly args: readonly string[];
}

export type CommandOutputStream = "stdout" | "stderr";

export interface CommandRequest {
  readonly command: CommandSpec;
  readonly cwd: string;
  /** Overrides merged over the runner's minimal base environment. */
  readonly env: Readonly<Record<string, string>> | null;
  readonly timeoutMs: number;
  /**
   * Aborting terminates the command the way a timeout does, and the result
   * reports the signal that did it. A signal already aborted when the request
   * is made stops the command from starting at all.
   */
  readonly signal?: AbortSignal;
  /**
   * Called with each chunk as the command writes it, before capture. An agent
   * run is minutes long and reports as it goes; a gate has no use for this.
   * Chunks are raw bytes and may split a multi-byte character or a line.
   */
  readonly onOutput?: (stream: CommandOutputStream, chunk: Buffer) => void;
}

export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  /** True when either stream hit the capture cap and was cut short. */
  readonly truncated: boolean;
}

interface CommandResultBase {
  readonly command: CommandSpec;
  readonly output: CommandOutput;
  readonly startedAt: string;
  readonly durationMs: number;
}

export interface ExitedCommandResult extends CommandResultBase {
  readonly outcome: "exited";
  readonly exitCode: number;
}

export interface SignaledCommandResult extends CommandResultBase {
  readonly outcome: "signaled";
  readonly signal: NodeJS.Signals;
}

export interface TimedOutCommandResult extends CommandResultBase {
  readonly outcome: "timed-out";
  readonly timeoutMs: number;
  /** True when the grace period elapsed and SIGKILL was needed. */
  readonly forceKilled: boolean;
}

export interface SpawnFailedCommandResult extends CommandResultBase {
  readonly outcome: "spawn-failed";
  readonly errorCode: string | null;
  readonly message: string;
}

export type CommandResult =
  | ExitedCommandResult
  | SignaledCommandResult
  | TimedOutCommandResult
  | SpawnFailedCommandResult;

/**
 * Implementations never reject. A non-zero exit is the expected outcome of a
 * gate, not an exception, and throwing would discard the captured output that
 * makes a failure report useful.
 */
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_KILL_GRACE_MS = 5_000;
export const DEFAULT_KILL_SIGNAL: NodeJS.Signals = "SIGTERM";
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export const EMPTY_COMMAND_OUTPUT: CommandOutput = {
  stdout: "",
  stderr: "",
  truncated: false,
};

export const commandSucceeded = (result: CommandResult): boolean =>
  result.outcome === "exited" && result.exitCode === 0;

/** Renders a command for logs. Never shell-quoted; never feed this to a shell. */
export const describeCommand = (command: CommandSpec): string =>
  [command.executable, ...command.args].join(" ");

export const describeCommandResult = (result: CommandResult): string => {
  switch (result.outcome) {
    case "exited":
      return `exited with code ${String(result.exitCode)}`;
    case "signaled":
      return `terminated by ${result.signal}`;
    case "timed-out":
      return `timed out after ${String(result.timeoutMs)}ms${
        result.forceKilled ? " and required SIGKILL" : ""
      }`;
    case "spawn-failed":
      return `could not be started: ${result.message}`;
  }
};

const readErrorCode = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }

  const { code } = error;

  return typeof code === "string" ? code : null;
};

const readErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Converts an arbitrary thrown or emitted value into a spawn failure. Shared
 * here rather than kept private to the Node runner so any future runner
 * implementation reports failures identically.
 */
export const toSpawnFailure = (input: {
  readonly command: CommandSpec;
  readonly output: CommandOutput;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly error: unknown;
}): SpawnFailedCommandResult => ({
  outcome: "spawn-failed",
  command: input.command,
  output: input.output,
  startedAt: input.startedAt,
  durationMs: input.durationMs,
  errorCode: readErrorCode(input.error),
  message: readErrorMessage(input.error),
});
