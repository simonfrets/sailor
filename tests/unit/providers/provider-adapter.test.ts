import type { AgentDefinition } from "../../../src/agents/agent-definition.js";
import { SailorError } from "../../../src/sailor/sailor-error.js";
import type { AgentEvent } from "../../../src/providers/agent-event.js";
import {
  PROVIDER_IDS,
  ProviderProtocolError,
  buildAgentInvocation,
  providerIdSchema,
  recordAgentRun,
} from "../../../src/providers/provider-adapter.js";
import type {
  AgentInvocation,
  BuildAgentInvocationInput,
  ProviderAdapter,
} from "../../../src/providers/provider-adapter.js";
import { buildAgentContext } from "../../../src/tasks/agent-context.js";
import type { AgentContext } from "../../../src/tasks/agent-context.js";
import type { Task } from "../../../src/tasks/task-schema.js";
import { captureError, captureRejection } from "../../helpers/expect-error.js";
import {
  RULE_SET_SHA256,
  buildTask,
  buildTransition,
} from "../../helpers/tasks.js";

const AT = "2026-08-28T12:00:00.000Z";
const PROJECT_ROOT = "/tmp/project";

const coder: AgentDefinition = {
  version: 1,
  id: "coder",
  displayName: "Coder",
  summary: "Implements the specification",
  modelProfile: "coding-high",
  tools: { read: true, search: true, edit: true, execute: true },
  writeScopes: ["src/**", "tests/**"],
  projectScripts: ["lint", "test"],
};

const CONTEXT_PATH = ".sailor/state/runs/run-1/agents/coder";

/** A task the coder was just handed: entered `implementing` at revision 5, decided at 4. */
const implementing = (overrides: Partial<Task> = {}): Task =>
  buildTask({
    state: "implementing",
    agentId: "coder",
    revision: 5,
    runId: "run-1",
    approvedAt: "2026-08-28T11:00:00.000Z",
    approvedBy: "a-reviewer",
    contextPath: CONTEXT_PATH,
    history: [
      buildTransition({
        revision: 5,
        expectedRevision: 4,
        from: "awaiting_approval",
        to: "implementing",
        fromAgent: null,
        toAgent: "coder",
        contextPath: CONTEXT_PATH,
      }),
    ],
    ...overrides,
  });

const contextFor = (
  task: Task,
  overrides: Partial<AgentContext> = {}
): AgentContext => ({
  ...buildAgentContext({
    task,
    definition: coder,
    policy: "# Agent policy: coder\n",
    ruleSetSha256: RULE_SET_SHA256,
    at: new Date(AT),
    attempt: 2,
    handoff: {
      fromAgent: "specifier",
      fromState: "awaiting_approval",
      gateReportIds: ["report-1"],
      artifactPaths: ["docs/specs/add-login.md"],
      failure: null,
    },
  }),
  ...overrides,
});

const input = (
  overrides: Partial<BuildAgentInvocationInput> = {}
): BuildAgentInvocationInput => {
  const task = implementing();

  return {
    projectRoot: PROJECT_ROOT,
    task,
    context: contextFor(task),
    modelProfile: coder.modelProfile,
    packageManager: "npm",
    timeoutMs: 600_000,
    signal: new AbortController().signal,
    ...overrides,
  };
};

const refused = (overrides: Partial<BuildAgentInvocationInput>): SailorError =>
  captureError(() => buildAgentInvocation(input(overrides)), SailorError);

const started: AgentEvent = { kind: "started", at: AT, command: null };
const output: AgentEvent = {
  kind: "output",
  at: AT,
  stream: "stdout",
  text: "working\n",
};
const finished: AgentEvent = {
  kind: "finished",
  at: AT,
  status: "completed",
  detail: "exited with code 0",
  exitCode: 0,
  durationMs: 10,
};

/** An adapter that replays what it is given, as any provider would after translation. */
const replaying = (events: readonly unknown[]): ProviderAdapter => ({
  provider: "claude",
  invoke: async function* () {
    for (const event of events) {
      yield await Promise.resolve(event as AgentEvent);
    }
  },
});

describe("provider ids", () => {
  it("names the two providers the design fixes", () => {
    expect([...PROVIDER_IDS]).toEqual(["claude", "codex"]);
    expect(providerIdSchema.safeParse("claude").success).toBe(true);
    expect(providerIdSchema.safeParse("openai").success).toBe(false);
  });
});

describe("buildAgentInvocation", () => {
  it("hands the adapter what the design lists, all taken from the context the handoff wrote", () => {
    const built = input();
    const invocation = buildAgentInvocation(built);

    expect(invocation).toEqual({
      projectRoot: PROJECT_ROOT,
      contextPath: ".sailor/state/runs/run-1/agents/coder",
      task: built.task,
      attempt: 2,
      handoff: built.context.handoff,
      policy: "# Agent policy: coder\n",
      modelProfile: "coding-high",
      toolPolicy: {
        tools: coder.tools,
        writeScopes: coder.writeScopes,
        projectScripts: coder.projectScripts,
        contextDirectory: ".sailor/state/runs/run-1/agents/coder",
        packageManager: "npm",
      },
      timeoutMs: 600_000,
      signal: built.signal,
    });
    expect(invocation.signal).toBe(built.signal);
  });

  it("is a snapshot: frozen, and not a view onto the task or context it was built from", () => {
    const built = input();
    const invocation = buildAgentInvocation(built);

    expect(Object.isFrozen(invocation)).toBe(true);
    expect(Object.isFrozen(invocation.task)).toBe(true);
    expect(Object.isFrozen(invocation.task.history)).toBe(true);
    expect(Object.isFrozen(invocation.toolPolicy.writeScopes)).toBe(true);
    expect(Object.isFrozen(invocation.handoff)).toBe(true);
    expect(invocation.task).not.toBe(built.task);
    expect(invocation.handoff).not.toBe(built.context.handoff);
    expect(invocation.toolPolicy.writeScopes).not.toBe(
      built.context.writeScopes
    );
  });

  it("refuses a task in a state no agent owns", () => {
    const task = buildTask({ state: "awaiting_approval", revision: 3 });
    const error = refused({ task, context: contextFor(task) });

    expect(error.kind).toBe("invalid-invocation");
    expect(error.message).toContain(
      "task `add-login` is `awaiting_approval`, which no agent owns"
    );
  });

  it("accepts the context a handoff actually writes: built before the transition, from the snapshot it was decided against", () => {
    const task = implementing();
    // What `writeAgentContext` was given: the task as it stood before the
    // move, at revision 4 in `awaiting_approval`, one revision behind.
    const context = contextFor(task, {
      taskRevision: 4,
      state: "awaiting_approval",
    });

    expect(buildAgentInvocation(input({ task, context })).task.revision).toBe(
      5
    );
  });

  it("refuses a context that was written for another task, run or agent", () => {
    const task = implementing();
    const cases: readonly [Partial<AgentContext>, string][] = [
      [{ taskId: "other-task" }, "task `other-task`, not `add-login`"],
      [{ runId: "run-0" }, "run `run-0`, not `run-1`"],
      [{ agentId: "cleaner" }, "agent `cleaner`, not `coder`"],
    ];

    for (const [overrides, expected] of cases) {
      const error = refused({ task, context: contextFor(task, overrides) });

      expect(error.kind).toBe("invalid-invocation");
      expect(error.details.join("\n")).toContain(expected);
    }
  });

  it("refuses a context built from any revision but the two this handoff spans", () => {
    const task = implementing();
    const cases: readonly Partial<AgentContext>[] = [
      // An earlier attempt, still at the same path.
      { taskRevision: 3, state: "implementing" },
      // The right revision paired with the wrong snapshot, either way round.
      { taskRevision: 4, state: "implementing" },
      { taskRevision: 5, state: "awaiting_approval" },
      { taskRevision: 5, state: "cleaning" },
    ];

    for (const overrides of cases) {
      const error = refused({ task, context: contextFor(task, overrides) });

      expect(error.kind).toBe("invalid-invocation");
      expect(error.details.join("\n")).toContain(
        `built from revision ${String(overrides.taskRevision)} in \`${String(overrides.state)}\`; this handoff was decided at revision 4 in \`awaiting_approval\` and produced revision 5 in \`implementing\``
      );
    }
  });

  it("holds a task whose history is missing to the snapshot it produced", () => {
    const task = implementing({ history: [] });

    expect(
      buildAgentInvocation(input({ task, context: contextFor(task) })).attempt
    ).toBe(2);

    const error = refused({
      task,
      context: contextFor(task, {
        taskRevision: 4,
        state: "awaiting_approval",
      }),
    });

    expect(error.details.join("\n")).toContain(
      "built from revision 4 in `awaiting_approval`; this handoff produced revision 5 in `implementing`"
    );
  });

  it("refuses a task whose recorded context path is not the one its run and agent name", () => {
    const task = implementing({
      contextPath: ".sailor/state/runs/run-0/agents/coder",
    });
    const error = refused({ task, context: contextFor(task) });

    expect(error.kind).toBe("invalid-invocation");
    expect(error.details.join("\n")).toContain(
      "`.sailor/state/runs/run-0/agents/coder`, not `.sailor/state/runs/run-1/agents/coder`"
    );
  });

  it("refuses a task that records no context at all", () => {
    const task = implementing({ contextPath: null });
    const error = refused({ task, context: contextFor(task) });

    expect(error.kind).toBe("invalid-invocation");
    expect(error.details.join("\n")).toContain("records no context path");
  });

  it("refuses a timeout that is not a positive whole number of milliseconds", () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN]) {
      expect(refused({ timeoutMs }).details.join("\n")).toContain(
        "timeout must be a positive whole number of milliseconds"
      );
    }
  });

  it("refuses a project root that is not absolute", () => {
    expect(refused({ projectRoot: "project" }).details.join("\n")).toContain(
      "project root must be absolute"
    );
  });

  it("reports every disagreement at once rather than the first", () => {
    const task = implementing({ contextPath: null });
    const error = refused({
      task,
      context: contextFor(task, { runId: "run-0", taskRevision: 1 }),
      timeoutMs: 0,
    });

    expect(error.details).toHaveLength(4);
  });
});

describe("recordAgentRun", () => {
  const invocation = (): AgentInvocation => buildAgentInvocation(input());

  it("collects the events in order and reports how the run ended", async () => {
    const seen: AgentEvent[] = [];
    const record = await recordAgentRun(
      replaying([started, output, finished]),
      invocation(),
      {
        onEvent: (event) => {
          seen.push(event);
        },
      }
    );

    expect(record.events).toEqual([started, output, finished]);
    expect(record.finished).toEqual(finished);
    expect(seen).toEqual([started, output, finished]);
  });

  it("passes the invocation through untouched", async () => {
    const received: AgentInvocation[] = [];
    const adapter: ProviderAdapter = {
      provider: "codex",
      invoke: async function* (request) {
        received.push(request);
        yield await Promise.resolve(started);
        yield finished;
      },
    };
    const request = invocation();

    await recordAgentRun(adapter, request);

    expect(received).toEqual([request]);
    expect(received[0]).toBe(request);
  });

  it("refuses a run that does not begin by starting", async () => {
    const error = await captureRejection(
      () =>
        recordAgentRun(replaying([output, started, finished]), invocation()),
      ProviderProtocolError
    );

    expect(error.provider).toBe("claude");
    expect(error.message).toContain("first event was `output`, not `started`");
  });

  it("refuses a run that starts twice", async () => {
    const error = await captureRejection(
      () =>
        recordAgentRun(replaying([started, started, finished]), invocation()),
      ProviderProtocolError
    );

    expect(error.message).toContain("started twice");
  });

  it("refuses a run that goes on after finishing", async () => {
    const error = await captureRejection(
      () =>
        recordAgentRun(replaying([started, finished, output]), invocation()),
      ProviderProtocolError
    );

    expect(error.message).toContain("`output` after `finished`");
  });

  it("refuses a run that ends without finishing", async () => {
    const error = await captureRejection(
      () => recordAgentRun(replaying([started, output]), invocation()),
      ProviderProtocolError
    );

    expect(error.message).toContain("ended without a `finished` event");
  });

  it("refuses an event that is not one, naming what was wrong with it", async () => {
    const error = await captureRejection(
      () =>
        recordAgentRun(
          replaying([started, { kind: "thought", at: AT }, finished]),
          invocation()
        ),
      ProviderProtocolError
    );

    expect(error.message).toContain(
      "reported something that is not an agent event"
    );
    expect(error.message).toContain("kind");
  });

  it("lets an adapter's own failure through rather than recording a run that never finished", async () => {
    const failing: ProviderAdapter = {
      provider: "claude",
      invoke: async function* () {
        yield await Promise.resolve(started);
        throw new Error("claude is not installed");
      },
    };

    await expect(recordAgentRun(failing, invocation())).rejects.toThrow(
      "claude is not installed"
    );
  });
});
