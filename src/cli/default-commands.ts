import { doctor } from "./commands/doctor.js";
import { explainRules } from "./commands/explain-rules.js";
import { initSailor } from "./commands/init.js";
import { runGate } from "./commands/run-gate.js";
import { validateRules } from "./commands/validate-rules.js";
import type { CliCommandRegistry } from "./run-cli.js";

/**
 * The commands this build provides.
 *
 * The registry is still partial rather than total: a command this build does
 * not implement reports itself as unavailable instead of being registered as a
 * stub that would look like it worked.
 */
export const createDefaultCliCommands = (): CliCommandRegistry => ({
  doctor,
  gate: runGate,
  init: initSailor,
  "rules explain": explainRules,
  "rules validate": validateRules,
});
