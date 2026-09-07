import { SailorError } from "../sailor/sailor-error.js";
import { SAILOR_DIRECTORY, sailorPath } from "../sailor/layout.js";
import { describeCommandResult } from "../processes/command-runner.js";
import type { CommandRunner } from "../processes/command-runner.js";

export const RUNTIME_PACKAGE_NAME = "sailor-runtime";
export const SAILOR_PACKAGE_NAME = "sailor";
export const RUNTIME_INSTALL_TIMEOUT_MS = 600_000;

/**
 * npm is used whatever the host project uses.
 *
 * This tree is the sailor's own, not the project's: resolving it with the
 * project's manager would drag in that manager's workspace rules, which in a
 * monorepo would hoist the sailor's dependencies up into the workspace root —
 * precisely the host-package contamination the `.sailor` boundary exists to
 * prevent. npm is already a stated requirement.
 */
export const RUNTIME_INSTALL_ARGV = [
  "install",
  "--no-audit",
  "--no-fund",
  "--omit=dev",
] as const;

/**
 * The GitHub release asset a project installs the sailor from.
 *
 * The sailor is deliberately not published to npm, so the dependency is the
 * tarball `npm pack` produces, attached to the release for its version. npm
 * installs a remote tarball without cloning or building anything, which a
 * `github:owner/repo` dependency would have to do - and this package's `dist/`
 * is not committed, so there would be nothing there to install.
 */
export const sailorReleaseTarballUrl = (
  repository: string,
  sailorVersion: string
): string =>
  `https://github.com/${repository}/releases/download/v${sailorVersion}/${SAILOR_PACKAGE_NAME}-${sailorVersion}.tgz`;

export interface RuntimePackageManifestInput {
  readonly sailorVersion: string;
  /** `owner/name` of the repository the release lives in. */
  readonly repository: string;
}

/**
 * The private manifest that gives `.sailor` its own dependency tree.
 *
 * It is `private` so it can never be published by accident, and it pins one
 * exact release asset, so an installed project keeps working the same way
 * until someone runs `sailor init --update`.
 */
export const buildRuntimePackageManifest = (
  input: RuntimePackageManifestInput
): string =>
  `${JSON.stringify(
    {
      name: RUNTIME_PACKAGE_NAME,
      version: "0.0.0",
      private: true,
      description:
        "Private dependency tree for the sailor installed in this project.",
      dependencies: {
        [SAILOR_PACKAGE_NAME]: sailorReleaseTarballUrl(
          input.repository,
          input.sailorVersion
        ),
      },
    },
    null,
    2
  )}\n`;

export interface InstallRuntimeDependenciesOptions {
  readonly projectRoot: string;
  readonly runner: CommandRunner;
  readonly timeoutMs?: number;
}

/**
 * Installs the sailor's own dependencies inside `.sailor`.
 *
 * The working directory is the sailor directory rather than the project root,
 * so npm resolves the private manifest and never reads, let alone rewrites,
 * the host project's `package.json` or lockfile.
 */
export const installRuntimeDependencies = async (
  options: InstallRuntimeDependenciesOptions
): Promise<void> => {
  const result = await options.runner({
    command: { executable: "npm", args: [...RUNTIME_INSTALL_ARGV] },
    cwd: sailorPath(options.projectRoot),
    env: null,
    timeoutMs: options.timeoutMs ?? RUNTIME_INSTALL_TIMEOUT_MS,
  });

  if (result.outcome !== "exited" || result.exitCode !== 0) {
    throw new SailorError(
      "dependency-install-failed",
      `installing the sailor runtime into ${SAILOR_DIRECTORY} failed: \`npm ${RUNTIME_INSTALL_ARGV.join(" ")}\` ${describeCommandResult(result)}`,
      result.output.stderr.trim() === ""
        ? []
        : result.output.stderr.trim().split("\n")
    );
  }
};
