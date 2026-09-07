import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadAgentDefinition } from "../../src/agents/agent-definition.js";
import type { AgentDefinition } from "../../src/agents/agent-definition.js";
import type { BuiltInAgentId } from "../../src/agents/agent-id.js";
import { loadSailorRuleSet } from "../../src/sailor/load-sailor-rule-set.js";
import {
  listSailorTemplateFiles,
  readSailorTemplateFile,
} from "../../src/install/sailor-templates.js";
import { compileAgentPolicy } from "../../src/prompts/compile-agent-policy.js";
import {
  AGENT_CONTEXT_FILE,
  buildAgentContext,
  readAgentContext,
  writeAgentContext,
} from "../../src/tasks/agent-context.js";
import {
  findTask,
  readTaskFile,
  requireTask,
} from "../../src/tasks/task-file.js";
import { WORKFLOW_STATES } from "../../src/tasks/task-schema.js";
import type {
  Task,
  TaskState,
  WorkflowState,
} from "../../src/tasks/task-schema.js";
import {
  approveSpecification,
  createTask,
  transitionTask,
} from "../../src/tasks/transition-task.js";
import { updateTaskFile } from "../../src/tasks/update-task-file.js";
import {
  completedStages,
  currentStage,
  pendingStages,
} from "../../src/tasks/workflow.js";
import { buildSailorProject } from "./sailor-project.js";

export const TASK_ID = "add-login";
export const TASK_TITLE = "Add login";
export const RUN_ID = "run-1";
export const APPROVED_BY = "a-reviewer";

/** When the task is written down. Every stage is entered after it. */
export const STARTED_AT = new Date("2026-08-27T10:00:00.000Z");

/**
 * The instant a stage is entered at, derived from the stage itself.
 *
 * A run split across two processes has no counter and no clock in common, so
 * the position in the pipeline is what keeps the instants increasing across
 * the boundary. One instant for the whole run would be simpler and would make
 * the history unreadable as a sequence: a transition stamped with the task's
 * creation time, or with the instant of the handoff before it, would be
 * indistinguishable from one stamped correctly.
 */
export const stageAt = (state: WorkflowState): Date =>
  new Date(STARTED_AT.getTime() + WORKFLOW_STATES.indexOf(state) * 60_000);

/** The approval, granted while the task waits rather than as it moves on. */
const APPROVED_AT = new Date(stageAt("awaiting_approval").getTime() + 30_000);

/**
 * The agent that owns each stage, or `null` where none does.
 *
 * `draft`, `awaiting_approval` and `completed` belong to nobody: the first is
 * where a task is written down, the second waits on a person, and the third is
 * over.
 */
export const STAGE_AGENTS = {
  draft: null,
  specified: "specifier",
  awaiting_approval: null,
  implementing: "coder",
  cleaning: "cleaner",
  architecture_review: "architect",
  hardening: "hardener",
  qa: "qa",
  completed: null,
} as const satisfies Record<WorkflowState, BuiltInAgentId | null>;

/** The six definitions the sailor actually ships, not test doubles. */
export const shippedAgentDefinitions = (
  packageRoot: string
): ReadonlyMap<string, AgentDefinition> =>
  new Map(
    listSailorTemplateFiles(packageRoot)
      .filter((file) => /^agents\/[^/]+\.yaml$/.test(file.installedPath))
      .map((file) => {
        const definition = loadAgentDefinition(
          readSailorTemplateFile(packageRoot, file.templatePath),
          { source: file.installedPath }
        );

        return [definition.id, definition];
      })
  );

/**
 * A project with the shipped rules in place, so every compiled policy is the
 * real one rather than one written to suit the assertion about it.
 */
export const buildWorkflowProject = (packageRoot: string): string =>
  buildSailorProject({
    rules: Object.fromEntries(
      listSailorTemplateFiles(packageRoot)
        .filter((file) => /^rules\/[^/]+\.yaml$/.test(file.installedPath))
        .map((file) => [
          file.installedPath.slice("rules/".length),
          readSailorTemplateFile(packageRoot, file.templatePath),
        ])
    ),
  });

export interface DriveWorkflowRequest {
  /** This repository's root, which is where the shipped agents are read from. */
  readonly packageRoot: string;
  readonly projectRoot: string;
  /**
   * Stop once the task has entered this state, as an interrupted run would.
   * Omitted, the pipeline runs to `completed`.
   */
  readonly stopAfter?: WorkflowState;
}

/**
 * What one run of the pipeline saw and did.
 *
 * It is returned rather than asserted here because the run may have happened
 * in another process, which can only hand back what it can serialise.
 */
export interface DriveWorkflowSummary {
  /** The stage the task stood at when this run picked it up. */
  readonly resumedAt: WorkflowState;
  readonly completedOnEntry: readonly WorkflowState[];
  readonly pendingOnEntry: readonly WorkflowState[];
  /**
   * The context waiting for the stage this run picked up, or `null` where the
   * machine it is running on holds none.
   *
   * Contexts live under the ignored `state/` tree, so a run resumed from a
   * fresh checkout finds nothing here and rebuilds what it needs from the task
   * file instead.
   */
  readonly resumedContext: ResumedContext | null;
  /** The stages this run drove the task into, in order. */
  readonly entered: readonly WorkflowState[];
  readonly finalState: TaskState;
  readonly historyLength: number;
}

/** The part of a context a resumed run reports having been handed. */
export interface ResumedContext {
  readonly agentId: string;
  readonly taskId: string;
  readonly attempt: number;
}

/**
 * Reads the context the current stage was handed, if this machine has it.
 *
 * Presence is checked rather than assumed: `tasks.yaml` is committed and names
 * a path under the ignored `state/` tree, so the path is meaningful on every
 * machine while the file behind it exists only on the one that wrote it.
 */
const resumedContextOf = (
  projectRoot: string,
  task: Task
): ResumedContext | null => {
  if (task.contextPath === null) {
    return null;
  }

  const path = join(projectRoot, task.contextPath, AGENT_CONTEXT_FILE);

  if (!existsSync(path)) {
    return null;
  }

  const context = readAgentContext(projectRoot, task.contextPath);

  return {
    agentId: context.agentId,
    taskId: context.taskId,
    attempt: context.attempt,
  };
};

/** How many times the task has entered a state, ignoring self-transitions. */
const entriesInto = (task: Task, state: TaskState): number =>
  task.history.filter(
    (record) => record.to === state && record.from !== record.to
  ).length;

/**
 * Runs one handoff exactly as a runtime would: write the next agent's context
 * first, then record the transition that points at it.
 */
const handOff = async (
  request: DriveWorkflowRequest,
  definitions: ReadonlyMap<string, AgentDefinition>,
  to: WorkflowState
): Promise<void> => {
  const ruleSet = loadSailorRuleSet({ projectRoot: request.projectRoot });

  await updateTaskFile(request.projectRoot, (file) => {
    const task = requireTask(file, TASK_ID);
    // The coder cannot start before an explicit approval, and the approval is
    // a revision of its own. A resumed run may find one already recorded.
    const approved =
      to === "implementing" && task.approvedAt === null
        ? approveSpecification(file, {
            taskId: task.id,
            expectedRevision: task.revision,
            approvedBy: APPROVED_BY,
            ruleSetSha256: ruleSet.sha256,
            at: APPROVED_AT,
          })
        : file;
    const current = requireTask(approved, TASK_ID);
    const agentId = STAGE_AGENTS[to];
    const definition = agentId === null ? undefined : definitions.get(agentId);

    if (agentId !== null && definition === undefined) {
      throw new Error(`the sailor ships no definition for ${agentId}`);
    }

    const contextPath =
      definition === undefined
        ? null
        : writeAgentContext(
            request.projectRoot,
            buildAgentContext({
              task: current,
              definition,
              policy: compileAgentPolicy({ agentId: definition.id, ruleSet }),
              ruleSetSha256: ruleSet.sha256,
              at: stageAt(to),
              attempt: entriesInto(current, to) + 1,
              handoff: {
                fromAgent: current.agentId,
                fromState: current.state,
                gateReportIds: [],
                artifactPaths: [],
                failure: null,
              },
            })
          );

    return transitionTask(approved, {
      taskId: task.id,
      expectedRevision: current.revision,
      to,
      toAgent: agentId,
      ruleSetSha256: ruleSet.sha256,
      at: stageAt(to),
      contextPath,
    });
  });
};

/**
 * Drives a task through the pipeline, starting wherever the file on disk says
 * it stands.
 *
 * Nothing is carried in memory between calls: what to run next is derived from
 * `pendingStages`, which is derived from the task that was just read. That is
 * what makes the same function serve a first run and a resumed one, and what
 * makes a resumed run in another process possible at all.
 */
export const driveWorkflow = async (
  request: DriveWorkflowRequest
): Promise<DriveWorkflowSummary> => {
  const definitions = shippedAgentDefinitions(request.packageRoot);
  const existing = findTask(readTaskFile(request.projectRoot), TASK_ID);

  if (existing === null) {
    await updateTaskFile(request.projectRoot, (file) =>
      createTask(file, {
        id: TASK_ID,
        title: TASK_TITLE,
        runId: RUN_ID,
        at: STARTED_AT,
      })
    );
  }

  const task = requireTask(readTaskFile(request.projectRoot), TASK_ID);
  const pendingOnEntry = pendingStages(task);
  const entered: WorkflowState[] = [];

  // The first pending stage is the one the task already stands in: being in a
  // stage is not having finished it, so the run picks up there rather than
  // transitioning into it a second time.
  for (const to of pendingOnEntry.slice(1)) {
    await handOff(request, definitions, to);
    entered.push(to);

    if (to === request.stopAfter) {
      break;
    }
  }

  const finished = requireTask(readTaskFile(request.projectRoot), TASK_ID);

  return {
    resumedAt: currentStage(task),
    completedOnEntry: completedStages(task),
    pendingOnEntry,
    resumedContext: resumedContextOf(request.projectRoot, task),
    entered,
    finalState: finished.state,
    historyLength: finished.history.length,
  };
};
