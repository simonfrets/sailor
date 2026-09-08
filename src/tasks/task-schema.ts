import { z } from "zod";

import { agentIdSchema } from "../agents/agent-id.js";
import type { BuiltInAgentId } from "../agents/agent-id.js";
import { notificationChannelSchema } from "../config/notifications-config.js";
import { projectRelativePathSchema } from "../sailor/project-path.js";
import { phaseSchema } from "../rules/rule-schema.js";
import { agentContextDirectory } from "./context-path.js";

/**
 * The pipeline states, in the order the workflow runs them.
 *
 * The order is load-bearing: `resolveTransitions` reads adjacency from this
 * array rather than from a hand-written edge list, so the sequence in
 * `docs/handoff/rule-enforcement.md` and the sequence the code enforces cannot
 * drift apart.
 */
export const WORKFLOW_STATES = [
  "draft",
  "specified",
  "awaiting_approval",
  "implementing",
  "cleaning",
  "architecture_review",
  "hardening",
  "qa",
  "completed",
] as const;

/**
 * The two states an interrupted task rests in.
 *
 * They are not stages: nothing is being worked on in either, and a task only
 * leaves one through a recovery transition back into the pipeline.
 */
export const INTERRUPTED_STATES = ["blocked", "failed"] as const;

export const TASK_STATES = [...WORKFLOW_STATES, ...INTERRUPTED_STATES] as const;

export const taskStateSchema = z.enum(TASK_STATES);

export type WorkflowState = (typeof WORKFLOW_STATES)[number];
export type InterruptedState = (typeof INTERRUPTED_STATES)[number];
export type TaskState = z.output<typeof taskStateSchema>;

/** The one state a task never leaves. */
export const TERMINAL_STATE = "completed" as const;

/** A pipeline state work can still be going on in. */
export type ActiveState = Exclude<WorkflowState, typeof TERMINAL_STATE>;

/**
 * The pipeline states a task can still be working in.
 *
 * `completed` is excluded because nothing is in progress there, which is what
 * makes "every active state may transition to `blocked` or `failed`" a rule
 * about eight states rather than nine. It lives here rather than beside the
 * workflow functions because the schema below has to be able to say that a
 * task was interrupted in one of these and in nothing else.
 */
export const ACTIVE_STATES: readonly ActiveState[] = WORKFLOW_STATES.filter(
  (state): state is ActiveState => state !== TERMINAL_STATE
);

/**
 * The stage a task stopped in, as recorded by a blocked or failed one.
 *
 * Deliberately narrower than `taskStateSchema`. `tasks.yaml` is committed and
 * meant to be read in a pull request, so a hand edit or a merge conflict can
 * put any state here, and recovery is computed as the stages up to and
 * including this one: `completed` would open the entire pipeline, so a task
 * could be walked straight to done without ever entering `implementing` or
 * `qa`. `blocked` and `failed` are refused with it, because neither is a stage
 * any work happened in.
 */
const activeStateSchema = z.enum(ACTIVE_STATES);

/**
 * The agent that owns each state, or `null` where none does.
 *
 * The specification fixes nine states and six agents and never says which
 * belongs to which, but something has to: design decision 6 puts tool
 * enforcement in the runtime, and what the runtime enforces is the policy of
 * the agent recorded against the state. Record the wrong one and the stage
 * runs under another agent's rights - `implementing` under QA's `edit: false`
 * and no write scope, or `qa` with the coder's - and nothing would say so,
 * because both are agents the sailor ships and both records validate.
 *
 * Five states name their owner outright. `specified` is the specifier's: it is
 * the stage whose work is the specification. The other four own nobody, and
 * each for its own reason. `draft` is where a task is written down before
 * anything picks it up, `awaiting_approval` waits on a person rather than an
 * agent, `completed` is over, and `blocked` and `failed` are not stages at all
 * - nothing is being worked on in either, which is exactly what makes them
 * interruptions. Keeping whoever ran last as the owner of those would name an
 * agent that is not running.
 *
 * The mapping is total and closed. A project-defined agent id validates,
 * because a rule may target one, but it cannot own a pipeline state: the nine
 * states are fixed by the design, so there is no state left for a seventh
 * agent, and giving it one would be a change to this array either way.
 */
export const STATE_AGENTS = {
  draft: null,
  specified: "specifier",
  awaiting_approval: null,
  implementing: "coder",
  cleaning: "cleaner",
  architecture_review: "architect",
  hardening: "hardener",
  qa: "qa",
  completed: null,
  blocked: null,
  failed: null,
} as const satisfies Record<TaskState, BuiltInAgentId | null>;

/** How an owner reads in a message, including where there is not one. */
export const describeStateOwner = (state: TaskState): string => {
  const owner = STATE_AGENTS[state];

  return owner === null ? "no agent" : `\`${owner}\``;
};

const TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const taskIdSchema = z
  .string()
  .regex(
    TASK_ID_PATTERN,
    "task ids must be lower-case kebab-case, for example `add-login`"
  );

/**
 * A run id is a path segment: contexts live under
 * `.sailor/state/runs/<run-id>/`. Restricting it to the same shape as a task
 * id is what stops a caller-supplied id from escaping that directory, and a
 * lower-cased `randomUUID()` already satisfies it.
 */
export const runIdSchema = z
  .string()
  .regex(
    TASK_ID_PATTERN,
    "run ids must be lower-case kebab-case, for example a uuid"
  );

/** UTC instants only: two machines writing local times order a history wrong. */
export const timestampSchema = z.iso.datetime();

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** One project file, pinned to its content. */
export const fileDigestSchema = z.strictObject({
  path: projectRelativePathSchema,
  /** SHA-256 of the file's bytes when it was accepted. */
  sha256: sha256Schema,
});

/**
 * What the approval accepted: the feature files naming the scenarios the
 * task must satisfy, and the executable QA procedure that will demonstrate
 * them. Digests rather than paths alone, so completion can prove the files
 * QA ran are the files that were approved and not versions rewritten since -
 * QA's own write scope includes `features/**`, and an agent that could adjust
 * a scenario to match the behaviour would be accepting its own work.
 */
export const acceptanceSchema = z.strictObject({
  features: z
    .array(fileDigestSchema)
    .min(1, "an approval must accept at least one feature file"),
  procedure: fileDigestSchema,
});

/** Why a task was blocked or failed. Never a bare boolean. */
export const taskFailureSchema = z.strictObject({
  reason: z.string().min(1),
  details: z.array(z.string().min(1)).default([]),
});

/**
 * The identifier a persisted report is filed under. It becomes a file name
 * inside the run's report directory, so it is held to one path segment; both
 * id makers already satisfy it - `createDefaultReportId` is a UUID and
 * `createDeterministicReportId` is 32 hex characters.
 */
export const reportIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/,
    "report ids are single path segments of letters, digits and dashes"
  );

/**
 * What the transition into `completed` records, and the only place it can be
 * recorded. The shape can express success and nothing else: a gate that
 * blocked, a procedure with no steps or a feature set with no scenarios is
 * unrepresentable, so "evidence of a failing run" is not a thing this file
 * can carry. The one exception is the notification, whose `failed` is a real
 * outcome a project may configure itself to record and proceed past.
 *
 * The digests are compared against the task's recorded acceptance by the
 * transition guard, which is what makes this evidence *about the accepted
 * files* rather than about whichever files were lying around at completion.
 */
export const completionEvidenceSchema = z.strictObject({
  /** One entry per final gate phase, each a report that did not block. */
  gates: z
    .array(
      z.strictObject({
        phase: phaseSchema,
        reportId: reportIdSchema,
        status: z.enum(["passed", "passed-with-warnings"]),
      })
    )
    .min(1),
  /** The accepted QA procedure, the report of running it, and its size. */
  procedure: z.strictObject({
    path: projectRelativePathSchema,
    sha256: sha256Schema,
    reportId: reportIdSchema,
    steps: z.int().min(1),
  }),
  /** The accepted features and how many scenarios they put in evidence. */
  gherkin: z.strictObject({
    features: z.array(fileDigestSchema).min(1),
    scenarios: z.int().min(1),
  }),
  /** What happened when a human was told. Recorded whatever happened. */
  notification: z.strictObject({
    channel: notificationChannelSchema,
    status: z.enum(["delivered", "failed"]),
    detail: z.string().min(1),
    at: timestampSchema,
  }),
});

/**
 * One recorded move between states.
 *
 * Every field the design requires a transition to store is present and
 * non-optional, because a record that may omit its rule-set hash or its
 * expected revision is not evidence of anything: the point of writing it down
 * is that a later reader can tell what the workflow believed at the time.
 */
export const transitionRecordSchema = z.strictObject({
  /** The task revision this transition produced. */
  revision: z.int().min(1),
  /** The revision its writer expected to find. A mismatch is rejected. */
  expectedRevision: z.int().min(1),
  /**
   * `from` equals `to` for exactly one kind of record: the approval of a
   * specification, which changes no state but does take a revision, so that
   * the history covers every revision the task has had.
   */
  from: taskStateSchema,
  to: taskStateSchema,
  /** Null where no agent owned the state, as `draft` never does. */
  fromAgent: agentIdSchema.nullable(),
  toAgent: agentIdSchema.nullable(),
  /** SHA-256 of the rule set resolved when the transition was taken. */
  ruleSetSha256: sha256Schema,
  gateReportIds: z.array(z.string().min(1)).default([]),
  artifactPaths: z.array(projectRelativePathSchema).default([]),
  at: timestampSchema,
  /** How many times the target state has now been entered. Starts at 1. */
  attempt: z.int().min(1),
  failure: taskFailureSchema.nullable().default(null),
  /** Where the target agent's isolated context was written. */
  contextPath: projectRelativePathSchema.nullable().default(null),
  /** Only the transition into `completed` records this, and it must. */
  completion: completionEvidenceSchema.nullable().default(null),
});

const taskShape = z.strictObject({
  id: taskIdSchema,
  title: z.string().min(1),
  state: taskStateSchema,
  /** Bumped by every transition. The concurrency token of the whole task. */
  revision: z.int().min(1),
  /** The run whose directory holds this task's agent contexts. */
  runId: runIdSchema,
  /** The agent that owns the current state, or null where none does. */
  agentId: agentIdSchema.nullable().default(null),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  /**
   * When the specification was approved, and by whom, or null for neither.
   *
   * The coder cannot start before explicit approval, so this is a stored fact
   * rather than something inferred from having reached `awaiting_approval`.
   * It is set by its own revision, so entering `implementing` can require that
   * approval already existed rather than accepting it from the same caller in
   * the same act. Re-entering the specification states clears it: an approval
   * granted for a specification that has since been rewritten approves
   * nothing.
   */
  approvedAt: timestampSchema.nullable().default(null),
  approvedBy: z.string().min(1).nullable().default(null),
  /**
   * What the approval accepted, or null before one. Defaulted so a
   * `tasks.yaml` written before acceptance existed still parses; a task
   * approved without one cannot complete, which is where the absence bites.
   */
  acceptance: acceptanceSchema.nullable().default(null),
  /** The stage a blocked or failed task was interrupted in. */
  interruptedFrom: activeStateSchema.nullable().default(null),
  /** The context the current agent was handed. */
  contextPath: projectRelativePathSchema.nullable().default(null),
  history: z.array(transitionRecordSchema).default([]),
});

/**
 * An approval is one fact, so half of it is not a state the file may record.
 * Reading `approvedAt` without knowing who granted it would leave the audit
 * trail unable to answer the only question it exists for.
 *
 * `agentId` is held to `STATE_AGENTS` for the reason `interruptedFrom` is held
 * to the active stages: `tasks.yaml` is committed and read in a pull request,
 * so a hand edit or a merge conflict is all it takes to put an agent against a
 * state it does not own, and a runtime reading it would hand that stage that
 * agent's tools and write scopes. The `history` is deliberately not checked
 * against the mapping. It records what the workflow believed at the time, and
 * a mapping that ever changed would otherwise make every file written before
 * the change unreadable rather than merely out of date.
 *
 * `contextPath` is held to the path this task's own run and agent name, which
 * is the pair nothing validated before. A context path is a function of the
 * run and the agent, so a driver that wrote the next agent's context before
 * knowing the run a retry would start under wrote it over the failed
 * attempt's and then recorded the two disagreeing here. The transition
 * validates the task it produces, so the disagreement is refused where it is
 * introduced rather than found later by whatever tried to invoke the agent.
 */
export const taskSchema = taskShape.superRefine((task, ctx) => {
  if ((task.approvedAt === null) !== (task.approvedBy === null)) {
    ctx.addIssue({
      code: "custom",
      path: ["approvedBy"],
      message:
        "`approvedAt` and `approvedBy` are one fact: record both or neither",
    });
  }

  if (task.acceptance !== null && task.approvedAt === null) {
    ctx.addIssue({
      code: "custom",
      path: ["acceptance"],
      message:
        "acceptance is recorded by the approval: a task nobody approved accepts nothing",
    });
  }

  if (task.agentId !== STATE_AGENTS[task.state]) {
    ctx.addIssue({
      code: "custom",
      path: ["agentId"],
      message: `\`${task.state}\` is owned by ${describeStateOwner(task.state)}, not \`${task.agentId ?? "null"}\``,
    });
  }

  if (task.contextPath !== null) {
    const named =
      task.agentId === null
        ? null
        : agentContextDirectory(task.runId, task.agentId);

    if (task.contextPath !== named) {
      ctx.addIssue({
        code: "custom",
        path: ["contextPath"],
        message:
          named === null
            ? `\`${task.state}\` runs no agent, so there is no context for this task to be holding`
            : `the context of this task's run and agent is \`${named}\`, not \`${task.contextPath}\``,
      });
    }
  }
});

export const TASK_FILE_VERSION = 1;

/**
 * A task id identifies a task, so two entries claiming one would make every
 * lookup depend on which the reader found first.
 */
export const taskFileSchema = z
  .strictObject({
    version: z.literal(TASK_FILE_VERSION),
    tasks: z.array(taskSchema).default([]),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();

    for (const [index, task] of file.tasks.entries()) {
      if (seen.has(task.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks", index, "id"],
          message: `task \`${task.id}\` is declared more than once`,
        });
      }

      seen.add(task.id);
    }
  });

export type FileDigest = z.output<typeof fileDigestSchema>;
export type CompletionEvidence = z.output<typeof completionEvidenceSchema>;
export type Acceptance = z.output<typeof acceptanceSchema>;
export type TaskFailure = z.output<typeof taskFailureSchema>;
export type TransitionRecord = z.output<typeof transitionRecordSchema>;
export type Task = z.output<typeof taskSchema>;
export type TaskFile = z.output<typeof taskFileSchema>;
