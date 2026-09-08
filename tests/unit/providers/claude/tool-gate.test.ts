import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ToolPolicy } from "../../../../src/enforcement/tool-policy.js";
import { SailorError } from "../../../../src/sailor/sailor-error.js";
import {
  CLAUDE_GATE_ENVIRONMENT_VARIABLE,
  CLAUDE_GATE_RECORD_VERSION,
  CLAUDE_TOOL_NAMES,
  appendClaudeGateRecord,
  claudeGateConfigSchema,
  claudeGateRecordSchema,
  claudeToolsFor,
  decideClaudeToolUse,
  parseClaudeHookInput,
  projectRelativeClaudePath,
  readClaudeGateLog,
  splitPlainCommand,
  toolActionOfClaudeToolUse,
} from "../../../../src/providers/claude/tool-gate.js";
import type {
  ClaudeGateConfig,
  ClaudeHookInput,
} from "../../../../src/providers/claude/tool-gate.js";
import { captureError } from "../../../helpers/expect-error.js";
import {
  createTempDirectory,
  removeTempDirectories,
} from "../../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const AT = "2026-09-07T12:00:00.000Z";
const PROJECT_ROOT = "/tmp/project";

const coder: ToolPolicy = {
  tools: { read: true, search: true, edit: true, execute: true },
  writeScopes: ["src/**", "tests/**"],
  projectScripts: ["lint", "test"],
  contextDirectory: ".sailor/state/runs/run-1/agents/coder",
  packageManager: "npm",
};

const architect: ToolPolicy = {
  tools: { read: true, search: true, edit: false, execute: false },
  writeScopes: [],
  projectScripts: [],
  contextDirectory: ".sailor/state/runs/run-1/agents/architect",
  packageManager: "npm",
};

const config = (policy: ToolPolicy = coder): ClaudeGateConfig => ({
  version: 1,
  projectRoot: PROJECT_ROOT,
  policy,
  log: "/tmp/project/.sailor/state/runs/run-1/claude/coder/decisions.jsonl",
});

const hookInput = (
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId = "toolu_01"
): ClaudeHookInput => ({
  session_id: "session-1",
  cwd: PROJECT_ROOT,
  hook_event_name: "PreToolUse",
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: toolUseId,
});

describe("the tools a Claude session is given", () => {
  it("names one Claude tool set per action kind, and nothing the gate cannot map", () => {
    expect(CLAUDE_TOOL_NAMES).toEqual({
      read: ["Read"],
      search: ["Glob", "Grep"],
      write: ["Edit", "Write", "NotebookEdit"],
      execute: ["Bash"],
    });
  });

  it("withholds Bash from an agent that may not execute, and nothing else", () => {
    // Every agent keeps the file tools whatever `edit` says: a reviewer with
    // `edit: false` still writes its findings to its own scratch directory,
    // and the gate is what decides each path.
    expect(claudeToolsFor(coder)).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "NotebookEdit",
      "Bash",
    ]);
    expect(claudeToolsFor(architect)).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "NotebookEdit",
    ]);
  });
});

describe("splitPlainCommand", () => {
  it("splits a command that is words, quoted words and nothing else", () => {
    expect(splitPlainCommand("npm run test")).toEqual(["npm", "run", "test"]);
    expect(splitPlainCommand("  npm\trun  lint -- --fix ")).toEqual([
      "npm",
      "run",
      "lint",
      "--",
      "--fix",
    ]);
    expect(splitPlainCommand("npm run test -- 'a b' \"c d\" e")).toEqual([
      "npm",
      "run",
      "test",
      "--",
      "a b",
      "c d",
      "e",
    ]);
    expect(splitPlainCommand("npm run test -- --grep=login,logout")).toEqual([
      "npm",
      "run",
      "test",
      "--",
      "--grep=login,logout",
    ]);
  });

  it("refuses anything a shell would interpret, rather than guessing what it means", () => {
    const shellish = [
      "npm run test | tee out",
      "npm run test && rm -rf .",
      "npm run test; echo done",
      "npm run test > out.txt",
      "npm run test 2>&1",
      "npm run test $(id)",
      "npm run test `id`",
      "npm run test $HOME",
      "npm run test ~/x",
      "npm run test *.ts",
      "npm run test a?b",
      "npm run test [a]",
      "npm run test {a,b}",
      "npm run test # comment",
      "npm run test \\\n lint",
      "npm run test\nnpm run lint",
      "npm run test 'unterminated",
      'npm run test "has $var"',
      'npm run test "has `x`"',
      'npm run test "has \\"',
      "npm run test (x)",
      "CI=true npm run test !",
      "",
      "   ",
    ];

    for (const command of shellish) {
      expect(splitPlainCommand(command)).toBeNull();
    }
  });
});

describe("toolActionOfClaudeToolUse", () => {
  it("maps each file tool to the action it is, with the path made project-relative", () => {
    expect(
      toolActionOfClaudeToolUse(PROJECT_ROOT, "Read", {
        file_path: "/tmp/project/src/a.ts",
      })
    ).toEqual({ action: { kind: "read", path: "src/a.ts" }, outside: null });
    expect(
      toolActionOfClaudeToolUse(PROJECT_ROOT, "Edit", {
        file_path: "src/./b.ts",
        old_string: "a",
        new_string: "b",
      })
    ).toEqual({ action: { kind: "write", path: "src/b.ts" }, outside: null });
    expect(
      toolActionOfClaudeToolUse(PROJECT_ROOT, "Write", {
        file_path: "/tmp/project/tests/c.test.ts",
        content: "",
      })
    ).toEqual({
      action: { kind: "write", path: "tests/c.test.ts" },
      outside: null,
    });
    expect(
      toolActionOfClaudeToolUse(PROJECT_ROOT, "NotebookEdit", {
        notebook_path: "/tmp/project/notes/d.ipynb",
        new_source: "",
      })
    ).toEqual({
      action: { kind: "write", path: "notes/d.ipynb" },
      outside: null,
    });
  });

  it("maps a search to its pattern", () => {
    expect(
      toolActionOfClaudeToolUse(PROJECT_ROOT, "Grep", {
        pattern: "TODO",
        path: "/tmp/project/src",
      })
    ).toEqual({ action: { kind: "search", query: "TODO" }, outside: null });
    expect(
      toolActionOfClaudeToolUse(PROJECT_ROOT, "Glob", { pattern: "**/*.ts" })
    ).toEqual({ action: { kind: "search", query: "**/*.ts" }, outside: null });
  });

  it("treats the project root itself as somewhere a search may look", () => {
    // A live run found this: the CLI globs `*` with `path` set to the project
    // root, which is the most ordinary argument a search has, and the gate
    // refused it as outside the project. `toProjectRelativePath` answers
    // `null` for the root because there is no file called "the project",
    // which is right for a write and wrong for a directory to search.
    for (const path of [PROJECT_ROOT, `${PROJECT_ROOT}/`, ".", "./"]) {
      expect(
        toolActionOfClaudeToolUse(PROJECT_ROOT, "Glob", { pattern: "*", path })
      ).toEqual({ action: { kind: "search", query: "*" }, outside: null });
    }
  });

  it("maps a plain Bash command to its argument vector, and a shell command to the shell that would run it", () => {
    expect(
      toolActionOfClaudeToolUse(PROJECT_ROOT, "Bash", {
        command: "npm run test -- --watch=false",
        description: "Run the tests",
      })
    ).toEqual({
      action: {
        kind: "execute",
        command: {
          executable: "npm",
          args: ["run", "test", "--", "--watch=false"],
        },
      },
      outside: null,
    });
    // The Bash tool runs its command through a shell, so a command that
    // needs one is recorded as exactly that: `sh -c <command>`. The policy
    // then refuses it as not being a project script, which it is not.
    expect(
      toolActionOfClaudeToolUse(PROJECT_ROOT, "Bash", {
        command: "npm run test | tee out.log",
      })
    ).toEqual({
      action: {
        kind: "execute",
        command: {
          executable: "sh",
          args: ["-c", "npm run test | tee out.log"],
        },
      },
      outside: null,
    });
  });

  it("keeps a path that leaves the project as the agent gave it, so the denial names it", () => {
    expect(
      toolActionOfClaudeToolUse(PROJECT_ROOT, "Read", {
        file_path: "/etc/passwd",
      })
    ).toEqual({
      action: { kind: "read", path: "/etc/passwd" },
      outside: "/etc/passwd",
    });
    expect(
      toolActionOfClaudeToolUse(PROJECT_ROOT, "Write", {
        file_path: "../outside.txt",
        content: "",
      })
    ).toEqual({
      action: { kind: "write", path: "../outside.txt" },
      outside: "../outside.txt",
    });
    expect(
      toolActionOfClaudeToolUse(PROJECT_ROOT, "Grep", {
        pattern: "x",
        path: "/tmp/project-sibling",
      })
    ).toEqual({
      action: { kind: "search", query: "x" },
      outside: "/tmp/project-sibling",
    });
  });

  it("refuses a tool it does not know and a call missing the field it maps", () => {
    const cases: readonly [string, Record<string, unknown>, string][] = [
      ["WebFetch", { url: "https://example.com" }, "`WebFetch` is not a tool"],
      ["Read", {}, "`Read` named no `file_path`"],
      ["Read", { file_path: 42 }, "`Read` named no `file_path`"],
      ["Edit", { file_path: "" }, "`Edit` named no `file_path`"],
      [
        "NotebookEdit",
        { file_path: "a" },
        "`NotebookEdit` named no `notebook_path`",
      ],
      ["Grep", { path: "src" }, "`Grep` named no `pattern`"],
      ["Bash", { description: "x" }, "`Bash` named no `command`"],
    ];

    for (const [toolName, toolInput, expected] of cases) {
      const error = captureError(
        () => toolActionOfClaudeToolUse(PROJECT_ROOT, toolName, toolInput),
        SailorError
      );

      expect(error.kind).toBe("tool-gate-failed");
      expect(error.message).toContain(expected);
    }
  });
});

describe("projectRelativeClaudePath", () => {
  /** A project reachable both directly and through a link, as macOS's `/var` is. */
  const buildLinkedProject = (): { real: string; link: string } => {
    const base = createTempDirectory("sailor-claude-links-");
    const real = join(base, "real");
    const link = join(base, "link");

    mkdirSync(join(real, "src"), { recursive: true });
    writeFileSync(join(real, "src", "a.ts"), "");
    symlinkSync(real, link);

    return { real, link };
  };

  it("agrees when the root is a link to the project and the CLI reports the target, or the reverse", () => {
    const { real, link } = buildLinkedProject();

    expect(projectRelativeClaudePath(link, join(real, "src", "a.ts"))).toBe(
      "src/a.ts"
    );
    expect(projectRelativeClaudePath(real, join(link, "src", "a.ts"))).toBe(
      "src/a.ts"
    );
    expect(projectRelativeClaudePath(link, "src/a.ts")).toBe("src/a.ts");
  });

  it("resolves a file that does not exist yet through the nearest ancestor that does", () => {
    const { real, link } = buildLinkedProject();

    expect(
      projectRelativeClaudePath(link, join(real, "src", "new", "deep", "b.ts"))
    ).toBe("src/new/deep/b.ts");
    expect(projectRelativeClaudePath(link, "tests/new.test.ts")).toBe(
      "tests/new.test.ts"
    );
  });

  it("sees a link inside the project for where it points", () => {
    const { real } = buildLinkedProject();
    const elsewhere = createTempDirectory("sailor-claude-elsewhere-");

    symlinkSync(elsewhere, join(real, "escape"));

    expect(projectRelativeClaudePath(real, "escape/x.txt")).toBeNull();
    expect(projectRelativeClaudePath(real, join(real, "escape"))).toBeNull();
  });

  it("still refuses what leaves the project, and the root itself", () => {
    const { real } = buildLinkedProject();

    expect(projectRelativeClaudePath(real, "/etc/passwd")).toBeNull();
    expect(projectRelativeClaudePath(real, "../outside")).toBeNull();
    expect(projectRelativeClaudePath(real, real)).toBeNull();
    expect(projectRelativeClaudePath(real, ".")).toBeNull();
  });
});

describe("decideClaudeToolUse", () => {
  it("allows what the policy allows, and answers the CLI in the form its hooks document", () => {
    const decided = decideClaudeToolUse({
      input: hookInput("Edit", {
        file_path: "/tmp/project/src/login.ts",
        old_string: "",
        new_string: "",
      }),
      config: config(),
      at: AT,
    });

    expect(decided.record).toEqual({
      version: CLAUDE_GATE_RECORD_VERSION,
      at: AT,
      toolUseId: "toolu_01",
      toolName: "Edit",
      action: { kind: "write", path: "src/login.ts" },
      decision: {
        verdict: "allowed",
        reason: "`src/login.ts` is within the write scope `src/**`",
      },
    });
    expect(decided.response).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason:
          "`src/login.ts` is within the write scope `src/**`",
      },
    });
  });

  it("denies what the policy denies, with the policy's own reason", () => {
    const decided = decideClaudeToolUse({
      input: hookInput("Bash", { command: "npx jest" }),
      config: config(),
      at: AT,
    });

    expect(decided.record.decision).toEqual({
      verdict: "denied",
      denial: "not-a-project-script",
      reason:
        "`npx jest` is not a project script run through `npm` (`build`, `format`, `lint`, `test`, `typecheck`)",
    });
    expect(decided.response.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decided.response.hookSpecificOutput.permissionDecisionReason).toBe(
      decided.record.decision.reason
    );
  });

  it("denies a read, a search and a write that reach outside the project before consulting the policy", () => {
    const cases: readonly [string, Record<string, unknown>][] = [
      ["Read", { file_path: "/etc/passwd" }],
      ["Grep", { pattern: "x", path: "/tmp/project-sibling" }],
      ["Write", { file_path: "../outside.txt", content: "" }],
    ];

    for (const [toolName, toolInput] of cases) {
      const decided = decideClaudeToolUse({
        input: hookInput(toolName, toolInput),
        config: config(),
        at: AT,
      });

      expect(decided.record.decision).toMatchObject({
        verdict: "denied",
        denial: "outside-project",
      });
      expect(decided.response.hookSpecificOutput.permissionDecision).toBe(
        "deny"
      );
    }
  });

  it("lets a reviewer write its findings to its scratch directory and nothing else", () => {
    const scratch = decideClaudeToolUse({
      input: hookInput("Write", {
        file_path:
          "/tmp/project/.sailor/state/runs/run-1/agents/architect/findings.md",
        content: "",
      }),
      config: config(architect),
      at: AT,
    });
    const source = decideClaudeToolUse({
      input: hookInput("Write", {
        file_path: "/tmp/project/src/a.ts",
        content: "",
      }),
      config: config(architect),
      at: AT,
    });
    const command = decideClaudeToolUse({
      input: hookInput("Bash", { command: "npm test" }),
      config: config(architect),
      at: AT,
    });

    expect(scratch.record.decision.verdict).toBe("allowed");
    expect(source.record.decision).toMatchObject({ denial: "edit-disabled" });
    expect(command.record.decision).toMatchObject({
      denial: "execute-disabled",
    });
  });
});

describe("the hook's input and configuration", () => {
  it("reads what the CLI documents it sends, and keeps fields it does not know", () => {
    const parsed = parseClaudeHookInput({
      ...hookInput("Read", { file_path: "a" }),
      transcript_path: "/somewhere",
      permission_mode: "default",
    });

    expect(parsed.tool_name).toBe("Read");
    expect(parsed.tool_use_id).toBe("toolu_01");
    expect(parsed).toMatchObject({ transcript_path: "/somewhere" });
  });

  it("refuses input that is not a PreToolUse call for one tool use", () => {
    const rejected = [
      null,
      "text",
      { tool_name: "Read" },
      {
        ...hookInput("Read", { file_path: "a" }),
        hook_event_name: "PostToolUse",
      },
      { ...hookInput("Read", { file_path: "a" }), tool_use_id: "" },
      { ...hookInput("Read", { file_path: "a" }), tool_input: "not an object" },
    ];

    for (const input of rejected) {
      const error = captureError(
        () => parseClaudeHookInput(input),
        SailorError
      );

      expect(error.kind).toBe("tool-gate-failed");
    }
  });

  it("names the variable the adapter hands the hook its configuration in", () => {
    expect(CLAUDE_GATE_ENVIRONMENT_VARIABLE).toBe("SAILOR_CLAUDE_GATE");
  });

  it("holds the configuration to absolute paths and a whole policy", () => {
    expect(claudeGateConfigSchema.safeParse(config()).success).toBe(true);

    const rejected = [
      { ...config(), version: 2 },
      { ...config(), projectRoot: "project" },
      { ...config(), log: "decisions.jsonl" },
      { ...config(), policy: { ...coder, tools: { read: true } } },
      { ...config(), policy: { ...coder, writeScopes: ["../**"] } },
      { ...config(), policy: { ...coder, packageManager: "cargo" } },
      { ...config(), extra: true },
    ];

    for (const candidate of rejected) {
      expect(claudeGateConfigSchema.safeParse(candidate).success).toBe(false);
    }
  });
});

describe("the decision log", () => {
  it("appends one line per decision and reads them back in order, validated", () => {
    const root = createTempDirectory("sailor-claude-gate-");
    const log = join(root, "nested", "decisions.jsonl");
    const first = decideClaudeToolUse({
      input: hookInput("Read", { file_path: "src/a.ts" }, "toolu_01"),
      config: { ...config(), log },
      at: AT,
    }).record;
    const second = decideClaudeToolUse({
      input: hookInput("Bash", { command: "npm run lint" }, "toolu_02"),
      config: { ...config(), log },
      at: AT,
    }).record;

    appendClaudeGateRecord(log, first);
    appendClaudeGateRecord(log, second);

    expect(readFileSync(log, "utf8").split("\n")).toHaveLength(3);
    expect(readClaudeGateLog(log)).toEqual([first, second]);
  });

  it("reads an absent log as no decisions, which is what a run with no tool call leaves", () => {
    const root = createTempDirectory("sailor-claude-gate-");

    expect(readClaudeGateLog(join(root, "decisions.jsonl"))).toEqual([]);
  });

  it("refuses a log line it cannot read rather than skipping it", () => {
    const root = createTempDirectory("sailor-claude-gate-");
    const log = join(root, "decisions.jsonl");

    mkdirSync(root, { recursive: true });
    writeFileSync(log, `${JSON.stringify({ version: 1, toolUseId: "x" })}\n`);

    const invalid = captureError(() => readClaudeGateLog(log), SailorError);

    expect(invalid.kind).toBe("tool-gate-failed");
    expect(invalid.message).toContain("line 1");

    writeFileSync(log, "not json\n");

    expect(captureError(() => readClaudeGateLog(log), SailorError).kind).toBe(
      "tool-gate-failed"
    );
  });

  it("validates a record's shape exactly", () => {
    const record = decideClaudeToolUse({
      input: hookInput("Read", { file_path: "src/a.ts" }),
      config: config(),
      at: AT,
    }).record;

    expect(claudeGateRecordSchema.safeParse(record).success).toBe(true);
    expect(
      claudeGateRecordSchema.safeParse({ ...record, extra: 1 }).success
    ).toBe(false);
    expect(
      claudeGateRecordSchema.safeParse({ ...record, toolUseId: "" }).success
    ).toBe(false);
  });
});
