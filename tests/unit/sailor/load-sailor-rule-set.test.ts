import { SailorError } from "../../../src/sailor/sailor-error.js";
import { loadSailorRuleSet } from "../../../src/sailor/load-sailor-rule-set.js";
import { RuleResolutionError } from "../../../src/rules/rule-error.js";
import { buildSailorProject } from "../../helpers/sailor-project.js";
import { captureError } from "../../helpers/expect-error.js";
import { ruleBundleYaml } from "../../helpers/rule-yaml.js";
import { removeTempDirectories } from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

describe("loadSailorRuleSet", () => {
  it("refuses a project with no sailor rules directory", () => {
    const root = buildSailorProject();

    expect(() => loadSailorRuleSet({ projectRoot: root })).toThrow(
      /is not installed/
    );
  });

  it("refuses a sailor rules directory that holds no bundles", () => {
    const root = buildSailorProject({
      files: { ".sailor/rules/.gitkeep": "" },
    });

    const error = captureError(
      () => loadSailorRuleSet({ projectRoot: root }),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
  });

  it("layers custom bundles over shipped bundles", () => {
    const root = buildSailorProject({
      rules: {
        "base.yaml": ruleBundleYaml({
          bundleId: "sailor-base",
          ruleId: "base.one",
          instruction: "Shipped instruction.",
        }),
      },
      customRules: {
        "team.yaml": ruleBundleYaml({
          bundleId: "team",
          ruleId: "base.one",
          instruction: "Team instruction.",
          overrides: true,
        }),
      },
    });

    const ruleSet = loadSailorRuleSet({ projectRoot: root });

    expect(ruleSet.rules).toHaveLength(1);
    expect(ruleSet.rules[0]?.instruction).toBe("Team instruction.");
    expect(ruleSet.rules[0]?.origin).toBe("project");
    expect(ruleSet.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("propagates an unresolved duplicate rule id", () => {
    const root = buildSailorProject({
      rules: {
        "base.yaml": ruleBundleYaml({
          bundleId: "sailor-base",
          ruleId: "base.one",
        }),
      },
      customRules: {
        "team.yaml": ruleBundleYaml({ bundleId: "team", ruleId: "base.one" }),
      },
    });

    expect(() => loadSailorRuleSet({ projectRoot: root })).toThrow(
      RuleResolutionError
    );
  });
});
