import { SailorError } from "../../sailor/sailor-error.js";
import { resolveProjectRoot } from "../../sailor/resolve-project-root.js";
import { driveTask } from "../../runtime/drive-task.js";
import type { DriveOutcome } from "../../runtime/drive-task.js";
import { CLI_EXIT_CODES } from "../exit-codes.js";
import { formatDriveResult } from "../format-drive-result.js";
import type { CliCommandHandler } from "../run-cli.js";

/**
 * The exit code each outcome ends on.
 *
 * No new kind is introduced: a blocked gate is exactly the `4` a `sailor gate`
 * exits with, because it is the same required check on the same phase failing
 * and blocking. Everything else that stops a run is `5`, the code for an
 * action the sailor understood, would not take, and recorded why - which is
 * what a refused handoff is, whether the agent's process failed, its writes
 * left its scopes, or a tool ran without consulting the gate.
 */
const EXIT_CODES: Readonly<Record<DriveOutcome, number>> = {
  "reached-qa": CLI_EXIT_CODES.ok,
  blocked: CLI_EXIT_CODES.gateBlocked,
  failed: CLI_EXIT_CODES.refused,
};

/**
 * Drives one task through its agents, reporting each stage as it settles.
 *
 * Stages are printed as they happen rather than collected and printed at the
 * end: an agent run is minutes long, and a command that printed nothing until
 * it finished would look like one that had hung.
 */
export const runTask: CliCommandHandler = async (context) => {
  const { taskId } = context.invocation;

  if (taskId === null) {
    throw new SailorError(
      "invalid-config",
      "`run` was dispatched with no task"
    );
  }

  const projectRoot = await resolveProjectRoot({
    cwd: context.cwd,
    runner: context.runner,
  });
  const result = await driveTask({
    projectRoot,
    taskId,
    runner: context.runner,
    packageRootDirectory: context.packageRootDirectory,
    nodeExecutable: context.nodeExecutable,
    now: context.now,
    onStage: (stage) => {
      context.streams.stderr.write(
        `[${stage.status}] ${stage.state} — ${stage.agentId}\n`
      );
    },
  });

  context.streams.stdout.write(formatDriveResult(result));

  return EXIT_CODES[result.outcome];
};
