import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ToolPolicy } from "../../../src/enforcement/tool-policy.js";
import {
  auditWorkingTree,
  snapshotWorkingTree,
} from "../../../src/enforcement/working-tree-audit.js";
import { SailorError } from "../../../src/sailor/sailor-error.js";
import {
  NODE_COMMAND_RUNNER_DEFAULTS,
  createNodeCommandRunner,
} from "../../../src/processes/node-command-runner.js";
import { captureRejection } from "../../helpers/expect-error.js";
import { cleanEnvironment, initRepository, runGit } from "../../helpers/git.js";
import {
  createTempDirectory,
  removeTempDirectories,
} from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const runner = createNodeCommandRunner({
  ...NODE_COMMAND_RUNNER_DEFAULTS,
  baseEnv: cleanEnvironment(),
});

const coder: ToolPolicy = {
  tools: { read: true, search: true, edit: true, execute: true },
  writeScopes: ["src/**", "tests/**"],
  projectScripts: ["test"],
  contextDirectory: ".sailor/state/runs/run-1/agents/coder",
  packageManager: "npm",
};

const write = (root: string, path: string, contents: string): void => {
  const absolute = join(root, path);

  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
};

/** A committed project with the sailor's ignore rules in place. */
const buildRepository = (): string => {
  const root = createTempDirectory("sailor-audit-repo-");

  initRepository(root);
  write(root, ".sailor/.gitignore", "node_modules/\nstate/\n");
  write(root, ".sailor/tasks.yaml", "version: 1\ntasks: []\n");
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "docs/readme.md", "# Readme\n");
  runGit(root, ["add", "--all"]);
  runGit(root, ["commit", "--quiet", "--message", "baseline"]);

  return root;
};

const staged = (root: string): string =>
  runGit(root, ["diff", "--cached", "--name-only"]).stdout;

describe("auditing a real working tree", () => {
  it("finds every path the agent changed and names the ones it may not have", async () => {
    const root = buildRepository();
    const indexFile = join(root, ".sailor", "state", "audit", "run-1.index");

    const before = await snapshotWorkingTree({
      projectRoot: root,
      runner,
      indexFile,
    });

    write(root, "src/a.ts", "export const a = 2;\n");
    write(root, "tests/a.test.ts", "// new\n");
    write(root, "docs/new.md", "# New\n");
    write(root, ".sailor/tasks.yaml", "version: 1\ntasks: [tampered]\n");
    write(root, ".sailor/state/runs/run-1/agents/coder/notes.md", "scratch\n");
    rmSync(join(root, "docs/readme.md"));

    const after = await snapshotWorkingTree({
      projectRoot: root,
      runner,
      indexFile,
    });

    const audit = await auditWorkingTree({
      projectRoot: root,
      runner,
      before,
      after,
      policy: coder,
    });

    expect(before.tree).not.toBe(after.tree);
    expect([...audit.changedPaths].sort()).toEqual([
      ".sailor/tasks.yaml",
      "docs/new.md",
      "docs/readme.md",
      "src/a.ts",
      "tests/a.test.ts",
    ]);
    expect(audit.clean).toBe(false);
    expect(
      audit.violations.map((violation) => [
        violation.path,
        violation.decision.denial,
      ])
    ).toEqual([
      [".sailor/tasks.yaml", "sailor-owned"],
      ["docs/new.md", "outside-write-scope"],
      ["docs/readme.md", "outside-write-scope"],
    ]);
  });

  it("leaves the repository's own index alone", async () => {
    const root = buildRepository();
    const indexFile = join(root, ".sailor", "state", "audit", "run-1.index");

    write(root, "src/b.ts", "export const b = 1;\n");

    expect(staged(root)).toBe("");

    const before = await snapshotWorkingTree({
      projectRoot: root,
      runner,
      indexFile,
    });

    write(root, "src/c.ts", "export const c = 1;\n");

    const after = await snapshotWorkingTree({
      projectRoot: root,
      runner,
      indexFile,
    });

    await auditWorkingTree({
      projectRoot: root,
      runner,
      before,
      after,
      policy: coder,
    });

    // Both snapshots staged the whole tree, into the private index. Nothing
    // reached the real one: a gate that quietly staged files would change what
    // the next commit contains.
    expect(staged(root)).toBe("");
    expect(runGit(root, ["status", "--porcelain"]).stdout).toBe(
      "?? src/b.ts\n?? src/c.ts\n"
    );
  });

  it("is clean when nothing changed or only scoped files did", async () => {
    const root = buildRepository();
    const indexFile = join(root, ".sailor", "state", "audit", "run-1.index");

    const before = await snapshotWorkingTree({
      projectRoot: root,
      runner,
      indexFile,
    });
    const unchanged = await snapshotWorkingTree({
      projectRoot: root,
      runner,
      indexFile,
    });

    expect(unchanged).toEqual(before);

    write(root, "src/a.ts", "export const a = 3;\n");

    const after = await snapshotWorkingTree({
      projectRoot: root,
      runner,
      indexFile,
    });

    expect(
      await auditWorkingTree({
        projectRoot: root,
        runner,
        before,
        after,
        policy: coder,
      })
    ).toEqual({ changedPaths: ["src/a.ts"], violations: [], clean: true });
  });

  it("refuses to audit a project that is not a repository", async () => {
    const root = createTempDirectory("sailor-audit-plain-");

    const error = await captureRejection(
      () =>
        snapshotWorkingTree({
          projectRoot: root,
          runner,
          indexFile: join(root, "audit.index"),
        }),
      SailorError
    );

    expect(error.kind).toBe("working-tree-audit-failed");
    expect(error.message).toContain("git add --all exited with code 128");
  });
});
