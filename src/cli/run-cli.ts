import { SailorError, describeFailure } from "../sailor/sailor-error.js";
import { readPackageVersion } from "../sailor/package-version.js";
import type { CommandRunner } from "../processes/command-runner.js";
import {
  RuleResolutionError,
  RuleValidationError,
} from "../rules/rule-error.js";
import { CLI_EXIT_CODES, exitCodeForSailorError } from "./exit-codes.js";
import { parseCliArguments } from "./parse-cli-arguments.js";
import type { CliCommand, CliInvocation } from "./parse-cli-arguments.js";

/**
 * The narrowest useful view of an output stream. `process.stdout` satisfies it
 * structurally, and so does a recording array, so no test needs to replace a
 * global.
 */
export interface CliStream {
  write(text: string): void;
}

export interface CliStreams {
  readonly stdout: CliStream;
  readonly stderr: CliStream;
}

export interface CliContext {
  readonly invocation: CliInvocation;
  /** Directory the CLI was invoked from, not necessarily the project root. */
  readonly cwd: string;
  readonly streams: CliStreams;
  /** Root of the installed `sailor` package; resolved by the bin entry. */
  readonly packageRootDirectory: string;
  readonly runner: CommandRunner;
  readonly now: () => Date;
  /** The Node runtime executing the CLI, as `process.versions.node`. */
  readonly nodeVersion: string;
}

export type CliCommandHandler = (context: CliContext) => Promise<number>;

/**
 * Handlers are injected, and the record is partial: a command the running
 * build does not provide reports that plainly instead of pretending to work.
 */
export type CliCommandRegistry = Readonly<
  Partial<Record<CliCommand, CliCommandHandler>>
>;

export interface RunCliOptions {
  /** Arguments after the node binary and the script path. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly streams: CliStreams;
  readonly packageRootDirectory: string;
  readonly runner: CommandRunner;
  readonly now: () => Date;
  readonly nodeVersion: string;
  readonly commands: CliCommandRegistry;
}

const HELP_TEXT = `Usage: sailor <command> [options]

Commands:
  init [--update]            Install or update .sailor in this project
  doctor                     Check that the installed sailor can run
  rules validate             Load and resolve every rule bundle
  rules explain [--agent id] Show the resolved rules, or one agent's policy
  gate <phase> [--agent id]  Run the checks that apply to a workflow phase

Phases:
  pre-agent, pre-handoff, pre-commit, pre-push, qa

Options:
  --agent <id>               Restrict the command to one agent
  --update                   Replace managed files the sailor still owns
  -h, --help                 Show this message
  -v, --version              Show the sailor version

Exit codes:
  0 success
  1 unexpected failure
  2 the command line could not be understood
  3 invalid or missing sailor configuration
  4 a required check failed and blocked the phase
  5 the action was unsafe and was not taken
`;

/**
 * Parses an argument vector, dispatches it, and turns any failure into an exit
 * code.
 *
 * Nothing here touches `process`: the argument vector, the streams, the clock,
 * the command runner and the package root are all supplied by the caller, so
 * the whole CLI is exercised in-process by tests and only the bin entry deals
 * with the real environment.
 */
export const runCli = async (options: RunCliOptions): Promise<number> => {
  const parsed = parseCliArguments(options.argv);

  if (parsed.kind === "help") {
    options.streams.stdout.write(HELP_TEXT);

    return CLI_EXIT_CODES.ok;
  }

  if (parsed.kind === "usage-error") {
    options.streams.stderr.write(
      `sailor: ${parsed.message}\nRun \`sailor --help\` for usage.\n`
    );

    return CLI_EXIT_CODES.usage;
  }

  try {
    if (parsed.kind === "version") {
      options.streams.stdout.write(
        `${readPackageVersion(options.packageRootDirectory)}\n`
      );

      return CLI_EXIT_CODES.ok;
    }

    const handler = options.commands[parsed.invocation.command];

    if (handler === undefined) {
      options.streams.stderr.write(
        `sailor: \`${parsed.invocation.command}\` is not available in this build\n`
      );

      return CLI_EXIT_CODES.failure;
    }

    return await handler({
      invocation: parsed.invocation,
      cwd: options.cwd,
      streams: options.streams,
      packageRootDirectory: options.packageRootDirectory,
      runner: options.runner,
      now: options.now,
      nodeVersion: options.nodeVersion,
    });
  } catch (error: unknown) {
    options.streams.stderr.write(`sailor: ${describeFailure(error)}\n`);

    if (error instanceof SailorError) {
      return exitCodeForSailorError(error.kind);
    }

    // A rule bundle that fails to parse or resolve is a configuration problem,
    // not a crash, and callers branch on that distinction.
    return error instanceof RuleValidationError ||
      error instanceof RuleResolutionError
      ? CLI_EXIT_CODES.invalidConfig
      : CLI_EXIT_CODES.failure;
  }
};
