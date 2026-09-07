import { SailorError } from "../../../src/sailor/sailor-error.js";
import {
  approveSpecification,
  createDefaultRunId,
  createTask,
  transitionTask,
} from "../../../src/tasks/transition-task.js";
import type { TransitionRequest } from "../../../src/tasks/transition-task.js";
import type { Task, TaskFile } from "../../../src/tasks/task-schema.js";
import { requireTask } from "../../../src/tasks/task-file.js";
import { captureError } from "../../helpers/expect-error.js";
import {
  RULE_SET_SHA256,
  buildTask,
  buildTaskFile,
} from "../../helpers/tasks.js";

/**
 * The instant a test's own transition happens at.
 *
 * It is deliberately later than everything `walkTo` records, so a transition
 * stamped with any instant the task was already carrying is a different
 * timestamp rather than the same one.
 */
const AT = new Date("2026-08-27T10:00:00.000Z");

/** When the task under test was written down. An hour before anything moves. */
const CREATED_AT = new Date("2026-08-27T09:00:00.000Z");

const only = (file: TaskFile): Task => requireTask(file, "add-login");

const move = (
  file: TaskFile,
  request: Omit<TransitionRequest, "taskId" | "ruleSetSha256" | "at"> &
    Partial<Pick<TransitionRequest, "taskId" | "ruleSetSha256" | "at">>
): TaskFile =>
  transitionTask(file, {
    taskId: "add-login",
    ruleSetSha256: RULE_SET_SHA256,
    at: AT,
    ...request,
  });

/**
 * Walks a task from `draft` to the state a test wants to start from.
 *
 * Creation, the approval and every step take an instant of their own, a minute
 * apart and all of them before `AT`. A task built at the same instant it is
 * then transitioned at cannot tell the two apart, so a record stamped with the
 * task's creation time - or with the time of the transition before it - would
 * read as correct, and the history would order wrongly for exactly the audit
 * question it exists to answer.
 */
const walkTo = (state: Task["state"], approvedBy = "a-reviewer"): TaskFile => {
  let file = createTask(buildTaskFile(), {
    id: "add-login",
    title: "Add login",
    runId: "run-1",
    at: CREATED_AT,
  });
  let minutes = 0;
  const nextInstant = (): Date =>
    new Date(CREATED_AT.getTime() + ++minutes * 60_000);
  const step = (to: Task["state"], toAgent: string | null): void => {
    file = move(file, {
      expectedRevision: only(file).revision,
      to,
      toAgent,
      at: nextInstant(),
    });
  };

  if (state === "draft") {
    return file;
  }

  step("specified", "specifier");

  if (state === "specified") {
    return file;
  }

  step("awaiting_approval", null);
  file = approveSpecification(file, {
    taskId: "add-login",
    expectedRevision: only(file).revision,
    approvedBy,
    ruleSetSha256: RULE_SET_SHA256,
    at: nextInstant(),
  });

  if (state === "awaiting_approval") {
    return file;
  }

  for (const [to, agent] of [
    ["implementing", "coder"],
    ["cleaning", "cleaner"],
    ["architecture_review", "architect"],
    ["hardening", "hardener"],
    ["qa", "qa"],
    ["completed", null],
  ] as const) {
    step(to, agent);

    if (state === to) {
      return file;
    }
  }

  return file;
};

describe("createTask", () => {
  it("starts a task in draft at revision one with no history", () => {
    const task = only(
      createTask(buildTaskFile(), {
        id: "add-login",
        title: "Add login",
        runId: "run-1",
        at: AT,
      })
    );

    expect(task).toEqual(
      buildTask({
        createdAt: AT.toISOString(),
        updatedAt: AT.toISOString(),
      })
    );
  });

  it("refuses to reuse an id already spent on other work", () => {
    const file = walkTo("draft");
    const error = captureError(
      () =>
        createTask(file, {
          id: "add-login",
          title: "Something else",
          runId: "run-2",
          at: AT,
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-transition");
  });

  it("refuses a run id that would escape the run directory", () => {
    const error = captureError(
      () =>
        createTask(buildTaskFile(), {
          id: "add-login",
          title: "Add login",
          runId: "../../etc",
          at: AT,
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.details.join("\n")).toContain("runId");
  });
});

describe("stale revisions", () => {
  it("refuses a transition decided against a revision that has moved on", () => {
    const file = walkTo("specified");
    const error = captureError(
      () =>
        move(file, {
          expectedRevision: 1,
          to: "awaiting_approval",
          toAgent: null,
        }),
      SailorError
    );

    expect(error.kind).toBe("stale-task-revision");
    expect(error.message).toContain("revision 2");
  });

  it("refuses an approval decided against a stale revision", () => {
    const file = walkTo("awaiting_approval");
    const error = captureError(
      () =>
        approveSpecification(file, {
          taskId: "add-login",
          expectedRevision: 1,
          approvedBy: "a-reviewer",
          ruleSetSha256: RULE_SET_SHA256,
          at: AT,
        }),
      SailorError
    );

    expect(error.kind).toBe("stale-task-revision");
  });

  it("records both revisions, so a reader can see what was decided against", () => {
    const task = only(walkTo("specified"));
    const [record] = task.history;

    expect(task.revision).toBe(2);
    expect(record?.revision).toBe(2);
    expect(record?.expectedRevision).toBe(1);
  });
});

describe("approval", () => {
  it("blocks the coder until the specification is explicitly approved", () => {
    let file = walkTo("specified");

    file = move(file, {
      expectedRevision: only(file).revision,
      to: "awaiting_approval",
      toAgent: null,
    });

    const error = captureError(
      () =>
        move(file, {
          expectedRevision: only(file).revision,
          to: "implementing",
          toAgent: "coder",
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-transition");
    expect(error.message).toContain("no approved specification");
  });

  it("takes a revision of its own so the coder cannot approve its own start", () => {
    const before = only(walkTo("awaiting_approval"));
    const approval = before.history.at(-1);

    // The approval happened when it happened, which is neither when the task
    // was written down nor when anything else moved it.
    expect(before.approvedAt).toBe(approval?.at);
    expect(before.approvedAt).not.toBe(before.createdAt);
    expect(before.approvedBy).toBe("a-reviewer");
    expect(approval?.from).toBe("awaiting_approval");
    expect(approval?.to).toBe("awaiting_approval");
    expect(approval?.revision).toBe(before.revision);
  });

  it("refuses to approve a task that is not awaiting approval", () => {
    const file = walkTo("specified");
    const error = captureError(
      () =>
        approveSpecification(file, {
          taskId: "add-login",
          expectedRevision: only(file).revision,
          approvedBy: "a-reviewer",
          ruleSetSha256: RULE_SET_SHA256,
          at: AT,
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-transition");
    expect(error.message).toContain("awaiting approval");
  });

  it("refuses a second approval of the same specification", () => {
    const file = walkTo("awaiting_approval");
    const error = captureError(
      () =>
        approveSpecification(file, {
          taskId: "add-login",
          expectedRevision: only(file).revision,
          approvedBy: "someone-else",
          ruleSetSha256: RULE_SET_SHA256,
          at: AT,
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-transition");
    expect(error.message).toContain("already approved");
  });

  it("withdraws the approval when the specification is written again", () => {
    let file = walkTo("implementing");

    file = move(file, {
      expectedRevision: only(file).revision,
      to: "blocked",
      toAgent: null,
      failure: { reason: "the specification was wrong", details: [] },
    });
    file = move(file, {
      expectedRevision: only(file).revision,
      to: "specified",
      toAgent: "specifier",
    });

    expect(only(file).approvedAt).toBeNull();
    expect(only(file).approvedBy).toBeNull();

    const error = captureError(
      () =>
        transitionTask(
          move(file, {
            expectedRevision: only(file).revision,
            to: "awaiting_approval",
            toAgent: null,
          }),
          {
            taskId: "add-login",
            expectedRevision: only(file).revision + 1,
            to: "implementing",
            toAgent: "coder",
            ruleSetSha256: RULE_SET_SHA256,
            at: AT,
          }
        ),
      SailorError
    );

    expect(error.message).toContain("no approved specification");
  });
});

describe("transitionTask", () => {
  it("records everything the next agent's evidence has to be traceable to", () => {
    let file = walkTo("implementing");

    file = move(file, {
      expectedRevision: only(file).revision,
      to: "cleaning",
      toAgent: "cleaner",
      gateReportIds: ["report-9"],
      artifactPaths: [".sailor/state/runs/run-1/agents/coder/diff.patch"],
      contextPath: ".sailor/state/runs/run-1/agents/cleaner",
    });

    const task = only(file);

    expect(task.history.at(-1)).toEqual({
      revision: task.revision,
      expectedRevision: task.revision - 1,
      from: "implementing",
      to: "cleaning",
      fromAgent: "coder",
      toAgent: "cleaner",
      ruleSetSha256: RULE_SET_SHA256,
      gateReportIds: ["report-9"],
      artifactPaths: [".sailor/state/runs/run-1/agents/coder/diff.patch"],
      at: AT.toISOString(),
      attempt: 1,
      failure: null,
      contextPath: ".sailor/state/runs/run-1/agents/cleaner",
    });
    expect(task.agentId).toBe("cleaner");
    expect(task.contextPath).toBe(".sailor/state/runs/run-1/agents/cleaner");
  });

  it("stamps a transition with the instant it happened, not one the task carried", () => {
    const file = walkTo("cleaning");
    const before = only(file);
    const task = only(
      move(file, {
        expectedRevision: before.revision,
        to: "architecture_review",
        toAgent: "architect",
      })
    );
    const timestamps = task.history.map((record) => record.at);

    expect(task.history.at(-1)?.at).toBe(AT.toISOString());
    // The three instants the task was already carrying. Stamping a record with
    // any of them loses when the stage was actually entered, which is the one
    // question the record exists to answer.
    expect(timestamps).not.toContain(before.createdAt);
    expect(timestamps.at(-1)).not.toBe(before.updatedAt);
    expect(timestamps.at(-1)).not.toBe(timestamps.at(-2));
    // A history that does not order in time cannot be read as a sequence of
    // events, however well its revisions are numbered.
    expect(new Set(timestamps).size).toBe(timestamps.length);
    expect(timestamps).toEqual([...timestamps].sort());
  });

  it("refuses to skip a stage", () => {
    const file = walkTo("implementing");
    const error = captureError(
      () =>
        move(file, {
          expectedRevision: only(file).revision,
          to: "qa",
          toAgent: "qa",
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-transition");
    expect(error.details.join("\n")).toContain("cleaning");
  });

  it("refuses to move a completed task at all", () => {
    const file = walkTo("completed");
    const error = captureError(
      () =>
        move(file, {
          expectedRevision: only(file).revision,
          to: "qa",
          toAgent: "qa",
        }),
      SailorError
    );

    expect(error.details.join("\n")).toContain("final");
  });

  it("insists that an interruption say why", () => {
    const file = walkTo("implementing");
    const error = captureError(
      () =>
        move(file, {
          expectedRevision: only(file).revision,
          to: "failed",
          toAgent: null,
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-transition");
    expect(error.message).toContain("must record why");
  });

  it("refuses a recovery that carries a failure of its own", () => {
    let file = walkTo("implementing");

    file = move(file, {
      expectedRevision: only(file).revision,
      to: "failed",
      toAgent: null,
      failure: { reason: "the gate blocked", details: ["lint exited 1"] },
    });

    const error = captureError(
      () =>
        move(file, {
          expectedRevision: only(file).revision,
          to: "implementing",
          toAgent: "coder",
          failure: { reason: "still broken", details: [] },
        }),
      SailorError
    );

    expect(error.message).toContain("must not record a failure");
  });

  it("remembers the stage an interruption stopped, and forgets it on recovery", () => {
    let file = walkTo("hardening");

    file = move(file, {
      expectedRevision: only(file).revision,
      to: "blocked",
      toAgent: null,
      failure: { reason: "waiting on a decision", details: [] },
    });

    expect(only(file).interruptedFrom).toBe("hardening");

    file = move(file, {
      expectedRevision: only(file).revision,
      to: "hardening",
      toAgent: "hardener",
    });

    expect(only(file).interruptedFrom).toBeNull();
  });

  it("carries the interrupted stage across from blocked to failed", () => {
    let file = walkTo("qa");

    file = move(file, {
      expectedRevision: only(file).revision,
      to: "blocked",
      toAgent: null,
      failure: { reason: "waiting on a decision", details: [] },
    });
    file = move(file, {
      expectedRevision: only(file).revision,
      to: "failed",
      toAgent: null,
      failure: { reason: "the decision was to stop", details: [] },
    });

    expect(only(file).interruptedFrom).toBe("qa");
  });

  it("counts a second entry into a state as the second attempt", () => {
    let file = walkTo("implementing");

    file = move(file, {
      expectedRevision: only(file).revision,
      to: "failed",
      toAgent: null,
      failure: { reason: "the gate blocked", details: [] },
    });
    file = move(file, {
      expectedRevision: only(file).revision,
      to: "implementing",
      toAgent: "coder",
      newRunId: () => "run-2",
    });

    expect(only(file).history.at(-1)?.attempt).toBe(2);
  });

  it("starts a retry in a new run so the failed attempt is not overwritten", () => {
    let file = walkTo("implementing");

    file = move(file, {
      expectedRevision: only(file).revision,
      to: "failed",
      toAgent: null,
      failure: { reason: "the gate blocked", details: [] },
    });

    expect(only(file).runId).toBe("run-1");

    file = move(file, {
      expectedRevision: only(file).revision,
      to: "implementing",
      toAgent: "coder",
      newRunId: () => "run-2",
    });

    expect(only(file).runId).toBe("run-2");
  });

  it("keeps the run when a blocked task simply resumes", () => {
    let file = walkTo("cleaning");

    file = move(file, {
      expectedRevision: only(file).revision,
      to: "blocked",
      toAgent: null,
      failure: { reason: "waiting on a decision", details: [] },
    });
    file = move(file, {
      expectedRevision: only(file).revision,
      to: "cleaning",
      toAgent: "cleaner",
      newRunId: () => "run-2",
    });

    expect(only(file).runId).toBe("run-1");
  });

  it("names a task it has never heard of rather than creating one", () => {
    const error = captureError(
      () =>
        move(buildTaskFile(), {
          taskId: "other",
          expectedRevision: 1,
          to: "specified",
          toAgent: "specifier",
        }),
      SailorError
    );

    expect(error.kind).toBe("unknown-task");
  });

  it("refuses to hand a stage to an agent that does not own it", () => {
    // Both are agents the sailor ships and both records validate, so nothing
    // downstream could tell this apart from a correct handoff. A driver builds
    // the next agent's context from whoever is recorded, and design decision 6
    // has the runtime enforce that context, so `implementing` would run under
    // QA's policy: `edit: false` and no write scope, unable to write the
    // implementation it was started to write.
    const file = walkTo("awaiting_approval");
    const error = captureError(
      () =>
        move(file, {
          expectedRevision: only(file).revision,
          to: "implementing",
          toAgent: "qa",
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-transition");
    expect(error.details.join("\n")).toContain("owned by `coder`");
    expect(only(file).agentId).toBeNull();
  });

  it("refuses to start a stage its own agent is not recorded for", () => {
    // The reverse of the above, and the reason the check is an equality rather
    // than a list of who is forbidden: a stage nobody is recorded against is a
    // stage the runtime has no policy to enforce.
    const file = walkTo("implementing");
    const error = captureError(
      () =>
        move(file, {
          expectedRevision: only(file).revision,
          to: "cleaning",
          toAgent: null,
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-transition");
    expect(error.details.join("\n")).toContain("owned by `cleaner`");
  });

  it("refuses to name an owner for a state nothing is worked on in", () => {
    // A blocked task is stopped, not being worked on by the agent that was
    // working when it stopped. That agent is on the record as `fromAgent`, and
    // the stage it stopped in as `interruptedFrom`; naming it the owner of
    // `blocked` as well would say it is still running.
    const file = walkTo("hardening");
    const error = captureError(
      () =>
        move(file, {
          expectedRevision: only(file).revision,
          to: "blocked",
          toAgent: "hardener",
          failure: { reason: "waiting on a decision", details: [] },
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-transition");
    expect(error.details.join("\n")).toContain("owned by no agent");
  });

  it("refuses a project-defined agent a stage of its own", () => {
    // `agentIdSchema` accepts one, because a rule may target one. Owning a
    // pipeline state is a different claim: the nine states are fixed, so there
    // is none spare for a seventh agent, and an id that is merely well-formed
    // is also what a misspelt built-in one looks like.
    const file = walkTo("implementing");
    const error = captureError(
      () =>
        move(file, {
          expectedRevision: only(file).revision,
          to: "cleaning",
          toAgent: "tidier",
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-transition");
    expect(error.message).toContain("`tidier`");
  });

  it("refuses a context path that leaves the project", () => {
    const file = walkTo("implementing");
    const error = captureError(
      () =>
        move(file, {
          expectedRevision: only(file).revision,
          to: "cleaning",
          toAgent: "cleaner",
          contextPath: "/tmp/somewhere",
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.details.join("\n")).toContain("contextPath");
  });
});

describe("createDefaultRunId", () => {
  it("mints an id the run directory can be named after", () => {
    expect(createDefaultRunId()).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(createDefaultRunId()).not.toBe(createDefaultRunId());
  });
});
