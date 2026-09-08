import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  listSailorTemplateFiles,
  readSailorTemplateFile,
} from "../../src/install/sailor-templates.js";
import { loadSailorRuleSet } from "../../src/sailor/load-sailor-rule-set.js";
import { agentContextDirectory } from "../../src/tasks/context-path.js";
import { requireTask } from "../../src/tasks/task-file.js";
import {
  approveSpecification,
  createTask,
  transitionTask,
} from "../../src/tasks/transition-task.js";
import { updateTaskFile } from "../../src/tasks/update-task-file.js";
import { initRepository, runGit } from "./git.js";
import { createTempDirectory } from "./temp-directory.js";

export const DRIVEN_TASK_ID = "add-greeting";
export const DRIVEN_TASK_TITLE = "Add a greeting";
export const DRIVEN_RUN_ID = "run-1";
export const DRIVEN_AT = new Date("2026-09-08T09:00:00.000Z");

const packageRoot = process.cwd();

/** A rule whose one check is a `command`, so the gate needs no project script. */
const gateRule = (argv: readonly string[]): string =>
  `version: 1
id: driver-fixture
description: What the fixture's handoffs are gated on
rules:
  - id: fixture.handoff
    description: The handoff gate this fixture runs
    severity: error
    appliesTo: [specifier, coder, cleaner, architect, hardener, qa]
    instruction: Leave the tree in a state the handoff check accepts.
    checks:
      - id: fixture-handoff-check
        runner: command
        argv: ${JSON.stringify(argv)}
        phases: [pre-handoff]
        required: true
        timeoutMs: 60000
`;

export const writeProjectFile = (
  root: string,
  path: string,
  contents: string
): void => {
  const absolute = join(root, path);

  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
};

export interface DrivenProjectFixture {
  /** One scenario per agent, as `fake-claude.ts` reads it. */
  readonly scenario: Record<string, unknown>;
  /** The pre-handoff check's argv. Defaults to one that passes. */
  readonly gateArgv?: readonly string[];
}

/**
 * A committed project with the six shipped agent definitions, one gated rule,
 * and `providers.yaml` pointing `claude` at the fake executable.
 *
 * The definitions are the ones the sailor ships rather than doubles written to
 * suit the assertion, so the write scopes the audit holds each agent to are
 * the real ones.
 */
export const buildDrivenProject = (fixture: DrivenProjectFixture): string => {
  const root = createTempDirectory("sailor-drive-");

  initRepository(root);
  writeProjectFile(root, ".sailor/.gitignore", "node_modules/\nstate/\n");
  writeProjectFile(root, ".sailor/tasks.yaml", "version: 1\ntasks: []\n");
  writeProjectFile(
    root,
    ".sailor/rules/base.yaml",
    gateRule(
      fixture.gateArgv ?? [process.execPath, "--eval", "process.exit(0)"]
    )
  );

  for (const file of listSailorTemplateFiles(packageRoot)) {
    if (/^agents\/[^/]+\.yaml$/.test(file.installedPath)) {
      writeProjectFile(
        root,
        join(".sailor", file.installedPath),
        readSailorTemplateFile(packageRoot, file.templatePath)
      );
    }
  }

  writeProjectFile(
    root,
    "scenario.json",
    `${JSON.stringify(fixture.scenario)}\n`
  );
  writeProjectFile(
    root,
    ".sailor/config/models.yaml",
    "version: 1\nmodels:\n  claude:\n    coding-high: sonnet\n"
  );
  writeProjectFile(
    root,
    ".sailor/config/providers.yaml",
    `version: 1
default: claude
agents: {}
claude:
  command: ${JSON.stringify([
    process.execPath,
    "--disable-warning=ExperimentalWarning",
    "--import",
    join(packageRoot, "tests/helpers/register-typescript-sources.mjs"),
    join(packageRoot, "tests/fixtures/fake-claude.ts"),
    join(root, "scenario.json"),
  ])}
  maxBudgetUsd: null
`
  );
  writeProjectFile(root, "package.json", '{"name":"host","private":true}\n');
  runGit(root, ["add", "--all"]);
  runGit(root, ["commit", "--quiet", "--message", "baseline"]);

  return root;
};

/** Walks a fresh task to `awaiting_approval` and approves it, as a person would. */
export const approveDrivenTask = async (root: string): Promise<void> => {
  await updateTaskFile(root, (file) =>
    createTask(file, {
      id: DRIVEN_TASK_ID,
      title: DRIVEN_TASK_TITLE,
      runId: DRIVEN_RUN_ID,
      at: DRIVEN_AT,
    })
  );

  const { sha256: ruleSetSha256 } = loadSailorRuleSet({ projectRoot: root });

  for (const to of ["specified", "awaiting_approval"] as const) {
    await updateTaskFile(root, (file) =>
      transitionTask(file, {
        taskId: DRIVEN_TASK_ID,
        expectedRevision: requireTask(file, DRIVEN_TASK_ID).revision,
        to,
        toAgent: to === "specified" ? "specifier" : null,
        ruleSetSha256,
        at: DRIVEN_AT,
      })
    );
  }

  await updateTaskFile(root, (file) =>
    approveSpecification(file, {
      taskId: DRIVEN_TASK_ID,
      expectedRevision: requireTask(file, DRIVEN_TASK_ID).revision,
      approvedBy: "a-reviewer",
      acceptance: {
        features: [
          { path: "features/greeting.feature", sha256: "c".repeat(64) },
        ],
        procedure: { path: "docs/qa/greeting.yaml", sha256: "d".repeat(64) },
      },
      ruleSetSha256,
      at: DRIVEN_AT,
    })
  );
};

export const readContextStep = (
  id: string,
  agentId: string
): Record<string, unknown> => ({
  id,
  tool: "Read",
  input: {
    file_path: `${agentContextDirectory(DRIVEN_RUN_ID, agentId)}/context.json`,
  },
});

export const writeFileStep = (
  id: string,
  path: string,
  content: string
): Record<string, unknown> => ({
  id,
  tool: "Write",
  input: { file_path: path, content },
});

/**
 * A scenario in which every agent says something and touches nothing.
 *
 * No `tool_use` means no hook, which is what lets a test drive the whole
 * pipeline without the built gate program this source tree has no `dist/`
 * for. Anything asserting what the gate decided needs the tool steps.
 */
export const talkOnly = (): Record<string, unknown> => ({
  agents: Object.fromEntries(
    ["coder", "cleaner", "architect", "hardener", "qa"].map((agentId) => [
      agentId,
      { steps: [{ text: `The ${agentId} had nothing to change.` }] },
    ])
  ),
});
