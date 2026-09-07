import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadRuleDirectory } from "../../../src/rules/load-rule-directory.js";
import { RuleValidationError } from "../../../src/rules/rule-error.js";
import { captureError } from "../../helpers/expect-error.js";
import { ruleBundleYaml } from "../../helpers/rule-yaml.js";
import {
  createTempDirectory,
  removeTempDirectories,
} from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const buildRuleDirectory = (
  files: Readonly<Record<string, string>>
): string => {
  const directory = createTempDirectory("sailor-rules-");

  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents);
  }

  return directory;
};

describe("loadRuleDirectory", () => {
  it("returns no sources for a directory that does not exist", () => {
    const directory = join(createTempDirectory("sailor-rules-"), "missing");

    expect(
      loadRuleDirectory({ directory, origin: "builtin", label: "rules" })
    ).toEqual([]);
  });

  it("loads yaml bundles in code-unit filename order", () => {
    const directory = buildRuleDirectory({
      "zeta.yaml": ruleBundleYaml({ bundleId: "zeta", ruleId: "zeta.one" }),
      "alpha.yml": ruleBundleYaml({ bundleId: "alpha", ruleId: "alpha.one" }),
    });

    const sources = loadRuleDirectory({
      directory,
      origin: "project",
      label: ".sailor/rules/custom",
    });

    expect(sources.map((source) => source.bundle.id)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(sources.map((source) => source.origin)).toEqual([
      "project",
      "project",
    ]);
    expect(sources.map((source) => source.location)).toEqual([
      ".sailor/rules/custom/alpha.yml",
      ".sailor/rules/custom/zeta.yaml",
    ]);
  });

  it("ignores subdirectories and non-yaml files", () => {
    const directory = buildRuleDirectory({
      "base.yaml": ruleBundleYaml({ bundleId: "base", ruleId: "base.one" }),
      "notes.md": "# not a rule bundle",
      ".gitkeep": "",
    });
    mkdirSync(join(directory, "custom"));
    writeFileSync(
      join(directory, "custom", "extra.yaml"),
      ruleBundleYaml({ bundleId: "extra", ruleId: "extra.one" })
    );

    const sources = loadRuleDirectory({
      directory,
      origin: "builtin",
      label: ".sailor/rules",
    });

    expect(sources.map((source) => source.bundle.id)).toEqual(["base"]);
  });

  it("reports the display label, not the machine path, on a bad bundle", () => {
    const directory = buildRuleDirectory({ "broken.yaml": "version: 2\n" });

    const error = captureError(
      () =>
        loadRuleDirectory({
          directory,
          origin: "builtin",
          label: ".sailor/rules",
        }),
      RuleValidationError
    );

    expect(error.source).toBe(".sailor/rules/broken.yaml");
  });
});
