import type { AgentId } from "../agents/agent-id.js";
import type { ModelsConfig } from "../config/models-config.js";
import { providerForAgent } from "../config/providers-config.js";
import type { ProvidersConfig } from "../config/providers-config.js";
import { SailorError } from "../sailor/sailor-error.js";
import type {
  CommandRunner,
  CommandSpec,
} from "../processes/command-runner.js";
import { createClaudeCliAdapter } from "../providers/claude/claude-cli-adapter.js";
import { claudeToolGateCommand } from "../providers/claude/claude-cli-adapter.js";
import { claudeAdapterOptions } from "../providers/claude/claude-config.js";
import { PROVIDER_CLI_VERSIONS } from "../providers/provider-adapter.js";
import type {
  ProviderAdapter,
  ProviderId,
} from "../providers/provider-adapter.js";

/**
 * Whether this package can drive a provider at all.
 *
 * `PROVIDER_CLI_VERSIONS` records the CLI version each adapter was written
 * against and `null` where no adapter exists, so the fact lives beside the
 * contract as data rather than as a list repeated here and in `sailor doctor`.
 */
export const hasProviderAdapter = (provider: ProviderId): boolean =>
  PROVIDER_CLI_VERSIONS[provider] !== null;

/** The wording `sailor doctor` uses, so a driver refusal reads like its diagnosis. */
const noAdapter = (provider: ProviderId): string =>
  `this sailor has no adapter for ${provider}, so no agent can be run on it whether or not its CLI is installed`;

/**
 * Refuses, before anything is spawned, a run whose agents are routed to a
 * provider this sailor cannot drive.
 *
 * It is decided up front and for every agent the run will reach, not for the
 * one about to start: an installation that routes the hardener to `codex`
 * would otherwise run the coder and the cleaner for real, spend whatever they
 * cost, and stop three stages in on a fact that was knowable before the first
 * process started. It is a fact about this package rather than about the
 * machine, so nothing is probed to establish it.
 */
export const requireProviderAdapters = (
  providers: ProvidersConfig,
  agentIds: readonly AgentId[]
): void => {
  const missing = new Map<ProviderId, AgentId[]>();

  for (const agentId of agentIds) {
    const provider = providerForAgent(providers, agentId);

    if (!hasProviderAdapter(provider)) {
      missing.set(provider, [...(missing.get(provider) ?? []), agentId]);
    }
  }

  if (missing.size === 0) {
    return;
  }

  throw new SailorError(
    "invalid-config",
    "this run cannot be driven with the providers it is configured to use",
    [...missing].map(
      ([provider, agents]) =>
        `${noAdapter(provider)}: ${agents.map((agent) => `\`${agent}\``).join(", ")}`
    )
  );
};

export interface CreateProviderAdapterOptions {
  readonly provider: ProviderId;
  readonly models: ModelsConfig;
  readonly providers: ProvidersConfig;
  /** The process seam every provider runs its CLI through. */
  readonly runner: CommandRunner;
  /** Root of the installed `sailor` package, which is where the gate lives. */
  readonly packageRootDirectory: string;
  /** The Node that runs the gate, as `process.execPath`. */
  readonly nodeExecutable: string;
  /**
   * How a provider runs its gate program.
   *
   * It defaults to the built program under `packageRootDirectory`, which is
   * where an installed sailor has it, and is overridable because where that
   * program lives is a fact about the installation rather than about the
   * provider: a suite running against this source tree has no `dist/`, and a
   * gate that could not be started would let every tool call through
   * unexamined.
   */
  readonly toolGate?: CommandSpec;
  readonly now?: () => Date;
}

/**
 * Builds the adapter for one provider out of the installed configuration.
 *
 * `claudeAdapterOptions` is the one place `models.yaml` and `providers.yaml`
 * become adapter options, so a driver never assembles them and cannot arrive
 * at a second reading of the same files. A provider with no adapter is
 * refused here too, because this function is also reachable without going
 * through `requireProviderAdapters` first, and a test holds the two answers
 * together so neither can start admitting a provider the other does not.
 */
export const createProviderAdapter = (
  options: CreateProviderAdapterOptions
): ProviderAdapter => {
  if (options.provider === "claude") {
    return createClaudeCliAdapter({
      ...claudeAdapterOptions({
        models: options.models,
        providers: options.providers,
        runner: options.runner,
        toolGate:
          options.toolGate ??
          claudeToolGateCommand(
            options.packageRootDirectory,
            options.nodeExecutable
          ),
      }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  throw new SailorError("invalid-config", noAdapter(options.provider));
};
