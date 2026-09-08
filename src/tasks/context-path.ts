import { posix } from "node:path";

import { SAILOR_DIRECTORY, SAILOR_PATHS } from "../sailor/layout.js";

/** The one file a context directory is required to hold. */
export const AGENT_CONTEXT_FILE = "context.json";

/**
 * Where one agent's context lives, relative to the project root.
 *
 * The run and the agent are both in the path, which is what makes a context
 * per agent per run rather than one the pipeline passes along and edits. Both
 * segments are validated identifiers, so neither can climb out of `state/` -
 * and a path arriving from anywhere else is checked before it is resolved.
 *
 * Being a function of the run id and the agent id - both of which `tasks.yaml`
 * carries, and `tasks.yaml` is committed - the path means the same thing on
 * every machine that checks the project out. The file at the end of it does
 * not: contexts live under the ignored `state/` tree, so a fresh checkout has
 * the name and not the file, and rebuilds what it needs there.
 *
 * It lives in a module of its own, importing nothing from `task-schema.ts`,
 * because the schema is what holds a task's recorded `contextPath` to the path
 * its own run and agent name. Leaving it beside the context reader would have
 * made that a cycle.
 */
export const agentContextDirectory = (runId: string, agentId: string): string =>
  posix.join(
    SAILOR_DIRECTORY,
    ...SAILOR_PATHS.runs.split(/[\\/]/),
    runId,
    "agents",
    agentId
  );

export const agentContextFile = (runId: string, agentId: string): string =>
  posix.join(agentContextDirectory(runId, agentId), AGENT_CONTEXT_FILE);
