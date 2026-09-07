import { existsSync } from "node:fs";

import { loadRuleDirectory } from "../rules/load-rule-directory.js";
import { resolveRuleSet } from "../rules/resolve-rule-set.js";
import type { ResolvedRuleSet, RuleSource } from "../rules/resolve-rule-set.js";
import { SailorError } from "./sailor-error.js";
import { SAILOR_DIRECTORY, SAILOR_PATHS, sailorPath } from "./layout.js";

export interface LoadSailorRuleSetOptions {
  readonly projectRoot: string;
}

/**
 * Loads the effective rule set of an installed project.
 *
 * The two directories are two precedence layers, not one flattened pile.
 * Bundles the installer manages are the `builtin` layer; a project's own
 * bundles in `rules/custom/` are the `project` layer and therefore may replace
 * a shipped rule by declaring `overrides: true`. That is what lets a project
 * change both its compiled agent policy and its gates by editing YAML alone.
 */
export const loadSailorRuleSet = (
  options: LoadSailorRuleSetOptions
): ResolvedRuleSet => {
  const rulesDirectory = sailorPath(options.projectRoot, SAILOR_PATHS.rules);

  if (!existsSync(rulesDirectory)) {
    throw new SailorError(
      "not-installed",
      `${SAILOR_DIRECTORY} is not installed in this project (no ${SAILOR_DIRECTORY}/${SAILOR_PATHS.rules} directory); run \`sailor init\``
    );
  }

  const sources: readonly RuleSource[] = [
    ...loadRuleDirectory({
      directory: rulesDirectory,
      origin: "builtin",
      label: `${SAILOR_DIRECTORY}/${SAILOR_PATHS.rules}`,
    }),
    ...loadRuleDirectory({
      directory: sailorPath(options.projectRoot, SAILOR_PATHS.customRules),
      origin: "project",
      label: `${SAILOR_DIRECTORY}/${SAILOR_PATHS.customRules}`,
    }),
  ];

  if (sources.length === 0) {
    throw new SailorError(
      "invalid-config",
      `no rule bundles were found in ${SAILOR_DIRECTORY}/${SAILOR_PATHS.rules}`
    );
  }

  return resolveRuleSet(sources);
};
