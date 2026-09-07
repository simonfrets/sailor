import {
  INTERRUPTED_STATES,
  TASK_STATES,
  WORKFLOW_STATES,
  taskFileSchema,
  taskSchema,
  transitionRecordSchema,
} from "../../../src/tasks/task-schema.js";
import { buildTask, buildTransition } from "../../helpers/tasks.js";

describe("task states", () => {
  it("declares the pipeline in the order the workflow runs it", () => {
    expect([...WORKFLOW_STATES]).toEqual([
      "draft",
      "specified",
      "awaiting_approval",
      "implementing",
      "cleaning",
      "architecture_review",
      "hardening",
      "qa",
      "completed",
    ]);
  });

  it("keeps the two interrupted states out of the pipeline", () => {
    expect([...INTERRUPTED_STATES]).toEqual(["blocked", "failed"]);
    expect([...TASK_STATES]).toEqual([
      ...WORKFLOW_STATES,
      ...INTERRUPTED_STATES,
    ]);

    for (const state of INTERRUPTED_STATES) {
      expect(WORKFLOW_STATES).not.toContain(state);
    }
  });
});

describe("transitionRecordSchema", () => {
  it("accepts a fully recorded transition", () => {
    const record = buildTransition({
      gateReportIds: ["report-1"],
      artifactPaths: [".sailor/state/runs/run-1/agents/coder/report.json"],
      contextPath: ".sailor/state/runs/run-1/agents/cleaner",
    });

    expect(transitionRecordSchema.parse(record)).toEqual(record);
  });

  it("requires the rule-set hash to be a sha-256", () => {
    expect(
      transitionRecordSchema.safeParse(
        buildTransition({ ruleSetSha256: "not-a-hash" })
      ).success
    ).toBe(false);
  });

  it("refuses a timestamp that is not an instant in UTC", () => {
    // Two machines writing local times would order the history differently.
    expect(
      transitionRecordSchema.safeParse(
        buildTransition({ at: "2026-08-27T02:01:00+02:00" })
      ).success
    ).toBe(false);
  });

  it("refuses an absolute path, which would name the machine that wrote it", () => {
    expect(
      transitionRecordSchema.safeParse(
        buildTransition({ contextPath: "/Users/someone/project/.sailor" })
      ).success
    ).toBe(false);
    expect(
      transitionRecordSchema.safeParse(
        buildTransition({ artifactPaths: ["/etc/passwd"] })
      ).success
    ).toBe(false);
  });

  it("refuses a path that escapes the project root", () => {
    expect(
      transitionRecordSchema.safeParse(
        buildTransition({ contextPath: ".sailor/state/../../elsewhere" })
      ).success
    ).toBe(false);
  });

  it("refuses an unknown key rather than dropping it", () => {
    expect(
      transitionRecordSchema.safeParse({
        ...buildTransition(),
        gateReports: ["report-1"],
      }).success
    ).toBe(false);
  });

  it("defaults the optional evidence lists so a reader never sees undefined", () => {
    const record = buildTransition();
    const { gateReportIds, artifactPaths, failure, contextPath, ...required } =
      record;

    expect(gateReportIds).toEqual([]);
    expect(artifactPaths).toEqual([]);
    expect(failure).toBeNull();
    expect(contextPath).toBeNull();
    expect(transitionRecordSchema.parse(required)).toEqual(record);
  });
});

describe("taskSchema", () => {
  it("accepts a freshly created task", () => {
    expect(taskSchema.parse(buildTask())).toEqual(buildTask());
  });

  it("refuses a run id that is not a single safe path segment", () => {
    // A run id becomes a directory name under `.sailor/state/runs/`.
    for (const runId of ["../escape", "run/1", "Run-1", ""]) {
      expect(taskSchema.safeParse(buildTask({ runId })).success).toBe(false);
    }
  });

  it("refuses a revision below one, which no transition could have produced", () => {
    expect(taskSchema.safeParse(buildTask({ revision: 0 })).success).toBe(
      false
    );
  });

  it("refuses an interruption recorded in a state no work happens in", () => {
    // Recovery is computed as the stages up to and including this one, so
    // `completed` would open the whole pipeline. `blocked` and `failed` are
    // refused with it, because neither is a stage any work happened in.
    for (const interruptedFrom of ["completed", "blocked", "failed"] as const) {
      expect(
        taskSchema.safeParse(
          buildTask({
            state: "blocked",
            interruptedFrom: interruptedFrom as "qa",
          })
        ).success
      ).toBe(false);
    }

    expect(
      taskSchema.safeParse(
        buildTask({ state: "blocked", interruptedFrom: "qa" })
      ).success
    ).toBe(true);
  });

  it("refuses an agent recorded against a state it does not own", () => {
    // `tasks.yaml` is committed and reviewed, so a hand edit or a merge
    // conflict is all it takes to write this, and a runtime reading it would
    // hand the stage the named agent's tools and write scopes.
    for (const [state, agentId] of [
      ["implementing", "qa"],
      ["qa", "coder"],
      ["cleaning", null],
      ["draft", "specifier"],
      ["completed", "qa"],
      ["blocked", "hardener"],
    ] as const) {
      expect(
        taskSchema.safeParse(
          buildTask({
            state,
            agentId,
            ...(state === "blocked" ? { interruptedFrom: "hardening" } : {}),
          })
        ).success
      ).toBe(false);
    }

    for (const [state, agentId] of [
      ["implementing", "coder"],
      ["specified", "specifier"],
      ["awaiting_approval", null],
      ["completed", null],
    ] as const) {
      expect(taskSchema.safeParse(buildTask({ state, agentId })).success).toBe(
        true
      );
    }
  });

  it("refuses a state it has no transition rules for", () => {
    expect(
      taskSchema.safeParse(buildTask({ state: "in_review" as "draft" })).success
    ).toBe(false);
  });
});

describe("taskFileSchema", () => {
  it("defaults an empty file to no tasks", () => {
    expect(taskFileSchema.parse({ version: 1 })).toEqual({
      version: 1,
      tasks: [],
    });
  });

  it("refuses a version it does not understand", () => {
    expect(taskFileSchema.safeParse({ version: 2, tasks: [] }).success).toBe(
      false
    );
  });

  it("refuses two tasks claiming the same id", () => {
    const result = taskFileSchema.safeParse({
      version: 1,
      tasks: [buildTask(), buildTask({ title: "Something else" })],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("more than once");
  });
});

describe("approval", () => {
  it("refuses half an approval", () => {
    // Knowing that something was approved without knowing who approved it
    // cannot answer the only question an audit trail exists for.
    for (const half of [
      { approvedAt: "2026-08-27T00:02:00.000Z", approvedBy: null },
      { approvedAt: null, approvedBy: "a-reviewer" },
    ]) {
      expect(taskSchema.safeParse(buildTask(half)).success).toBe(false);
    }

    expect(
      taskSchema.safeParse(
        buildTask({
          approvedAt: "2026-08-27T00:02:00.000Z",
          approvedBy: "a-reviewer",
        })
      ).success
    ).toBe(true);
  });
});
