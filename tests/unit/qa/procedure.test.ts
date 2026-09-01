import { SailorError } from "../../../src/sailor/sailor-error.js";
import type { ProjectProfile } from "../../../src/project/project-profile-schema.js";
import {
  QA_STEP_STATUSES,
  loadQaProcedure,
  qaProcedureReportSchema,
  qaProcedureSchema,
  runQaProcedure,
} from "../../../src/qa/procedure.js";
import type { QaProcedure } from "../../../src/qa/procedure.js";
import { captureError } from "../../helpers/expect-error.js";
import {
  at,
  createFakeCommandRunner,
  exited,
  spawnFailed,
  timedOut,
} from "../../helpers/fake-command-runner.js";
import type { PlannedCommandResult } from "../../helpers/fake-command-runner.js";

const PROFILE: ProjectProfile = {
  root: "/workspace/example",
  packageManager: "npm",
  availableScripts: ["build", "test"],
  typescriptConfigFiles: [],
  eslintConfigFiles: [],
  gitHooksPath: null,
  existingHookEntrypoints: [],
  validationMode: "native-plus-sailor",
};

const procedure = (steps: readonly unknown[]): QaProcedure =>
  qaProcedureSchema.parse({ version: 1, steps });

const commandStep = (id: string, covers: readonly string[] = []) => ({
  id,
  runner: "command",
  argv: ["node", "--test", id],
  covers,
});

let clock: number;

const run = async (
  given: QaProcedure,
  respond:
    | PlannedCommandResult
    | ((request: never, index: number) => PlannedCommandResult) = exited(0)
) => {
  clock = 0;

  const fake = createFakeCommandRunner(
    respond as PlannedCommandResult | (() => PlannedCommandResult)
  );
  const report = await runQaProcedure({
    procedure: given,
    profile: PROFILE,
    runner: fake.run,
    now: (): Date => new Date(1_800_000_000_000 + clock++ * 1000),
    createReportId: (): string => "qa-report-1",
  });

  return { report, fake };
};

describe("qaProcedureSchema", () => {
  it("accepts both runners and applies the defaults", () => {
    const parsed = procedure([
      {
        id: "unit-tests",
        runner: "project-script",
        script: "test",
        covers: ["Happy path"],
      },
      commandStep("acceptance"),
    ]);

    expect(parsed.steps).toEqual([
      {
        id: "unit-tests",
        runner: "project-script",
        script: "test",
        args: [],
        covers: ["Happy path"],
        timeoutMs: 120_000,
      },
      {
        id: "acceptance",
        runner: "command",
        argv: ["node", "--test", "acceptance"],
        covers: [],
        timeoutMs: 120_000,
      },
    ]);
  });

  it("refuses a procedure with nothing to run", () => {
    expect(qaProcedureSchema.safeParse({ version: 1, steps: [] }).success).toBe(
      false
    );
  });

  it("refuses two steps sharing an id, which one result could not tell apart", () => {
    expect(
      qaProcedureSchema.safeParse({
        version: 1,
        steps: [commandStep("same"), commandStep("same")],
      }).success
    ).toBe(false);
  });

  it("refuses an arbitrary script name and an empty argv", () => {
    expect(
      qaProcedureSchema.safeParse({
        version: 1,
        steps: [{ id: "x", runner: "project-script", script: "deploy" }],
      }).success
    ).toBe(false);
    expect(
      qaProcedureSchema.safeParse({
        version: 1,
        steps: [{ id: "x", runner: "command", argv: [] }],
      }).success
    ).toBe(false);
  });

  it("refuses a key it does not know", () => {
    expect(
      qaProcedureSchema.safeParse({
        version: 1,
        steps: [{ ...commandStep("x"), shell: true }],
      }).success
    ).toBe(false);
  });
});

describe("loadQaProcedure", () => {
  it("loads YAML and reports where a mistake is", () => {
    const loaded = loadQaProcedure(
      [
        "version: 1",
        "steps:",
        "  - id: acceptance",
        "    runner: command",
        "    argv: [node, --test]",
        "    covers: [Happy path]",
        "",
      ].join("\n"),
      { source: "docs/qa/add-login.yaml" }
    );

    expect(loaded.steps).toHaveLength(1);

    const error = captureError(
      () =>
        loadQaProcedure("version: 1\nsteps: []\n", {
          source: "docs/qa/add-login.yaml",
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("docs/qa/add-login.yaml");
  });
});

describe("runQaProcedure", () => {
  it("runs every step in order against the project root and reports a pass", async () => {
    const { report, fake } = await run(
      procedure([
        {
          id: "unit-tests",
          runner: "project-script",
          script: "test",
          args: ["--forbid-only"],
          covers: ["Happy path"],
        },
        commandStep("acceptance", ["Bad passwords"]),
      ])
    );

    expect(fake.requests.map((request) => request.command)).toEqual([
      { executable: "npm", args: ["run", "test", "--", "--forbid-only"] },
      { executable: "node", args: ["--test", "acceptance"] },
    ]);
    expect(at(fake.requests, 0).cwd).toBe("/workspace/example");
    expect(at(fake.requests, 1).timeoutMs).toBe(120_000);
    expect(report.reportId).toBe("qa-report-1");
    expect(report.passed).toBe(true);
    expect(report.failedStepIds).toEqual([]);
    expect(report.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["unit-tests", "passed"],
      ["acceptance", "passed"],
    ]);
    expect(at(report.steps, 1).covers).toEqual(["Bad passwords"]);
  });

  it("keeps running after a failure so the report is complete, and names what failed", async () => {
    const { report } = await run(
      procedure([commandStep("a"), commandStep("b"), commandStep("c")]),
      (request: { command: { args: readonly string[] } }) =>
        request.command.args.includes("b")
          ? exited(3, { stderr: "boom\n" })
          : exited(0)
    );

    expect(report.passed).toBe(false);
    expect(report.failedStepIds).toEqual(["b"]);
    expect(report.steps.map((step) => step.status)).toEqual([
      "passed",
      "failed",
      "passed",
    ]);
    expect(at(report.steps, 1).stderr).toBe("boom\n");
    expect(at(report.steps, 1).detail).toBe("exited with code 3");
  });

  it("reports a timeout and a spawn failure as themselves, never as a plain failure", async () => {
    const { report } = await run(
      procedure([commandStep("slow"), commandStep("broken")]),
      (request: { command: { args: readonly string[] } }) =>
        request.command.args.includes("slow")
          ? timedOut(1000)
          : spawnFailed("ENOENT")
    );

    expect(report.steps.map((step) => step.status)).toEqual([
      "timed-out",
      "spawn-failed",
    ]);
    expect(report.passed).toBe(false);
    expect(report.failedStepIds).toEqual(["slow", "broken"]);
  });

  it("fails a script the project does not define without attempting anything", async () => {
    const { report, fake } = await run(
      procedure([
        { id: "lint", runner: "project-script", script: "lint" },
        commandStep("after"),
      ])
    );

    expect(fake.requests).toHaveLength(1);
    expect(at(report.steps, 0)).toMatchObject({
      stepId: "lint",
      status: "failed",
      command: null,
    });
    expect(at(report.steps, 0).detail).toContain(
      'project script "lint" is not defined'
    );
    expect(report.passed).toBe(false);
  });

  it("produces reports the persistence schema accepts, whatever the outcome", async () => {
    const { report } = await run(
      procedure([
        commandStep("pass"),
        commandStep("fail"),
        commandStep("slow"),
        commandStep("broken"),
        { id: "absent", runner: "project-script", script: "typecheck" },
      ]),
      (request: { command: { args: readonly string[] } }, index: number) => {
        if (request.command.args.includes("fail")) {
          return exited(1);
        }

        if (request.command.args.includes("slow")) {
          return timedOut(50);
        }

        if (request.command.args.includes("broken")) {
          return spawnFailed("EACCES");
        }

        return exited(index);
      }
    );
    const parsed = qaProcedureReportSchema.safeParse(report);

    expect(
      parsed.success
        ? []
        : parsed.error.issues.map(
            (issue) => `${issue.path.join(".")}: ${issue.message}`
          )
    ).toEqual([]);
    expect([...QA_STEP_STATUSES].sort()).toEqual(
      [...new Set(report.steps.map((step) => step.status))].sort()
    );
  });
});
