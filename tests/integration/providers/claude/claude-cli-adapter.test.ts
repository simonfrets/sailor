import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AgentDefinition } from "../../../../src/agents/agent-definition.js";
import { SailorError } from "../../../../src/sailor/sailor-error.js";
import {
  NODE_COMMAND_RUNNER_DEFAULTS,
  createNodeCommandRunner,
} from "../../../../src/processes/node-command-runner.js";
import type { CommandSpec } from "../../../../src/processes/command-runner.js";
import { recordAuditedAgentRun } from "../../../../src/providers/audited-run.js";
import {
  claudeRunFiles,
  createClaudeCliAdapter,
} from "../../../../src/providers/claude/claude-cli-adapter.js";
import {
  CLAUDE_TOOL_GATE_SOURCE,
  readClaudeGateLog,
} from "../../../../src/providers/claude/tool-gate.js";
import { buildAgentInvocation } from "../../../../src/providers/provider-adapter.js";
import type { AgentInvocation } from "../../../../src/providers/provider-adapter.js";
import { buildAgentContext } from "../../../../src/tasks/agent-context.js";
import { captureRejection } from "../../../helpers/expect-error.js";
import {
  cleanEnvironment,
  initRepository,
  runGit,
} from "../../../helpers/git.js";
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

const packageRoot = process.cwd();

const runner = createNodeCommandRunner({
  ...NODE_COMMAND_RUNNER_DEFAULTS,
  baseEnv: cleanEnvironment(),
});

/** Starts a TypeScript source in a fresh Node process, as `runNodeScript` does. */
const nodeSource = (script: string): CommandSpec => ({
  executable: process.execPath,
  args: [
    "--disable-warning=ExperimentalWarning",
    "--import",
    join(packageRoot, "tests/helpers/register-typescript-sources.mjs"),
    join(packageRoot, script),
  ],
});

const coder: AgentDefinition = {
  version: 1,
  id: "coder",
  displayName: "Coder",
  summary: "Implements the specification",
  modelProfile: "coding-high",
  tools: { read: true, search: true, edit: true, execute: true },
  writeScopes: ["src/**", "tests/**"],
  projectScripts: ["test"],
};

const write = (root: string, path: string, contents: string): void => {
  const absolute = join(root, path);

  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
};

/** A committed project with the sailor's ignore rules and a spec to read. */
const buildRepository = (): string => {
  const root = createTempDirectory("sailor-claude-e2e-");

  initRepository(root);
  write(root, ".sailor/.gitignore", "node_modules/\nstate/\n");
  write(root, ".sailor/tasks.yaml", "version: 1\ntasks: []\n");
  write(root, "docs/specs/add-login.md", "# Add login\n");
  write(root, "package.json", '{"name":"host","scripts":{"test":"jest"}}\n');
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
    approvedAt: "2026-09-07T11:00:00.000Z",
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
      at: new Date("2026-09-07T12:00:00.000Z"),
      attempt: 1,
      handoff: {
        fromAgent: "specifier",
        fromState: "awaiting_approval",
        gateReportIds: [],
        artifactPaths: ["docs/specs/add-login.md"],
        failure: null,
      },
    }),
    modelProfile: "coding-high",
    packageManager: "npm",
    timeoutMs: 60_000,
    signal: new AbortController().signal,
  });
};

const adapterFor = (scenarioPath: string) => {
  const fake = nodeSource("tests/fixtures/fake-claude.ts");

  return createClaudeCliAdapter({
    runner,
    claude: { executable: fake.executable, args: [...fake.args, scenarioPath] },
    toolGate: nodeSource(CLAUDE_TOOL_GATE_SOURCE),
  });
};

const scenarioFile = (root: string, scenario: unknown): string => {
  const path = join(
    root,
    "..",
    `${root.split("/").pop() ?? "x"}.scenario.json`
  );

  writeFileSync(path, JSON.stringify(scenario));

  return path;
};

describe("invoking an agent through a Claude CLI that runs the real hook", () => {
  it("lets the coder do what its policy allows, refuses the rest before it happens, and audits the tree afterwards", async () => {
    const root = buildRepository();
    const scenario = scenarioFile(root, {
      steps: [
        { text: "Reading the specification." },
        {
          id: "toolu_read",
          tool: "Read",
          input: { file_path: join(root, "docs/specs/add-login.md") },
        },
        {
          id: "toolu_write",
          tool: "Write",
          input: {
            file_path: join(root, "src/login.ts"),
            content: "export const login = () => true;\n",
          },
        },
        {
          id: "toolu_outside",
          tool: "Write",
          input: { file_path: "docs/notes.md", content: "# notes\n" },
        },
        {
          id: "toolu_sailor",
          tool: "Edit",
          input: {
            file_path: join(root, ".sailor/tasks.yaml"),
            old_string: "",
            new_string: "tampered",
          },
        },
        {
          id: "toolu_scratch",
          tool: "Write",
          input: {
            file_path: join(
              root,
              ".sailor/state/runs/run-1/agents/coder/notes.md"
            ),
            content: "scratch\n",
          },
        },
        { id: "toolu_test", tool: "Bash", input: { command: "npm run test" } },
        {
          id: "toolu_shell",
          tool: "Bash",
          input: { command: "npm test | cat" },
        },
        { text: "Implemented login." },
      ],
    });
    const invocation = invocationFor(root);
    const record = await recordAuditedAgentRun(
      adapterFor(scenario),
      invocation,
      { runner }
    );
    const verdicts = record.events.flatMap((event) =>
      event.kind === "tool-action"
        ? [
            [
              event.action.kind,
              event.decision.verdict,
              event.decision.verdict === "denied"
                ? event.decision.denial
                : null,
            ],
          ]
        : []
    );

    expect(record.finished).toMatchObject({ status: "completed", exitCode: 0 });
    expect(verdicts).toEqual([
      ["read", "allowed", null],
      ["write", "allowed", null],
      ["write", "denied", "outside-write-scope"],
      ["write", "denied", "sailor-owned"],
      ["write", "allowed", null],
      ["execute", "allowed", null],
      ["execute", "denied", "not-a-project-script"],
    ]);
    expect(
      record.events
        .filter((event) => event.kind === "output")
        .map((e) => e.text)
    ).toEqual(["Reading the specification.", "Implemented login."]);

    // What the CLI refused did not happen; what it allowed did.
    expect(readFileSync(join(root, "src/login.ts"), "utf8")).toBe(
      "export const login = () => true;\n"
    );
    expect(existsSync(join(root, "docs/notes.md"))).toBe(false);
    expect(readFileSync(join(root, ".sailor/tasks.yaml"), "utf8")).toBe(
      "version: 1\ntasks: []\n"
    );
    expect(
      readFileSync(
        join(root, ".sailor/state/runs/run-1/agents/coder/notes.md"),
        "utf8"
      )
    ).toBe("scratch\n");

    // The audit agrees with the gate, and the scratch write is not its business.
    expect(record.audit).toEqual({
      changedPaths: ["src/login.ts"],
      violations: [],
      clean: true,
    });

    // The decisions and the transcript are on disk, under the run.
    const files = claudeRunFiles(root, "run-1", "coder", 1);

    expect(readClaudeGateLog(files.decisionLog)).toHaveLength(7);
    expect(readFileSync(files.transcript, "utf8").split("\n")).toHaveLength(
      1 + 1 + 7 * 2 + 1 + 1 + 1
    );
    expect(runGit(root, ["diff", "--cached", "--name-only"]).stdout).toBe("");
  });

  it("refuses the run when the CLI writes without consulting the gate, rather than auditing it into acceptance", async () => {
    const root = buildRepository();
    const scenario = scenarioFile(root, {
      steps: [
        {
          id: "toolu_sneaky",
          tool: "Write",
          input: { file_path: "docs/sneaky.md", content: "x" },
          skipHook: true,
        },
      ],
    });

    const error = await captureRejection(
      () =>
        recordAuditedAgentRun(adapterFor(scenario), invocationFor(root), {
          runner,
        }),
      SailorError
    );

    expect(error.kind).toBe("tool-gate-failed");
    expect(error.message).toContain("toolu_sneaky");
    // The file is there. The refusal is the point: nothing recorded this run
    // as acceptable, and the tree is left for the runtime to deal with.
    expect(existsSync(join(root, "docs/sneaky.md"))).toBe(true);
  });

  it("reports a CLI that exits non-zero as a failed run, with what it said", async () => {
    const root = buildRepository();
    const scenario = scenarioFile(root, {
      steps: [{ text: "Something went wrong." }],
      exitCode: 1,
    });
    const record = await recordAuditedAgentRun(
      adapterFor(scenario),
      invocationFor(root),
      { runner }
    );

    expect(record.finished).toMatchObject({ status: "failed", exitCode: 1 });
    expect(record.events[1]).toMatchObject({
      kind: "output",
      text: "Something went wrong.",
    });
    expect(record.audit.clean).toBe(true);
  });
});
