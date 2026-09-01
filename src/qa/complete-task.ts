import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { createDefaultReportId } from "../gates/run-phase-gates.js";
import { runPhaseGates } from "../gates/run-phase-gates.js";
import type { PhaseGateReport } from "../gates/run-phase-gates.js";
import { readInstalledNotificationsConfig } from "../config/notifications-config.js";
import { SailorError } from "../sailor/sailor-error.js";
import { loadSailorRuleSet } from "../sailor/load-sailor-rule-set.js";
import { createNotifier } from "../notifications/notifier.js";
import type {
  NotificationResult,
  Notifier,
} from "../notifications/notifier.js";
import type { CommandRunner } from "../processes/command-runner.js";
import { discoverProjectProfile } from "../project/discover-project-profile.js";
import { readTaskFile, requireTask } from "../tasks/task-file.js";
import { writeRunReport } from "../tasks/run-report.js";
import type { CompletionEvidence, Task } from "../tasks/task-schema.js";
import {
  COMPLETION_GATE_PHASES,
  transitionTask,
} from "../tasks/transition-task.js";
import { updateTaskFile } from "../tasks/update-task-file.js";
import { prepareAcceptance } from "./acceptance.js";
import { runQaProcedure } from "./procedure.js";
import type { QaProcedureReport } from "./procedure.js";

export interface CompleteTaskOptions {
  readonly projectRoot: string;
  readonly taskId: string;
  /** The revision the caller decided against. A mismatch is refused. */
  readonly expectedRevision: number;
  readonly runner: CommandRunner;
  readonly now?: () => Date;
  readonly createReportId?: () => string;
  /** Replaces the configured channel's transport. The policy stays the config's. */
  readonly notifier?: Notifier;
}

export interface CompletionOutcome {
  readonly task: Task;
  readonly evidence: CompletionEvidence;
  readonly gateReports: readonly PhaseGateReport[];
  readonly procedureReport: QaProcedureReport;
  readonly notification: NotificationResult;
  /** Where the full reports were persisted, relative to the project root. */
  readonly reportPaths: readonly string[];
}

const shortDigest = (sha256: string): string => `${sha256.slice(0, 12)}..`;

/**
 * `runPhaseGates` reports `failed` exactly when a blocking failure exists,
 * and a blocked gate has already been refused by the time evidence is built,
 * so this narrowing cannot fire; it throws rather than defaulting so that if
 * the runner's invariant ever changes, completion breaks loudly instead of
 * recording a failed gate as a passed one.
 */
const evidenceStatus = (
  status: PhaseGateReport["status"]
): "passed" | "passed-with-warnings" => {
  if (status === "failed") {
    throw new Error("a failed gate report cannot become completion evidence");
  }

  return status;
};

/**
 * Drives acceptance criterion 10 end to end and completes the task.
 *
 * Everything here happens before the task lock is taken, deliberately: the
 * lock's stale window is two seconds and a gate run takes as long as the
 * project's own scripts take, so the gates, the procedure and the
 * notification run against a snapshot, and the transition at the end is
 * refused by the revision check if anything moved the task meanwhile.
 *
 * The order is the cheap-to-honest order. The accepted files are re-hashed
 * first, so a rewritten feature is caught before a single script runs; the
 * gates and the procedure run next, and their full reports are persisted
 * under the run whether or not they passed - a failing run is exactly the
 * one whose evidence matters; the notification goes out only once everything
 * has passed, so nobody is told about a completion that then did not happen
 * for a reason other than a concurrent write.
 */
export const completeTask = async (
  options: CompleteTaskOptions
): Promise<CompletionOutcome> => {
  const now = options.now ?? ((): Date => new Date());
  const createReportId = options.createReportId ?? createDefaultReportId;
  const task = requireTask(readTaskFile(options.projectRoot), options.taskId);

  if (task.state !== "qa") {
    throw new SailorError(
      "invalid-transition",
      `task \`${task.id}\` is \`${task.state}\`, and only a task in \`qa\` completes`
    );
  }

  if (task.revision !== options.expectedRevision) {
    throw new SailorError(
      "stale-task-revision",
      `task \`${task.id}\` is at revision ${String(task.revision)}, not the expected ${String(options.expectedRevision)}`,
      [
        "another process changed the task since it was read; re-read it and decide again",
      ]
    );
  }

  if (task.acceptance === null) {
    throw new SailorError(
      "incomplete-evidence",
      `task \`${task.id}\` records no acceptance, so evidence has nothing to be held against`,
      [
        "the specification was approved before acceptance was recorded",
        "send the task back to `specified` and approve it again",
      ]
    );
  }

  const { acceptance } = task;

  // The digests are compared before anything is parsed or run, so a
  // rewritten feature reads as "changed since approval" rather than as
  // whatever downstream symptom the rewrite happens to cause first - a
  // renamed scenario, for instance, would otherwise surface as a coverage
  // error blaming the procedure.
  const drift: string[] = [];

  for (const accepted of [...acceptance.features, acceptance.procedure]) {
    const absolute = join(
      options.projectRoot,
      ...accepted.path.split(posix.sep)
    );

    if (!existsSync(absolute)) {
      drift.push(`\`${accepted.path}\` is no longer there`);
      continue;
    }

    const current = createHash("sha256")
      .update(readFileSync(absolute, "utf8"), "utf8")
      .digest("hex");

    if (current !== accepted.sha256) {
      drift.push(
        `\`${accepted.path}\` changed since approval (now ${shortDigest(
          current
        )}, accepted ${shortDigest(accepted.sha256)})`
      );
    }
  }

  if (drift.length > 0) {
    throw new SailorError(
      "incomplete-evidence",
      `task \`${task.id}\`'s accepted files are not the files on disk`,
      [
        ...drift,
        "what was accepted no longer exists; restore the files or send the task back for a new approval",
      ]
    );
  }

  const prepared = prepareAcceptance({
    projectRoot: options.projectRoot,
    featurePaths: acceptance.features.map((digest) => digest.path),
    procedurePath: acceptance.procedure.path,
  });

  const ruleSet = loadSailorRuleSet({ projectRoot: options.projectRoot });
  const profile = await discoverProjectProfile({
    root: options.projectRoot,
    runner: options.runner,
  });

  const gateReports: PhaseGateReport[] = [];
  const reportPaths: string[] = [];
  const gateIssues: string[] = [];

  for (const phase of COMPLETION_GATE_PHASES) {
    const report = await runPhaseGates({
      ruleSet,
      phase,
      // Every check for the phase, not QA's slice of them: these are the
      // final gates of the whole task, and a coder-only lint rule left
      // unrun here would complete a task the next commit cannot make.
      agentId: null,
      profile,
      runner: options.runner,
      now,
      createReportId,
    });

    gateReports.push(report);
    reportPaths.push(
      writeRunReport(options.projectRoot, {
        runId: task.runId,
        kind: "phase-gates",
        report,
        writtenAt: now(),
      })
    );

    for (const result of report.results) {
      if (result.blocking && result.status !== "passed") {
        gateIssues.push(
          `${phase}: ${result.ruleId} / ${result.checkId} ${result.detail}`
        );
      }
    }
  }

  if (gateIssues.length > 0) {
    throw new SailorError(
      "incomplete-evidence",
      `task \`${task.id}\`'s final gates blocked completion`,
      [
        ...gateIssues,
        `the full reports are recorded under the run: ${reportPaths.join(", ")}`,
      ]
    );
  }

  const procedureReport = await runQaProcedure({
    procedure: prepared.procedure,
    profile,
    runner: options.runner,
    now,
    createReportId,
  });

  reportPaths.push(
    writeRunReport(options.projectRoot, {
      runId: task.runId,
      kind: "qa-procedure",
      report: procedureReport,
      writtenAt: now(),
    })
  );

  if (!procedureReport.passed) {
    throw new SailorError(
      "incomplete-evidence",
      `task \`${task.id}\`'s accepted QA procedure did not pass`,
      procedureReport.steps
        .filter((step) => step.status !== "passed")
        .map((step) => `step \`${step.stepId}\` ${step.detail}`)
    );
  }

  const config = readInstalledNotificationsConfig(options.projectRoot);
  const notifier =
    options.notifier ??
    createNotifier({
      projectRoot: options.projectRoot,
      config,
      runner: options.runner,
      now,
    });
  const notification = await notifier({
    taskId: task.id,
    title: task.title,
    state: "completed",
    runId: task.runId,
    revision: task.revision + 1,
    at: now().toISOString(),
  });

  if (notification.status === "failed" && config.onFailure === "block") {
    throw new SailorError(
      "notification-failed",
      `task \`${task.id}\` has its evidence, but nobody could be told it completed`,
      [
        notification.detail,
        "`onFailure: block` is set; fix the channel, or set `onFailure: record` to complete anyway with the failure recorded",
      ]
    );
  }

  const evidence: CompletionEvidence = {
    gates: gateReports.map((report) => ({
      phase: report.phase,
      reportId: report.reportId,
      status: evidenceStatus(report.status),
    })),
    procedure: {
      path: acceptance.procedure.path,
      sha256: acceptance.procedure.sha256,
      reportId: procedureReport.reportId,
      steps: procedureReport.steps.length,
    },
    gherkin: {
      features: acceptance.features,
      scenarios: prepared.scenarios.length,
    },
    notification,
  };

  const updated = await updateTaskFile(options.projectRoot, (file) =>
    transitionTask(file, {
      taskId: task.id,
      expectedRevision: options.expectedRevision,
      to: "completed",
      toAgent: null,
      ruleSetSha256: ruleSet.sha256,
      at: now(),
      gateReportIds: [
        ...gateReports.map((report) => report.reportId),
        procedureReport.reportId,
      ],
      artifactPaths: [
        ...acceptance.features.map((digest) => digest.path),
        acceptance.procedure.path,
      ],
      completion: evidence,
    })
  );

  return {
    task: requireTask(updated, task.id),
    evidence,
    gateReports,
    procedureReport,
    notification,
    reportPaths,
  };
};
