import { isAbsolute } from "node:path";

import { z } from "zod";

import type { ModelProfile } from "../agents/agent-definition.js";
import { toolPolicyFromContext } from "../enforcement/tool-policy.js";
import type { ToolPolicy } from "../enforcement/tool-policy.js";
import { deepFreeze } from "../sailor/deep-freeze.js";
import { SailorError } from "../sailor/sailor-error.js";
import type { PackageManager } from "../project/project-profile-schema.js";
import { agentContextDirectory } from "../tasks/agent-context.js";
import type { AgentContext, ContextHandoff } from "../tasks/agent-context.js";
import type { Task } from "../tasks/task-schema.js";
import { agentEventSchema } from "./agent-event.js";
import type { AgentEvent, FinishedEvent } from "./agent-event.js";

/** The two providers the design names. A provider's flags live in its adapter, never here. */
export const PROVIDER_IDS = ["claude", "codex"] as const;

export const providerIdSchema = z.enum(PROVIDER_IDS);

export type ProviderId = z.output<typeof providerIdSchema>;

/**
 * Everything an adapter is handed for one run of one agent.
 *
 * It carries what the design lists - the project root, the isolated context
 * path, a task snapshot, the compiled policy, the logical model profile, the
 * allowed tools, a timeout and an abort signal - and it carries the attempt
 * and the previous agent's handoff, because a prompt for a retry has to say
 * what failed. It is provider-neutral: no flag, no model identifier, no
 * executable. Mapping the profile to a model and the policy to a provider's
 * own permission scheme is the adapter's work.
 */
export interface AgentInvocation {
  /** Absolute. The adapter runs the provider here. */
  readonly projectRoot: string;
  /** The agent's context directory, relative to the project root. */
  readonly contextPath: string;
  /** Frozen. A view of the task as it stood when the run began. */
  readonly task: Task;
  readonly attempt: number;
  readonly handoff: ContextHandoff | null;
  /** The compiled policy, as Markdown. */
  readonly policy: string;
  readonly modelProfile: ModelProfile;
  /** What the agent may do, as `evaluateToolAction` and the audit read it. */
  readonly toolPolicy: ToolPolicy;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface BuildAgentInvocationInput {
  readonly projectRoot: string;
  readonly task: Task;
  /** The context the handoff wrote for this task, as `readAgentContext` returns it. */
  readonly context: AgentContext;
  readonly modelProfile: ModelProfile;
  readonly packageManager: PackageManager;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

const code = (text: string): string => `\`${text}\``;

/**
 * Builds an invocation from a task and the context its handoff wrote.
 *
 * The capabilities, scopes, scripts and policy all come from the context and
 * nowhere else, so the adapter and the working-tree audit read one policy
 * rather than two that could disagree. The result is frozen and copied: an
 * adapter cannot reach the task file through it, and a task the runtime goes
 * on changing does not change under the agent.
 *
 * Refused, with every disagreement listed at once: a context written for
 * another task, run, revision, state or agent, and a task whose recorded
 * context path is not the one its own run and agent name. The second is what
 * a retry needs. `transitionTask` mints a new run for a retry, and a driver
 * that wrote the context under the old run leaves a task whose `runId` and
 * `contextPath` disagree, with nothing until now to say so. Running the stage
 * anyway would run it under whichever policy that other context carries.
 */
export const buildAgentInvocation = (
  input: BuildAgentInvocationInput
): AgentInvocation => {
  const { task, context } = input;

  if (task.agentId === null) {
    throw new SailorError(
      "invalid-invocation",
      `task ${code(task.id)} is ${code(task.state)}, which no agent owns`,
      ["only a task in a stage an agent owns can be handed to one"]
    );
  }

  const contextPath = agentContextDirectory(task.runId, task.agentId);
  const issues: string[] = [];

  if (context.taskId !== task.id) {
    issues.push(
      `the context was written for task ${code(context.taskId)}, not ${code(task.id)}`
    );
  }

  if (context.runId !== task.runId) {
    issues.push(
      `the context was written for run ${code(context.runId)}, not ${code(task.runId)}`
    );
  }

  if (context.taskRevision !== task.revision) {
    issues.push(
      `the context was written at revision ${String(context.taskRevision)}, not ${String(task.revision)}`
    );
  }

  if (context.state !== task.state) {
    issues.push(
      `the context was written for ${code(context.state)}, not ${code(task.state)}`
    );
  }

  if (context.agentId !== task.agentId) {
    issues.push(
      `the context was written for agent ${code(context.agentId)}, not ${code(task.agentId)}`
    );
  }

  if (task.contextPath === null) {
    issues.push("the task records no context path");
  } else if (task.contextPath !== contextPath) {
    issues.push(
      `the task records its context at ${code(task.contextPath)}, not ${code(contextPath)}, which its run and agent name`
    );
  }

  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    issues.push("the timeout must be a positive whole number of milliseconds");
  }

  if (!isAbsolute(input.projectRoot)) {
    issues.push("the project root must be absolute");
  }

  if (issues.length > 0) {
    throw new SailorError(
      "invalid-invocation",
      `task ${code(task.id)} cannot be handed to ${code(task.agentId)}`,
      issues
    );
  }

  return Object.freeze({
    projectRoot: input.projectRoot,
    contextPath,
    task: deepFreeze(structuredClone(task)),
    attempt: context.attempt,
    handoff: deepFreeze(structuredClone(context.handoff)),
    policy: context.policy,
    modelProfile: input.modelProfile,
    toolPolicy: deepFreeze(
      toolPolicyFromContext(context, input.packageManager)
    ),
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
};

/**
 * The one method a provider implements.
 *
 * Events are pulled rather than pushed so the runtime consuming them decides
 * the pace, and so an adapter that has to wait on a process can do so
 * without a callback. The iterable ends when the run does.
 */
export interface ProviderAdapter {
  readonly provider: ProviderId;
  invoke(invocation: AgentInvocation): AsyncIterable<AgentEvent>;
}

/**
 * An adapter broke the event protocol.
 *
 * It is not a `SailorError` because it is not an operational condition: an
 * adapter that reports `finished` twice is a defect in that adapter, and
 * mapping it to an exit code would present it as something the operator
 * could act on.
 */
export class ProviderProtocolError extends Error {
  public readonly provider: ProviderId;

  public constructor(provider: ProviderId, detail: string) {
    super(`the ${provider} adapter ${detail}`);
    this.name = "ProviderProtocolError";
    this.provider = provider;
  }
}

export interface AgentRunRecord {
  readonly events: readonly AgentEvent[];
  /** The last event, which is how the run ended. Also in `events`. */
  readonly finished: FinishedEvent;
}

export interface RecordAgentRunOptions {
  /** Called with each event as it is validated, for a log that streams. */
  readonly onEvent?: (event: AgentEvent) => void;
}

/**
 * Drives an adapter through one invocation and records what it reported.
 *
 * Every event is validated against the schema and held to the order the
 * contract fixes: `started` first and once, `finished` last and once,
 * nothing after it. A run that ends without finishing has no status, and is
 * refused rather than given one. An adapter's own failure is let through as
 * it is: turning it into a `finished: failed` event would record a run that
 * did not happen as one that did.
 */
export const recordAgentRun = async (
  adapter: ProviderAdapter,
  invocation: AgentInvocation,
  options: RecordAgentRunOptions = {}
): Promise<AgentRunRecord> => {
  const events: AgentEvent[] = [];
  let finished: FinishedEvent | null = null;

  const fail = (detail: string): ProviderProtocolError =>
    new ProviderProtocolError(adapter.provider, detail);

  for await (const reported of adapter.invoke(invocation)) {
    const parsed = agentEventSchema.safeParse(reported);

    if (!parsed.success) {
      throw fail(
        `reported something that is not an agent event: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`
      );
    }

    const event = parsed.data;

    if (finished !== null) {
      throw fail(`reported ${code(event.kind)} after ${code("finished")}`);
    }

    if (events.length === 0 && event.kind !== "started") {
      throw fail(`first event was ${code(event.kind)}, not ${code("started")}`);
    }

    if (events.length > 0 && event.kind === "started") {
      throw fail("started twice");
    }

    events.push(event);
    options.onEvent?.(event);

    if (event.kind === "finished") {
      finished = event;
    }
  }

  if (finished === null) {
    throw fail(`ended without a ${code("finished")} event`);
  }

  return { events, finished };
};
