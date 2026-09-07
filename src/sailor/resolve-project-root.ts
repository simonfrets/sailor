import { describeCommandResult } from "../processes/command-runner.js";
import type { CommandRunner } from "../processes/command-runner.js";
import { SailorError } from "./sailor-error.js";

const GIT_TIMEOUT_MS = 10_000;

export interface ResolveProjectRootOptions {
  readonly cwd: string;
  readonly runner: CommandRunner;
}

/**
 * Resolves the working tree root that owns a directory.
 *
 * git is asked rather than the filesystem walked upwards for a `.git` entry,
 * because in a linked worktree `.git` is a file, in a submodule it points
 * elsewhere, and `core.worktree` can move it entirely. Getting this wrong would
 * install the sailor into the wrong directory.
 */
export const resolveProjectRoot = async (
  options: ResolveProjectRootOptions
): Promise<string> => {
  const result = await options.runner({
    command: { executable: "git", args: ["rev-parse", "--show-toplevel"] },
    cwd: options.cwd,
    env: null,
    timeoutMs: GIT_TIMEOUT_MS,
  });

  if (result.outcome !== "exited" || result.exitCode !== 0) {
    throw new SailorError(
      "not-a-git-repository",
      `${options.cwd} is not inside a git repository: \`git rev-parse --show-toplevel\` ${describeCommandResult(result)}`,
      result.output.stderr.trim() === ""
        ? []
        : result.output.stderr.trim().split("\n")
    );
  }

  const root = result.output.stdout.trim();

  if (root === "") {
    throw new SailorError(
      "not-a-git-repository",
      `\`git rev-parse --show-toplevel\` succeeded in ${options.cwd} but named no working tree root`
    );
  }

  return root;
};
