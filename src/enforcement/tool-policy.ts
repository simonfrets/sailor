import { posix } from "node:path";

import { z } from "zod";

import type { AgentTools } from "../agents/agent-definition.js";
import { buildPackageManagerCommand } from "../gates/resolve-project-script.js";
import { SAILOR_DIRECTORY } from "../sailor/layout.js";
import { projectRelativePathSchema } from "../sailor/project-path.js";
import { describeCommand } from "../processes/command-runner.js";
import type { CommandSpec } from "../processes/command-runner.js";
import type { PackageManager } from "../project/project-profile-schema.js";
import { PROJECT_SCRIPT_NAMES } from "../rules/rule-schema.js";
import type { ProjectScriptName } from "../rules/rule-schema.js";
import {
  AGENT_CONTEXT_FILE,
  agentContextDirectory,
} from "../tasks/agent-context.js";
import type { AgentContext } from "../tasks/agent-context.js";
import { matchingWriteScope } from "./write-scope.js";

/**
 * What an agent can do to a project, as the runtime sees it.
 *
 * The four kinds are the four capabilities an agent definition declares, so a
 * provider adapter has one question to answer about each thing the agent
 * attempts - which of these is it - and the policy has one answer per kind.
 */
export const TOOL_ACTION_KINDS = [
  "read",
  "search",
  "write",
  "execute",
] as const;

/** Matches `CommandSpec`, readonly arguments included, so one flows into the other. */
export const commandSpecSchema = z.strictObject({
  executable: z.string().min(1),
  args: z.array(z.string()).readonly(),
});

/**
 * An action is recorded as the agent named it. A `write` carries the path the
 * agent gave, even one that leaves the project, because the record has to
 * show what was attempted for the denial to mean anything.
 */
export const toolActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("read"), path: z.string().min(1) }),
  z.strictObject({ kind: z.literal("search"), query: z.string() }),
  z.strictObject({ kind: z.literal("write"), path: z.string().min(1) }),
  z.strictObject({ kind: z.literal("execute"), command: commandSpecSchema }),
]);

/**
 * Every reason an action is refused, so a denial is recognised by its kind
 * rather than by the wording of its reason.
 */
export const TOOL_DENIALS = [
  "context-immutable",
  "edit-disabled",
  "execute-disabled",
  "sailor-owned",
  "not-a-project-script",
  "outside-project",
  "outside-write-scope",
  "read-disabled",
  "script-not-permitted",
  "search-disabled",
] as const;

export const toolDenialSchema = z.enum(TOOL_DENIALS);

export const toolDecisionSchema = z.discriminatedUnion("verdict", [
  z.strictObject({ verdict: z.literal("allowed"), reason: z.string().min(1) }),
  z.strictObject({
    verdict: z.literal("denied"),
    denial: toolDenialSchema,
    reason: z.string().min(1),
  }),
]);

export type ToolAction = z.output<typeof toolActionSchema>;
export type ToolDenial = z.output<typeof toolDenialSchema>;
export type ToolDecision = z.output<typeof toolDecisionSchema>;
export type DeniedToolDecision = Extract<ToolDecision, { verdict: "denied" }>;

/**
 * Everything the policy needs to decide an action, and nothing it does not.
 *
 * The capabilities, scopes and scripts are the agent's own, as its definition
 * declared them and its context carried them. The context directory is where
 * the agent may leave findings whether or not it may edit the project. The
 * package manager is the project's, and is what turns an argument vector back
 * into the name of the script it runs.
 */
export interface ToolPolicy {
  readonly tools: AgentTools;
  readonly writeScopes: readonly string[];
  readonly projectScripts: readonly ProjectScriptName[];
  /** The agent's own context directory, relative to the project root. */
  readonly contextDirectory: string;
  readonly packageManager: PackageManager;
}

/**
 * The policy an agent runs under is the one its context recorded.
 *
 * It is taken from the context rather than from the definition on disk
 * because the context is what the handoff wrote down: a definition edited
 * after the handoff describes the next run, not this one. The copy is a copy,
 * so a policy cannot be changed by reaching into a context through it.
 */
export const toolPolicyFromContext = (
  context: AgentContext,
  packageManager: PackageManager
): ToolPolicy => ({
  tools: { ...context.tools },
  writeScopes: [...context.writeScopes],
  projectScripts: [...context.projectScripts],
  contextDirectory: agentContextDirectory(context.runId, context.agentId),
  packageManager,
});

const code = (text: string): string => `\`${text}\``;

const codeList = (items: readonly string[]): string =>
  items.length === 0 ? "none" : items.map(code).join(", ");

/**
 * The bare forms each package manager documents as running the `test`
 * script. Bun has none: `bun test` is Bun's own test runner, not the script.
 */
const TEST_ALIASES: Readonly<Record<PackageManager, readonly string[]>> = {
  bun: [],
  npm: ["test", "t", "tst"],
  pnpm: ["test", "t"],
  yarn: ["test"],
};

const startsWith = (
  args: readonly string[],
  prefix: readonly string[]
): boolean =>
  prefix.length <= args.length &&
  prefix.every((value, index) => args[index] === value);

/**
 * The project script an argument vector runs, or `null` when it runs none.
 *
 * A script is recognised in the form the sailor itself would build for it,
 * `<manager> run <script> [args]`, so the gate runner and the policy cannot
 * disagree about what running a script looks like. Arguments after the
 * script name do not change which script it is. The one addition is the bare
 * `test` each manager documents, because it is how the script is actually
 * run by hand.
 *
 * Anything else is not a project script. `npx jest` may well run the same
 * tests, but the policy grants scripts by name, and a command that is not one
 * of them is one the definition never mentioned.
 */
export const matchProjectScript = (
  packageManager: PackageManager,
  command: CommandSpec
): ProjectScriptName | null => {
  for (const script of PROJECT_SCRIPT_NAMES) {
    const canonical = buildPackageManagerCommand(packageManager, script, []);

    if (
      command.executable === canonical.executable &&
      startsWith(command.args, canonical.args)
    ) {
      return script;
    }
  }

  const [only] = command.args;

  if (
    command.executable === packageManager &&
    command.args.length === 1 &&
    only !== undefined &&
    TEST_ALIASES[packageManager].includes(only)
  ) {
    return "test";
  }

  return null;
};

const allowed = (reason: string): ToolDecision => ({
  verdict: "allowed",
  reason,
});

const denied = (denial: ToolDenial, reason: string): ToolDecision => ({
  verdict: "denied",
  denial,
  reason,
});

const evaluateWrite = (rawPath: string, policy: ToolPolicy): ToolDecision => {
  if (!projectRelativePathSchema.safeParse(rawPath).success) {
    return denied(
      "outside-project",
      `${code(rawPath)} is not a path inside the project`
    );
  }

  // The schema has refused `..`, so normalising can only collapse `.` and
  // doubled separators, which is what lets `./src/a.ts` fall under `src/**`.
  const path = posix.normalize(rawPath);
  const scratch = `${policy.contextDirectory}/`;

  if (path.startsWith(scratch)) {
    if (path === posix.join(policy.contextDirectory, AGENT_CONTEXT_FILE)) {
      return denied(
        "context-immutable",
        `${code(path)} is the context this agent was handed; it is read, never rewritten`
      );
    }

    return allowed(
      `${code(path)} is in this agent's scratch directory ${code(policy.contextDirectory)}`
    );
  }

  if (path === SAILOR_DIRECTORY || path.startsWith(`${SAILOR_DIRECTORY}/`)) {
    return denied(
      "sailor-owned",
      `${code(path)} belongs to the sailor; no agent writes there`
    );
  }

  if (!policy.tools.edit) {
    return denied(
      "edit-disabled",
      "this agent may not edit project files: `tools.edit` is false"
    );
  }

  const scope = matchingWriteScope(policy.writeScopes, path);

  if (scope === null) {
    return denied(
      "outside-write-scope",
      `${code(path)} is outside every write scope: ${codeList(policy.writeScopes)}`
    );
  }

  return allowed(`${code(path)} is within the write scope ${code(scope)}`);
};

const evaluateExecute = (
  command: CommandSpec,
  policy: ToolPolicy
): ToolDecision => {
  if (!policy.tools.execute) {
    return denied(
      "execute-disabled",
      "this agent may not run commands: `tools.execute` is false"
    );
  }

  const rendered = code(describeCommand(command));
  const script = matchProjectScript(policy.packageManager, command);

  if (script === null) {
    return denied(
      "not-a-project-script",
      `${rendered} is not a project script run through ${code(policy.packageManager)} (${codeList(PROJECT_SCRIPT_NAMES)})`
    );
  }

  if (!policy.projectScripts.includes(script)) {
    return denied(
      "script-not-permitted",
      `${rendered} runs the project script ${code(script)}, which this agent may not run (permitted: ${codeList(policy.projectScripts)})`
    );
  }

  return allowed(
    `${rendered} runs the permitted project script ${code(script)}`
  );
};

/**
 * Decides one action against one agent's policy.
 *
 * This is where design decision 6 stops being a sentence in a prompt. The
 * decision is a value rather than an exception because both outcomes are
 * recorded: an adapter reports every action with the verdict it received, and
 * a run whose record shows a denial is a run that tried something.
 *
 * A write is held to four things in order. It has to be inside the project,
 * or no scope can be consulted about it. The agent's own context directory is
 * scratch, writable by every agent so a reviewer that may not edit can still
 * leave its findings - except for the context file itself, which is what the
 * agent was handed and is never rewritten by the agent that holds it. The
 * rest of `.sailor/` belongs to the sailor: rules, definitions, task state
 * and hooks are what govern the agents, and a scope that could reach them
 * would let an agent widen its own scope for the next run. Only then do the
 * capability and the write scopes apply.
 *
 * An execute is a project script or it is refused. The definition grants
 * scripts by their semantic name, and that is the whole vocabulary: there is
 * no arbitrary command an agent is permitted, so there is none to evaluate.
 */
export const evaluateToolAction = (
  action: ToolAction,
  policy: ToolPolicy
): ToolDecision => {
  switch (action.kind) {
    case "read":
      return policy.tools.read
        ? allowed(`reading ${code(action.path)} is permitted`)
        : denied(
            "read-disabled",
            "this agent may not read project files: `tools.read` is false"
          );
    case "search":
      return policy.tools.search
        ? allowed("searching the project is permitted")
        : denied(
            "search-disabled",
            "this agent may not search the project: `tools.search` is false"
          );
    case "write":
      return evaluateWrite(action.path, policy);
    case "execute":
      return evaluateExecute(action.command, policy);
  }
};
