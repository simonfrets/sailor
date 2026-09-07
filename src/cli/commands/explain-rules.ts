import { loadSailorRuleSet } from "../../sailor/load-sailor-rule-set.js";
import { resolveProjectRoot } from "../../sailor/resolve-project-root.js";
import { compileAgentPolicy } from "../../prompts/compile-agent-policy.js";
import { CLI_EXIT_CODES } from "../exit-codes.js";
import { formatRuleSetExplanation } from "../format-rule-set.js";
import type { CliCommandHandler } from "../run-cli.js";

/**
 * Shows what the rules resolve to.
 *
 * With `--agent` it prints the compiled policy that agent is given, which is
 * the same text the runtime will send, so what an agent is told can be
 * inspected without running one.
 */
export const explainRules: CliCommandHandler = async (context) => {
  const projectRoot = await resolveProjectRoot({
    cwd: context.cwd,
    runner: context.runner,
  });
  const ruleSet = loadSailorRuleSet({ projectRoot });
  const { agentId } = context.invocation;

  context.streams.stdout.write(
    agentId === null
      ? formatRuleSetExplanation(ruleSet)
      : compileAgentPolicy({ agentId, ruleSet })
  );

  return CLI_EXIT_CODES.ok;
};
