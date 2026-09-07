import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { SailorError } from "../../../src/sailor/sailor-error.js";
import { readSailorTemplateFile } from "../../../src/install/sailor-templates.js";
import {
  agentContextDirectory,
  readAgentContext,
} from "../../../src/tasks/agent-context.js";
import { readTaskFile, requireTask } from "../../../src/tasks/task-file.js";
import { WORKFLOW_STATES } from "../../../src/tasks/task-schema.js";
import { captureError } from "../../helpers/expect-error.js";
import { initRepository, runGit } from "../../helpers/git.js";
import { runNodeScript } from "../../helpers/node-script.js";
import {
  createTempDirectory,
  removeTempDirectories,
} from "../../helpers/temp-directory.js";
import {
  RUN_ID,
  TASK_ID,
  buildWorkflowProject,
  driveWorkflow,
} from "../../helpers/workflow-driver.js";
import type { DriveWorkflowSummary } from "../../helpers/workflow-driver.js";

afterEach(() => {
  removeTempDirectories();
});

const packageRoot = process.cwd();

/** The program the second, resuming process runs. */
const RESUME_SCRIPT = "tests/fixtures/resume-workflow.ts";

const resumeInAnotherProcess = (projectRoot: string): DriveWorkflowSummary => {
  const run = runNodeScript({
    packageRoot,
    script: RESUME_SCRIPT,
    args: [packageRoot, projectRoot],
    cwd: projectRoot,
  });

  if (run.status !== 0) {
    throw new Error(
      `the resuming process exited ${String(run.status)}:\n${run.stderr}`
    );
  }

  return JSON.parse(run.stdout) as DriveWorkflowSummary;
};

describe("acceptance criterion 9: a stopped workflow resumes from tasks.yaml", () => {
  it("picks up in a new process at the stage it stopped, running no stage twice", async () => {
    const root = buildWorkflowProject(packageRoot);

    // The run that gets stopped. It goes through the specifier, has the
    // specification approved, hands the coder its context - and then the
    // process ends, mid-`implementing`, with the coder's work unfinished.
    const stopped = await driveWorkflow({
      packageRoot,
      projectRoot: root,
      stopAfter: "implementing",
    });

    expect(stopped.entered).toEqual([
      "specified",
      "awaiting_approval",
      "implementing",
    ]);
    expect(stopped.finalState).toBe("implementing");

    // A real second Node process. It shares no module registry, no cache and
    // no object graph with the run above; it is handed two paths and nothing
    // else, so `.sailor/tasks.yaml` is the whole handover.
    const resumed = resumeInAnotherProcess(root);

    expect(resumed.resumedAt).toBe("implementing");
    expect(resumed.completedOnEntry).toEqual([
      "draft",
      "specified",
      "awaiting_approval",
    ]);
    // It re-ran nothing the first process finished: the specifier and the
    // approval are behind it, and it starts by finishing the coder's stage.
    expect(resumed.entered).toEqual([
      "cleaning",
      "architecture_review",
      "hardening",
      "qa",
      "completed",
    ]);
    // What it picked up at `implementing` is the coder's context, written by
    // the process that has since exited. Nothing was handed across in memory,
    // so a context it can read is a context that reached the filesystem.
    expect(resumed.resumedContext).toEqual({
      agentId: "coder",
      taskId: TASK_ID,
      attempt: 1,
    });
    expect(resumed.finalState).toBe("completed");

    // Back in the process that stopped. Whatever it still believes about the
    // task, the file is the only thing that can be right about it now.
    const finished = requireTask(readTaskFile(root), TASK_ID);

    expect(finished.state).toBe("completed");
    expect(finished.approvedBy).toBe("a-reviewer");
    // Five transitions before the stop, four after, and every stage but
    // `draft` - which nothing transitions into - entered exactly once.
    expect(finished.history).toHaveLength(9);

    // Nine records, nine instants, in order - though the last four were
    // written by a process that had nothing of the first but this file.
    const timestamps = finished.history.map((record) => record.at);

    expect(new Set(timestamps).size).toBe(timestamps.length);
    expect(timestamps).toEqual([...timestamps].sort());

    for (const stage of WORKFLOW_STATES) {
      const entries = finished.history.filter(
        (record) => record.to === stage && record.from !== record.to
      );

      expect(entries).toHaveLength(stage === "draft" ? 0 : 1);
    }
  });
});

/**
 * Commits the project the way an installed one is committed - with the shipped
 * `.gitignore`, not one written to suit the test - and clones it.
 *
 * The clone is what another machine gets: exactly the tracked files, decided
 * by the ignore file the sailor actually installs.
 */
const cloneTrackedFiles = (root: string): string => {
  const ignore = join(root, ".sailor", ".gitignore");

  mkdirSync(dirname(ignore), { recursive: true });
  writeFileSync(ignore, readSailorTemplateFile(packageRoot, "gitignore"));

  initRepository(root);
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "--quiet", "-m", "Start the task"]);

  const destination = join(createTempDirectory("sailor-clone-"), "b");

  runGit(root, ["clone", "--quiet", root, destination]);

  return destination;
};

describe("a workflow resumed from a fresh checkout", () => {
  it("finds no contexts, rebuilds what it needs, and still runs no stage twice", async () => {
    const root = buildWorkflowProject(packageRoot);

    await driveWorkflow({
      packageRoot,
      projectRoot: root,
      stopAfter: "implementing",
    });

    const clone = cloneTrackedFiles(root);

    // What the second developer actually has. `tasks.yaml` is committed on
    // purpose; every context the first machine wrote is under the ignored
    // `state/` tree and did not come with it.
    expect(existsSync(join(clone, ".sailor", "tasks.yaml"))).toBe(true);
    expect(existsSync(join(clone, ".sailor", "state"))).toBe(false);

    const missing = captureError(
      () => readAgentContext(clone, agentContextDirectory(RUN_ID, "coder")),
      SailorError
    );

    expect(missing.kind).toBe("missing-context");

    // The resume nevertheless completes, because everything a context holds is
    // derived from files the checkout does have: the task, the rules and the
    // agent definitions.
    const resumed = resumeInAnotherProcess(clone);

    expect(resumed.resumedAt).toBe("implementing");
    expect(resumed.resumedContext).toBeNull();
    expect(resumed.entered).toEqual([
      "cleaning",
      "architecture_review",
      "hardening",
      "qa",
      "completed",
    ]);

    const finished = requireTask(readTaskFile(clone), TASK_ID);

    expect(finished.state).toBe("completed");
    expect(finished.approvedBy).toBe("a-reviewer");
    expect(finished.history).toHaveLength(9);

    // The stages the first machine ran stayed run: nothing about starting
    // again somewhere else re-entered them.
    for (const stage of WORKFLOW_STATES) {
      const entries = finished.history.filter(
        (record) => record.to === stage && record.from !== record.to
      );

      expect(entries).toHaveLength(stage === "draft" ? 0 : 1);
    }

    // And the machine that resumed wrote its own contexts where the recorded
    // paths said they belonged.
    expect(
      readAgentContext(clone, agentContextDirectory(RUN_ID, "cleaner")).taskId
    ).toBe(TASK_ID);
  });
});
