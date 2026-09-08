import {
  TOOL_ACTION_KINDS,
  TOOL_DENIALS,
  evaluateToolAction,
  matchProjectScript,
  toolActionSchema,
  toolDecisionSchema,
  toolPolicyFromContext,
} from "../../../src/enforcement/tool-policy.js";
import type {
  ToolDecision,
  ToolDenial,
  ToolPolicy,
} from "../../../src/enforcement/tool-policy.js";
import type { CommandSpec } from "../../../src/processes/command-runner.js";
import type { PackageManager } from "../../../src/project/project-profile-schema.js";
import { buildAgentContext } from "../../../src/tasks/agent-context.js";
import { RULE_SET_SHA256, buildTask } from "../../helpers/tasks.js";

const CONTEXT_DIRECTORY = ".sailor/state/runs/run-1/agents/coder";

const policy = (overrides: Partial<ToolPolicy> = {}): ToolPolicy => ({
  tools: { read: true, search: true, edit: true, execute: true },
  writeScopes: ["src/**", "tests/**"],
  projectScripts: ["lint", "test"],
  contextDirectory: CONTEXT_DIRECTORY,
  packageManager: "npm",
  ...overrides,
});

/** The architect as shipped: reads and searches, never edits or runs. */
const reviewer = (): ToolPolicy =>
  policy({
    tools: { read: true, search: true, edit: false, execute: false },
    writeScopes: [],
    projectScripts: [],
    contextDirectory: ".sailor/state/runs/run-1/agents/architect",
  });

const denialOf = (decision: ToolDecision): ToolDenial => {
  if (decision.verdict !== "denied") {
    throw new Error(`expected a denial, got: ${decision.reason}`);
  }

  return decision.denial;
};

const command = (executable: string, ...args: string[]): CommandSpec => ({
  executable,
  args,
});

describe("tool action vocabulary", () => {
  it("names the four things an agent can do", () => {
    expect([...TOOL_ACTION_KINDS]).toEqual([
      "read",
      "search",
      "write",
      "execute",
    ]);
  });

  it("names every reason an action can be refused", () => {
    expect([...TOOL_DENIALS]).toEqual([
      "context-immutable",
      "edit-disabled",
      "execute-disabled",
      "sailor-owned",
      "not-a-project-script",
      "outside-project",
      "outside-write-scope",
      "read-disabled",
      "script-not-permitted",
      "search-disabled",
    ]);
  });

  it("validates each action shape and nothing else", () => {
    expect(
      toolActionSchema.safeParse({ kind: "read", path: "src/a.ts" }).success
    ).toBe(true);
    expect(
      toolActionSchema.safeParse({ kind: "search", query: "TODO" }).success
    ).toBe(true);
    expect(
      toolActionSchema.safeParse({ kind: "write", path: "src/a.ts" }).success
    ).toBe(true);
    expect(
      toolActionSchema.safeParse({
        kind: "execute",
        command: { executable: "npm", args: ["run", "test"] },
      }).success
    ).toBe(true);

    expect(
      toolActionSchema.safeParse({ kind: "delete", path: "x" }).success
    ).toBe(false);
    expect(toolActionSchema.safeParse({ kind: "write" }).success).toBe(false);
    expect(
      toolActionSchema.safeParse({ kind: "write", path: "src/a.ts", extra: 1 })
        .success
    ).toBe(false);
    expect(
      toolActionSchema.safeParse({
        kind: "execute",
        command: { executable: "", args: [] },
      }).success
    ).toBe(false);
  });

  it("validates a decision as allowed with a reason or denied with a cause", () => {
    expect(
      toolDecisionSchema.safeParse({ verdict: "allowed", reason: "in scope" })
        .success
    ).toBe(true);
    expect(
      toolDecisionSchema.safeParse({
        verdict: "denied",
        denial: "outside-write-scope",
        reason: "not in scope",
      }).success
    ).toBe(true);

    expect(
      toolDecisionSchema.safeParse({ verdict: "denied", reason: "no cause" })
        .success
    ).toBe(false);
    expect(
      toolDecisionSchema.safeParse({
        verdict: "allowed",
        denial: "outside-write-scope",
        reason: "contradiction",
      }).success
    ).toBe(false);
    expect(
      toolDecisionSchema.safeParse({
        verdict: "denied",
        denial: "because",
        reason: "unknown cause",
      }).success
    ).toBe(false);
  });
});

describe("evaluateToolAction: read and search", () => {
  it("allows a read or a search exactly when the capability is granted", () => {
    expect(
      evaluateToolAction({ kind: "read", path: "package.json" }, policy())
        .verdict
    ).toBe("allowed");
    expect(
      evaluateToolAction({ kind: "search", query: "TODO" }, policy()).verdict
    ).toBe("allowed");
  });

  it("refuses them by the capability that is off", () => {
    const blind = policy({
      tools: { read: false, search: false, edit: true, execute: true },
    });

    expect(
      denialOf(
        evaluateToolAction({ kind: "read", path: "package.json" }, blind)
      )
    ).toBe("read-disabled");
    expect(
      denialOf(evaluateToolAction({ kind: "search", query: "TODO" }, blind))
    ).toBe("search-disabled");
  });
});

describe("evaluateToolAction: write", () => {
  it("allows a write inside a scope and names the scope", () => {
    const decision = evaluateToolAction(
      { kind: "write", path: "tests/unit/a.test.ts" },
      policy()
    );

    expect(decision).toEqual({
      verdict: "allowed",
      reason: "`tests/unit/a.test.ts` is within the write scope `tests/**`",
    });
  });

  it("refuses a write outside every scope and lists them", () => {
    const decision = evaluateToolAction(
      { kind: "write", path: "docs/readme.md" },
      policy()
    );

    expect(denialOf(decision)).toBe("outside-write-scope");
    expect(decision.reason).toBe(
      "`docs/readme.md` is outside every write scope: `src/**`, `tests/**`"
    );
  });

  it("refuses every write for an agent without the edit capability", () => {
    const decision = evaluateToolAction(
      { kind: "write", path: "src/a.ts" },
      reviewer()
    );

    expect(denialOf(decision)).toBe("edit-disabled");
    expect(decision.reason).toContain("`tools.edit` is false");
  });

  it("refuses a write that leaves the project before consulting any scope", () => {
    for (const path of ["/etc/passwd", "../a.ts", "src/../../a.ts"]) {
      expect(
        denialOf(
          evaluateToolAction(
            { kind: "write", path },
            policy({ writeScopes: ["**"] })
          )
        )
      ).toBe("outside-project");
    }
  });

  it("refuses a write into the sailor directory, whatever the scopes grant", () => {
    for (const path of [
      ".sailor/tasks.yaml",
      ".sailor/agents/coder.yaml",
      ".sailor/rules/custom/team.yaml",
      ".sailor/config/project.yaml",
      ".sailor/hooks/pre-commit",
      ".sailor/state/runs/run-1/agents/qa/notes.md",
      ".sailor/state/runs/run-2/agents/coder/notes.md",
    ]) {
      const decision = evaluateToolAction(
        { kind: "write", path },
        policy({ writeScopes: ["**", ".sailor/**"] })
      );

      expect(denialOf(decision)).toBe("sailor-owned");
    }
  });

  it("lets every agent write its own scratch directory, edit capability or not", () => {
    const decision = evaluateToolAction(
      {
        kind: "write",
        path: ".sailor/state/runs/run-1/agents/architect/findings.md",
      },
      reviewer()
    );

    expect(decision.verdict).toBe("allowed");
    expect(decision.reason).toContain("scratch");
  });

  it("never lets an agent rewrite the context it was handed", () => {
    const decision = evaluateToolAction(
      { kind: "write", path: `${CONTEXT_DIRECTORY}/context.json` },
      policy({ writeScopes: ["**"] })
    );

    expect(denialOf(decision)).toBe("context-immutable");
  });

  it("reads a path the way the filesystem will, not the way it was spelled", () => {
    expect(
      evaluateToolAction({ kind: "write", path: "./src//a.ts" }, policy())
    ).toEqual({
      verdict: "allowed",
      reason: "`src/a.ts` is within the write scope `src/**`",
    });
    expect(
      denialOf(
        evaluateToolAction(
          { kind: "write", path: "./.sailor/tasks.yaml" },
          policy({ writeScopes: ["**"] })
        )
      )
    ).toBe("sailor-owned");
  });

  it("does not let a directory sharing the sailor prefix pass as sailor-owned or as scratch", () => {
    expect(
      evaluateToolAction(
        { kind: "write", path: ".sailorx/a.ts" },
        policy({ writeScopes: ["**"] })
      ).verdict
    ).toBe("allowed");
    expect(
      denialOf(
        evaluateToolAction(
          { kind: "write", path: `${CONTEXT_DIRECTORY}x/notes.md` },
          reviewer()
        )
      )
    ).toBe("sailor-owned");
  });
});

describe("evaluateToolAction: execute", () => {
  it("allows a permitted project script and names it", () => {
    const decision = evaluateToolAction(
      { kind: "execute", command: command("npm", "run", "test") },
      policy()
    );

    expect(decision).toEqual({
      verdict: "allowed",
      reason: "`npm run test` runs the permitted project script `test`",
    });
  });

  it("refuses every command for an agent without the execute capability", () => {
    const decision = evaluateToolAction(
      { kind: "execute", command: command("npm", "run", "test") },
      reviewer()
    );

    expect(denialOf(decision)).toBe("execute-disabled");
  });

  it("refuses a command that is not one of the project's semantic scripts", () => {
    for (const spec of [
      command("npx", "jest"),
      command("node", "--test"),
      command("npm", "run", "deploy"),
      command("rm", "-rf", "dist"),
      command("pnpm", "run", "test"),
    ]) {
      const decision = evaluateToolAction(
        { kind: "execute", command: spec },
        policy()
      );

      expect(denialOf(decision)).toBe("not-a-project-script");
    }
  });

  it("refuses a project script the agent was not granted", () => {
    const decision = evaluateToolAction(
      { kind: "execute", command: command("npm", "run", "build") },
      policy()
    );

    expect(denialOf(decision)).toBe("script-not-permitted");
    expect(decision.reason).toBe(
      "`npm run build` runs the project script `build`, which this agent may not run (permitted: `lint`, `test`)"
    );
  });
});

describe("matchProjectScript", () => {
  const cases: readonly [PackageManager, readonly string[], string | null][] = [
    ["npm", ["run", "test"], "test"],
    ["npm", ["run", "test", "--", "--watch"], "test"],
    ["npm", ["run", "lint", "--fix"], "lint"],
    ["npm", ["test"], "test"],
    ["npm", ["t"], "test"],
    ["npm", ["tst"], "test"],
    ["npm", ["run", "deploy"], null],
    ["npm", ["run"], null],
    ["npm", ["install"], null],
    ["npm", ["start"], null],
    ["pnpm", ["run", "typecheck"], "typecheck"],
    ["pnpm", ["test"], "test"],
    ["pnpm", ["t"], "test"],
    ["pnpm", ["build"], null],
    ["yarn", ["run", "build"], "build"],
    ["yarn", ["test"], "test"],
    ["yarn", ["build"], null],
    ["bun", ["run", "format"], "format"],
    ["bun", ["test"], null],
  ];

  it.each(cases)("%s %j resolves to %s", (packageManager, args, expected) => {
    expect(
      matchProjectScript(packageManager, {
        executable: packageManager,
        args,
      })
    ).toBe(expected);
  });

  it("does not recognise another package manager's executable", () => {
    expect(
      matchProjectScript("npm", command("pnpm", "run", "test"))
    ).toBeNull();
    expect(matchProjectScript("yarn", command("npm", "test"))).toBeNull();
    expect(matchProjectScript("npm", command("npx", "test"))).toBeNull();
  });
});

describe("toolPolicyFromContext", () => {
  const context = buildAgentContext({
    task: buildTask({
      state: "hardening",
      agentId: "hardener",
      revision: 4,
      runId: "run-7",
    }),
    definition: {
      version: 1,
      id: "hardener",
      displayName: "Hardener",
      summary: "Attacks the tests",
      modelProfile: "coding-high",
      tools: { read: true, search: true, edit: true, execute: true },
      writeScopes: ["tests/**"],
      projectScripts: ["test", "typecheck"],
    },
    policy: "# Agent policy: hardener\n",
    ruleSetSha256: RULE_SET_SHA256,
    at: new Date("2026-08-28T10:00:00.000Z"),
    attempt: 1,
  });

  it("takes the capabilities, scopes and scripts from the context the agent was handed", () => {
    expect(toolPolicyFromContext(context, "pnpm")).toEqual({
      tools: { read: true, search: true, edit: true, execute: true },
      writeScopes: ["tests/**"],
      projectScripts: ["test", "typecheck"],
      contextDirectory: ".sailor/state/runs/run-7/agents/hardener",
      packageManager: "pnpm",
    });
  });

  it("copies rather than aliases what it takes", () => {
    const built = toolPolicyFromContext(context, "npm");

    expect(built.writeScopes).not.toBe(context.writeScopes);
    expect(built.projectScripts).not.toBe(context.projectScripts);
    expect(built.tools).not.toBe(context.tools);
  });
});
