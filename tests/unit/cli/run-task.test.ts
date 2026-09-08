import { runTask } from "../../../src/cli/commands/run-task.js";
import { formatDriveResult } from "../../../src/cli/format-drive-result.js";
import type { DriveTaskResult } from "../../../src/runtime/drive-task.js";
import { createRecordedStreams } from "../../helpers/cli-streams.js";
import {
  createFakeCommandRunner,
  exited,
} from "../../helpers/fake-command-runner.js";
import { buildTask } from "../../helpers/tasks.js";

describe("runTask", () => {
  it("refuses an invocation that carries no task", async () => {
    const recorded = createRecordedStreams();

    await expect(
      runTask({
        invocation: {
          command: "run",
          phase: null,
          agentId: null,
          update: false,
          taskId: null,
        },
        cwd: "/tmp/project",
        streams: recorded.streams,
        packageRootDirectory: "/tmp/package",
        runner: createFakeCommandRunner(exited(0)).run,
        now: () => new Date("2026-09-08T09:00:00.000Z"),
        nodeVersion: "22.22.1",
        nodeExecutable: "/usr/bin/node",
      })
    ).rejects.toThrow(/no task/);
  });
});

describe("formatDriveResult", () => {
  it("says so plainly when no agent ran", () => {
    // A run that stopped before its first agent - a refused provider, a task
    // in a state the driver does not start from - has no stage to show, and
    // an empty list would read as a run that did nothing wrong.
    const result: DriveTaskResult = {
      task: buildTask({ state: "awaiting_approval" }),
      outcome: "failed",
      stages: [],
    };

    expect(formatDriveResult(result)).toContain("No agent ran.");
    expect(formatDriveResult(result)).toContain("Result: failed");
  });

  it("shows what a refused run changed, and which changes were not its to make", () => {
    // The reader's question after a stop is what is now in the tree, because
    // the sailor does not undo it.
    const rendered = formatDriveResult({
      task: buildTask({ state: "failed", interruptedFrom: "implementing" }),
      outcome: "failed",
      stages: [
        {
          state: "implementing",
          agentId: "coder",
          provider: "claude",
          attempt: 2,
          status: "failed",
          run: null,
          audit: {
            changedPaths: ["docs/notes.md", "src/login.ts"],
            violations: [
              {
                path: "docs/notes.md",
                decision: {
                  verdict: "denied",
                  denial: "outside-write-scope",
                  reason: "`docs/notes.md` is outside every write scope",
                },
              },
            ],
            clean: false,
          },
          gate: null,
          failure: {
            reason: "the `coder` run could not be vouched for",
            details: ["`Write` (coder-2)"],
          },
        },
      ],
    });

    expect(rendered).toContain(
      "FAIL implementing — coder on claude, attempt 2"
    );
    expect(rendered).toContain("refused");
    expect(rendered).toContain("changed: docs/notes.md, src/login.ts");
    expect(rendered).toContain("docs/notes.md: outside-write-scope");
    expect(rendered).toContain("could not be vouched for");
    expect(rendered).toContain("`Write` (coder-2)");
  });
});
