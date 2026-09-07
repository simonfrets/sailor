import { installSailor } from "../../install/install-sailor.js";
import { CLI_EXIT_CODES } from "../exit-codes.js";
import { formatInstallResult } from "../format-install-result.js";
import type { CliCommandHandler } from "../run-cli.js";

/**
 * Installs, or updates, `.sailor` in the project the command was run in.
 *
 * A conflict raises rather than returning a code here, so the message and the
 * exit code are produced in the one place `runCli` maps a `SailorError`, and
 * every command reports an unsafe overwrite identically.
 */
export const initSailor: CliCommandHandler = async (context) => {
  const result = await installSailor({
    cwd: context.cwd,
    packageRootDirectory: context.packageRootDirectory,
    runner: context.runner,
    now: context.now,
    update: context.invocation.update,
  });

  context.streams.stdout.write(formatInstallResult(result));

  // The summary is printed either way; the exit code is what a script reads.
  return result.dependencyFailure === null
    ? CLI_EXIT_CODES.ok
    : CLI_EXIT_CODES.refused;
};
