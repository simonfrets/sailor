import {
  formatRuleSetExplanation,
  formatRuleSetSummary,
} from "../../../src/cli/format-rule-set.js";
import { resolveRuleSet } from "../../../src/rules/resolve-rule-set.js";
import type { ResolvedRuleSet } from "../../../src/rules/resolve-rule-set.js";
import { loadRuleBundle } from "../../../src/rules/load-rule-bundle.js";
import {
  projectScriptCheckYaml,
  ruleBundleYaml,
} from "../../helpers/rule-yaml.js";

const buildRuleSet = (): ResolvedRuleSet =>
  resolveRuleSet([
    {
      origin: "builtin",
      location: ".sailor/rules/base.yaml",
      bundle: loadRuleBundle(
        ruleBundleYaml({
          bundleId: "sailor-base",
          ruleId: "base.tests",
          checks: projectScriptCheckYaml({
            checkId: "native-test",
            script: "test",
            phases: ["pre-commit"],
          }),
        }),
        { source: "base.yaml" }
      ),
    },
    {
      origin: "project",
      location: ".sailor/rules/custom/team.yaml",
      bundle: loadRuleBundle(
        ruleBundleYaml({
          bundleId: "team",
          ruleId: "team.style",
          severity: "warning",
        }),
        { source: "team.yaml" }
      ),
    },
  ]);

describe("formatRuleSetSummary", () => {
  it("states the counts and the hash", () => {
    const text = formatRuleSetSummary(buildRuleSet());

    expect(text).toContain("2 rules resolved");
    expect(text).toContain("1 error, 1 warning");
    expect(text).toContain("1 executable check");
    expect(text).toMatch(/sha256 [0-9a-f]{64}/);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("reports an empty rule set without pretending it is fine", () => {
    const text = formatRuleSetSummary(resolveRuleSet([]));

    expect(text).toContain("0 rules resolved");
    expect(text).toContain("0 executable checks");
  });
});

describe("formatRuleSetExplanation", () => {
  it("lists every rule with its origin, agents and checks", () => {
    const text = formatRuleSetExplanation(buildRuleSet());

    expect(text).toContain("base.tests [error] from builtin bundle");
    expect(text).toContain("sailor-base");
    expect(text).toContain("agents: coder");
    expect(text).toContain("scopes: the whole project");
    expect(text).toContain("native-test: project script `test` at pre-commit");
    expect(text).toContain("team.style [warning] from project bundle");
    expect(text).toContain("no executable checks");
  });

  it("describes a command check by its argument vector", () => {
    const ruleSet = resolveRuleSet([
      {
        origin: "builtin",
        location: ".sailor/rules/git.yaml",
        bundle: loadRuleBundle(
          [
            "version: 1",
            "id: sailor-git",
            "description: Git rules",
            "",
            "rules:",
            "  - id: git.no-conflict-markers",
            "    description: Reject conflict markers",
            "    severity: error",
            "    appliesTo: [coder, qa]",
            '    scopes: ["**/*.ts"]',
            "    instruction: Resolve every conflict marker.",
            "    checks:",
            "      - id: git-diff-check",
            "        runner: command",
            "        argv: [git, diff, --check, --cached]",
            "        phases: [pre-commit, pre-push]",
            "",
          ].join("\n"),
          { source: "git.yaml" }
        ),
      },
    ]);

    const text = formatRuleSetExplanation(ruleSet);

    expect(text).toContain("agents: coder, qa");
    expect(text).toContain("scopes: **/*.ts");
    expect(text).toContain(
      "git-diff-check: `git diff --check --cached` at pre-commit, pre-push"
    );
  });

  it("says so when nothing is resolved", () => {
    expect(formatRuleSetExplanation(resolveRuleSet([]))).toContain(
      "No rules are resolved."
    );
  });
});
