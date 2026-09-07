import { readPackageVersion } from "../../sailor/package-version.js";
import { resolveProjectRoot } from "../../sailor/resolve-project-root.js";
import { diagnoseSailor } from "../../install/diagnose-sailor.js";
import { CLI_EXIT_CODES } from "../exit-codes.js";
import { formatDiagnosis } from "../format-diagnosis.js";
import type { CliCommandHandler } from "../run-cli.js";

/**
 * Reports whether the installed sailor can run.
 *
 * The report goes to stdout even when it is bad news, because it is the
 * command's output rather than an error; the exit code is what a script
 * branches on.
 */
export const doctor: CliCommandHandler = async (context) => {
  const projectRoot = await resolveProjectRoot({
    cwd: context.cwd,
    runner: context.runner,
  });

  const diagnosis = await diagnoseSailor({
    projectRoot,
    runner: context.runner,
    nodeVersion: context.nodeVersion,
    sailorVersion: readPackageVersion(context.packageRootDirectory),
  });

  context.streams.stdout.write(formatDiagnosis(diagnosis));

  return diagnosis.healthy ? CLI_EXIT_CODES.ok : CLI_EXIT_CODES.invalidConfig;
};
