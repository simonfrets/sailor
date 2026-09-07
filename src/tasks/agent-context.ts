import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { agentIdSchema } from "../agents/agent-id.js";
import { agentToolsSchema } from "../agents/agent-definition.js";
import type { AgentDefinition } from "../agents/agent-definition.js";
import { z } from "zod";

import { writeFileAtomic } from "../sailor/atomic-write.js";
import { SailorError } from "../sailor/sailor-error.js";
import { SAILOR_DIRECTORY, SAILOR_PATHS } from "../sailor/layout.js";
import {
  projectRelativeGlobSchema,
  projectRelativePathSchema,
} from "../sailor/project-path.js";
import { projectScriptNameSchema } from "../rules/rule-schema.js";
import { TASK_FILE_SOURCE } from "./task-file.js";
import {
  runIdSchema,
  sha256Schema,
  taskFailureSchema,
  taskIdSchema,
  taskStateSchema,
  timestampSchema,
} from "./task-schema.js";
import type { Task } from "./task-schema.js";

export const AGENT_CONTEXT_VERSION = 1;

/** The one file a context directory is required to hold. */
export const AGENT_CONTEXT_FILE = "context.json";

const CONTEXT_MODE = 0o644;

/** What the previous agent left behind for this one. */
export const contextHandoffSchema = z.strictObject({
  /** Null when nothing preceded this agent in the run. */
  fromAgent: agentIdSchema.nullable(),
  fromState: taskStateSchema,
  gateReportIds: z.array(z.string().min(1)).default([]),
  artifactPaths: z.array(projectRelativePathSchema).default([]),
  /** Why the work stopped, when this context resumes an interruption. */
  failure: taskFailureSchema.nullable().default(null),
});

/**
 * Everything one agent is given for one handoff.
 *
 * The tool policy travels with it because design decision 6 puts enforcement
 * in the runtime rather than in the prompt: a runtime that had to go and look
 * the policy up somewhere else could be pointed at a different one. The
 * rule-set hash travels with it because decision 7 requires every handoff to
 * record which rules it was made under, and a hash written only into the task
 * file would not be readable from inside the agent's own directory.
 */
export const agentContextSchema = z.strictObject({
  version: z.literal(AGENT_CONTEXT_VERSION),
  runId: runIdSchema,
  agentId: agentIdSchema,
  taskId: taskIdSchema,
  taskTitle: z.string().min(1),
  /** The revision this context was built from. */
  taskRevision: z.int().min(1),
  state: taskStateSchema,
  attempt: z.int().min(1),
  ruleSetSha256: sha256Schema,
  writtenAt: timestampSchema,
  tools: agentToolsSchema,
  writeScopes: z.array(projectRelativeGlobSchema),
  projectScripts: z.array(projectScriptNameSchema),
  /** The compiled policy, as Markdown. Provider-neutral. */
  policy: z.string().min(1),
  handoff: contextHandoffSchema.nullable().default(null),
});

export type ContextHandoff = z.output<typeof contextHandoffSchema>;
export type AgentContext = z.output<typeof agentContextSchema>;

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

/**
 * Resolves a recorded context path against a project, refusing to leave it.
 *
 * The recorded form already starts at `.sailor`, because that is what
 * `tasks.yaml` has to carry to mean the same thing on the next machine.
 *
 * The guard is here rather than at one call site because the two callers reach
 * this from opposite directions. `writeAgentContext` builds its path from a run
 * id and an agent id the schema has already validated, so it cannot escape.
 * `readAgentContext` is handed a string by whoever holds it, and is a public
 * export whose intended consumer is a runtime that has not been written yet: a
 * `..` segment in a hand-edited `tasks.yaml` would otherwise load a context
 * from outside the project entirely, and a context is what says which files an
 * agent may write.
 */
const absoluteContextPath = (projectRoot: string, relative: string): string => {
  const validated = projectRelativePathSchema.safeParse(relative);

  if (!validated.success) {
    throw new SailorError(
      "invalid-config",
      `\`${relative}\` is not a context path inside this project`,
      validated.error.issues.map((issue) => issue.message)
    );
  }

  return join(projectRoot, ...relative.split(posix.sep));
};

export interface BuildAgentContextInput {
  readonly task: Task;
  readonly definition: AgentDefinition;
  /** Output of `compileAgentPolicy` for this agent and rule set. */
  readonly policy: string;
  readonly ruleSetSha256: string;
  readonly at: Date;
  readonly attempt: number;
  readonly handoff?: ContextHandoff | null;
}

/**
 * Assembles the context one agent is about to be handed.
 *
 * The capabilities are read from that agent's own definition rather than
 * passed in, so two agents in one run cannot end up holding the same policy by
 * being built from the same argument. What comes back is the schema's own
 * output, which is a fresh structure rather than a view onto the definition
 * that produced it - a context that aliased its definition would change under
 * the agent holding it the moment anything else touched that definition.
 */
export const buildAgentContext = (
  input: BuildAgentContextInput
): AgentContext => {
  const context = {
    version: AGENT_CONTEXT_VERSION,
    runId: input.task.runId,
    agentId: input.definition.id,
    taskId: input.task.id,
    taskTitle: input.task.title,
    taskRevision: input.task.revision,
    state: input.task.state,
    attempt: input.attempt,
    ruleSetSha256: input.ruleSetSha256,
    writtenAt: input.at.toISOString(),
    tools: input.definition.tools,
    writeScopes: input.definition.writeScopes,
    projectScripts: input.definition.projectScripts,
    policy: input.policy,
    handoff: input.handoff ?? null,
  };

  const result = agentContextSchema.safeParse(context);

  if (!result.success) {
    throw new SailorError(
      "invalid-config",
      `cannot build a context for \`${input.definition.id}\` on task \`${input.task.id}\``,
      result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`
      )
    );
  }

  return result.data;
};

/**
 * Writes a context into the directory its own run and agent name.
 *
 * The destination is derived from the context rather than supplied beside it,
 * so a caller cannot write one agent's context over another's, and the path
 * recorded in `tasks.yaml` is the path the file is actually at.
 *
 * Writing it is cheap and repeatable on purpose. Everything in a context is
 * derived from things a checkout already has - the task, the agent definition
 * and the resolved rule set - so a machine that finds none writes its own
 * rather than needing the one that made the handoff.
 */
export const writeAgentContext = (
  projectRoot: string,
  context: AgentContext
): string => {
  const relative = agentContextFile(context.runId, context.agentId);

  writeFileAtomic(
    absoluteContextPath(projectRoot, relative),
    `${JSON.stringify(context, null, 2)}\n`,
    CONTEXT_MODE
  );

  return agentContextDirectory(context.runId, context.agentId);
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  for (const entry of Object.values(value)) {
    deepFreeze(entry);
  }

  return Object.freeze(value);
};

/**
 * Reads a context back, frozen.
 *
 * Every read parses the file again, so two agents never hold the same object,
 * and the result is frozen so a runtime that passed one along by mistake could
 * not turn it into the single mutable context this layout exists to prevent.
 *
 * A context this machine never wrote is reported as `missing-context` rather
 * than as a broken configuration, because the two call for opposite responses:
 * a resumed run that finds nothing has to build the context it needs, while
 * one that finds a damaged file must not paper over it. Distinguishing them by
 * kind rather than by message is the whole point of having kinds.
 */
export const readAgentContext = (
  projectRoot: string,
  contextDirectory: string
): AgentContext => {
  const relative = posix.join(contextDirectory, AGENT_CONTEXT_FILE);
  const path = absoluteContextPath(projectRoot, relative);

  if (!existsSync(path)) {
    throw new SailorError(
      "missing-context",
      `${relative} was not written on this machine`,
      [
        "agent contexts live under the ignored `state/` tree, so a checkout carries none",
        `rebuild it from ${TASK_FILE_SOURCE}, the agent definition and the resolved rule set`,
      ]
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error: unknown) {
    throw new SailorError(
      "invalid-config",
      `${contextDirectory} does not hold a readable ${AGENT_CONTEXT_FILE}`,
      [String(error)]
    );
  }

  const result = agentContextSchema.safeParse(parsed);

  if (!result.success) {
    throw new SailorError(
      "invalid-config",
      `${relative} is not a valid agent context`,
      result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`
      )
    );
  }

  return deepFreeze(result.data);
};
