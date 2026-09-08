import { existsSync } from "node:fs";
import { join } from "node:path";

import { SailorError } from "../../../src/sailor/sailor-error.js";
import { loadSailorRuleSet } from "../../../src/sailor/load-sailor-rule-set.js";
import {
  NODE_COMMAND_RUNNER_DEFAULTS,
  createNodeCommandRunner,
} from "../../../src/processes/node-command-runner.js";
import type {
  CommandRunner,
  CommandSpec,
} from "../../../src/processes/command-runner.js";
import { CLAUDE_TOOL_GATE_SOURCE } from "../../../src/providers/claude/tool-gate.js";
import { readAgentContext } from "../../../src/tasks/agent-context.js";
import { agentContextDirectory } from "../../../src/tasks/context-path.js";
import { readTaskFile, requireTask } from "../../../src/tasks/task-file.js";
import { readRunReport } from "../../../src/tasks/run-report.js";
import {
  createTask,
  transitionTask,
} from "../../../src/tasks/transition-task.js";
import { updateTaskFile } from "../../../src/tasks/update-task-file.js";
import { driveTask } from "../../../src/runtime/drive-task.js";
import type {
  DriveTaskOptions,
  DriveTaskResult,
} from "../../../src/runtime/drive-task.js";
import {
  DRIVEN_AT,
  DRIVEN_RUN_ID,
  DRIVEN_TASK_ID,
  approveDrivenTask,
  buildDrivenProject,
  readContextStep,
  writeFileStep,
  writeProjectFile,
} from "../../helpers/driven-project.js";
import { captureRejection } from "../../helpers/expect-error.js";
import { cleanEnvironment } from "../../helpers/git.js";
import { removeTempDirectories } from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const packageRoot = process.cwd();

/**
 * The runner the driver is given, built with an environment that carries no
 * `GIT_*` variable: this repository's own pre-commit hook runs the suite, and
 * a snapshot that inherited `GIT_DIR` would audit this repository instead of
 * the fixture.
 */
const runner: CommandRunner = createNodeCommandRunner({
  ...NODE_COMMAND_RUNNER_DEFAULTS,
  baseEnv: cleanEnvironment(),
});

const TASK_ID = DRIVEN_TASK_ID;
const RUN_ID = DRIVEN_RUN_ID;
const RULE_SET_AT = DRIVEN_AT;

const buildProject = buildDrivenProject;
const approvedTask = approveDrivenTask;
const write = writeProjectFile;
const readStep = readContextStep;
const writeStep = writeFileStep;

/** Starts a TypeScript source in a fresh Node process, as `runNodeScript` does. */
const nodeSource = (script: string): CommandSpec => ({
  executable: process.execPath,
  args: [
    "--disable-warning=ExperimentalWarning",
    "--import",
    join(packageRoot, "tests/helpers/register-typescript-sources.mjs"),
    join(packageRoot, script),
  ],
});

const drive = async (
  root: string,
  overrides: Partial<DriveTaskOptions> = {}
): Promise<DriveTaskResult> =>
  driveTask({
    projectRoot: root,
    taskId: TASK_ID,
    runner,
    packageRootDirectory: packageRoot,
    nodeExecutable: process.execPath,
    // This tree has no `dist/`, so the gate is run from its source. A gate
    // that could not start would let every tool call through unexamined.
    toolGate: nodeSource(CLAUDE_TOOL_GATE_SOURCE),
    timeoutMs: 60_000,
    newRunId: () => "run-2",
    ...overrides,
  });

/** Every agent from the coder on, each doing something inside its own scopes. */
const wholePipeline = (): Record<string, unknown> => ({
  agents: {
    coder: {
      steps: [
        readStep("coder-1", "coder"),
        writeStep(
          "coder-2",
          "src/greeting.js",
          "export const hi = () => 'hi';\n"
        ),
        { text: "Wrote the greeting." },
      ],
    },
    cleaner: {
      steps: [
        writeStep(
          "cleaner-1",
          "src/greeting.js",
          "export const hi = () => 'hi';\n// tidied\n"
        ),
      ],
    },
    architect: {
      steps: [
        writeStep(
          "architect-1",
          `${agentContextDirectory(RUN_ID, "architect")}/findings.md`,
          "# Findings\n"
        ),
      ],
    },
    hardener: {
      steps: [writeStep("hardener-1", "tests/greeting.test.js", "// a test\n")],
    },
    qa: {
      steps: [writeStep("qa-1", "features/greeting.feature", "Feature: hi\n")],
    },
  },
});

describe("driveTask", () => {
  it("takes an approved task through every agent to qa", async () => {
    const root = buildProject({ scenario: wholePipeline() });

    await approvedTask(root);

    const result = await drive(root);

    expect(result.outcome).toBe("reached-qa");
    expect(result.task.state).toBe("qa");
    expect(result.task.agentId).toBe("qa");
    expect(result.stages.map((stage) => stage.agentId)).toEqual([
      "coder",
      "cleaner",
      "architect",
      "hardener",
      "qa",
    ]);
    expect(result.stages.map((stage) => stage.status)).toEqual([
      "handed-off",
      "handed-off",
      "handed-off",
      "handed-off",
      "reached",
    ]);

    for (const stage of result.stages) {
      expect(stage.provider).toBe("claude");
      expect(stage.run?.finished.status).toBe("completed");
      expect(stage.audit.violations).toEqual([]);
    }
  });

  it("reports every agent's events against the stage they came from", async () => {
    const root = buildProject({ scenario: wholePipeline() });
    const seen: string[] = [];

    await approvedTask(root);
    await drive(root, {
      onEvent: (stage, event): void => {
        if (event.kind === "tool-action") {
          seen.push(`${stage}:${event.action.kind}:${event.decision.verdict}`);
        }
      },
    });

    expect(seen).toContain("implementing:read:allowed");
    expect(seen).toContain("implementing:write:allowed");
    expect(seen).toContain("cleaning:write:allowed");
    expect(seen).toContain("qa:write:allowed");
  });

  it("gives each agent its own context and runs it under its own policy", async () => {
    const root = buildProject({ scenario: wholePipeline() });

    await approvedTask(root);
    await drive(root);

    const architect = readAgentContext(
      root,
      agentContextDirectory(RUN_ID, "architect")
    );
    const coder = readAgentContext(
      root,
      agentContextDirectory(RUN_ID, "coder")
    );

    expect(architect.tools.edit).toBe(false);
    expect(architect.writeScopes).toEqual([]);
    expect(architect.displayName).toBe("Architect");
    expect(coder.tools.edit).toBe(true);
    expect(coder.writeScopes).toEqual(["src/**", "tests/**"]);
    expect(coder.handoff?.fromState).toBe("awaiting_approval");
    expect(coder.policy).toContain("# Agent policy: coder");
  });

  it("records every handoff with the gate report it was made under", async () => {
    const root = buildProject({ scenario: wholePipeline() });

    await approvedTask(root);

    const result = await drive(root);
    const task = requireTask(readTaskFile(root), TASK_ID);
    const handoffs = task.history.filter((record) =>
      ["cleaning", "architecture_review", "hardening", "qa"].includes(record.to)
    );

    expect(handoffs).toHaveLength(4);

    for (const record of handoffs) {
      expect(record.gateReportIds).toHaveLength(1);
      expect(record.artifactPaths).toHaveLength(1);
      expect(
        readRunReport(root, RUN_ID, record.gateReportIds[0] ?? "")
      ).toMatchObject({
        kind: "phase-gates",
        report: { phase: "pre-handoff" },
      });
      expect(existsSync(join(root, record.artifactPaths[0] ?? ""))).toBe(true);
    }

    // The transition into a stage names the context its agent then ran under.
    for (const stage of result.stages) {
      const entry = task.history.find((record) => record.to === stage.state);

      expect(entry?.contextPath).toBe(
        agentContextDirectory(RUN_ID, stage.agentId)
      );
    }
  });

  it("blocks the handoff when the pre-handoff gates fail", async () => {
    const root = buildProject({
      scenario: wholePipeline(),
      gateArgv: [process.execPath, "--eval", "process.exit(3)"],
    });

    await approvedTask(root);

    const result = await drive(root);

    expect(result.outcome).toBe("blocked");
    expect(result.task.state).toBe("blocked");
    expect(result.task.interruptedFrom).toBe("implementing");
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]?.status).toBe("blocked");
    expect(result.stages[0]?.gate?.blocked).toBe(true);
    // The work the coder did is still there; what failed is nameable, and a
    // person who fixes it resumes the stage the task stopped in.
    expect(existsSync(join(root, "src/greeting.js"))).toBe(true);
    expect(result.task.history.at(-1)?.failure?.reason).toContain(
      "blocked the handoff out of `implementing`"
    );
    expect(result.task.history.at(-1)?.gateReportIds).toHaveLength(1);
  });

  it("fails the task when the tree ends up outside the agent's scopes", async () => {
    // The change the provider never reported: no `tool_use`, so the gate is
    // not consulted and no decision is missing. Only the audit can catch it,
    // and a violation is a run the sailor will not hand off whatever the
    // provider said it did.
    const root = buildProject({
      scenario: {
        agents: {
          coder: {
            steps: [writeStep("coder-1", "src/greeting.js", "// in scope\n")],
            writes: { "docs/notes.md": "// nobody asked for this\n" },
          },
        },
      },
    });

    await approvedTask(root);

    const result = await drive(root);

    expect(result.outcome).toBe("failed");
    expect(result.task.state).toBe("failed");
    expect(result.task.interruptedFrom).toBe("implementing");
    expect(result.stages[0]?.status).toBe("failed");
    expect(result.stages[0]?.run?.finished.status).toBe("completed");
    expect(result.stages[0]?.audit.violations.map((one) => one.path)).toEqual([
      "docs/notes.md",
    ]);
    expect(result.task.history.at(-1)?.failure?.details.join("\n")).toContain(
      "outside-write-scope"
    );
  });

  it("fails the task, and says what the tree holds, when a tool skips the gate", async () => {
    const root = buildProject({
      scenario: {
        agents: {
          coder: {
            steps: [
              {
                ...writeStep("coder-1", "src/greeting.js", "// unasked\n"),
                skipHook: true,
              },
            ],
          },
        },
      },
    });

    await approvedTask(root);

    const result = await drive(root);
    const failure = result.task.history.at(-1)?.failure;

    expect(result.outcome).toBe("failed");
    expect(result.stages[0]?.status).toBe("failed");
    // No record to audit with, so the driver audits against a snapshot of its
    // own and reports the tree the refused run left behind.
    expect(result.stages[0]?.run).toBeNull();
    expect(failure?.reason).toContain("could not be vouched for");
    expect(failure?.details.join("\n")).toContain("changed: src/greeting.js");
    expect(failure?.details.join("\n")).toContain("has been undone");
  });

  it("fails the task when the agent's own process fails", async () => {
    const root = buildProject({
      scenario: { agents: { coder: { steps: [], exitCode: 9 } } },
    });

    await approvedTask(root);

    const result = await drive(root);

    expect(result.outcome).toBe("failed");
    expect(result.stages[0]?.run?.finished.status).toBe("failed");
    expect(result.task.history.at(-1)?.failure?.reason).toContain(
      "the `coder` run failed"
    );
  });

  it("picks a task up in the stage it stands in, rebuilding a context this machine lacks", async () => {
    // A run interrupted after the handoff into `implementing` - the process
    // was killed, or the checkout is a fresh one - resumes there, because
    // being in a stage is not the same as having finished it. Nothing is
    // carried in memory: what to do next comes out of `tasks.yaml`, and the
    // context that names is rebuilt from the task, the definition and the
    // rules, all of which are tracked.
    const root = buildProject({ scenario: wholePipeline() });

    await approvedTask(root);
    await updateTaskFile(root, (file) =>
      transitionTask(file, {
        taskId: TASK_ID,
        expectedRevision: requireTask(file, TASK_ID).revision,
        to: "implementing",
        toAgent: "coder",
        ruleSetSha256: loadSailorRuleSet({ projectRoot: root }).sha256,
        at: RULE_SET_AT,
        contextPath: agentContextDirectory(RUN_ID, "coder"),
      })
    );

    expect(existsSync(join(root, agentContextDirectory(RUN_ID, "coder")))).toBe(
      false
    );

    const result = await drive(root);

    expect(result.outcome).toBe("reached-qa");
    expect(result.stages[0]?.state).toBe("implementing");
    expect(
      requireTask(readTaskFile(root), TASK_ID).history.filter(
        (record) => record.to === "implementing"
      )
    ).toHaveLength(1);
    expect(
      readAgentContext(root, agentContextDirectory(RUN_ID, "coder")).agentId
    ).toBe("coder");
  });

  it("reports a damaged context rather than rebuilding over it", async () => {
    // Absence is a normal answer and rebuilding is the response to it. A file
    // that is there and unreadable is a different condition, and papering
    // over it would run the stage under a policy nobody wrote.
    const root = buildProject({ scenario: wholePipeline() });

    await approvedTask(root);
    await updateTaskFile(root, (file) =>
      transitionTask(file, {
        taskId: TASK_ID,
        expectedRevision: requireTask(file, TASK_ID).revision,
        to: "implementing",
        toAgent: "coder",
        ruleSetSha256: loadSailorRuleSet({ projectRoot: root }).sha256,
        at: RULE_SET_AT,
        contextPath: agentContextDirectory(RUN_ID, "coder"),
      })
    );
    write(
      root,
      `${agentContextDirectory(RUN_ID, "coder")}/context.json`,
      "{ not json"
    );

    const error = await captureRejection(() => drive(root), SailorError);

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("context.json");
  });

  it("reports an audit it could not make rather than accepting the run", async () => {
    // The sailor cannot say whether the agent stayed in scope, so handing the
    // work on would be the unsafe act. It is an exception, not a finding.
    const root = buildProject({ scenario: wholePipeline() });

    await approvedTask(root);

    const error = await captureRejection(
      () =>
        drive(root, {
          runner: async (request) =>
            request.command.executable === "git" &&
            request.command.args[0] === "diff-tree"
              ? {
                  command: request.command,
                  outcome: "exited",
                  exitCode: 128,
                  output: {
                    stdout: "",
                    stderr: "fatal: bad object",
                    truncated: false,
                  },
                  startedAt: RULE_SET_AT.toISOString(),
                  durationMs: 1,
                }
              : runner(request),
        }),
      SailorError
    );

    expect(error.kind).toBe("working-tree-audit-failed");
    expect(error.message).toContain("git diff-tree");
  });

  it("refuses a task in a state it does not start from", async () => {
    const root = buildProject({ scenario: wholePipeline() });

    await updateTaskFile(root, (file) =>
      createTask(file, {
        id: TASK_ID,
        title: "Add a greeting",
        runId: RUN_ID,
        at: RULE_SET_AT,
      })
    );

    const error = await captureRejection(() => drive(root), SailorError);

    expect(error.kind).toBe("invalid-transition");
    expect(error.message).toContain("which the driver does not start from");
  });

  it("refuses a run routed to a provider it has no adapter for, before spawning anything", async () => {
    const root = buildProject({ scenario: wholePipeline() });

    await approvedTask(root);
    write(
      root,
      ".sailor/config/providers.yaml",
      "version: 1\ndefault: claude\nagents:\n  hardener: codex\n"
    );

    const error = await captureRejection(() => drive(root), SailorError);

    expect(error.kind).toBe("invalid-config");
    expect(error.details.join("\n")).toContain("no adapter for codex");
    expect(error.details.join("\n")).toContain("`hardener`");
    // Nothing ran: the coder is three stages before the one that is misrouted.
    expect(requireTask(readTaskFile(root), TASK_ID).state).toBe(
      "awaiting_approval"
    );
    expect(existsSync(join(root, "src/greeting.js"))).toBe(false);
  });
});
