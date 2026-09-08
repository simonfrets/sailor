import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AgentDefinition } from "../../../src/agents/agent-definition.js";
import {
  NODE_COMMAND_RUNNER_DEFAULTS,
  createNodeCommandRunner,
} from "../../../src/processes/node-command-runner.js";
import type { AgentEvent } from "../../../src/providers/agent-event.js";
import {
  auditIndexFile,
  recordAuditedAgentRun,
} from "../../../src/providers/audited-run.js";
import { buildAgentInvocation } from "../../../src/providers/provider-adapter.js";
import type {
  AgentInvocation,
  ProviderAdapter,
} from "../../../src/providers/provider-adapter.js";
import { buildAgentContext } from "../../../src/tasks/agent-context.js";
import { cleanEnvironment, initRepository, runGit } from "../../helpers/git.js";
import {
  RULE_SET_SHA256,
  buildTask,
  buildTransition,
} from "../../helpers/tasks.js";
import {
  createTempDirectory,
  removeTempDirectories,
} from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const AT = "2026-09-07T12:00:00.000Z";

const runner = createNodeCommandRunner({
  ...NODE_COMMAND_RUNNER_DEFAULTS,
  baseEnv: cleanEnvironment(),
});

const coder: AgentDefinition = {
  version: 1,
  id: "coder",
  displayName: "Coder",
  summary: "Implements the specification",
  modelProfile: "coding-high",
  tools: { read: true, search: true, edit: true, execute: true },
  writeScopes: ["src/**"],
  projectScripts: ["test"],
};

const write = (root: string, path: string, contents: string): void => {
  const absolute = join(root, path);

  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
};

const buildRepository = (): string => {
  const root = createTempDirectory("sailor-audited-run-");

  initRepository(root);
  write(root, ".sailor/.gitignore", "state/\n");
  write(root, "src/a.ts", "export const a = 1;\n");
  runGit(root, ["add", "--all"]);
  runGit(root, ["commit", "--quiet", "--message", "baseline"]);

  return root;
};

const invocationFor = (projectRoot: string): AgentInvocation => {
  const task = buildTask({
    state: "implementing",
    agentId: "coder",
    revision: 5,
    runId: "run-1",
    approvedAt: AT,
    approvedBy: "a-reviewer",
    contextPath: ".sailor/state/runs/run-1/agents/coder",
    history: [
      buildTransition({
        revision: 5,
        expectedRevision: 4,
        from: "awaiting_approval",
        to: "implementing",
        toAgent: "coder",
        contextPath: ".sailor/state/runs/run-1/agents/coder",
      }),
    ],
  });

  return buildAgentInvocation({
    projectRoot,
    task,
    context: buildAgentContext({
      task,
      definition: coder,
      policy: "# Agent policy: coder\n",
      ruleSetSha256: RULE_SET_SHA256,
      at: new Date(AT),
      attempt: 1,
    }),
    modelProfile: "coding-high",
    packageManager: "npm",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });
};

const started: AgentEvent = { kind: "started", at: AT, command: null };
const finished: AgentEvent = {
  kind: "finished",
  at: AT,
  status: "completed",
  detail: "exited with code 0",
  exitCode: 0,
  durationMs: 1,
};

/** An adapter whose agent writes files while it runs, as a real one would. */
const writing = (writes: readonly [string, string][]): ProviderAdapter => ({
  provider: "claude",
  invoke: async function* (invocation) {
    yield await Promise.resolve(started);

    for (const [path, contents] of writes) {
      write(invocation.projectRoot, path, contents);
    }

    yield finished;
  },
});

describe("recordAuditedAgentRun", () => {
  it("records the run and holds every change the agent made to its policy", async () => {
    const root = buildRepository();
    const seen: AgentEvent["kind"][] = [];
    const record = await recordAuditedAgentRun(
      writing([
        ["src/b.ts", "export const b = 1;\n"],
        ["docs/readme.md", "# no\n"],
        [".sailor/state/runs/run-1/agents/coder/notes.md", "scratch\n"],
      ]),
      invocationFor(root),
      {
        runner,
        onEvent: (event) => {
          seen.push(event.kind);
        },
      }
    );

    expect(record.events).toEqual([started, finished]);
    expect(record.finished).toEqual(finished);
    expect(seen).toEqual(["started", "finished"]);
    expect(record.audit).toEqual({
      changedPaths: ["docs/readme.md", "src/b.ts"],
      violations: [
        {
          path: "docs/readme.md",
          decision: {
            verdict: "denied",
            denial: "outside-write-scope",
            reason: "`docs/readme.md` is outside every write scope: `src/**`",
          },
        },
      ],
      clean: false,
    });
  });

  it("snapshots before the agent starts, so what was already there is not blamed on it", async () => {
    const root = buildRepository();

    write(root, "docs/existing.md", "# before\n");

    const record = await recordAuditedAgentRun(
      writing([["src/c.ts", "export const c = 1;\n"]]),
      invocationFor(root),
      { runner }
    );

    expect(record.audit).toEqual({
      changedPaths: ["src/c.ts"],
      violations: [],
      clean: true,
    });
  });

  it("keeps its private index under the sailor's audit directory, outside the agent's scratch", () => {
    expect(auditIndexFile("/tmp/project", "run-1", "coder")).toBe(
      join("/tmp/project", ".sailor", "state", "audit", "run-1-coder.index")
    );
  });

  it("leaves the repository's own index untouched", async () => {
    const root = buildRepository();

    await recordAuditedAgentRun(
      writing([["src/d.ts", "export const d = 1;\n"]]),
      invocationFor(root),
      { runner }
    );

    expect(runGit(root, ["diff", "--cached", "--name-only"]).stdout).toBe("");
    expect(runGit(root, ["status", "--porcelain"]).stdout).toBe(
      "?? src/d.ts\n"
    );
  });

  it("lets the adapter's own failure through, unaudited and unrecorded", async () => {
    const root = buildRepository();
    const failing: ProviderAdapter = {
      provider: "claude",
      invoke: async function* () {
        yield await Promise.resolve(started);
        throw new Error("claude is not installed");
      },
    };

    await expect(
      recordAuditedAgentRun(failing, invocationFor(root), { runner })
    ).rejects.toThrow("claude is not installed");
  });
});
