import { randomUUID } from "node:crypto";

import type { AgentId } from "../agents/agent-id.js";
import { SailorError } from "../sailor/sailor-error.js";
import { TASK_FILE_SOURCE, findTask, requireTask } from "./task-file.js";
import { STATE_AGENTS, describeStateOwner, taskSchema } from "./task-schema.js";
import type {
  Task,
  TaskFailure,
  TaskFile,
  TaskState,
  TransitionRecord,
} from "./task-schema.js";
import {
  allowedTransitions,
  isActiveState,
  isInterruptedState,
} from "./workflow.js";

/** The run a retry starts under, when the caller supplies no id of its own. */
export const createDefaultRunId = (): string => randomUUID();

const replaceTask = (file: TaskFile, task: Task): TaskFile => ({
  ...file,
  tasks: file.tasks.map((entry) => (entry.id === task.id ? task : entry)),
});

/**
 * Validates a task the sailor just built, rather than only the file it ends
 * up in. A rejected run id or context path is reported against the change that
 * introduced it instead of against the whole document one layer later.
 */
const validated = (task: Task, what: string): Task => {
  const result = taskSchema.safeParse(task);

  if (!result.success) {
    throw new SailorError(
      "invalid-config",
      `${what} would put invalid state in ${TASK_FILE_SOURCE}`,
      result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`
      )
    );
  }

  return result.data;
};

/**
 * Rejects a write made against a revision that is no longer current.
 *
 * Two agents handed the same task snapshot would otherwise both compute
 * revision N+1 from revision N, and the second would erase the first's
 * transition along with the evidence attached to it.
 */
const requireRevision = (task: Task, expected: number): void => {
  if (task.revision !== expected) {
    throw new SailorError(
      "stale-task-revision",
      `task \`${task.id}\` is at revision ${String(task.revision)}, not the expected ${String(expected)}`,
      [
        "another process changed the task since it was read; re-read it and decide again",
      ]
    );
  }
};

/** How many times the task has entered a state. Self-transitions do not count. */
const entriesInto = (task: Task, state: TaskState): number =>
  task.history.filter(
    (record) => record.to === state && record.from !== record.to
  ).length;

export interface CreateTaskRequest {
  readonly id: string;
  readonly title: string;
  /** The run whose directory will hold this task's agent contexts. */
  readonly runId: string;
  readonly at: Date;
}

/** Adds a task in `draft`, the one state nothing transitions into. */
export const createTask = (
  file: TaskFile,
  request: CreateTaskRequest
): TaskFile => {
  if (findTask(file, request.id) !== null) {
    throw new SailorError(
      "invalid-transition",
      `${TASK_FILE_SOURCE} already has a task \`${request.id}\``,
      ["a task id identifies one piece of work for the life of the project"]
    );
  }

  const at = request.at.toISOString();

  return {
    ...file,
    tasks: [
      ...file.tasks,
      validated(
        {
          id: request.id,
          title: request.title,
          state: "draft",
          revision: 1,
          runId: request.runId,
          agentId: null,
          createdAt: at,
          updatedAt: at,
          approvedAt: null,
          approvedBy: null,
          interruptedFrom: null,
          contextPath: null,
          history: [],
        },
        `creating task \`${request.id}\``
      ),
    ],
  };
};

export interface ApproveSpecificationRequest {
  readonly taskId: string;
  readonly expectedRevision: number;
  /** Who approved it. A person or a system, never the agent being unblocked. */
  readonly approvedBy: string;
  readonly ruleSetSha256: string;
  readonly at: Date;
}

/**
 * Records that a specification was approved.
 *
 * It is a revision of its own rather than a flag passed to the transition that
 * starts the coder. Design decision: the coder cannot start before explicit
 * approval, and an approval accepted from the same call that starts the work
 * would be granted by whoever wanted the work started. Taking a revision also
 * keeps the history total: every revision the task has had has a record.
 */
export const approveSpecification = (
  file: TaskFile,
  request: ApproveSpecificationRequest
): TaskFile => {
  const task = requireTask(file, request.taskId);

  requireRevision(task, request.expectedRevision);

  if (task.state !== "awaiting_approval") {
    throw new SailorError(
      "invalid-transition",
      `task \`${task.id}\` is \`${task.state}\`, so there is no specification awaiting approval`
    );
  }

  if (task.approvedAt !== null) {
    throw new SailorError(
      "invalid-transition",
      `task \`${task.id}\` was already approved by ${task.approvedBy ?? "?"} at ${task.approvedAt}`
    );
  }

  const at = request.at.toISOString();
  const revision = task.revision + 1;

  return replaceTask(
    file,
    validated(
      {
        ...task,
        revision,
        updatedAt: at,
        approvedAt: at,
        approvedBy: request.approvedBy,
        history: [
          ...task.history,
          {
            revision,
            expectedRevision: request.expectedRevision,
            from: "awaiting_approval",
            to: "awaiting_approval",
            fromAgent: task.agentId,
            toAgent: task.agentId,
            ruleSetSha256: request.ruleSetSha256,
            gateReportIds: [],
            artifactPaths: [],
            at,
            attempt: Math.max(1, entriesInto(task, "awaiting_approval")),
            failure: null,
            contextPath: task.contextPath,
          },
        ],
      },
      `approving task \`${task.id}\``
    )
  );
};

export interface TransitionRequest {
  readonly taskId: string;
  /** The revision the caller decided against. A mismatch is refused. */
  readonly expectedRevision: number;
  readonly to: TaskState;
  /**
   * The agent that owns the target state, and refused if it is any other.
   *
   * `STATE_AGENTS` says which that is, and `null` is the answer for the four
   * states no agent runs in. It is passed rather than derived so that a caller
   * that has decided wrongly is told, instead of having its answer quietly
   * replaced by the right one.
   */
  readonly toAgent: AgentId | null;
  readonly ruleSetSha256: string;
  readonly at: Date;
  readonly gateReportIds?: readonly string[];
  readonly artifactPaths?: readonly string[];
  /** Required entering `blocked` or `failed`, refused entering anything else. */
  readonly failure?: TaskFailure | null;
  /** Where the target agent's isolated context was written. */
  readonly contextPath?: string | null;
  /** Mints the run a retry starts under. Injected so tests stay deterministic. */
  readonly newRunId?: () => string;
}

/**
 * Moves a task to its next state and records what that decision was based on.
 *
 * Every rule the design fixes is enforced here rather than described in a
 * prompt: the pipeline order, the two interrupted states every active state
 * can fall into, the recovery transitions that are the only way out of them,
 * the agent each state belongs to, and the requirement that a specification be
 * approved by an earlier revision before the coder may start.
 */
export const transitionTask = (
  file: TaskFile,
  request: TransitionRequest
): TaskFile => {
  const task = requireTask(file, request.taskId);

  requireRevision(task, request.expectedRevision);

  const allowed = allowedTransitions(task);

  if (!allowed.includes(request.to)) {
    throw new SailorError(
      "invalid-transition",
      `task \`${task.id}\` cannot move from \`${task.state}\` to \`${request.to}\``,
      [
        allowed.length === 0
          ? `\`${task.state}\` is final`
          : `it may move to: ${allowed.join(", ")}`,
      ]
    );
  }

  if (request.toAgent !== STATE_AGENTS[request.to]) {
    throw new SailorError(
      "invalid-transition",
      `task \`${task.id}\` cannot enter \`${request.to}\` as \`${request.toAgent ?? "null"}\``,
      [
        `\`${request.to}\` is owned by ${describeStateOwner(request.to)}`,
        "the agent recorded here is the one whose tools and write scopes the stage runs under, so naming another hands it the wrong policy",
      ]
    );
  }

  if (request.to === "implementing" && task.approvedAt === null) {
    throw new SailorError(
      "invalid-transition",
      `task \`${task.id}\` has no approved specification, so implementation cannot start`,
      ["approve the specification first; it is recorded as its own revision"]
    );
  }

  const failure = request.failure ?? null;
  const interrupting = isInterruptedState(request.to);

  if (interrupting && failure === null) {
    throw new SailorError(
      "invalid-transition",
      `moving task \`${task.id}\` to \`${request.to}\` must record why`,
      ["a task nobody can see the reason for is a task nobody can recover"]
    );
  }

  if (!interrupting && failure !== null) {
    throw new SailorError(
      "invalid-transition",
      `moving task \`${task.id}\` to \`${request.to}\` must not record a failure`,
      ["a transition back into the pipeline is the recovery, not the failure"]
    );
  }

  const at = request.at.toISOString();
  const revision = task.revision + 1;
  const contextPath = request.contextPath ?? null;
  // A retry re-runs agents, and their contexts live under the run id. Reusing
  // it would overwrite the record of the attempt that failed with the one
  // being made to replace it. Resuming a blocked task keeps its run: nothing
  // was discarded, so nothing is about to be written twice.
  const runId =
    task.state === "failed"
      ? (request.newRunId ?? createDefaultRunId)()
      : task.runId;
  // Re-specifying invalidates the approval: what was approved no longer exists.
  const clearsApproval = request.to === "draft" || request.to === "specified";
  // The stage an interruption stopped in. `blocked -> failed` keeps whatever
  // the task already recorded, because the move to `failed` happened in
  // `blocked` rather than in a stage of its own.
  const stoppedIn = isActiveState(task.state)
    ? task.state
    : task.interruptedFrom;

  const record: TransitionRecord = {
    revision,
    expectedRevision: request.expectedRevision,
    from: task.state,
    to: request.to,
    fromAgent: task.agentId,
    toAgent: request.toAgent,
    ruleSetSha256: request.ruleSetSha256,
    gateReportIds: [...(request.gateReportIds ?? [])],
    artifactPaths: [...(request.artifactPaths ?? [])],
    at,
    attempt: entriesInto(task, request.to) + 1,
    failure,
    contextPath,
  };

  return replaceTask(
    file,
    validated(
      {
        ...task,
        state: request.to,
        revision,
        runId,
        agentId: request.toAgent,
        updatedAt: at,
        approvedAt: clearsApproval ? null : task.approvedAt,
        approvedBy: clearsApproval ? null : task.approvedBy,
        interruptedFrom: interrupting ? stoppedIn : null,
        contextPath,
        history: [...task.history, record],
      },
      `moving task \`${task.id}\` to \`${request.to}\``
    )
  );
};
