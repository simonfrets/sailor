import { posix } from "node:path";

import { loadAgentDefinition } from "../agents/agent-definition.js";
import type { AgentDefinition } from "../agents/agent-definition.js";
import type { AgentId } from "../agents/agent-id.js";
import { SailorError } from "../sailor/sailor-error.js";
import {
  SAILOR_DIRECTORY,
  SAILOR_PATHS,
  sailorPath,
} from "../sailor/layout.js";
import { readTextFileIfPresent } from "../sailor/read-text-file.js";

/** Where one agent's definition lives, relative to the project root. */
export const installedAgentPath = (agentId: AgentId): string =>
  posix.join(SAILOR_DIRECTORY, SAILOR_PATHS.agents, `${agentId}.yaml`);

/**
 * Reads the definition of one agent out of the installed sailor.
 *
 * Definitions are **managed** files, so a project that has been installed has
 * all six and an edit to one is already a conflict at install time. A missing
 * one here is therefore a broken installation rather than a project decision,
 * and it is reported as invalid configuration naming the file: by the time
 * anything asks for an agent, `loadSailorRuleSet` has already reported an
 * absent `.sailor` as `not-installed`.
 *
 * The id inside the file is held to the id in its name. They are two records
 * of the same fact, and a `coder.yaml` declaring `cleaner` would hand the
 * coder's stage the cleaner's tools and write scopes - the same
 * wrong-policy-by-accident the task schema refuses for `agentId`.
 */
export const readInstalledAgentDefinition = (
  projectRoot: string,
  agentId: AgentId
): AgentDefinition => {
  const source = installedAgentPath(agentId);
  const text = readTextFileIfPresent(
    sailorPath(projectRoot, SAILOR_PATHS.agents, `${agentId}.yaml`)
  );

  if (text === null) {
    throw new SailorError(
      "invalid-config",
      `this project has no definition for the \`${agentId}\` agent at ${source}`,
      [
        "agent definitions are managed files; `sailor init --update` restores one this version ships",
      ]
    );
  }

  const definition = loadAgentDefinition(text, { source });

  if (definition.id !== agentId) {
    throw new SailorError(
      "invalid-config",
      `${source} declares the \`${definition.id}\` agent`,
      [
        "the file name and the `id` inside it are two records of one fact, and the stage would run under the wrong tools and write scopes",
      ]
    );
  }

  return definition;
};
