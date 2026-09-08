import { runGate } from "../../../src/cli/commands/run-gate.js";
import { createRecordedStreams } from "../../helpers/cli-streams.js";
import {
  createFakeCommandRunner,
  exited,
} from "../../helpers/fake-command-runner.js";

describe("runGate", () => {
  it("refuses an invocation that carries no phase", async () => {
    const recorded = createRecordedStreams();

    await expect(
      runGate({
        invocation: {
          command: "gate",
          phase: null,
          agentId: null,
          update: false,
          taskId: null,
        },
        cwd: "/tmp/project",
        streams: recorded.streams,
        packageRootDirectory: "/tmp/package",
        runner: createFakeCommandRunner(exited(0)).run,
        now: () => new Date("2026-08-26T00:00:00.000Z"),
        nodeVersion: "22.22.1",
        nodeExecutable: "/usr/bin/node",
      })
    ).rejects.toThrow(/no phase/);
  });
});
