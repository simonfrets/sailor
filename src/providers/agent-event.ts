import { z } from "zod";

import {
  commandSpecSchema,
  toolActionSchema,
  toolDecisionSchema,
} from "../enforcement/tool-policy.js";
import { describeCommandResult } from "../processes/command-runner.js";
import type { CommandResult } from "../processes/command-runner.js";
import { timestampSchema } from "../tasks/task-schema.js";

/**
 * What an adapter reports while an agent runs, in the order a run has them:
 * `started` once, then any number of `output` chunks and `tool-action`s, then
 * `finished` once, last.
 */
export const AGENT_EVENT_KINDS = [
  "started",
  "output",
  "tool-action",
  "finished",
] as const;

/**
 * How a run ended. `aborted` is the caller's doing, through the invocation's
 * signal; the other three are the process's.
 */
export const AGENT_STATUSES = [
  "completed",
  "failed",
  "timed-out",
  "aborted",
] as const;

export const OUTPUT_STREAMS = ["stdout", "stderr"] as const;

export const agentStatusSchema = z.enum(AGENT_STATUSES);

/**
 * Events are validated, not merely typed, because an adapter translates a
 * provider's output into them and the record of a run is read back later.
 * A `tool-action` carries the verdict the adapter received for it, so the
 * record shows what the agent tried and what was refused.
 */
export const agentEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("started"),
    at: timestampSchema,
    /** The process the adapter ran, or null for an adapter that ran none. */
    command: commandSpecSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("output"),
    at: timestampSchema,
    stream: z.enum(OUTPUT_STREAMS),
    text: z.string(),
  }),
  z.strictObject({
    kind: z.literal("tool-action"),
    at: timestampSchema,
    action: toolActionSchema,
    decision: toolDecisionSchema,
  }),
  z.strictObject({
    kind: z.literal("finished"),
    at: timestampSchema,
    status: agentStatusSchema,
    /** One printable line saying what happened. Always populated. */
    detail: z.string().min(1),
    exitCode: z.int().nullable(),
    durationMs: z.int().min(0),
  }),
]);

export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];
export type AgentStatus = z.output<typeof agentStatusSchema>;
export type OutputStream = (typeof OUTPUT_STREAMS)[number];
export type AgentEvent = z.output<typeof agentEventSchema>;
export type FinishedEvent = Extract<AgentEvent, { kind: "finished" }>;

/**
 * The status a process outcome amounts to. A signal and a spawn failure are
 * both failures: the agent did not finish, and neither is the caller's
 * timeout or the caller's abort, which are reported on their own.
 */
export const agentStatusOfCommandResult = (
  result: CommandResult
): AgentStatus => {
  switch (result.outcome) {
    case "exited":
      return result.exitCode === 0 ? "completed" : "failed";
    case "signaled":
    case "spawn-failed":
      return "failed";
    case "timed-out":
      return "timed-out";
  }
};

/**
 * The closing event for a run that was a process.
 *
 * An adapter built on `CommandRunner` gets its timeouts, its output cap and
 * its environment allowlist from there, and gets its final status from here,
 * so the two do not describe one outcome in two vocabularies. A run whose
 * signal fired is `aborted` only if it did not finish cleanly anyway: an agent
 * that exited 0 before the abort reached it completed, whatever was intended.
 */
export const finishedEventOf = (
  result: CommandResult,
  at: string,
  signal?: AbortSignal
): FinishedEvent => {
  const status = agentStatusOfCommandResult(result);

  return {
    kind: "finished",
    at,
    status:
      status !== "completed" && signal?.aborted === true ? "aborted" : status,
    detail: describeCommandResult(result),
    exitCode: result.outcome === "exited" ? result.exitCode : null,
    durationMs: result.durationMs,
  };
};
