import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ToolPolicy } from "../../../src/enforcement/tool-policy.js";
import {
  WORKING_TREE_AUDIT_TIMEOUT_MS,
  auditWorkingTree,
  snapshotWorkingTree,
} from "../../../src/enforcement/working-tree-audit.js";
import { SailorError } from "../../../src/sailor/sailor-error.js";
import type { CommandRequest } from "../../../src/processes/command-runner.js";
import { captureRejection } from "../../helpers/expect-error.js";
import {
  at,
  createFakeCommandRunner,
  exited,
  spawnFailed,
  timedOut,
} from "../../helpers/fake-command-runner.js";
import type { PlannedCommandResult } from "../../helpers/fake-command-runner.js";
import {
  createTempDirectory,
  removeTempDirectories,
} from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const ROOT = "/tmp/project";
const BEFORE = "a".repeat(40);
const AFTER = "b".repeat(40);

const coder: ToolPolicy = {
  tools: { read: true, search: true, edit: true, execute: true },
  writeScopes: ["src/**", "tests/**"],
  projectScripts: ["test"],
  contextDirectory: ".sailor/state/runs/run-1/agents/coder",
  packageManager: "npm",
};

const respondInOrder =
  (
    ...results: readonly PlannedCommandResult[]
  ): ((request: CommandRequest, index: number) => PlannedCommandResult) =>
  (_request, index) =>
    at(results, index);

describe("snapshotWorkingTree", () => {
  it("stages everything into a private index and writes it as a tree", async () => {
    const indexFile = join(createTempDirectory("sailor-audit-"), "audit.index");
    const runner = createFakeCommandRunner(
      respondInOrder(exited(0), exited(0, { stdout: `${BEFORE}\n` }))
    );

    const snapshot = await snapshotWorkingTree({
      projectRoot: ROOT,
      runner: runner.run,
      indexFile,
    });

    expect(snapshot).toEqual({ tree: BEFORE });
    expect(runner.requests).toEqual([
      {
        command: { executable: "git", args: ["add", "--all"] },
        cwd: ROOT,
        env: { GIT_INDEX_FILE: indexFile },
        timeoutMs: WORKING_TREE_AUDIT_TIMEOUT_MS,
      },
      {
        command: { executable: "git", args: ["write-tree"] },
        cwd: ROOT,
        env: { GIT_INDEX_FILE: indexFile },
        timeoutMs: WORKING_TREE_AUDIT_TIMEOUT_MS,
      },
    ]);
  });

  it("starts from an empty index rather than whatever a previous snapshot left", async () => {
    const indexFile = join(createTempDirectory("sailor-audit-"), "audit.index");

    writeFileSync(indexFile, "stale");

    const runner = createFakeCommandRunner(
      respondInOrder(exited(0), exited(0, { stdout: `${BEFORE}\n` }))
    );

    await snapshotWorkingTree({
      projectRoot: ROOT,
      runner: runner.run,
      indexFile,
    });

    // The fake spawns nothing, so the only way the file is gone is that the
    // snapshot removed it before asking git to stage into it.
    expect(existsSync(indexFile)).toBe(false);
  });

  it("creates the directory the index lives in", async () => {
    const indexFile = join(
      createTempDirectory("sailor-audit-"),
      "state",
      "audit",
      "run-1.index"
    );
    const runner = createFakeCommandRunner(
      respondInOrder(exited(0), exited(0, { stdout: `${BEFORE}\n` }))
    );

    await snapshotWorkingTree({
      projectRoot: ROOT,
      runner: runner.run,
      indexFile,
    });

    expect(existsSync(join(indexFile, ".."))).toBe(true);
  });

  it("honours a caller's timeout", async () => {
    const runner = createFakeCommandRunner(
      respondInOrder(exited(0), exited(0, { stdout: `${BEFORE}\n` }))
    );

    await snapshotWorkingTree({
      projectRoot: ROOT,
      runner: runner.run,
      indexFile: join(createTempDirectory("sailor-audit-"), "i"),
      timeoutMs: 5_000,
    });

    expect(at(runner.requests, 0).timeoutMs).toBe(5_000);
    expect(at(runner.requests, 1).timeoutMs).toBe(5_000);
  });

  it("reports a failed stage with git's own words rather than a clean snapshot", async () => {
    const runner = createFakeCommandRunner(
      respondInOrder(
        exited(128, { stderr: "fatal: not a git repository\n" }),
        exited(0, { stdout: `${BEFORE}\n` })
      )
    );

    const error = await captureRejection(
      () =>
        snapshotWorkingTree({
          projectRoot: ROOT,
          runner: runner.run,
          indexFile: join(createTempDirectory("sailor-audit-"), "i"),
        }),
      SailorError
    );

    expect(error.kind).toBe("working-tree-audit-failed");
    expect(error.message).toContain("git add --all exited with code 128");
    expect(error.details).toEqual(["fatal: not a git repository"]);
    expect(runner.requests).toHaveLength(1);
  });

  it("refuses a tree id that is not one", async () => {
    const runner = createFakeCommandRunner(
      respondInOrder(exited(0), exited(0, { stdout: "not a sha\n" }))
    );

    const error = await captureRejection(
      () =>
        snapshotWorkingTree({
          projectRoot: ROOT,
          runner: runner.run,
          indexFile: join(createTempDirectory("sailor-audit-"), "i"),
        }),
      SailorError
    );

    expect(error.kind).toBe("working-tree-audit-failed");
    expect(error.message).toContain("git write-tree did not print a tree id");
    expect(error.details).toEqual(["not a sha"]);
  });

  it("reports a git that could not start or did not finish", async () => {
    for (const planned of [spawnFailed("ENOENT"), timedOut(50)]) {
      const runner = createFakeCommandRunner(respondInOrder(planned));

      const error = await captureRejection(
        () =>
          snapshotWorkingTree({
            projectRoot: ROOT,
            runner: runner.run,
            indexFile: join(createTempDirectory("sailor-audit-"), "i"),
          }),
        SailorError
      );

      expect(error.kind).toBe("working-tree-audit-failed");
    }
  });
});

describe("auditWorkingTree", () => {
  it("asks git nothing when the tree did not change", async () => {
    const runner = createFakeCommandRunner(exited(0));

    const audit = await auditWorkingTree({
      projectRoot: ROOT,
      runner: runner.run,
      before: { tree: BEFORE },
      after: { tree: BEFORE },
      policy: coder,
    });

    expect(audit).toEqual({ changedPaths: [], violations: [], clean: true });
    expect(runner.requests).toHaveLength(0);
  });

  it("lists every changed path and holds each to the write policy", async () => {
    const runner = createFakeCommandRunner(
      exited(0, {
        stdout:
          [
            "src/a.ts",
            "docs/x.md",
            ".sailor/tasks.yaml",
            "tests/a.test.ts",
          ].join("\0") + "\0",
      })
    );

    const audit = await auditWorkingTree({
      projectRoot: ROOT,
      runner: runner.run,
      before: { tree: BEFORE },
      after: { tree: AFTER },
      policy: coder,
    });

    expect(runner.requests).toEqual([
      {
        command: {
          executable: "git",
          args: ["diff-tree", "-r", "--name-only", "-z", BEFORE, AFTER],
        },
        cwd: ROOT,
        env: null,
        timeoutMs: WORKING_TREE_AUDIT_TIMEOUT_MS,
      },
    ]);
    expect(audit.changedPaths).toEqual([
      "src/a.ts",
      "docs/x.md",
      ".sailor/tasks.yaml",
      "tests/a.test.ts",
    ]);
    expect(audit.clean).toBe(false);
    expect(audit.violations).toEqual([
      {
        path: "docs/x.md",
        decision: {
          verdict: "denied",
          denial: "outside-write-scope",
          reason:
            "`docs/x.md` is outside every write scope: `src/**`, `tests/**`",
        },
      },
      {
        path: ".sailor/tasks.yaml",
        decision: {
          verdict: "denied",
          denial: "sailor-owned",
          reason:
            "`.sailor/tasks.yaml` belongs to the sailor; no agent writes there",
        },
      },
    ]);
  });

  it("is clean when every change stayed inside the scopes", async () => {
    const runner = createFakeCommandRunner(
      exited(0, { stdout: "src/a.ts\0tests/a.test.ts\0" })
    );

    const audit = await auditWorkingTree({
      projectRoot: ROOT,
      runner: runner.run,
      before: { tree: BEFORE },
      after: { tree: AFTER },
      policy: coder,
    });

    expect(audit).toEqual({
      changedPaths: ["src/a.ts", "tests/a.test.ts"],
      violations: [],
      clean: true,
    });
  });

  it("does not fail open when git cannot compare the trees", async () => {
    const runner = createFakeCommandRunner(
      exited(128, { stderr: "fatal: bad object\n" })
    );

    const error = await captureRejection(
      () =>
        auditWorkingTree({
          projectRoot: ROOT,
          runner: runner.run,
          before: { tree: BEFORE },
          after: { tree: AFTER },
          policy: coder,
        }),
      SailorError
    );

    expect(error.kind).toBe("working-tree-audit-failed");
    expect(error.message).toContain("git diff-tree");
    expect(error.details).toEqual(["fatal: bad object"]);
  });

  it("does not fail open when git's output was cut short", async () => {
    const runner = createFakeCommandRunner(
      exited(0, { stdout: "src/a.ts\0", truncated: true })
    );

    const error = await captureRejection(
      () =>
        auditWorkingTree({
          projectRoot: ROOT,
          runner: runner.run,
          before: { tree: BEFORE },
          after: { tree: AFTER },
          policy: coder,
        }),
      SailorError
    );

    expect(error.kind).toBe("working-tree-audit-failed");
    expect(error.message).toContain("truncated");
  });
});
