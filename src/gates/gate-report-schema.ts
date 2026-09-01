import { z } from "zod";

import { agentIdSchema } from "../agents/agent-id.js";
import { commandSpecSchema } from "../enforcement/tool-policy.js";
import { phaseSchema, severitySchema } from "../rules/rule-schema.js";
import { sha256Schema, timestampSchema } from "../tasks/task-schema.js";

/**
 * The identifier a persisted report is filed under. It becomes a file name
 * inside the run's report directory, so it is held to one path segment:
 * both id makers already satisfy it - `createDefaultReportId` is a UUID and
 * `createDeterministicReportId` is 32 hex characters - and an id that could
 * carry a `/` or lead with a dot would name a file somewhere else.
 */
export const reportIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/,
    "report ids are single path segments of letters, digits and dashes"
  );

export const GATE_STATUSES = [
  "passed",
  "failed",
  "skipped",
  "timed-out",
  "spawn-failed",
] as const;

export const gateStatusSchema = z.enum(GATE_STATUSES);

export const gateResultSchema = z.strictObject({
  ruleId: z.string().min(1),
  checkId: z.string().min(1),
  severity: severitySchema,
  required: z.boolean(),
  blocking: z.boolean(),
  status: gateStatusSchema,
  command: commandSpecSchema.nullable(),
  exitCode: z.int().nullable(),
  signal: z.string().min(1).nullable(),
  stdout: z.string(),
  stderr: z.string(),
  outputTruncated: z.boolean(),
  durationMs: z.number().min(0),
  detail: z.string().min(1),
});

export const PHASE_GATE_STATUSES = [
  "passed",
  "passed-with-warnings",
  "failed",
] as const;

/**
 * The persisted shape of a `PhaseGateReport`.
 *
 * `runPhaseGates` keeps returning its interface; this schema exists because
 * reports are written under the run and read back later, and a file is only
 * evidence if a reader can tell it from damage. A test parses a report the
 * real runner produced, so the interface and the schema cannot drift apart
 * without a failure saying so.
 */
export const phaseGateReportSchema = z.strictObject({
  reportId: reportIdSchema,
  phase: phaseSchema,
  agentId: agentIdSchema.nullable(),
  ruleSetSha256: sha256Schema,
  status: z.enum(PHASE_GATE_STATUSES),
  blocked: z.boolean(),
  startedAt: timestampSchema,
  finishedAt: timestampSchema,
  durationMs: z.number().min(0),
  results: z.array(gateResultSchema),
  skippedCheckIds: z.array(z.string().min(1)),
  blockingFailureCount: z.int().min(0),
  warningFailureCount: z.int().min(0),
});

export type StoredGateResult = z.output<typeof gateResultSchema>;
export type StoredPhaseGateReport = z.output<typeof phaseGateReportSchema>;
