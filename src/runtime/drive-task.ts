import type { AgentDefinition } from "../agents/agent-definition.js";
import type { AgentId } from "../agents/agent-id.js";
import { readInstalledModelsConfig } from "../config/models-config.js";
import type { ModelsConfig } from "../config/models-config.js";
import {
  providerForAgent,
  readInstalledProvidersConfig,
} from "../config/providers-config.js";
import type { ProvidersConfig } from "../config/providers-config.js";
import {
  auditWorkingTree,
  snapshotWorkingTree,
} from "../enforcement/working-tree-audit.js";
import type { WorkingTreeAudit } from "../enforcement/working-tree-audit.js";
import {
  createDefaultReportId,
  runPhaseGates,
} from "../gates/run-phase-gates.js";
import type { PhaseGateReport } from "../gates/run-phase-gates.js";
import { SailorError } from "../sailor/sailor-error.js";
import { loadSailorRuleSet } from "../sailor/load-sailor-rule-set.js";
import type { ResolvedRuleSet } from "../rules/resolve-rule-set.js";
import type {
  CommandRunner,
  CommandSpec,
} from "../processes/command-runner.js";
import { discoverProjectProfile } from "../project/discover-project-profile.js";
import type { ProjectProfile } from "../project/project-profile-schema.js";
import { compileAgentPolicy } from "../prompts/compile-agent-policy.js";
import type { AgentEvent } from "../providers/agent-event.js";
import {
  auditIndexFile,
  recordAuditedAgentRun,
} from "../providers/audited-run.js";
import type { AuditedAgentRunRecord } from "../providers/audited-run.js";
import { buildAgentInvocation } from "../providers/provider-adapter.js";
import type { ProviderId } from "../providers/provider-adapter.js";
import {
  buildAgentContext,
  readAgentContext,
  writeAgentContext,
} from "../tasks/agent-context.js";
import type { AgentContext } from "../tasks/agent-context.js";
import { agentContextDirectory } from "../tasks/context-path.js";
import { writeRunReport } from "../tasks/run-report.js";
import { readTaskFile, requireTask } from "../tasks/task-file.js";
import { STATE_AGENTS } from "../tasks/task-schema.js";
import type { Task, TaskFailure, WorkflowState } from "../tasks/task-schema.js";
import {
  createDefaultRunId,
  runIdForTransition,
  transitionTask,
} from "../tasks/transition-task.js";
import { updateTaskFile } from "../tasks/update-task-file.js";
import { isWorkflowState, pendingStages } from "../tasks/workflow.js";
import { readInstalledAgentDefinition } from "./installed-agents.js";
import {
  createProviderAdapter,
  requireProviderAdapters,
} from "./provider-adapters.js";

/**
 * How long one agent is given.
 *
 * Half an hour, rather than the two minutes a gate gets: an agent run is a
 * conversation with a model that reads the project, writes files and runs its
 * scripts, and the live runs this was built against took one to three minutes
 * each for a two-file change. It is the invocation's timeout, so
 * `nodeCommandRunner` is what enforces it.
 */
export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60_000;

/** The stage the driver stops at. Completing a task is `completeTask`'s. */
export const DRIVE_DESTINATION = "qa" as const;

/**
 * The gate phase that runs between two agents. `pre-commit` and `pre-push`
 * belong to git hooks and `qa` to completion; `pre-handoff` is the phase the
 * design gives to a handoff.
 */
export const HANDOFF_GATE_PHASE = "pre-handoff" as const;

/**
 * What happened in one stage the driver ran an agent in.
 *
 * - `handed-off`: the agent finished, the tree stayed inside its scopes, the
 *   pre-handoff gates passed, and the task moved on.
 * - `reached`: the same, in `qa`, which is where the driver stops.
 * - `blocked`: the pre-handoff gates blocked the handoff. The work is on
 *   disk and what failed is nameable, so the task rests in `blocked` and a
 *   person fixing it resumes the stage it stopped in.
 * - `failed`: the run produced no handoff the sailor would accept. The
 *   attempt is over, so the next one replaces it and starts a run of its own.
 */
export const DRIVEN_STAGE_STATUSES = [
  "handed-off",
  "reached",
  "blocked",
  "failed",
] as const;

export type DrivenStageStatus = (typeof DRIVEN_STAGE_STATUSES)[number];

export interface DrivenStage {
  readonly state: WorkflowState;
  readonly agentId: AgentId;
  readonly provider: ProviderId;
  readonly attempt: number;
  readonly status: DrivenStageStatus;
  /** The run, or null when the adapter refused it before it could be recorded. */
  readonly run: AuditedAgentRunRecord | null;
  /** What the run did to the tree, whether or not the run was accepted. */
  readonly audit: WorkingTreeAudit;
  /** The pre-handoff gates run after this agent, or null where they never ran. */
  readonly gate: PhaseGateReport | null;
  /** Why the driver stopped here, or null where it did not. */
  readonly failure: TaskFailure | null;
}

export type DriveOutcome = "reached-qa" | "blocked" | "failed";

export interface DriveTaskResult {
  /** The task as it stands now, whether it reached `qa` or stopped. */
  readonly task: Task;
  readonly outcome: DriveOutcome;
  /** One entry per stage an agent was run in, in order. */
  readonly stages: readonly DrivenStage[];
}

export interface DriveTaskOptions {
  readonly projectRoot: string;
  readonly taskId: string;
  /** Runs every child process: the provider's CLI, git and the gates. */
  readonly runner: CommandRunner;
  /** Root of the installed `sailor` package, which is where a gate program lives. */
  readonly packageRootDirectory: string;
  /** The Node that runs a provider's gate, as `process.execPath`. */
  readonly nodeExecutable: string;
  /** Where a provider's gate program is; the built one under the package root by default. */
  readonly toolGate?: CommandSpec;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  /** Aborting terminates the agent that is running and stops the run there. */
  readonly signal?: AbortSignal;
  readonly createReportId?: () => string;
  /** Mints the run a discarding recovery starts under. Injected for determinism. */
  readonly newRunId?: () => string;
  /** Called with every event of every agent, for a log that streams. */
  readonly onEvent?: (stage: WorkflowState, event: AgentEvent) => void;
  /** Called as each stage settles, before the next one starts. */
  readonly onStage?: (stage: DrivenStage) => void;
}

const code = (text: string): string => `\`${text}\``;

/**
 * The stages this run still has to get through, ending at the destination.
 *
 * `pendingStages` starts at the stage the task stands in, because being in a
 * stage is not the same as having finished it, and the slice stops at `qa`:
 * `completed` is guarded evidence that `completeTask` produces, not a stage
 * an agent runs.
 */
const remainingStages = (task: Task): readonly WorkflowState[] => {
  const pending = pendingStages(task);
  const end = pending.indexOf(DRIVE_DESTINATION);

  return end === -1 ? [] : pending.slice(0, end + 1);
};

const remainingAgents = (task: Task): readonly AgentId[] => [
  ...new Set(
    remainingStages(task).flatMap((state) => {
      const agentId = STATE_AGENTS[state];

      return agentId === null ? [] : [agentId];
    })
  ),
];

const WHY_NOT_DRIVABLE: Readonly<Record<string, string>> = {
  draft: "nothing has specified it yet",
  specified:
    "its specification is not approved, and approving one is a person's act rather than a stage",
  completed: "it is finished",
  blocked:
    "which stage it recovers into is the judgement an interruption exists to force",
  failed:
    "which stage it recovers into is the judgement an interruption exists to force",
};

/**
 * The states the driver will pick a task up in.
 *
 * `awaiting_approval` is the start the design names, and the five stages an
 * agent owns are where a run interrupted part way through resumes. Everything
 * else is refused, and none of them is refused for a reason the driver could
 * act on by itself: a specification is approved by a person, a completed task
 * is over, and which stage an interrupted task recovers into is exactly the
 * decision that stopping it was for.
 */
const requireDrivable = (task: Task): WorkflowState => {
  const { state } = task;

  if (
    isWorkflowState(state) &&
    (state === "awaiting_approval" || STATE_AGENTS[state] !== null)
  ) {
    return state;
  }

  throw new SailorError(
    "invalid-transition",
    `task ${code(task.id)} is ${code(state)}, which the driver does not start from`,
    [
      WHY_NOT_DRIVABLE[state] ?? "no stage of the pipeline is running",
      `the driver takes a task from ${code("awaiting_approval")} to ${code(DRIVE_DESTINATION)}`,
    ]
  );
};

interface DriverContext {
  readonly options: DriveTaskOptions;
  readonly now: () => Date;
  readonly ruleSet: ResolvedRuleSet;
  readonly profile: ProjectProfile;
  readonly providers: ProvidersConfig;
  readonly models: ModelsConfig;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly createReportId: () => string;
  readonly newRunId: () => string;
}

/**
 * The context the stage runs under: the one its handoff wrote, or a fresh one
 * where this machine does not have it.
 *
 * Contexts live under the ignored `state/` tree, so a run resumed from a
 * fresh checkout finds the path in `tasks.yaml` and no file behind it.
 * Everything in a context is derived from the task, the agent definition and
 * the rules, all of which are tracked, so rebuilding is the answer rather
 * than an error - which is why `readAgentContext` distinguishes absence from
 * damage. A damaged context is still an error.
 */
const contextFor = (
  driver: DriverContext,
  task: Task,
  definition: AgentDefinition
): AgentContext => {
  const { projectRoot } = driver.options;
  const directory = agentContextDirectory(task.runId, definition.id);

  try {
    return readAgentContext(projectRoot, directory);
  } catch (error: unknown) {
    if (!(error instanceof SailorError && error.kind === "missing-context")) {
      throw error;
    }
  }

  const entered = task.history.at(-1);
  const context = buildAgentContext({
    task,
    definition,
    policy: compileAgentPolicy({
      agentId: definition.id,
      ruleSet: driver.ruleSet,
    }),
    ruleSetSha256: driver.ruleSet.sha256,
    at: driver.now(),
    attempt: entered?.attempt ?? 1,
    handoff:
      entered === undefined
        ? null
        : {
            fromAgent: entered.fromAgent,
            fromState: entered.from,
            gateReportIds: [...entered.gateReportIds],
            artifactPaths: [...entered.artifactPaths],
            failure: entered.failure,
          },
  });

  writeAgentContext(projectRoot, context);

  return context;
};

const describeTree = (audit: WorkingTreeAudit): readonly string[] =>
  audit.changedPaths.length === 0
    ? ["the working tree is unchanged"]
    : [`changed: ${audit.changedPaths.join(", ")}`];

interface StageRun {
  readonly run: AuditedAgentRunRecord | null;
  readonly audit: WorkingTreeAudit;
  /** Null when what came back is a handoff the sailor accepts. */
  readonly failure: TaskFailure | null;
}

/**
 * Runs the agent that owns the stage the task stands in, and says whether
 * what came back is a handoff.
 *
 * The tree is snapshotted here as well as inside `recordAuditedAgentRun`,
 * because a run the adapter refuses never reaches the wrapper's second
 * snapshot: `tool-gate-failed` is thrown rather than finished, and the design
 * deliberately leaves the tree such a run left behind to the runtime that
 * catches it. This is that runtime, so it holds a `before` of its own and
 * audits against it when there is no record to audit with.
 */
const runStage = async (
  driver: DriverContext,
  task: Task,
  state: WorkflowState,
  agentId: AgentId
): Promise<StageRun> => {
  const { options } = driver;
  const definition = readInstalledAgentDefinition(options.projectRoot, agentId);
  const context = contextFor(driver, task, definition);
  const invocation = buildAgentInvocation({
    projectRoot: options.projectRoot,
    task,
    context,
    modelProfile: definition.modelProfile,
    packageManager: driver.profile.packageManager,
    timeoutMs: driver.timeoutMs,
    signal: driver.signal,
  });
  const adapter = createProviderAdapter({
    provider: providerForAgent(driver.providers, agentId),
    models: driver.models,
    providers: driver.providers,
    runner: options.runner,
    packageRootDirectory: options.packageRootDirectory,
    nodeExecutable: options.nodeExecutable,
    now: driver.now,
    ...(options.toolGate === undefined ? {} : { toolGate: options.toolGate }),
  });
  const snapshotOptions = {
    projectRoot: options.projectRoot,
    runner: options.runner,
    indexFile: auditIndexFile(options.projectRoot, task.runId, agentId),
  };
  const before = await snapshotWorkingTree(snapshotOptions);

  let record: AuditedAgentRunRecord;

  try {
    record = await recordAuditedAgentRun(adapter, invocation, {
      runner: options.runner,
      ...(options.onEvent === undefined
        ? {}
        : {
            onEvent: (event: AgentEvent): void => {
              options.onEvent?.(state, event);
            },
          }),
    });
  } catch (error: unknown) {
    if (!(error instanceof SailorError && error.kind === "tool-gate-failed")) {
      throw error;
    }

    const audit = await auditWorkingTree({
      projectRoot: options.projectRoot,
      runner: options.runner,
      before,
      after: await snapshotWorkingTree(snapshotOptions),
      policy: invocation.toolPolicy,
    });

    return {
      run: null,
      audit,
      failure: {
        reason: `the ${code(agentId)} run could not be vouched for`,
        details: [
          ...error.details,
          ...describeTree(audit),
          "nothing this run wrote has been undone; decide what to keep before retrying",
        ],
      },
    };
  }

  const { audit } = record;

  if (record.finished.status !== "completed") {
    return {
      run: record,
      audit,
      failure: {
        reason: `the ${code(agentId)} run ${record.finished.status}`,
        details: [record.finished.detail, ...describeTree(audit)],
      },
    };
  }

  if (!audit.clean) {
    return {
      run: record,
      audit,
      failure: {
        reason: `the ${code(agentId)} run changed files it may not write`,
        details: audit.violations.map(
          (violation) =>
            `${violation.path}: ${violation.decision.denial} - ${violation.decision.reason}`
        ),
      },
    };
  }

  return { run: record, audit, failure: null };
};

/**
 * Records a stop, in the state the reason calls for.
 *
 * A blocked gate is `blocked`: the work is on disk, what failed is nameable,
 * and a person who fixes it resumes the stage the task stopped in. Anything
 * else is `failed`: the attempt produced no handoff, so the next one replaces
 * it and starts a run of its own, which is what `runIdForTransition` decides.
 */
const recordStop = async (
  driver: DriverContext,
  to: "blocked" | "failed",
  failure: TaskFailure,
  gateReportIds: readonly string[],
  artifactPaths: readonly string[]
): Promise<Task> => {
  const { options } = driver;
  const file = await updateTaskFile(options.projectRoot, (current) =>
    transitionTask(current, {
      taskId: options.taskId,
      expectedRevision: requireTask(current, options.taskId).revision,
      to,
      toAgent: null,
      ruleSetSha256: driver.ruleSet.sha256,
      at: driver.now(),
      gateReportIds,
      artifactPaths,
      failure,
    })
  );

  return requireTask(file, options.taskId);
};

/**
 * Moves the task into the next stage and writes the context the agent that
 * owns it will run under.
 *
 * Both happen under one lock, in that order. `runIdForTransition` is asked
 * once and its answer handed straight back as `newRunId`, so the run a
 * discarding recovery starts under is decided before the path is derived from
 * it, and there is no second id for the two to disagree about; `taskSchema`
 * refuses the pair if they ever do. Writing second also means the context is
 * built from the task the transition produced rather than from the snapshot
 * before it - `buildAgentInvocation` accepts both - and if the write fails the
 * mutator throws, so a task never names a context that was not written.
 */
const handOff = async (
  driver: DriverContext,
  to: WorkflowState,
  gateReportIds: readonly string[],
  artifactPaths: readonly string[]
): Promise<Task> => {
  const { options } = driver;
  const agentId = STATE_AGENTS[to];
  const definition =
    agentId === null
      ? null
      : readInstalledAgentDefinition(options.projectRoot, agentId);
  const file = await updateTaskFile(options.projectRoot, (current) => {
    const task = requireTask(current, options.taskId);
    const runId = runIdForTransition(task, to, driver.newRunId);
    const updated = transitionTask(current, {
      taskId: options.taskId,
      expectedRevision: task.revision,
      to,
      toAgent: agentId,
      ruleSetSha256: driver.ruleSet.sha256,
      at: driver.now(),
      gateReportIds,
      artifactPaths,
      newRunId: () => runId,
      ...(definition === null
        ? {}
        : { contextPath: agentContextDirectory(runId, definition.id) }),
    });

    if (definition !== null) {
      const entered = requireTask(updated, options.taskId);

      writeAgentContext(
        options.projectRoot,
        buildAgentContext({
          task: entered,
          definition,
          policy: compileAgentPolicy({
            agentId: definition.id,
            ruleSet: driver.ruleSet,
          }),
          ruleSetSha256: driver.ruleSet.sha256,
          at: driver.now(),
          attempt: entered.history.at(-1)?.attempt ?? 1,
          handoff: {
            fromAgent: task.agentId,
            fromState: task.state,
            gateReportIds: [...gateReportIds],
            artifactPaths: [...artifactPaths],
            failure: null,
          },
        })
      );
    }

    return updated;
  });

  return requireTask(file, options.taskId);
};

/**
 * Takes a task from `awaiting_approval` to `qa`, one agent at a time.
 *
 * Each stage is entered by a handoff that writes the owning agent's context
 * and records the transition naming it, then that agent runs, then its work
 * is audited against its own write policy and put to the `pre-handoff` gates,
 * whose report is recorded on the transition into the stage after it. The
 * stage the run starts in is not entered again - being in a stage is not
 * having finished it - and `awaiting_approval`, the only stage here that no
 * agent owns, hands off with no run and no gate: the work before it was
 * gated by the handoff that put the task there, and that handoff is not this
 * driver's.
 *
 * It stops at `qa` and never enters `completed`. Completion demands evidence
 * about accepted files and gates run over the whole rule set, and
 * `completeTask` is what produces that honestly.
 *
 * Nothing is carried between stages except the last gate's report: what to do
 * next is read from the task file every time, which is what lets a run
 * stopped part way through be picked up by another process, or on another
 * machine, from `tasks.yaml` alone.
 */
export const driveTask = async (
  options: DriveTaskOptions
): Promise<DriveTaskResult> => {
  const now = options.now ?? ((): Date => new Date());
  const ruleSet = loadSailorRuleSet({ projectRoot: options.projectRoot });
  const profile = await discoverProjectProfile({
    root: options.projectRoot,
    runner: options.runner,
  });
  const driver: DriverContext = {
    options,
    now,
    ruleSet,
    profile,
    providers: readInstalledProvidersConfig(options.projectRoot),
    models: readInstalledModelsConfig(options.projectRoot),
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
    createReportId: options.createReportId ?? createDefaultReportId,
    newRunId: options.newRunId ?? createDefaultRunId,
  };

  let task = requireTask(readTaskFile(options.projectRoot), options.taskId);

  requireDrivable(task);
  requireProviderAdapters(driver.providers, remainingAgents(task));

  const stages: DrivenStage[] = [];
  const settle = (stage: DrivenStage): void => {
    stages.push(stage);
    options.onStage?.(stage);
  };

  let gateReportIds: readonly string[] = [];
  let artifactPaths: readonly string[] = [];
  // The stage whose work was accepted but whose handoff has not been recorded
  // yet. A stage is reported as handed off once the transition carrying it is
  // in `tasks.yaml`, not once the sailor decided it should be.
  let handedOff: DrivenStage | null = null;

  for (const [index, state] of remainingStages(task).entries()) {
    if (index > 0) {
      task = await handOff(driver, state, gateReportIds, artifactPaths);

      if (handedOff !== null) {
        settle(handedOff);
        handedOff = null;
      }
    }

    const agentId = STATE_AGENTS[state];

    if (agentId === null) {
      gateReportIds = [];
      artifactPaths = [];
      continue;
    }

    const provider = providerForAgent(driver.providers, agentId);
    const attempt = task.history.at(-1)?.attempt ?? 1;
    const ran = await runStage(driver, task, state, agentId);
    const shared = {
      state,
      agentId,
      provider,
      attempt,
      run: ran.run,
      audit: ran.audit,
    };

    if (ran.failure !== null) {
      task = await recordStop(driver, "failed", ran.failure, [], []);
      settle({ ...shared, status: "failed", gate: null, failure: ran.failure });

      return { task, outcome: "failed", stages };
    }

    if (state === DRIVE_DESTINATION) {
      settle({ ...shared, status: "reached", gate: null, failure: null });

      return { task, outcome: "reached-qa", stages };
    }

    const gate = await runPhaseGates({
      ruleSet,
      phase: HANDOFF_GATE_PHASE,
      agentId,
      profile,
      runner: options.runner,
      now,
      createReportId: driver.createReportId,
    });

    gateReportIds = [gate.reportId];
    artifactPaths = [
      writeRunReport(options.projectRoot, {
        runId: task.runId,
        kind: "phase-gates",
        report: gate,
        writtenAt: now(),
      }),
    ];

    if (gate.blocked) {
      const failure: TaskFailure = {
        reason: `the ${code(HANDOFF_GATE_PHASE)} gates blocked the handoff out of ${code(state)}`,
        details: gate.results
          .filter((result) => result.blocking && result.status !== "passed")
          .map(
            (result) => `${result.ruleId} / ${result.checkId} ${result.detail}`
          ),
      };

      task = await recordStop(
        driver,
        "blocked",
        failure,
        gateReportIds,
        artifactPaths
      );
      settle({ ...shared, status: "blocked", gate, failure });

      return { task, outcome: "blocked", stages };
    }

    handedOff = { ...shared, status: "handed-off", gate, failure: null };
  }

  // `remainingStages` ends at the destination and the destination returns, so
  // the loop cannot fall out of the bottom. Saying so loudly is better than
  // letting an impossible state become a quiet answer.
  throw new SailorError(
    "invalid-transition",
    `task ${code(options.taskId)} ran out of stages before reaching ${code(DRIVE_DESTINATION)}`
  );
};
