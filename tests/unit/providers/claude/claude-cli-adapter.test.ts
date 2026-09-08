import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentDefinition } from "../../../../src/agents/agent-definition.js";
import { SailorError } from "../../../../src/sailor/sailor-error.js";
import type {
  CommandRequest,
  CommandSpec,
} from "../../../../src/processes/command-runner.js";
import type { AgentEvent } from "../../../../src/providers/agent-event.js";
import {
  CLAUDE_PRINT_FLAGS,
  CLAUDE_TOOL_GATE_MATCHER,
  DEFAULT_CLAUDE_MODELS,
  buildClaudeCommand,
  buildClaudePrompt,
  claudeRunFiles,
  claudeToolGateCommand,
  createClaudeCliAdapter,
  quoteForPosixShell,
} from "../../../../src/providers/claude/claude-cli-adapter.js";
import {
  CLAUDE_GATE_ENVIRONMENT_VARIABLE,
  appendClaudeGateRecord,
  parseClaudeGateConfig,
} from "../../../../src/providers/claude/tool-gate.js";
import type { ClaudeGateRecord } from "../../../../src/providers/claude/tool-gate.js";
import {
  buildAgentInvocation,
  recordAgentRun,
} from "../../../../src/providers/provider-adapter.js";
import type { AgentInvocation } from "../../../../src/providers/provider-adapter.js";
import { buildAgentContext } from "../../../../src/tasks/agent-context.js";
import type { Task } from "../../../../src/tasks/task-schema.js";
import {
  captureError,
  captureRejection,
} from "../../../helpers/expect-error.js";
import {
  createFakeCommandRunner,
  exited,
  signaled,
  timedOut,
} from "../../../helpers/fake-command-runner.js";
import type { PlannedCommandResult } from "../../../helpers/fake-command-runner.js";
import {
  RULE_SET_SHA256,
  buildTask,
  buildTransition,
} from "../../../helpers/tasks.js";
import {
  createTempDirectory,
  removeTempDirectories,
} from "../../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const AT = "2026-09-07T12:00:00.000Z";
const CONTEXT_PATH = ".sailor/state/runs/run-1/agents/coder";

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

const architect: AgentDefinition = {
  version: 1,
  id: "architect",
  displayName: "Architect",
  summary: "Reviews the structure",
  modelProfile: "reasoning-high",
  tools: { read: true, search: true, edit: false, execute: false },
  writeScopes: [],
  projectScripts: [],
};

const TOOL_GATE: CommandSpec = {
  executable: "/usr/local/bin/node",
  args: ["/pkg/dist/providers/claude/tool-gate-main.js"],
};

const taskFor = (definition: AgentDefinition): Task =>
  buildTask({
    state: definition.id === "coder" ? "implementing" : "architecture_review",
    agentId: definition.id,
    revision: 5,
    runId: "run-1",
    approvedAt: "2026-09-07T11:00:00.000Z",
    approvedBy: "a-reviewer",
    contextPath: `.sailor/state/runs/run-1/agents/${definition.id}`,
    history: [
      buildTransition({
        revision: 5,
        expectedRevision: 4,
        from: definition.id === "coder" ? "awaiting_approval" : "cleaning",
        to: definition.id === "coder" ? "implementing" : "architecture_review",
        fromAgent: definition.id === "coder" ? null : "cleaner",
        toAgent: definition.id,
        contextPath: `.sailor/state/runs/run-1/agents/${definition.id}`,
      }),
    ],
  });

const invocationFor = (
  projectRoot: string,
  definition: AgentDefinition = coder,
  signal: AbortSignal = new AbortController().signal
): AgentInvocation => {
  const task = taskFor(definition);

  return buildAgentInvocation({
    projectRoot,
    task,
    context: buildAgentContext({
      task,
      definition,
      policy: `# Agent policy: ${definition.id}\n\nRule set revision 3.\n`,
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
    modelProfile: definition.modelProfile,
    packageManager: "npm",
    timeoutMs: 600_000,
    signal,
  });
};

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

const assistant = (...content: unknown[]): string =>
  line({ type: "assistant", message: { role: "assistant", content } });

const toolUse = (id: string, name: string, input: unknown): unknown => ({
  type: "tool_use",
  id,
  name,
  input,
});

const toolResult = (id: string, isError = false): string =>
  line({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, is_error: isError }],
    },
  });

const init = line({ type: "system", subtype: "init", tools: ["Read"] });
const result = line({ type: "result", subtype: "success", is_error: false });

interface Script {
  /** Written into the gate's log before the stream is replayed, as the hook would. */
  readonly decisions?: readonly Omit<ClaudeGateRecord, "version" | "at">[];
  readonly stdout?: readonly (string | Buffer)[];
  readonly stderr?: readonly string[];
  readonly result?: PlannedCommandResult;
}

/**
 * A runner that plays the CLI: appends the decisions the hook would have
 * made, streams the lines the CLI would have printed, and exits as told.
 */
const scripted = (script: Script) =>
  createFakeCommandRunner((request: CommandRequest) => {
    const gate = parseClaudeGateConfig(
      request.env?.[CLAUDE_GATE_ENVIRONMENT_VARIABLE] ?? "{}"
    );

    for (const decision of script.decisions ?? []) {
      appendClaudeGateRecord(gate.log, { version: 1, at: AT, ...decision });
    }

    for (const text of script.stdout ?? []) {
      request.onOutput?.(
        "stdout",
        Buffer.isBuffer(text) ? text : Buffer.from(text)
      );
    }

    for (const text of script.stderr ?? []) {
      request.onOutput?.("stderr", Buffer.from(text));
    }

    return script.result ?? exited(0);
  });

const run = async (
  script: Script,
  definition: AgentDefinition = coder,
  signal?: AbortSignal
): Promise<{
  readonly events: readonly AgentEvent[];
  readonly requests: readonly CommandRequest[];
  readonly projectRoot: string;
}> => {
  const projectRoot = createTempDirectory("sailor-claude-adapter-");
  const runner = scripted(script);
  const adapter = createClaudeCliAdapter({
    runner: runner.run,
    toolGate: TOOL_GATE,
    now: () => new Date(AT),
  });
  const record = await recordAgentRun(
    adapter,
    invocationFor(projectRoot, definition, signal)
  );

  return { events: record.events, requests: runner.requests, projectRoot };
};

const readDecision: Omit<ClaudeGateRecord, "version" | "at"> = {
  toolUseId: "toolu_1",
  toolName: "Read",
  action: { kind: "read", path: "docs/specs/add-login.md" },
  decision: {
    verdict: "allowed",
    reason: "reading `docs/specs/add-login.md` is permitted",
  },
};

const bashDecision: Omit<ClaudeGateRecord, "version" | "at"> = {
  toolUseId: "toolu_2",
  toolName: "Bash",
  action: {
    kind: "execute",
    command: { executable: "sh", args: ["-c", "rm -rf /"] },
  },
  decision: {
    verdict: "denied",
    denial: "not-a-project-script",
    reason: "`sh -c rm -rf /` is not a project script run through `npm`",
  },
};

describe("buildClaudeCommand", () => {
  it("runs the CLI the way its --help documents a governed, non-interactive session", () => {
    const projectRoot = createTempDirectory("sailor-claude-command-");
    const invocation = invocationFor(projectRoot);
    const command = buildClaudeCommand({
      invocation,
      claude: { executable: "claude", args: [] },
      toolGate: TOOL_GATE,
      models: DEFAULT_CLAUDE_MODELS,
      maxBudgetUsd: null,
    });
    const prompt = buildClaudePrompt(invocation);

    expect(command.executable).toBe("claude");
    expect(command.args).toEqual([
      ...CLAUDE_PRINT_FLAGS,
      "--tools",
      "Read,Glob,Grep,Edit,Write,NotebookEdit,Bash",
      "--model",
      "opus",
      "--settings",
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: CLAUDE_TOOL_GATE_MATCHER,
              hooks: [
                {
                  type: "command",
                  command:
                    "'/usr/local/bin/node' '/pkg/dist/providers/claude/tool-gate-main.js'",
                },
              ],
            },
          ],
        },
      }),
      "--append-system-prompt",
      prompt.systemPrompt,
      "--",
      prompt.prompt,
    ]);
    expect(CLAUDE_PRINT_FLAGS).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--restricted",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--permission-prompts",
      "none",
    ]);
  });

  it("withholds Bash from an agent that may not execute, picks its model from its profile, and caps the spend when asked", () => {
    const projectRoot = createTempDirectory("sailor-claude-command-");
    const command = buildClaudeCommand({
      invocation: invocationFor(projectRoot, architect),
      claude: { executable: "/opt/claude/bin/claude", args: ["--debug"] },
      toolGate: TOOL_GATE,
      models: { ...DEFAULT_CLAUDE_MODELS, "reasoning-high": "claude-fable-5" },
      maxBudgetUsd: 2.5,
    });
    const args = [...command.args];

    expect(command.executable).toBe("/opt/claude/bin/claude");
    expect(args[0]).toBe("--debug");
    expect(args[args.indexOf("--tools") + 1]).toBe(
      "Read,Glob,Grep,Edit,Write,NotebookEdit"
    );
    expect(args[args.indexOf("--model") + 1]).toBe("claude-fable-5");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("2.5");
    expect(args.indexOf("--max-budget-usd")).toBeLessThan(args.indexOf("--"));
  });

  it("maps every logical profile to an alias `claude --help` documents", () => {
    expect(DEFAULT_CLAUDE_MODELS).toEqual({
      "coding-high": "opus",
      "reasoning-high": "opus",
      verification: "sonnet",
    });
  });
});

describe("buildClaudePrompt", () => {
  it("puts the compiled policy and the enforced tool policy in the system prompt", () => {
    const projectRoot = createTempDirectory("sailor-claude-prompt-");
    const { systemPrompt } = buildClaudePrompt(invocationFor(projectRoot));

    expect(systemPrompt).toContain("You are Coder, the `coder` agent");
    expect(systemPrompt).toContain("# Agent policy: coder");
    expect(systemPrompt).toContain("Rule set revision 3.");
    expect(systemPrompt).toContain("`src/**`, `tests/**`");
    expect(systemPrompt).toContain("`npm run lint`, `npm run test`");
    expect(systemPrompt).toContain("`.sailor/state/runs/run-1/agents/coder`");
    expect(systemPrompt).toContain("`context.json`");
    expect(systemPrompt).toContain("A refused call did not happen");
  });

  it("tells an agent that may not edit or execute exactly that", () => {
    const projectRoot = createTempDirectory("sailor-claude-prompt-");
    const { systemPrompt } = buildClaudePrompt(
      invocationFor(projectRoot, architect)
    );

    expect(systemPrompt).toContain("You are Architect, the `architect` agent");
    expect(systemPrompt).toContain("Edit project files: no.");
    expect(systemPrompt).toContain("Run commands: no.");
    expect(systemPrompt).not.toContain("npm run");
  });

  it("says what the agent is for, in its definition's own words", () => {
    // Without this the prompt names the id and nothing else, so an agent is
    // told which policy it runs under and never what the stage is for.
    const projectRoot = createTempDirectory("sailor-claude-prompt-");

    expect(
      buildClaudePrompt(invocationFor(projectRoot)).systemPrompt
    ).toContain("Implements the specification");
    expect(
      buildClaudePrompt(invocationFor(projectRoot, architect)).systemPrompt
    ).toContain("Reviews the structure");
  });

  it("puts the task, the stage, the attempt and the handoff in the prompt", () => {
    const projectRoot = createTempDirectory("sailor-claude-prompt-");
    const { prompt } = buildClaudePrompt(invocationFor(projectRoot));

    expect(prompt).toContain("# Task `add-login`: Add login");
    expect(prompt).toContain("Stage `implementing`, attempt 2, run `run-1`.");
    expect(prompt).toContain("From `specifier` in `awaiting_approval`.");
    expect(prompt).toContain("`docs/specs/add-login.md`");
    expect(prompt).toContain("`report-1`");
    expect(prompt).toContain(
      "`.sailor/state/runs/run-1/agents/coder/context.json`"
    );
    expect(prompt).not.toContain("Failure");
  });

  it("says what failed when the context resumes an interruption", () => {
    const projectRoot = createTempDirectory("sailor-claude-prompt-");
    const task = taskFor(coder);
    const invocation = buildAgentInvocation({
      projectRoot,
      task,
      context: buildAgentContext({
        task,
        definition: coder,
        policy: "# Agent policy: coder\n",
        ruleSetSha256: RULE_SET_SHA256,
        at: new Date(AT),
        attempt: 3,
        handoff: {
          fromAgent: null,
          fromState: "failed",
          gateReportIds: [],
          artifactPaths: [],
          failure: { reason: "the tests timed out", details: ["jest hung"] },
        },
      }),
      modelProfile: "coding-high",
      packageManager: "npm",
      timeoutMs: 1000,
      signal: new AbortController().signal,
    });
    const { prompt } = buildClaudePrompt(invocation);

    expect(prompt).toContain("attempt 3");
    expect(prompt).toContain("Failure: the tests timed out");
    expect(prompt).toContain("  - jest hung");
    expect(prompt).toContain("Nothing preceded this agent in the run.");
  });
});

describe("the Claude CLI adapter", () => {
  it("reports the run as the events the contract fixes, in the order the CLI produced them", async () => {
    const { events, requests, projectRoot } = await run({
      decisions: [readDecision, bashDecision],
      stdout: [
        init,
        assistant({ type: "text", text: "Reading the spec." }),
        assistant(
          toolUse("toolu_1", "Read", { file_path: "docs/specs/add-login.md" })
        ),
        toolResult("toolu_1"),
        assistant(toolUse("toolu_2", "Bash", { command: "rm -rf /" })),
        toolResult("toolu_2", true),
        assistant({ type: "text", text: "Done." }),
        result,
      ],
    });
    const [request] = requests;

    expect(events).toEqual([
      { kind: "started", at: AT, command: request?.command },
      { kind: "output", at: AT, stream: "stdout", text: "Reading the spec." },
      {
        kind: "tool-action",
        at: AT,
        action: readDecision.action,
        decision: readDecision.decision,
      },
      {
        kind: "tool-action",
        at: AT,
        action: bashDecision.action,
        decision: bashDecision.decision,
      },
      { kind: "output", at: AT, stream: "stdout", text: "Done." },
      {
        kind: "finished",
        at: AT,
        status: "completed",
        detail: "exited with code 0",
        exitCode: 0,
        durationMs: 1,
      },
    ]);
    expect(request?.cwd).toBe(projectRoot);
    expect(request?.timeoutMs).toBe(600_000);
  });

  it("hands the gate its policy, its log and the project root through the environment, and nothing else", async () => {
    const { requests, projectRoot } = await run({ stdout: [init, result] });
    const [request] = requests;
    const gate = parseClaudeGateConfig(
      request?.env?.[CLAUDE_GATE_ENVIRONMENT_VARIABLE] ?? ""
    );
    const files = claudeRunFiles(projectRoot, "run-1", "coder", 2);

    expect(Object.keys(request?.env ?? {})).toEqual([
      CLAUDE_GATE_ENVIRONMENT_VARIABLE,
    ]);
    expect(gate).toEqual({
      version: 1,
      projectRoot,
      policy: {
        tools: coder.tools,
        writeScopes: coder.writeScopes,
        projectScripts: coder.projectScripts,
        contextDirectory: CONTEXT_PATH,
        packageManager: "npm",
      },
      log: files.decisionLog,
    });
    expect(files.decisionLog).toBe(
      join(
        projectRoot,
        ".sailor/state/runs/run-1/claude/coder/attempt-2.decisions.jsonl"
      )
    );
  });

  it("passes the invocation's signal to the runner, and reports a run it cut short as aborted", async () => {
    const controller = new AbortController();

    controller.abort();

    const { events, requests } = await run(
      { stdout: [init], result: signaled("SIGTERM") },
      coder,
      controller.signal
    );

    expect(requests[0]?.signal).toBe(controller.signal);
    expect(events.at(-1)).toMatchObject({
      kind: "finished",
      status: "aborted",
      detail: "terminated by SIGTERM",
    });
  });

  it("reports a failing exit and a timeout as what they were", async () => {
    const failed = await run({ stdout: [init], result: exited(1) });
    const late = await run({ stdout: [init], result: timedOut(600_000) });

    expect(failed.events.at(-1)).toMatchObject({
      kind: "finished",
      status: "failed",
      exitCode: 1,
    });
    expect(late.events.at(-1)).toMatchObject({
      kind: "finished",
      status: "timed-out",
      exitCode: null,
    });
  });

  it("reports the CLI's stderr, an unreadable stdout line and an error result as output rather than losing them", async () => {
    const { events } = await run({
      stdout: [
        "not json at all\n",
        line({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "Not logged in",
        }),
      ],
      stderr: ["[claude-code:unrecognized_model] x\n"],
      result: exited(1),
    });

    expect(events.slice(1, -1)).toEqual([
      { kind: "output", at: AT, stream: "stdout", text: "not json at all" },
      {
        kind: "output",
        at: AT,
        stream: "stdout",
        text: "error_during_execution: Not logged in",
      },
      {
        kind: "output",
        at: AT,
        stream: "stderr",
        text: "[claude-code:unrecognized_model] x",
      },
    ]);
  });

  it("assembles a line the CLI wrote in pieces before reading it", async () => {
    const text = assistant({ type: "text", text: "split \u{1F600} line" });
    const bytes = Buffer.from(text);
    const { events } = await run({
      stdout: [bytes.subarray(0, 40), bytes.subarray(40)],
    });

    expect(events).toEqual([
      expect.objectContaining({ kind: "started" }),
      {
        kind: "output",
        at: AT,
        stream: "stdout",
        text: "split \u{1F600} line",
      },
      expect.objectContaining({ kind: "finished" }),
    ]);
  });

  it("still reports a decision whose result never came back, when the CLI died first", async () => {
    const { events } = await run({
      decisions: [readDecision],
      stdout: [
        init,
        assistant(
          toolUse("toolu_1", "Read", { file_path: "docs/specs/add-login.md" })
        ),
      ],
      result: signaled("SIGKILL"),
    });

    expect(events.map((event) => event.kind)).toEqual([
      "started",
      "tool-action",
      "finished",
    ]);
  });

  it("refuses a run in which a tool was used without the gate deciding it", async () => {
    const error = await captureRejection(
      () =>
        run({
          decisions: [readDecision],
          stdout: [
            init,
            assistant(
              toolUse("toolu_1", "Read", {
                file_path: "docs/specs/add-login.md",
              })
            ),
            toolResult("toolu_1"),
            assistant(toolUse("toolu_9", "Write", { file_path: "x" })),
            toolResult("toolu_9"),
            result,
          ],
        }),
      SailorError
    );

    expect(error.kind).toBe("tool-gate-failed");
    expect(error.message).toContain("toolu_9");
    expect(error.message).toContain("`Write`");
    expect(error.message).toContain(
      "the CLI ran a tool without consulting the gate"
    );
  });

  it("writes the transcript beside the decisions, as the CLI printed it", async () => {
    const stdout = [init, assistant({ type: "text", text: "hi" }), result];
    const { projectRoot } = await run({ stdout });
    const files = claudeRunFiles(projectRoot, "run-1", "coder", 2);

    expect(readFileSync(files.transcript, "utf8")).toBe(stdout.join(""));
    expect(files.transcript).toBe(
      join(files.directory, "attempt-2.transcript.jsonl")
    );
  });

  it("starts each attempt from an empty log and transcript", async () => {
    const projectRoot = createTempDirectory("sailor-claude-adapter-");
    const files = claudeRunFiles(projectRoot, "run-1", "coder", 2);
    const adapter = createClaudeCliAdapter({
      runner: scripted({
        decisions: [readDecision],
        stdout: [
          init,
          assistant(
            toolUse("toolu_1", "Read", { file_path: "docs/specs/add-login.md" })
          ),
          toolResult("toolu_1"),
          result,
        ],
      }).run,
      toolGate: TOOL_GATE,
      now: () => new Date(AT),
    });

    await recordAgentRun(adapter, invocationFor(projectRoot));

    const first = readFileSync(files.decisionLog, "utf8");

    await recordAgentRun(adapter, invocationFor(projectRoot));

    expect(readFileSync(files.decisionLog, "utf8")).toBe(first);
    expect(existsSync(files.transcript)).toBe(true);
  });

  it("names its provider", () => {
    expect(
      createClaudeCliAdapter({ runner: scripted({}).run, toolGate: TOOL_GATE })
        .provider
    ).toBe("claude");
  });
});

describe("the adapter's own failures", () => {
  it("refuses a spending cap that is not a positive amount", () => {
    for (const maxBudgetUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = captureError(
        () =>
          createClaudeCliAdapter({
            runner: scripted({}).run,
            toolGate: TOOL_GATE,
            maxBudgetUsd,
          }),
        SailorError
      );

      expect(error.kind).toBe("invalid-config");
    }
  });

  it("reports a decision the transcript never mentioned, when the transcript was cut before the tool use was printed", async () => {
    const { events } = await run({
      decisions: [readDecision],
      stdout: [init, assistant({ type: "text", text: "partial" })],
      result: signaled("SIGKILL"),
    });

    expect(events.map((event) => event.kind)).toEqual([
      "started",
      "output",
      "tool-action",
      "finished",
    ]);
  });

  it("lets a runner that breaks its contract and rejects through, rather than recording a run", async () => {
    const projectRoot = createTempDirectory("sailor-claude-adapter-");
    const adapter = createClaudeCliAdapter({
      runner: () => Promise.reject(new Error("the runner broke")),
      toolGate: TOOL_GATE,
    });

    await expect(
      recordAgentRun(adapter, invocationFor(projectRoot))
    ).rejects.toThrow("the runner broke");
  });
});

describe("the hook command line", () => {
  it("quotes each word for a POSIX shell, so a path with a quote or a space survives `sh -c`", () => {
    expect(quoteForPosixShell("plain")).toBe("'plain'");
    expect(quoteForPosixShell("has space")).toBe("'has space'");
    expect(quoteForPosixShell("it's")).toBe("'it'\\''s'");
    expect(quoteForPosixShell('$HOME `x` "y"')).toBe("'$HOME `x` \"y\"'");
  });

  it("names the built hook program under the package root", () => {
    expect(claudeToolGateCommand("/pkg", "/usr/bin/node")).toEqual({
      executable: "/usr/bin/node",
      args: ["/pkg/dist/providers/claude/tool-gate-main.js"],
    });
  });
});
