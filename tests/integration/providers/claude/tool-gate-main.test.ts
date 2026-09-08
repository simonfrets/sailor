import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ToolPolicy } from "../../../../src/enforcement/tool-policy.js";
import {
  CLAUDE_GATE_ENVIRONMENT_VARIABLE,
  CLAUDE_TOOL_GATE_SOURCE,
  readClaudeGateLog,
} from "../../../../src/providers/claude/tool-gate.js";
import type { ClaudeGateConfig } from "../../../../src/providers/claude/tool-gate.js";
import { runNodeScript } from "../../../helpers/node-script.js";
import {
  createTempDirectory,
  removeTempDirectories,
} from "../../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const packageRoot = process.cwd();

const coder: ToolPolicy = {
  tools: { read: true, search: true, edit: true, execute: true },
  writeScopes: ["src/**"],
  projectScripts: ["test"],
  contextDirectory: ".sailor/state/runs/run-1/agents/coder",
  packageManager: "npm",
};

interface HookRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const runHook = (
  input: unknown,
  env: Readonly<Record<string, string>>
): HookRun =>
  runNodeScript({
    packageRoot,
    script: CLAUDE_TOOL_GATE_SOURCE,
    args: [],
    cwd: packageRoot,
    input: typeof input === "string" ? input : JSON.stringify(input),
    env,
  });

const configFor = (root: string): ClaudeGateConfig => ({
  version: 1,
  projectRoot: root,
  policy: coder,
  log: join(
    root,
    ".sailor",
    "state",
    "runs",
    "run-1",
    "claude",
    "coder",
    "decisions.jsonl"
  ),
});

const call = (toolName: string, toolInput: Record<string, unknown>) => ({
  session_id: "s",
  cwd: "/anywhere",
  hook_event_name: "PreToolUse",
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: "toolu_main",
});

describe("the Claude tool gate as the CLI runs it", () => {
  it("answers an allowed call on stdout, exits 0 and records the decision", () => {
    const root = createTempDirectory("sailor-gate-main-");
    const config = configFor(root);
    const run = runHook(call("Edit", { file_path: join(root, "src/a.ts") }), {
      [CLAUDE_GATE_ENVIRONMENT_VARIABLE]: JSON.stringify(config),
    });

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason:
          "`src/a.ts` is within the write scope `src/**`",
      },
    });
    expect(readClaudeGateLog(config.log)).toMatchObject([
      {
        toolUseId: "toolu_main",
        toolName: "Edit",
        action: { kind: "write", path: "src/a.ts" },
        decision: { verdict: "allowed" },
      },
    ]);
  });

  it("answers a denied call with the denial, still exiting 0 so the reason reaches the agent", () => {
    const root = createTempDirectory("sailor-gate-main-");
    const config = configFor(root);
    const run = runHook(call("Bash", { command: "rm -rf /" }), {
      [CLAUDE_GATE_ENVIRONMENT_VARIABLE]: JSON.stringify(config),
    });

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(readClaudeGateLog(config.log)).toMatchObject([
      { decision: { verdict: "denied", denial: "not-a-project-script" } },
    ]);
  });

  it("blocks the call with exit 2 when it is not configured, and records nothing", () => {
    const root = createTempDirectory("sailor-gate-main-");
    const run = runHook(call("Read", { file_path: "a" }), {});

    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(CLAUDE_GATE_ENVIRONMENT_VARIABLE);
    expect(existsSync(configFor(root).log)).toBe(false);
  });

  it("blocks the call with exit 2 when its configuration or input cannot be read", () => {
    const root = createTempDirectory("sailor-gate-main-");
    const config = configFor(root);
    const cases: readonly [unknown, string][] = [
      [call("Read", { file_path: "a" }), "{not json"],
      [
        call("Read", { file_path: "a" }),
        JSON.stringify({ ...config, version: 9 }),
      ],
      ["not json", JSON.stringify(config)],
      [call("WebFetch", { url: "x" }), JSON.stringify(config)],
    ];

    for (const [input, gate] of cases) {
      const run = runHook(input, { [CLAUDE_GATE_ENVIRONMENT_VARIABLE]: gate });

      expect(run.status).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).not.toBe("");
    }

    expect(existsSync(config.log)).toBe(false);
  });
});
