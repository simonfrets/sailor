import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join, posix } from "node:path";

import type { ModelProfile } from "../../agents/agent-definition.js";
import { buildPackageManagerCommand } from "../../gates/resolve-project-script.js";
import { SailorError } from "../../sailor/sailor-error.js";
import { SAILOR_DIRECTORY, SAILOR_PATHS } from "../../sailor/layout.js";
import { describeCommand } from "../../processes/command-runner.js";
import type {
  CommandRunner,
  CommandSpec,
} from "../../processes/command-runner.js";
import { AGENT_CONTEXT_FILE } from "../../tasks/agent-context.js";
import { finishedEventOf } from "../agent-event.js";
import type { AgentEvent } from "../agent-event.js";
import type { AgentInvocation, ProviderAdapter } from "../provider-adapter.js";
import { createLineSplitter, readClaudeStreamLine } from "./claude-stream.js";
import type { ClaudeStreamItem } from "./claude-stream.js";
import {
  CLAUDE_GATE_ENVIRONMENT_VARIABLE,
  CLAUDE_GATE_VERSION,
  CLAUDE_TOOL_GATE_BUILT,
  claudeToolsFor,
  readClaudeGateLog,
} from "./tool-gate.js";
import type { ClaudeGateConfig, ClaudeGateRecord } from "./tool-gate.js";

/**
 * The flags every governed session gets, in the words of `claude --help`
 * for version 2.1.263, which is what this adapter was written against.
 *
 * - `--print` runs one turn without a terminal; `--output-format
 *   stream-json` reports it as one JSON line per message, and `--verbose` is
 *   what the CLI demands before it will do that in print mode.
 * - `--no-session-persistence` keeps the run out of the user's `~/.claude`
 *   session store: the transcript the sailor keeps is the record.
 * - `--restricted` confines the file tools to the working directory, removes
 *   the tools that run code unless `--tools` names them, refuses
 *   `bypassPermissions`, and ignores the user's, the project's and the local
 *   settings files while still applying `--settings` - which is where the
 *   gate is configured. `--strict-mcp-config` with no MCP configuration
 *   leaves no MCP server, and `--disable-slash-commands` no skill.
 * - `--permission-prompts none` says nobody will answer a prompt: whatever
 *   would have asked is denied unless the gate allowed it first.
 *
 * `--bare` was considered and rejected: it also restricts authentication to
 * an API key, which the CLI on a developer's machine does not have.
 */
export const CLAUDE_PRINT_FLAGS = [
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
] as const;

/** The hook matcher the hooks reference documents as "every tool". */
export const CLAUDE_TOOL_GATE_MATCHER = "*";

/**
 * The model each logical profile runs on, as the aliases `claude --help`
 * documents (`fable`, `opus`, `sonnet`). A project overrides this through the
 * adapter's options; `config/models.yaml` is where the design eventually
 * puts it, and is not written yet.
 */
export const DEFAULT_CLAUDE_MODELS: Readonly<Record<ModelProfile, string>> = {
  "coding-high": "opus",
  "reasoning-high": "opus",
  verification: "sonnet",
};

export const DEFAULT_CLAUDE_COMMAND: CommandSpec = {
  executable: "claude",
  args: [],
};

/**
 * Quotes one word for `sh -c`.
 *
 * The CLI runs a hook command through a shell, so the one shell string in
 * this package is built here, from an argument vector, by the only quoting
 * a POSIX shell cannot misread: single quotes, with an embedded single quote
 * spelled `'\''`.
 */
export const quoteForPosixShell = (value: string): string =>
  `'${value.replace(/'/g, "'\\''")}'`;

/** The hook program of an installed package, run by an explicit node. */
export const claudeToolGateCommand = (
  packageRootDirectory: string,
  nodeExecutable: string
): CommandSpec => ({
  executable: nodeExecutable,
  args: [join(packageRootDirectory, ...CLAUDE_TOOL_GATE_BUILT.split("/"))],
});

/**
 * Where the adapter keeps what the CLI produced for one agent of one run,
 * beside the agent's own directory rather than inside it. The agent may
 * write to its scratch directory; it may not write here, because this is
 * the record of what it did.
 */
export const claudeRunDirectory = (runId: string, agentId: string): string =>
  posix.join(
    SAILOR_DIRECTORY,
    ...SAILOR_PATHS.runs.split(/[\\/]/),
    runId,
    "claude",
    agentId
  );

export interface ClaudeRunFiles {
  readonly directory: string;
  /** Every gate decision, one JSON line each, in the order they were made. */
  readonly decisionLog: string;
  /** The CLI's stdout, verbatim, one `stream-json` message per line. */
  readonly transcript: string;
}

/** Absolute paths for one attempt. A retry within a run does not overwrite the attempt before it. */
export const claudeRunFiles = (
  projectRoot: string,
  runId: string,
  agentId: string,
  attempt: number
): ClaudeRunFiles => {
  const directory = join(
    projectRoot,
    ...claudeRunDirectory(runId, agentId).split(posix.sep)
  );
  const prefix = `attempt-${String(attempt)}`;

  return {
    directory,
    decisionLog: join(directory, `${prefix}.decisions.jsonl`),
    transcript: join(directory, `${prefix}.transcript.jsonl`),
  };
};

export interface ClaudePrompt {
  /** Appended to the CLI's own system prompt. */
  readonly systemPrompt: string;
  /** The turn the agent is given. */
  readonly prompt: string;
}

const code = (text: string): string => `\`${text}\``;

const codeList = (items: readonly string[]): string =>
  items.map(code).join(", ");

const yesNo = (value: boolean): string => (value ? "yes" : "no");

/**
 * What the agent is told.
 *
 * The system prompt carries the compiled policy and a plain statement of the
 * tool policy. The statement is not the enforcement - the gate is - but an
 * agent that knows the rule spends its turns on the work rather than on
 * refusals. The prompt carries the task, the stage, the attempt and the
 * handoff, and points at the context file for the rest, so the prompt says
 * nothing the context does not already record.
 */
export const buildClaudePrompt = (
  invocation: AgentInvocation
): ClaudePrompt => {
  const { agentId, task, toolPolicy, handoff } = invocation;
  const scripts = toolPolicy.projectScripts.map((script) =>
    describeCommand(
      buildPackageManagerCommand(toolPolicy.packageManager, script, [])
    )
  );

  const systemPrompt = [
    `You are the ${code(agentId)} agent of a sailor that governs this repository.`,
    "",
    "The policy below is compiled from the project's rules. The sailor enforces it: every tool call is checked before it runs, and a call outside the policy is refused with the reason. A refused call did not happen; do not retry it or work around it.",
    "",
    invocation.policy.trimEnd(),
    "",
    "## What you may do",
    "",
    `- Read project files: ${yesNo(toolPolicy.tools.read)}. Search the project: ${yesNo(toolPolicy.tools.search)}.`,
    toolPolicy.tools.edit
      ? `- Edit project files: only under ${codeList(toolPolicy.writeScopes)}.`
      : "- Edit project files: no.",
    `- Your scratch directory is ${code(toolPolicy.contextDirectory)}. You may write notes and findings there, but never its ${code(AGENT_CONTEXT_FILE)}.`,
    toolPolicy.tools.execute
      ? `- Run commands: only the project scripts ${codeList(scripts)}. Nothing else runs.`
      : "- Run commands: no.",
    "",
  ].join("\n");

  const fromAgent = handoff?.fromAgent ?? null;
  const handoffLines =
    handoff === null || fromAgent === null
      ? ["Nothing preceded this agent in the run."]
      : [`From ${code(fromAgent)} in ${code(handoff.fromState)}.`];

  if (handoff !== null) {
    if (handoff.artifactPaths.length > 0) {
      handoffLines.push(`Artifacts: ${codeList(handoff.artifactPaths)}.`);
    }

    if (handoff.gateReportIds.length > 0) {
      handoffLines.push(`Gate reports: ${codeList(handoff.gateReportIds)}.`);
    }

    if (handoff.failure !== null) {
      handoffLines.push(
        `Failure: ${handoff.failure.reason}`,
        ...handoff.failure.details.map((detail) => `  - ${detail}`)
      );
    }
  }

  const prompt = [
    `# Task ${code(task.id)}: ${task.title}`,
    "",
    `Stage ${code(task.state)}, attempt ${String(invocation.attempt)}, run ${code(task.runId)}.`,
    "",
    "## Handoff",
    "",
    ...handoffLines,
    "",
    "## Context",
    "",
    `Your context is ${code(posix.join(invocation.contextPath, AGENT_CONTEXT_FILE))}. Read it first: it carries the task, the rule-set hash and what the previous agent left behind.`,
    "",
    `Do the work this stage asks of the ${code(agentId)} agent. When you are done, stop and summarise what you changed and what remains.`,
    "",
  ].join("\n");

  return { systemPrompt, prompt };
};

export interface BuildClaudeCommandInput {
  readonly invocation: AgentInvocation;
  readonly claude: CommandSpec;
  readonly toolGate: CommandSpec;
  readonly models: Readonly<Record<ModelProfile, string>>;
  readonly maxBudgetUsd: number | null;
}

/**
 * The command line for one invocation. Pure, so a test can hold the exact
 * vector to what `--help` documents without starting anything.
 *
 * The gate is installed through `--settings` as a `PreToolUse` hook on every
 * tool. The hook command is the one shell string in the package, built from
 * an argument vector by `quoteForPosixShell`. The prompt follows `--`, so a
 * prompt beginning with a dash is a prompt and not an option, and so the
 * variadic `--tools` cannot swallow it.
 */
export const buildClaudeCommand = (
  input: BuildClaudeCommandInput
): CommandSpec => {
  const { invocation } = input;
  const { systemPrompt, prompt } = buildClaudePrompt(invocation);
  const hookCommand = [input.toolGate.executable, ...input.toolGate.args]
    .map(quoteForPosixShell)
    .join(" ");
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: CLAUDE_TOOL_GATE_MATCHER,
          hooks: [{ type: "command", command: hookCommand }],
        },
      ],
    },
  };

  return {
    executable: input.claude.executable,
    args: [
      ...input.claude.args,
      ...CLAUDE_PRINT_FLAGS,
      "--tools",
      claudeToolsFor(invocation.toolPolicy).join(","),
      "--model",
      input.models[invocation.modelProfile],
      "--settings",
      JSON.stringify(settings),
      "--append-system-prompt",
      systemPrompt,
      ...(input.maxBudgetUsd === null
        ? []
        : ["--max-budget-usd", String(input.maxBudgetUsd)]),
      "--",
      prompt,
    ],
  };
};

export interface ClaudeCliAdapterOptions {
  readonly runner: CommandRunner;
  /** How to start the CLI. The default finds `claude` on `PATH`. */
  readonly claude?: CommandSpec;
  /** How the CLI runs the gate. See `claudeToolGateCommand`. */
  readonly toolGate: CommandSpec;
  readonly models?: Readonly<Record<ModelProfile, string>>;
  /** Passed as `--max-budget-usd`. Omit for no cap. */
  readonly maxBudgetUsd?: number;
  readonly now?: () => Date;
}

/** A queue one side fills as chunks arrive and the other drains as it yields. */
interface EventQueue {
  readonly push: (event: AgentEvent) => void;
  readonly close: () => void;
  readonly next: () => Promise<AgentEvent | undefined>;
}

const createEventQueue = (): EventQueue => {
  const events: AgentEvent[] = [];
  let closed = false;
  let wake: (() => void) | null = null;

  const notify = (): void => {
    const waiting = wake;

    wake = null;
    waiting?.();
  };

  return {
    push: (event) => {
      events.push(event);
      notify();
    },
    close: () => {
      closed = true;
      notify();
    },
    next: async () => {
      while (events.length === 0 && !closed) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }

      return events.shift();
    },
  };
};

interface SeenToolUse {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

const toolActionEvent = (record: ClaudeGateRecord): AgentEvent => ({
  kind: "tool-action",
  at: record.at,
  action: record.action,
  decision: record.decision,
});

/**
 * Invokes an agent through the Claude CLI.
 *
 * One process per invocation, run through the injected `CommandRunner` so
 * the timeout, the output cap, the environment allowlist and the abort
 * signal are the runner's. The CLI's stdout is read as it arrives and
 * reported as events; its stderr is reported as output; the gate's decisions
 * are read from the log the hook appends to and reported as `tool-action`s
 * when the CLI reports the tool's result, which is after the hook has
 * answered. The closing event is `finishedEventOf` the runner's result.
 *
 * A tool use the transcript shows and the log does not is refused as
 * `tool-gate-failed`. The session was configured to consult the gate for
 * every tool; a CLI that did not is one whose run the sailor cannot vouch
 * for, and the refusal is loud on purpose. An earlier attempt's log and
 * transcript are not kept: each attempt starts both empty.
 */
export const createClaudeCliAdapter = (
  options: ClaudeCliAdapterOptions
): ProviderAdapter => {
  const claude = options.claude ?? DEFAULT_CLAUDE_COMMAND;
  const models = options.models ?? DEFAULT_CLAUDE_MODELS;
  const maxBudgetUsd = options.maxBudgetUsd ?? null;
  const now = options.now ?? ((): Date => new Date());

  if (
    maxBudgetUsd !== null &&
    !(Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0)
  ) {
    throw new SailorError(
      "invalid-config",
      "the Claude adapter's spending cap must be a positive amount in USD"
    );
  }

  return {
    provider: "claude",
    invoke: async function* (invocation) {
      const files = claudeRunFiles(
        invocation.projectRoot,
        invocation.task.runId,
        invocation.agentId,
        invocation.attempt
      );
      const gate: ClaudeGateConfig = {
        version: CLAUDE_GATE_VERSION,
        projectRoot: invocation.projectRoot,
        policy: invocation.toolPolicy,
        log: files.decisionLog,
      };
      const command = buildClaudeCommand({
        invocation,
        claude,
        toolGate: options.toolGate,
        models,
        maxBudgetUsd,
      });

      mkdirSync(files.directory, { recursive: true });
      rmSync(files.decisionLog, { force: true });
      rmSync(files.transcript, { force: true });

      yield { kind: "started", at: now().toISOString(), command };

      const queue = createEventQueue();
      const stdoutLines = createLineSplitter();
      const stderrLines = createLineSplitter();
      const toolUses = new Map<string, SeenToolUse>();
      const reported = new Set<string>();
      let records = new Map<string, ClaudeGateRecord>();

      const recordFor = (id: string): ClaudeGateRecord | undefined => {
        if (!records.has(id)) {
          records = new Map(
            readClaudeGateLog(files.decisionLog).map((record) => [
              record.toolUseId,
              record,
            ])
          );
        }

        return records.get(id);
      };

      const output = (
        stream: "stdout" | "stderr",
        text: string
      ): AgentEvent => ({
        kind: "output",
        at: now().toISOString(),
        stream,
        text,
      });

      const eventsOf = (item: ClaudeStreamItem): AgentEvent[] => {
        switch (item.kind) {
          case "text":
            return [output("stdout", item.text)];
          case "unreadable":
            return [output("stdout", item.line)];
          case "tool-use":
            toolUses.set(item.id, { name: item.name, input: item.input });

            return [];
          case "tool-result": {
            const record = recordFor(item.id);

            if (record === undefined || reported.has(item.id)) {
              return [];
            }

            reported.add(item.id);

            return [toolActionEvent(record)];
          }
          case "result":
            return item.isError
              ? [
                  output(
                    "stdout",
                    item.text === null
                      ? item.subtype
                      : `${item.subtype}: ${item.text}`
                  ),
                ]
              : [];
        }
      };

      const stdoutEvents = (lines: readonly string[]): AgentEvent[] =>
        lines.flatMap((line) => readClaudeStreamLine(line).flatMap(eventsOf));

      const stderrEvents = (lines: readonly string[]): AgentEvent[] =>
        lines
          .filter((line) => line.trim() !== "")
          .map((line) => output("stderr", line));

      const result = options.runner({
        command,
        cwd: invocation.projectRoot,
        env: { [CLAUDE_GATE_ENVIRONMENT_VARIABLE]: JSON.stringify(gate) },
        timeoutMs: invocation.timeoutMs,
        signal: invocation.signal,
        onOutput: (stream, chunk) => {
          if (stream === "stdout") {
            appendFileSync(files.transcript, chunk);
          }

          const events =
            stream === "stdout"
              ? stdoutEvents(stdoutLines.feed(chunk))
              : stderrEvents(stderrLines.feed(chunk));

          for (const event of events) {
            queue.push(event);
          }
        },
      });

      void result.then(
        () => {
          queue.close();
        },
        () => {
          queue.close();
        }
      );

      for (;;) {
        const event = await queue.next();

        if (event === undefined) {
          break;
        }

        yield event;
      }

      const outcome = await result;
      const trailing = [
        ...stdoutEvents(stdoutLines.end()),
        ...stderrEvents(stderrLines.end()),
      ];

      for (const event of trailing) {
        yield event;
      }

      // The tool results the CLI never printed - it was killed first, or
      // the transcript was cut - still have decisions in the log, and the
      // log is what the record is made from.
      const log = readClaudeGateLog(files.decisionLog);
      const undecided: string[] = [];

      records = new Map(log.map((record) => [record.toolUseId, record]));

      for (const [id, use] of toolUses) {
        if (reported.has(id)) {
          continue;
        }

        const record = records.get(id);

        if (record === undefined) {
          undecided.push(
            `${code(use.name)} (${id}): ${JSON.stringify(use.input)}`
          );
        } else {
          reported.add(id);
          yield toolActionEvent(record);
        }
      }

      for (const record of log) {
        if (!reported.has(record.toolUseId)) {
          reported.add(record.toolUseId);
          yield toolActionEvent(record);
        }
      }

      if (undecided.length > 0) {
        throw new SailorError(
          "tool-gate-failed",
          `the CLI ran a tool without consulting the gate, so this run of ${code(invocation.agentId)} on task ${code(invocation.task.id)} cannot be vouched for`,
          undecided
        );
      }

      yield finishedEventOf(outcome, now().toISOString(), invocation.signal);
    },
  };
};
