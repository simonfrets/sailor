import type {
  DriveOutcome,
  DriveTaskResult,
  DrivenStage,
} from "../runtime/drive-task.js";

const labelFor = (stage: DrivenStage): string => {
  switch (stage.status) {
    case "handed-off":
      return "DONE";
    case "reached":
      return "QA  ";
    case "blocked":
      return "HELD";
    case "failed":
      return "FAIL";
  }
};

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

const renderStage = (stage: DrivenStage): readonly string[] => {
  const lines = [
    `  ${labelFor(stage)} ${stage.state} — ${stage.agentId} on ${
      stage.provider
    }, attempt ${String(stage.attempt)}: ${
      stage.run === null ? "refused" : stage.run.finished.detail
    }`,
  ];

  if (stage.audit.changedPaths.length > 0) {
    lines.push(`       changed: ${stage.audit.changedPaths.join(", ")}`);
  }

  for (const violation of stage.audit.violations) {
    lines.push(
      `       ${violation.path}: ${violation.decision.denial} — ${violation.decision.reason}`
    );
  }

  if (stage.gate !== null) {
    lines.push(
      `       pre-handoff gates ${stage.gate.status}: ${stage.gate.reportId}`
    );
  }

  if (stage.failure !== null) {
    lines.push(
      `       ${stage.failure.reason}`,
      ...stage.failure.details.map((detail) => `         ${detail}`)
    );
  }

  return lines;
};

const renderOutcome = (result: DriveTaskResult): string => {
  const outcome: DriveOutcome = result.outcome;

  switch (outcome) {
    case "reached-qa":
      return `Result: reached \`qa\` after ${plural(
        result.stages.length,
        "agent"
      )}`;
    case "blocked":
      return "Result: blocked — the work is there and the gates are not green";
    case "failed":
      return "Result: failed — the run produced no handoff the sailor would accept";
  }
};

/**
 * Renders a driven run for a terminal.
 *
 * Every stage is listed, including the ones that were handed off, because the
 * question a reader has after a stop is how far it got and what each agent
 * changed on the way. The stop itself carries the reason and its details:
 * a run that reported only a verdict would send someone to `tasks.yaml` to
 * find out what happened.
 */
export const formatDriveResult = (result: DriveTaskResult): string => {
  const lines = [
    `Task: ${result.task.id} — ${result.task.title}`,
    `Run: ${result.task.runId}`,
    `State: ${result.task.state} (revision ${String(result.task.revision)})`,
    "",
    ...(result.stages.length === 0
      ? ["No agent ran."]
      : result.stages.flatMap(renderStage)),
    "",
    renderOutcome(result),
  ];

  return `${lines.join("\n")}\n`;
};
