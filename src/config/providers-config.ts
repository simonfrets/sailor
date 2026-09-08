import { z } from "zod";

import { agentIdSchema } from "../agents/agent-id.js";
import type { AgentId } from "../agents/agent-id.js";
import { providerIdSchema } from "../providers/provider-adapter.js";
import type { ProviderId } from "../providers/provider-adapter.js";
import {
  SAILOR_DIRECTORY,
  SAILOR_PATHS,
  sailorPath,
} from "../sailor/layout.js";
import { readTextFileIfPresent } from "../sailor/read-text-file.js";
import { loadYamlConfig } from "./load-yaml-config.js";

/**
 * How each provider's command line is started when the file says nothing.
 *
 * The executable name is not a provider flag, so naming it here is not the
 * guess the design forbids: what is version-sensitive lives in the adapter,
 * written against the installed `--help`. A test pins this against the
 * adapter's own default, so the two cannot be changed apart.
 */
export const DEFAULT_PROVIDER_COMMANDS: Readonly<
  Record<ProviderId, readonly [string, ...string[]]>
> = {
  claude: ["claude"],
  codex: ["codex"],
};

/**
 * An argument vector, never a shell string, and never empty: the first word
 * is the executable, which a shell would otherwise have to find in a string.
 *
 * A tuple rather than a length-checked array, so the executable is a `string`
 * to whatever destructures it rather than a `string | undefined` needing a
 * fallback branch that nothing could reach.
 */
export const providerCommandSchema = z.tuple(
  [z.string().min(1)],
  z.string().min(1)
);

export const claudeProviderConfigSchema = z.strictObject({
  command: providerCommandSchema.default([...DEFAULT_PROVIDER_COMMANDS.claude]),
  /**
   * Passed as `--max-budget-usd`. `null` is no cap, which is the seeded
   * default because a cap that stops a run half way through leaves the tree
   * the agent was in the middle of changing, and what a run is worth is the
   * project's judgement rather than the sailor's.
   */
  maxBudgetUsd: z.number().positive().nullable().default(null),
});

/**
 * Codex has a command and nothing else, because nothing else about its CLI
 * has been read. `codex` is not installed where this was built, so the
 * adapter is unwritten and any option shaped for it would be a guess.
 */
export const codexProviderConfigSchema = z.strictObject({
  command: providerCommandSchema.default([...DEFAULT_PROVIDER_COMMANDS.codex]),
});

/**
 * Which provider runs an agent, and how that provider is started.
 *
 * The provider is not a property of an agent definition: a definition names a
 * logical model profile and stays portable across adapters, so the mapping
 * from agent to provider belongs to the project rather than to the shipped
 * agent. Every key has a default, as every seeded file's must.
 */
export const providersConfigSchema = z.strictObject({
  version: z.literal(1),
  /** The provider every agent runs on unless `agents` names another. */
  default: providerIdSchema.default("claude"),
  agents: z.record(agentIdSchema, providerIdSchema).default({}),
  claude: claudeProviderConfigSchema.default({
    command: [...DEFAULT_PROVIDER_COMMANDS.claude],
    maxBudgetUsd: null,
  }),
  codex: codexProviderConfigSchema.default({
    command: [...DEFAULT_PROVIDER_COMMANDS.codex],
  }),
});

export type ProviderCommand = z.output<typeof providerCommandSchema>;
export type ClaudeProviderConfig = z.output<typeof claudeProviderConfigSchema>;
export type CodexProviderConfig = z.output<typeof codexProviderConfigSchema>;
export type ProvidersConfig = z.output<typeof providersConfigSchema>;

export const providerForAgent = (
  config: ProvidersConfig,
  agentId: AgentId
): ProviderId => config.agents[agentId] ?? config.default;

/**
 * The command that starts one provider's CLI.
 *
 * Written out rather than indexed, because the two provider blocks are
 * different shapes: only Claude's carries a spending cap.
 */
export const providerCommand = (
  config: ProvidersConfig,
  provider: ProviderId
): ProviderCommand =>
  provider === "claude" ? config.claude.command : config.codex.command;

export const loadProvidersConfig = (
  text: string,
  options: { readonly source: string }
): ProvidersConfig => loadYamlConfig(text, providersConfigSchema, options);

/**
 * The installed copy, or the defaults where none was ever installed.
 *
 * An invalid file is reported rather than ignored: a project that pinned its
 * agents to one provider and mistyped it would otherwise have them all run on
 * the default, which is the opposite of what it asked for.
 */
export const readInstalledProvidersConfig = (
  projectRoot: string
): ProvidersConfig => {
  const source = `${SAILOR_DIRECTORY}/${SAILOR_PATHS.providersConfig}`;
  const text = readTextFileIfPresent(
    sailorPath(projectRoot, SAILOR_PATHS.providersConfig)
  );

  return text === null
    ? providersConfigSchema.parse({ version: 1 })
    : loadProvidersConfig(text, { source });
};
