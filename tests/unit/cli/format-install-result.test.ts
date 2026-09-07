import { join } from "node:path";

import { formatInstallResult } from "../../../src/cli/format-install-result.js";
import type { InstallSailorResult } from "../../../src/install/install-sailor.js";

const RESULT: InstallSailorResult = {
  projectRoot: join("/tmp", "host"),
  sailorVersion: "0.1.0",
  created: [],
  replaced: [],
  kept: [],
  orphaned: [],
  removed: [],
  dependenciesInstalled: true,
  dependencyFailure: null,
  hooks: [],
  previousHooksPath: null,
  previousHooksPathScope: null,
  gitHooksPathChanged: false,
};

const format = (overrides: Partial<InstallSailorResult> = {}): string =>
  formatInstallResult({ ...RESULT, ...overrides });

describe("formatInstallResult", () => {
  it("names the sailor version and the directory it owns", () => {
    expect(format()).toContain(
      `Sailor 0.1.0 installed in ${join("/tmp", "host", ".sailor")}`
    );
  });

  it("lists what it created and what it replaced", () => {
    const text = format({
      created: ["rules/base.yaml"],
      replaced: ["config/project.yaml"],
      kept: ["agents/coder.yaml", "agents/qa.yaml"],
    });

    expect(text).toContain("1 file created, 1 replaced, 2 already up to date");
    expect(text).toContain("  + rules/base.yaml");
    expect(text).toContain("  ~ config/project.yaml");
  });

  it("counts files that were already correct without listing them", () => {
    expect(format({ kept: ["agents/coder.yaml"] })).not.toContain(
      "agents/coder.yaml"
    );
  });

  it("reports an orphaned managed file and says it was left alone", () => {
    const text = format({ orphaned: ["rules/retired.yaml"] });

    expect(text).toContain("1 managed file this version no longer ships");
    expect(text).toContain("  ? rules/retired.yaml");
    expect(text).toContain("Delete them yourself");
  });

  it("reports a hook dispatcher it deleted and says why", () => {
    const text = format({ removed: ["hooks/pre-commit"] });

    expect(text).toContain("1 hook dispatcher removed");
    expect(text).toContain("git would otherwise still run them");
    expect(text).toContain("  - hooks/pre-commit");
  });

  it("says nothing about removals when there are none", () => {
    expect(format()).not.toContain("removed, because");
  });

  it("says nothing about orphans when there are none", () => {
    expect(format()).not.toContain("no longer ships");
  });

  it("says whether the private dependency tree was resolved", () => {
    expect(format()).toContain(
      "Runtime dependencies resolved in .sailor/node_modules"
    );
    expect(format({ dependenciesInstalled: false })).toContain(
      "Runtime dependencies were not installed"
    );
  });

  it("says which hooks git now runs and what each preserves", () => {
    const text = format({
      hooks: [
        { hook: "commit-msg", chained: ".git/hooks/commit-msg" },
        { hook: "pre-commit", chained: null },
      ],
      gitHooksPathChanged: true,
    });

    expect(text).toContain("git now dispatches 2 hooks through .sailor/hooks");
    expect(text).toContain("  commit-msg runs .git/hooks/commit-msg first");
    expect(text).toContain("  pre-commit\n");
  });

  it("does not claim to have changed a hooks path it left alone", () => {
    expect(
      format({ hooks: [{ hook: "pre-commit", chained: null }] })
    ).toContain("git dispatches 1 hook through .sailor/hooks");
  });

  it("records where the project's own hooks path pointed", () => {
    expect(
      format({
        hooks: [{ hook: "pre-commit", chained: ".husky/pre-commit" }],
        previousHooksPath: ".husky",
        previousHooksPathScope: "local",
      })
    ).toContain("`core.hooksPath` was `.husky`");
  });

  it("points at CI the first time it takes the hooks over", () => {
    const text = format({
      hooks: [{ hook: "pre-commit", chained: null }],
      gitHooksPathChanged: true,
    });

    expect(text).toContain("--no-verify");
    expect(text).toContain(".sailor/ci/github-actions.yml");
    expect(text).toContain(".github/workflows/");
  });

  it("does not repeat the CI reminder on every later install", () => {
    expect(
      format({ hooks: [{ hook: "pre-commit", chained: null }] })
    ).not.toContain("--no-verify");
  });

  it("warns that a hooks path from outside the repository is not shared", () => {
    const text = format({
      hooks: [
        { hook: "pre-commit", chained: "/home/x/globalhooks/pre-commit" },
      ],
      previousHooksPath: "/home/x/globalhooks",
      previousHooksPathScope: "inherited",
    });

    expect(text).toContain("set outside this repository");
    expect(text).toContain("will not exist for anyone else");
  });

  it("says nothing about hooks when it manages none", () => {
    expect(format()).not.toContain("dispatches");
  });

  it("still reports the install when the runtime could not be resolved", () => {
    // Throwing here used to discard the whole summary, leaving an npm error as
    // the only thing anyone saw.
    const text = format({
      created: ["rules/base.yaml"],
      dependenciesInstalled: false,
      dependencyFailure: "npm install failed\nnpm error code ETARGET",
    });

    expect(text).toContain("  + rules/base.yaml");
    expect(text).toContain("git hooks were left alone");
    expect(text).toContain("  npm error code ETARGET");
    expect(text).toContain("re-run `sailor init`");
  });

  it("pluralises the file count", () => {
    expect(format({ created: ["a", "b"] })).toContain("2 files created");
  });
});
