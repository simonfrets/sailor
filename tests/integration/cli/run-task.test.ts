import { createDefaultCliCommands } from "../../../src/cli/default-commands.js";
import { CLI_EXIT_CODES } from "../../../src/cli/exit-codes.js";
import { runCli } from "../../../src/cli/run-cli.js";
import {
  NODE_COMMAND_RUNNER_DEFAULTS,
  createNodeCommandRunner,
} from "../../../src/processes/node-command-runner.js";
import { readTaskFile, requireTask } from "../../../src/tasks/task-file.js";
import { createTask } from "../../../src/tasks/transition-task.js";
import { updateTaskFile } from "../../../src/tasks/update-task-file.js";
import { createRecordedStreams } from "../../helpers/cli-streams.js";
import {
  DRIVEN_AT,
  DRIVEN_RUN_ID,
  DRIVEN_TASK_ID,
  approveDrivenTask,
  buildDrivenProject,
  talkOnly,
  writeProjectFile,
} from "../../helpers/driven-project.js";
import { cleanEnvironment } from "../../helpers/git.js";
import { removeTempDirectories } from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const runner = createNodeCommandRunner({
  ...NODE_COMMAND_RUNNER_DEFAULTS,
  baseEnv: cleanEnvironment(),
});

interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const run = async (root: string, argv: readonly string[]): Promise<CliRun> => {
  const recorded = createRecordedStreams();
  const exitCode = await runCli({
    argv,
    commands: createDefaultCliCommands(),
    cwd: root,
    now: () => DRIVEN_AT,
    nodeExecutable: process.execPath,
    nodeVersion: "22.22.1",
    packageRootDirectory: process.cwd(),
    runner,
    streams: recorded.streams,
  });

  return { exitCode, stdout: recorded.stdout(), stderr: recorded.stderr() };
};

describe("sailor run", () => {
  it("drives an approved task to qa and exits zero", async () => {
    const root = buildDrivenProject({ scenario: talkOnly() });

    await approveDrivenTask(root);

    const result = await run(root, ["run", DRIVEN_TASK_ID]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.ok);
    expect(result.stdout).toContain(`Task: ${DRIVEN_TASK_ID}`);
    expect(result.stdout).toContain(`Run: ${DRIVEN_RUN_ID}`);
    expect(result.stdout).toContain("DONE implementing — coder on claude");
    expect(result.stdout).toContain("QA   qa — qa on claude");
    expect(result.stdout).toContain("Result: reached `qa` after 5 agents");
    // Each stage is reported as it settles, because an agent run is minutes
    // long and a command that printed nothing until the end looks hung.
    expect(result.stderr).toContain("[handed-off] implementing — coder");
    expect(requireTask(readTaskFile(root), DRIVEN_TASK_ID).state).toBe("qa");
  });

  it("exits four when the pre-handoff gates block a handoff", async () => {
    // The same code `sailor gate` exits with, for the same reason: a required
    // check on an error rule failed and blocked the phase.
    const root = buildDrivenProject({
      scenario: talkOnly(),
      gateArgv: [process.execPath, "--eval", "process.exit(1)"],
    });

    await approveDrivenTask(root);

    const result = await run(root, ["run", DRIVEN_TASK_ID]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.gateBlocked);
    expect(result.stdout).toContain("HELD implementing");
    expect(result.stdout).toContain("Result: blocked");
    expect(requireTask(readTaskFile(root), DRIVEN_TASK_ID).state).toBe(
      "blocked"
    );
  });

  it("exits five when a run produces no handoff", async () => {
    const root = buildDrivenProject({
      scenario: { agents: { coder: { steps: [], exitCode: 4 } } },
    });

    await approveDrivenTask(root);

    const result = await run(root, ["run", DRIVEN_TASK_ID]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.refused);
    expect(result.stdout).toContain("FAIL implementing");
    expect(result.stdout).toContain("the `coder` run failed");
    expect(requireTask(readTaskFile(root), DRIVEN_TASK_ID).state).toBe(
      "failed"
    );
  });

  it("exits five when the task is in a state the driver does not start from", async () => {
    const root = buildDrivenProject({ scenario: talkOnly() });

    await updateTaskFile(root, (file) =>
      createTask(file, {
        id: DRIVEN_TASK_ID,
        title: "Add a greeting",
        runId: DRIVEN_RUN_ID,
        at: DRIVEN_AT,
      })
    );

    const result = await run(root, ["run", DRIVEN_TASK_ID]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.refused);
    expect(result.stderr).toContain("which the driver does not start from");
  });

  it("exits three when the configuration routes an agent nowhere", async () => {
    const root = buildDrivenProject({ scenario: talkOnly() });

    await approveDrivenTask(root);
    writeProjectFile(
      root,
      ".sailor/config/providers.yaml",
      "version: 1\ndefault: codex\n"
    );

    const result = await run(root, ["run", DRIVEN_TASK_ID]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.invalidConfig);
    expect(result.stderr).toContain("no adapter for codex");
  });

  it("exits three for a task the project does not have", async () => {
    const root = buildDrivenProject({ scenario: talkOnly() });
    const result = await run(root, ["run", "no-such-task"]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.invalidConfig);
    expect(result.stderr).toContain("no-such-task");
  });

  it("rejects a run with no task before touching the project", async () => {
    const result = await run(buildDrivenProject({ scenario: talkOnly() }), [
      "run",
    ]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.usage);
    expect(result.stderr).toContain("requires a task id");
  });
});
