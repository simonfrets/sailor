import {
  AGENT_EVENT_KINDS,
  AGENT_STATUSES,
  OUTPUT_STREAMS,
  agentEventSchema,
  agentStatusOfCommandResult,
  finishedEventOf,
} from "../../../src/providers/agent-event.js";
import type { AgentStatus } from "../../../src/providers/agent-event.js";
import { EMPTY_COMMAND_OUTPUT } from "../../../src/processes/command-runner.js";
import type {
  CommandResult,
  CommandSpec,
} from "../../../src/processes/command-runner.js";

const AT = "2026-08-28T12:00:00.000Z";
const COMMAND: CommandSpec = { executable: "claude", args: ["--print"] };

const base = {
  command: COMMAND,
  output: EMPTY_COMMAND_OUTPUT,
  startedAt: AT,
  durationMs: 1_500,
};

const exited = (exitCode: number): CommandResult => ({
  ...base,
  outcome: "exited",
  exitCode,
});

describe("agent event vocabulary", () => {
  it("names the events an adapter reports and the statuses a run ends in", () => {
    expect([...AGENT_EVENT_KINDS]).toEqual([
      "started",
      "output",
      "tool-action",
      "finished",
    ]);
    expect([...AGENT_STATUSES]).toEqual([
      "completed",
      "failed",
      "timed-out",
      "aborted",
    ]);
    expect([...OUTPUT_STREAMS]).toEqual(["stdout", "stderr"]);
  });

  it("keeps the kind list and the schema's discriminator in step", () => {
    expect(
      agentEventSchema.options.map((option) => option.shape.kind.value)
    ).toEqual([...AGENT_EVENT_KINDS]);
  });

  it("validates each event shape", () => {
    const events = [
      { kind: "started", at: AT, command: COMMAND },
      { kind: "started", at: AT, command: null },
      { kind: "output", at: AT, stream: "stdout", text: "hello\n" },
      { kind: "output", at: AT, stream: "stderr", text: "" },
      {
        kind: "tool-action",
        at: AT,
        action: { kind: "write", path: "src/a.ts" },
        decision: {
          verdict: "allowed",
          reason: "`src/a.ts` is within the write scope `src/**`",
        },
      },
      {
        kind: "finished",
        at: AT,
        status: "completed",
        detail: "exited with code 0",
        exitCode: 0,
        durationMs: 1_500,
      },
      {
        kind: "finished",
        at: AT,
        status: "timed-out",
        detail: "timed out after 10ms",
        exitCode: null,
        durationMs: 10,
      },
    ];

    for (const event of events) {
      expect(agentEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("refuses an event it does not know, a field it does not know, and a status it does not know", () => {
    const rejected = [
      { kind: "thought", at: AT, text: "hmm" },
      { kind: "started", at: AT, command: null, pid: 42 },
      { kind: "started", at: "yesterday", command: null },
      { kind: "output", at: AT, stream: "stdin", text: "" },
      {
        kind: "tool-action",
        at: AT,
        action: { kind: "write", path: "src/a.ts" },
      },
      {
        kind: "finished",
        at: AT,
        status: "crashed",
        detail: "x",
        exitCode: null,
        durationMs: 1,
      },
      {
        kind: "finished",
        at: AT,
        status: "failed",
        detail: "",
        exitCode: 1,
        durationMs: 1,
      },
      {
        kind: "finished",
        at: AT,
        status: "failed",
        detail: "x",
        exitCode: 1,
        durationMs: -1,
      },
    ];

    for (const event of rejected) {
      expect(agentEventSchema.safeParse(event).success).toBe(false);
    }
  });
});

describe("agentStatusOfCommandResult", () => {
  const cases: readonly [string, CommandResult, AgentStatus][] = [
    ["a clean exit", exited(0), "completed"],
    ["a non-zero exit", exited(2), "failed"],
    ["a signal", { ...base, outcome: "signaled", signal: "SIGKILL" }, "failed"],
    [
      "a timeout",
      { ...base, outcome: "timed-out", timeoutMs: 10, forceKilled: false },
      "timed-out",
    ],
    [
      "a spawn failure",
      {
        ...base,
        outcome: "spawn-failed",
        errorCode: "ENOENT",
        message: "spawn claude ENOENT",
      },
      "failed",
    ],
  ];

  it.each(cases)("reads %s as a status", (_label, result, status) => {
    expect(agentStatusOfCommandResult(result)).toBe(status);
  });
});

describe("finishedEventOf", () => {
  it("records what the process did, in the words the gate runner uses", () => {
    expect(finishedEventOf(exited(3), AT)).toEqual({
      kind: "finished",
      at: AT,
      status: "failed",
      detail: "exited with code 3",
      exitCode: 3,
      durationMs: 1_500,
    });
  });

  it("reports a run that was cut short by the caller as aborted", () => {
    const controller = new AbortController();

    controller.abort();

    expect(
      finishedEventOf(
        { ...base, outcome: "signaled", signal: "SIGTERM" },
        AT,
        controller.signal
      ).status
    ).toBe("aborted");
  });

  it("does not call a run that finished cleanly aborted, whatever the signal says", () => {
    const controller = new AbortController();

    controller.abort();

    expect(finishedEventOf(exited(0), AT, controller.signal).status).toBe(
      "completed"
    );
    expect(
      finishedEventOf(exited(1), AT, new AbortController().signal).status
    ).toBe("failed");
  });
});
