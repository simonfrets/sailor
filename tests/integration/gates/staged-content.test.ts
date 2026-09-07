import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createDefaultReportId,
  runPhaseGates,
} from "../../../src/gates/run-phase-gates.js";
import type { PhaseGateReport } from "../../../src/gates/run-phase-gates.js";
import { readSailorTemplateFile } from "../../../src/install/sailor-templates.js";
import {
  NODE_COMMAND_RUNNER_DEFAULTS,
  createNodeCommandRunner,
} from "../../../src/processes/node-command-runner.js";
import { discoverProjectProfile } from "../../../src/project/discover-project-profile.js";
import { loadRuleBundle } from "../../../src/rules/load-rule-bundle.js";
import { resolveRuleSet } from "../../../src/rules/resolve-rule-set.js";
import { cleanEnvironment, initRepository, runGit } from "../../helpers/git.js";
import {
  createTempDirectory,
  removeTempDirectories,
} from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const CONFLICTED = "x\n<<<<<<< HEAD\n1\n=======\n2\n>>>>>>> b\n";

/** The real shipped bundle, so this covers the rule projects actually get. */
const ruleSet = resolveRuleSet([
  {
    origin: "builtin",
    location: "rules/git.yaml",
    bundle: loadRuleBundle(
      readSailorTemplateFile(process.cwd(), "rules/git.yaml"),
      { source: "rules/git.yaml" }
    ),
  },
]);

/**
 * Runs the pre-commit gate the way a hook would, with git naming the index the
 * commit is actually being built from.
 */
const gateWithIndex = async (
  root: string,
  indexFile: string | null
): Promise<PhaseGateReport> =>
  runPhaseGates({
    ruleSet,
    phase: "pre-commit",
    agentId: null,
    profile: await discoverProjectProfile({
      root,
      runner: createNodeCommandRunner({
        ...NODE_COMMAND_RUNNER_DEFAULTS,
        baseEnv: cleanEnvironment(),
      }),
    }),
    runner: createNodeCommandRunner({
      ...NODE_COMMAND_RUNNER_DEFAULTS,
      // Built from a scrubbed environment: this suite runs under the
      // repository's own pre-commit hook, where GIT_INDEX_FILE is already set
      // to something that has nothing to do with the fixture.
      baseEnv: cleanEnvironment(
        indexFile === null ? {} : { GIT_INDEX_FILE: indexFile }
      ),
    }),
    now: () => new Date("2026-08-26T00:00:00.000Z"),
    createReportId: createDefaultReportId,
  });

/**
 * A repository mid-`git commit -- a.txt`: the main index holds a clean a.txt,
 * the temporary index git built for this commit holds the conflicted one.
 */
const buildPartialCommit = (): { root: string; temporaryIndex: string } => {
  const root = createTempDirectory("sailor-staged-");
  const temporaryIndex = join(root, "temporary-index");

  initRepository(root);
  writeFileSync(join(root, "a.txt"), "clean\n");
  runGit(root, ["add", "a.txt"]);

  writeFileSync(join(root, "a.txt"), CONFLICTED);
  runGit(root, ["add", "a.txt"], { GIT_INDEX_FILE: temporaryIndex });

  return { root, temporaryIndex };
};

describe("the shipped staged-content gate", () => {
  it("blocks a partial commit whose temporary index carries conflict markers", async () => {
    // `git commit -- <path>`, `commit -p` and `commit --only` all build a
    // temporary index and name it in GIT_INDEX_FILE. A gate that cannot see it
    // reads the stale on-disk index, passes, and lets the markers be committed.
    const { root, temporaryIndex } = buildPartialCommit();

    const report = await gateWithIndex(root, temporaryIndex);

    expect(report.blocked).toBe(true);
    expect(report.results[0]).toMatchObject({
      ruleId: "git.no-conflict-markers",
      checkId: "git-diff-check",
      status: "failed",
    });
    expect(report.results[0]?.stdout).toContain("leftover conflict marker");
  });

  it("passes when the index the commit is built from is clean", async () => {
    const root = createTempDirectory("sailor-staged-");

    initRepository(root);
    writeFileSync(join(root, "a.txt"), "clean\n");
    runGit(root, ["add", "a.txt"]);

    const report = await gateWithIndex(root, null);

    expect(report.blocked).toBe(false);
    expect(report.results[0]?.status).toBe("passed");
  });

  it("reads the main index when git names no temporary one", async () => {
    const root = createTempDirectory("sailor-staged-");

    initRepository(root);
    writeFileSync(join(root, "a.txt"), CONFLICTED);
    runGit(root, ["add", "a.txt"]);

    const report = await gateWithIndex(root, null);

    expect(report.blocked).toBe(true);
  });
});
