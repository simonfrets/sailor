import { loadSailorRuleSet } from "../../sailor/load-sailor-rule-set.js";
import { resolveProjectRoot } from "../../sailor/resolve-project-root.js";
import { CLI_EXIT_CODES } from "../exit-codes.js";
import { formatRuleSetSummary } from "../format-rule-set.js";
import type { CliCommandHandler } from "../run-cli.js";

/**
 * Loads and resolves every rule bundle, reporting the first file that does not
 * validate. Nothing is executed, so this is safe to run at any time.
 */
export const validateRules: CliCommandHandler = async (context) => {
  const projectRoot = await resolveProjectRoot({
    cwd: context.cwd,
    runner: context.runner,
  });

  context.streams.stdout.write(
    formatRuleSetSummary(loadSailorRuleSet({ projectRoot }))
  );

  return CLI_EXIT_CODES.ok;
};
