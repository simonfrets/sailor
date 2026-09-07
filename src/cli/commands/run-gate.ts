import {
  createDefaultReportId,
  runPhaseGates,
} from "../../gates/run-phase-gates.js";
import { SailorError } from "../../sailor/sailor-error.js";
import { loadSailorRuleSet } from "../../sailor/load-sailor-rule-set.js";
import { resolveProjectRoot } from "../../sailor/resolve-project-root.js";
import { discoverProjectProfile } from "../../project/discover-project-profile.js";
import { CLI_EXIT_CODES } from "../exit-codes.js";
import { formatPhaseGateReport } from "../format-gate-report.js";
import type { CliCommandHandler } from "../run-cli.js";

/**
 * Runs the checks that apply to one workflow phase.
 *
 * The exit code is the enforcement: a blocked phase exits non-zero, which is
 * what makes a git hook or a handoff fail rather than merely print a warning.
 */
export const runGate: CliCommandHandler = async (context) => {
  const { phase, agentId } = context.invocation;

  if (phase === null) {
    throw new SailorError(
      "invalid-config",
      "`gate` was dispatched with no phase"
    );
  }

  const projectRoot = await resolveProjectRoot({
    cwd: context.cwd,
    runner: context.runner,
  });
  const ruleSet = loadSailorRuleSet({ projectRoot });
  const profile = await discoverProjectProfile({
    root: projectRoot,
    runner: context.runner,
  });

  const report = await runPhaseGates({
    ruleSet,
    phase,
    agentId,
    profile,
    runner: context.runner,
    now: context.now,
    createReportId: createDefaultReportId,
  });

  context.streams.stdout.write(formatPhaseGateReport(report));

  return report.blocked ? CLI_EXIT_CODES.gateBlocked : CLI_EXIT_CODES.ok;
};
