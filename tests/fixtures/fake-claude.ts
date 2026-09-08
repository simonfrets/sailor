/**
 * A stand-in for the `claude` executable.
 *
 * It behaves the way `claude --help` and the hooks reference say the real
 * one does for what the adapter relies on: it demands the flags a governed
 * `--print` session needs, prints `stream-json` lines, and before each tool
 * call runs the `PreToolUse` hook from `--settings` through `sh -c` with the
 * call on stdin, honouring the decision it reads back. It never talks to a
 * model: the conversation is a scenario file, given as the first argument,
 * so a test states what the agent tries and asserts what the sailor did
 * about it. Nothing here makes a network call.
 *
 * Usage: `fake-claude.ts <scenario.json> <claude arguments...>`
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface TextStep {
  readonly text: string;
}

interface ToolStep {
  readonly id: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  /** Do not consult the hook, as a CLI that ignored its settings would not. */
  readonly skipHook?: boolean;
}

interface Scenario {
  readonly steps: readonly (TextStep | ToolStep)[];
  readonly exitCode?: number;
  readonly resultText?: string;
}

const REQUIRED_FLAGS = [
  "--print",
  "--verbose",
  "--restricted",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--disable-slash-commands",
] as const;

const [scenarioPath, ...args] = process.argv.slice(2);

if (scenarioPath === undefined) {
  throw new Error("usage: fake-claude.ts <scenario.json> <claude arguments>");
}

const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario;

const valueOf = (flag: string): string => {
  const index = args.indexOf(flag);
  const value = args[index + 1];

  if (index === -1 || value === undefined) {
    throw new Error(`fake claude: ${flag} was not given`);
  }

  return value;
};

for (const flag of REQUIRED_FLAGS) {
  if (!args.includes(flag)) {
    throw new Error(`fake claude: ${flag} was not given`);
  }
}

if (valueOf("--output-format") !== "stream-json") {
  throw new Error("fake claude: --output-format must be stream-json");
}

if (valueOf("--permission-prompts") !== "none") {
  throw new Error("fake claude: --permission-prompts must be none");
}

const separator = args.indexOf("--");
const prompt = separator === -1 ? undefined : args[separator + 1];

if (prompt === undefined || prompt === "") {
  throw new Error("fake claude: no prompt after --");
}

const tools = valueOf("--tools").split(",");
const settings = JSON.parse(valueOf("--settings")) as {
  hooks?: {
    PreToolUse?: readonly {
      matcher?: string;
      hooks: readonly { type: string; command: string }[];
    }[];
  };
};

const hookCommands = (settings.hooks?.PreToolUse ?? []).flatMap((entry) =>
  entry.hooks.map((hook) => hook.command)
);

const emit = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

emit({
  type: "system",
  subtype: "init",
  session_id: "fake-session",
  tools,
  model: valueOf("--model"),
  permissionMode: "default",
});

interface Decision {
  readonly allowed: boolean;
  readonly reason: string;
}

/** Runs the configured hook exactly as the CLI does: `sh -c`, JSON on stdin. */
const consultHook = (step: ToolStep): Decision => {
  const [command] = hookCommands;

  if (command === undefined) {
    return { allowed: true, reason: "no hook configured" };
  }

  const hook = spawnSync("sh", ["-c", command], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    input: JSON.stringify({
      session_id: "fake-session",
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: step.tool,
      tool_input: step.input,
      tool_use_id: step.id,
    }),
  });

  if (hook.status === 2) {
    return { allowed: false, reason: hook.stderr.trim() };
  }

  if (hook.status !== 0) {
    return { allowed: true, reason: `hook exited ${String(hook.status)}` };
  }

  const output = JSON.parse(hook.stdout) as {
    hookSpecificOutput: {
      permissionDecision: string;
      permissionDecisionReason: string;
    };
  };

  return {
    allowed: output.hookSpecificOutput.permissionDecision === "allow",
    reason: output.hookSpecificOutput.permissionDecisionReason,
  };
};

/** What the tool would have done to the working tree, when it ran. */
const perform = (step: ToolStep): void => {
  if (step.tool === "Write" || step.tool === "Edit") {
    const path = resolve(process.cwd(), String(step.input.file_path));
    const content = step.input.content ?? step.input.new_string;

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === "string" ? content : "");
  }
};

for (const step of scenario.steps) {
  if ("text" in step) {
    emit({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: step.text }],
      },
    });

    continue;
  }

  emit({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: step.id, name: step.tool, input: step.input },
      ],
    },
  });

  const decision =
    step.skipHook === true
      ? { allowed: true, reason: "hook skipped" }
      : consultHook(step);

  if (decision.allowed) {
    perform(step);
  }

  emit({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: step.id,
          content: decision.reason,
          is_error: !decision.allowed,
        },
      ],
    },
  });
}

emit({
  type: "result",
  subtype: "success",
  is_error: false,
  result: scenario.resultText ?? "done",
  num_turns: scenario.steps.length,
  session_id: "fake-session",
});

process.exitCode = scenario.exitCode ?? 0;
