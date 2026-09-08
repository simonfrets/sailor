import { modelsForProvider } from "../../config/models-config.js";
import type { ModelsConfig } from "../../config/models-config.js";
import type { ProvidersConfig } from "../../config/providers-config.js";
import type {
  CommandRunner,
  CommandSpec,
} from "../../processes/command-runner.js";
import { DEFAULT_CLAUDE_MODELS } from "./claude-cli-adapter.js";
import type { ClaudeCliAdapterOptions } from "./claude-cli-adapter.js";

export interface ClaudeAdapterOptionsInput {
  readonly models: ModelsConfig;
  readonly providers: ProvidersConfig;
  /** The process seam the adapter runs the CLI through. */
  readonly runner: CommandRunner;
  /** How the CLI runs the gate. See `claudeToolGateCommand`. */
  readonly toolGate: CommandSpec;
}

/**
 * The Claude adapter's provider-specific options, as the project configured
 * them.
 *
 * This is the one place the two configuration files become adapter options,
 * so whatever drives a task never assembles them by hand and cannot arrive at
 * a different reading of the same files.
 *
 * A profile the project did not name keeps the adapter's own model rather
 * than becoming an empty `--model`: `config/models.yaml` is seeded, so a copy
 * written before a profile existed has to keep working, and overriding one
 * model must not mean restating the other two. A cap of `null` is passed as
 * no cap at all rather than as an absent one, because `--max-budget-usd null`
 * is what a forwarded `null` would become.
 *
 * The runner and the gate are not configuration - one is the process seam and
 * the other is a path inside this package - so they are passed in.
 */
export const claudeAdapterOptions = (
  input: ClaudeAdapterOptionsInput
): ClaudeCliAdapterOptions => {
  const [executable, ...args] = input.providers.claude.command;
  const { maxBudgetUsd } = input.providers.claude;

  return {
    runner: input.runner,
    toolGate: input.toolGate,
    claude: { executable, args },
    models: {
      ...DEFAULT_CLAUDE_MODELS,
      ...modelsForProvider(input.models, "claude"),
    },
    ...(maxBudgetUsd === null ? {} : { maxBudgetUsd }),
  };
};
