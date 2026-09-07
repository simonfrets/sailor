import { agentIdSchema } from "../agents/agent-id.js";
import type { AgentId } from "../agents/agent-id.js";
import { PHASES } from "../rules/rule-schema.js";
import type { Phase } from "../rules/rule-schema.js";

/**
 * Every command the CLI dispatches. `rules` takes a subcommand, so the command
 * name carries the space: one flat key means dispatch is a lookup rather than
 * a nested switch that each new command has to be threaded through.
 */
export const CLI_COMMANDS = [
  "doctor",
  "gate",
  "init",
  "rules explain",
  "rules validate",
] as const;

export type CliCommand = (typeof CLI_COMMANDS)[number];

export interface CliInvocation {
  readonly command: CliCommand;
  /** The phase to run. Only `gate` sets it. */
  readonly phase: Phase | null;
  /** Restricts a policy or a gate to one agent. Null means every agent. */
  readonly agentId: AgentId | null;
  readonly update: boolean;
}

export type CliParseResult =
  | { readonly kind: "invocation"; readonly invocation: CliInvocation }
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "usage-error"; readonly message: string };

interface AllowedOptions {
  readonly agent: boolean;
  readonly update: boolean;
}

const usageError = (message: string): CliParseResult => ({
  kind: "usage-error",
  message,
});

const isPhase = (value: string): value is Phase =>
  (PHASES as readonly string[]).includes(value);

/**
 * Parses an argument vector into an invocation.
 *
 * Parsing is total and never throws: an unusable command line is a
 * `usage-error` result, so the caller decides the exit code in one place
 * instead of catching an exception from an argument parser.
 */
export const parseCliArguments = (argv: readonly string[]): CliParseResult => {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { kind: "help" };
  }

  if (argv.includes("--version") || argv.includes("-v")) {
    return { kind: "version" };
  }

  const positionals: string[] = [];
  let agent: string | null = null;
  let update = false;
  let consumed = false;

  for (const [index, token] of argv.entries()) {
    if (consumed) {
      consumed = false;
      continue;
    }

    if (token === "--update") {
      update = true;
      continue;
    }

    if (token === "--agent") {
      const value = argv[index + 1];

      if (value === undefined) {
        return usageError("`--agent` requires a value");
      }

      agent = value;
      consumed = true;
      continue;
    }

    if (token.startsWith("--")) {
      return usageError(`unknown option \`${token}\``);
    }

    positionals.push(token);
  }

  if (agent !== null) {
    const parsedAgent = agentIdSchema.safeParse(agent);

    if (!parsedAgent.success) {
      return usageError(
        `invalid \`--agent\` value \`${agent}\`: ${parsedAgent.error.issues
          .map((issue) => issue.message)
          .join("; ")}`
      );
    }
  }

  const command = positionals[0];

  if (command === undefined) {
    return usageError("missing command; run `sailor --help`");
  }

  const surplusFrom = (count: number): string | null => {
    const surplus = positionals.slice(count);

    return surplus.length === 0 ? null : surplus.join(" ");
  };

  const build = (
    name: CliCommand,
    consumedPositionals: number,
    allowed: AllowedOptions,
    phase: Phase | null
  ): CliParseResult => {
    if (update && !allowed.update) {
      return usageError(`\`${name}\` does not accept \`--update\``);
    }

    if (agent !== null && !allowed.agent) {
      return usageError(`\`${name}\` does not accept \`--agent\``);
    }

    const surplus = surplusFrom(consumedPositionals);

    if (surplus !== null) {
      return usageError(`unexpected argument \`${surplus}\``);
    }

    return {
      kind: "invocation",
      invocation: { command: name, phase, agentId: agent, update },
    };
  };

  switch (command) {
    case "init":
      return build("init", 1, { agent: false, update: true }, null);
    case "doctor":
      return build("doctor", 1, { agent: false, update: false }, null);
    case "rules": {
      const subcommand = positionals[1];

      if (subcommand === undefined) {
        return usageError(
          "`rules` requires a subcommand: `validate` or `explain`"
        );
      }

      if (subcommand === "validate") {
        return build(
          "rules validate",
          2,
          { agent: false, update: false },
          null
        );
      }

      if (subcommand === "explain") {
        return build("rules explain", 2, { agent: true, update: false }, null);
      }

      return usageError(
        `unknown \`rules\` subcommand \`${subcommand}\`: expected \`validate\` or \`explain\``
      );
    }
    case "gate": {
      const phase = positionals[1];

      if (phase === undefined) {
        return usageError(
          `\`gate\` requires a phase: ${PHASES.map((name) => `\`${name}\``).join(", ")}`
        );
      }

      if (!isPhase(phase)) {
        return usageError(
          `unknown phase \`${phase}\`: expected ${PHASES.map((name) => `\`${name}\``).join(", ")}`
        );
      }

      return build("gate", 2, { agent: true, update: false }, phase);
    }
    default:
      return usageError(
        `unknown command \`${command}\`: expected ${CLI_COMMANDS.map((name) => `\`${name}\``).join(", ")}`
      );
  }
};
