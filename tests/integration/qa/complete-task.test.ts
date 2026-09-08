import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { SailorError } from "../../../src/sailor/sailor-error.js";
import type { CommandRequest } from "../../../src/processes/command-runner.js";
import { prepareAcceptance } from "../../../src/qa/acceptance.js";
import { completeTask } from "../../../src/qa/complete-task.js";
import { readRunReport } from "../../../src/tasks/run-report.js";
import { readTaskFile, requireTask } from "../../../src/tasks/task-file.js";
import { captureRejection } from "../../helpers/expect-error.js";
import {
  createFakeCommandRunner,
  exited,
} from "../../helpers/fake-command-runner.js";
import type {
  FakeCommandRunner,
  PlannedCommandResult,
} from "../../helpers/fake-command-runner.js";
import { removeTempDirectories } from "../../helpers/temp-directory.js";
import {
  RUN_ID,
  TASK_ID,
  buildWorkflowProject,
  driveWorkflow,
} from "../../helpers/workflow-driver.js";

afterEach(() => {
  removeTempDirectories();
});

const packageRoot = process.cwd();

const FEATURE = [
  "Feature: Login",
  "  Scenario: Happy path",
  "    When they log in",
  "  Scenario: Wrong password",
  "    When they log in badly",
  "",
].join("\n");

const PROCEDURE = [
  "version: 1",
  "steps:",
  "  - id: acceptance-suite",
  "    runner: command",
  "    argv: [node, --test, acceptance]",
  "    covers: [Happy path, Wrong password]",
  "  - id: unit-tests",
  "    runner: project-script",
  "    script: test",
  "",
].join("\n");

const write = (root: string, path: string, contents: string): void => {
  const absolute = join(root, path);

  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
};

/**
 * Responds like a healthy project: git has no hooksPath set, every script
 * and command exits cleanly. Tests override single commands to fail.
 */
const respondHealthy =
  (
    overrides: (request: CommandRequest) => PlannedCommandResult | null = () =>
      null
  ) =>
  (request: CommandRequest): PlannedCommandResult => {
    const special = overrides(request);

    if (special !== null) {
      return special;
    }

    if (
      request.command.executable === "git" &&
      request.command.args[0] === "config"
    ) {
      return exited(1);
    }

    return exited(0);
  };

/** Drives a real task to `qa` over real accepted files, ready to complete. */
const buildCompletableTask = async (
  overrides?: (request: CommandRequest) => PlannedCommandResult | null
): Promise<{
  root: string;
  revision: number;
  runner: FakeCommandRunner;
}> => {
  const root = buildWorkflowProject(packageRoot);

  write(
    root,
    "package.json",
    `${JSON.stringify(
      {
        name: "host",
        private: true,
        scripts: {
          build: "x",
          lint: "x",
          test: "x",
          typecheck: "x",
        },
      },
      null,
      2
    )}\n`
  );
  write(root, "features/login.feature", FEATURE);
  write(root, "docs/qa/add-login.yaml", PROCEDURE);

  const prepared = prepareAcceptance({
    projectRoot: root,
    featurePaths: ["features/login.feature"],
    procedurePath: "docs/qa/add-login.yaml",
  });

  await driveWorkflow({
    packageRoot,
    projectRoot: root,
    stopAfter: "qa",
    acceptance: prepared.acceptance,
  });

  const task = requireTask(readTaskFile(root), TASK_ID);

  return {
    root,
    revision: task.revision,
    runner: createFakeCommandRunner(respondHealthy(overrides)),
  };
};

let clock: number;

const complete = async (
  root: string,
  revision: number,
  runner: FakeCommandRunner
) => {
  clock = 0;

  return completeTask({
    projectRoot: root,
    taskId: TASK_ID,
    expectedRevision: revision,
    runner: runner.run,
    now: (): Date => new Date(1_800_000_000_000 + clock++ * 1000),
    createReportId: (): string => `report-${String(++clock)}`,
  });
};

describe("acceptance criterion 10: completing a task", () => {
  it("completes with gates, procedure, Gherkin evidence and a notification, all recorded", async () => {
    const { root, revision, runner } = await buildCompletableTask();
    const outcome = await complete(root, revision, runner);

    expect(outcome.task.state).toBe("completed");

    const record = outcome.task.history.at(-1);

    expect(record?.completion).toEqual(outcome.evidence);
    expect(outcome.evidence.gates.map((gate) => gate.phase)).toEqual([
      "pre-handoff",
      "qa",
    ]);
    expect(outcome.evidence.gherkin.scenarios).toBe(2);
    expect(outcome.evidence.procedure.steps).toBe(2);
    expect(outcome.evidence.notification).toMatchObject({
      channel: "log",
      status: "delivered",
    });
    expect(record?.gateReportIds).toHaveLength(3);

    // The full reports really are behind the ids the record carries.
    for (const path of outcome.reportPaths) {
      expect(existsSync(join(root, path))).toBe(true);
    }

    expect(
      readRunReport(root, RUN_ID, outcome.procedureReport.reportId)?.kind
    ).toBe("qa-procedure");

    // The notification landed in the machine-local log, one line, this task.
    const logged = readFileSync(
      join(root, ".sailor/state/notifications.jsonl"),
      "utf8"
    )
      .trim()
      .split("\n");

    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0] ?? "")).toMatchObject({
      taskId: TASK_ID,
      state: "completed",
    });
  });

  it("refuses to complete when an accepted feature was rewritten, naming the file", async () => {
    const { root, revision, runner } = await buildCompletableTask();

    write(
      root,
      "features/login.feature",
      FEATURE.replace("Wrong password", "Wrong password twice")
    );

    const error = await captureRejection(
      () => complete(root, revision, runner),
      SailorError
    );

    expect(error.kind).toBe("incomplete-evidence");
    expect(error.message).toContain("features/login.feature");
    expect(error.message).toContain("changed since approval");
    expect(requireTask(readTaskFile(root), TASK_ID).state).toBe("qa");
  });

  it("refuses to complete on a blocked gate and persists the report that says why", async () => {
    const { root, revision, runner } = await buildCompletableTask((request) =>
      request.command.args.join(" ") === "run lint" ? exited(2) : null
    );

    const error = await captureRejection(
      () => complete(root, revision, runner),
      SailorError
    );

    expect(error.kind).toBe("incomplete-evidence");
    expect(error.message).toContain("final gates blocked completion");
    expect(error.message).toContain("native-lint");

    const reports = readdirSync(
      join(root, ".sailor/state/runs", RUN_ID, "reports")
    );

    expect(reports.length).toBeGreaterThan(0);
    expect(requireTask(readTaskFile(root), TASK_ID).state).toBe("qa");
  });

  it("refuses to complete when an accepted procedure step fails, naming the step", async () => {
    const { root, revision, runner } = await buildCompletableTask((request) =>
      request.command.args.join(" ") === "--test acceptance"
        ? exited(1, { stderr: "1 failing\n" })
        : null
    );

    const error = await captureRejection(
      () => complete(root, revision, runner),
      SailorError
    );

    expect(error.kind).toBe("incomplete-evidence");
    expect(error.message).toContain("did not pass");
    expect(error.message).toContain("`acceptance-suite`");
    expect(requireTask(readTaskFile(root), TASK_ID).state).toBe("qa");
  });

  it("blocks completion when nobody could be told, and records the failure when configured to proceed", async () => {
    const notifications = (onFailure: string): string =>
      [
        "version: 1",
        "channel: command",
        `onFailure: ${onFailure}`,
        "command:",
        "  argv: [notify-send, done]",
        "",
      ].join("\n");
    const failNotify = (
      request: CommandRequest
    ): PlannedCommandResult | null =>
      request.command.executable === "notify-send"
        ? exited(1, { stderr: "no session bus\n" })
        : null;

    const blocking = await buildCompletableTask(failNotify);

    write(
      blocking.root,
      ".sailor/config/notifications.yaml",
      notifications("block")
    );

    const error = await captureRejection(
      () => complete(blocking.root, blocking.revision, blocking.runner),
      SailorError
    );

    expect(error.kind).toBe("notification-failed");
    expect(error.message).toContain("nobody could be told");
    expect(requireTask(readTaskFile(blocking.root), TASK_ID).state).toBe("qa");

    const recording = await buildCompletableTask(failNotify);

    write(
      recording.root,
      ".sailor/config/notifications.yaml",
      notifications("record")
    );

    const outcome = await complete(
      recording.root,
      recording.revision,
      recording.runner
    );

    expect(outcome.task.state).toBe("completed");
    expect(outcome.evidence.notification.status).toBe("failed");
    expect(outcome.evidence.notification.detail).toContain("no session bus");
  });

  it("refuses a stale revision and a task that is not in qa", async () => {
    const { root, revision, runner } = await buildCompletableTask();

    const stale = await captureRejection(
      () => complete(root, revision + 1, runner),
      SailorError
    );

    expect(stale.kind).toBe("stale-task-revision");

    await complete(root, revision, runner);

    const done = await captureRejection(
      () => complete(root, revision + 1, runner),
      SailorError
    );

    expect(done.kind).toBe("invalid-transition");
    expect(done.message).toContain("only a task in `qa` completes");
  });
});
