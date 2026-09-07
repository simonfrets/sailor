import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import { SAILOR_PATHS, sailorPath } from "../sailor/layout.js";
import type { CommandRunner } from "../processes/command-runner.js";

const GIT_TIMEOUT_MS = 10_000;

/** Git's own templates. They ship non-executable and git never runs them. */
const SAMPLE_SUFFIX = ".sample";

export interface PriorHook {
  readonly hook: string;
  /**
   * Where the hook lives: relative to the project root when it is inside it,
   * absolute otherwise. A relative path is what makes a generated dispatcher
   * the same file on every machine that checks the project out.
   */
  readonly path: string;
}

/**
 * Where an effective `core.hooksPath` was configured.
 *
 * `local` is the repository's own. `inherited` means it came from the user's
 * global or the system config, so it governs this repository but is not part
 * of it, and the hooks it names will not exist for anyone else who checks the
 * project out.
 */
export const HOOKS_PATH_SCOPES = ["local", "inherited"] as const;
export type HooksPathScope = (typeof HOOKS_PATH_SCOPES)[number];

export interface HookEnvironment {
  /** The effective `core.hooksPath`, from any config scope, or null. */
  readonly hooksPath: string | null;
  /** Which config the effective value came from. Null when it is unset. */
  readonly hooksPathScope: HooksPathScope | null;
  /** Absolute directory git was running hooks from before this install. */
  readonly hooksDirectory: string;
  /** True when git already dispatches through this project's sailor. */
  readonly dispatchedBySailor: boolean;
  /** Executable hooks that were active, sorted by name. */
  readonly priorHooks: readonly PriorHook[];
}

export interface DiscoverHookEnvironmentOptions {
  readonly projectRoot: string;
  readonly runner: CommandRunner;
}

const gitOutput = async (
  args: readonly string[],
  options: DiscoverHookEnvironmentOptions
): Promise<string> => {
  const result = await options.runner({
    command: { executable: "git", args: [...args] },
    cwd: options.projectRoot,
    env: null,
    timeoutMs: GIT_TIMEOUT_MS,
  });

  // git exits non-zero for an unset key, which is not an error to report here.
  return result.outcome === "exited" && result.exitCode === 0
    ? result.output.stdout.trim()
    : "";
};

const isExecutableFile = (path: string): boolean => {
  try {
    const stats = statSync(path);

    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

const listExecutableHooks = (directory: string): readonly string[] => {
  let names: readonly string[];

  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }

  return names
    .filter(
      (name) =>
        !name.endsWith(SAMPLE_SUFFIX) && isExecutableFile(join(directory, name))
    )
    .sort();
};

/** Reports a path relative to the project when it is inside it. */
export const toProjectPath = (projectRoot: string, path: string): string => {
  const inside = relative(projectRoot, path);

  return inside === "" || inside.startsWith("..") || isAbsolute(inside)
    ? path
    : inside.split(sep).join(posix.sep);
};

/**
 * Records what git was doing about hooks before the sailor touched anything.
 *
 * The hooks directory is resolved from `core.hooksPath` when it is set and from
 * `--git-common-dir` otherwise, rather than by assuming `<root>/.git/hooks`:
 * in a linked worktree `.git` is a file and the hooks that actually run belong
 * to the main repository, so the naive path would find nothing and the sailor
 * would report that a project had no hooks while quietly switching them off.
 */
export const discoverHookEnvironment = async (
  options: DiscoverHookEnvironmentOptions
): Promise<HookEnvironment> => {
  const { projectRoot } = options;
  // The *effective* value, from whichever config scope set it. Asking only
  // `--local` reported "no hooks configured" for a repository whose hooks were
  // running perfectly well from the user's global config, and the installer
  // then redirected core.hooksPath and switched them off without a word.
  const configured = await gitOutput(
    ["config", "--get", "core.hooksPath"],
    options
  );
  const hooksPath = configured === "" ? null : configured;
  const local = await gitOutput(
    ["config", "--local", "--get", "core.hooksPath"],
    options
  );
  const hooksPathScope: HooksPathScope | null =
    hooksPath === null ? null : local === "" ? "inherited" : "local";

  let hooksDirectory: string;

  if (hooksPath === null) {
    const commonDirectory = await gitOutput(
      ["rev-parse", "--git-common-dir"],
      options
    );

    hooksDirectory = join(
      // git answers with a path relative to the working tree it was asked in
      // whenever it can, so it is resolved against the same directory.
      resolve(projectRoot, commonDirectory === "" ? ".git" : commonDirectory),
      SAILOR_PATHS.hooks
    );
  } else {
    // git resolves a relative core.hooksPath against the top of the working
    // tree, because that is the directory it runs a hook from.
    hooksDirectory = resolve(projectRoot, hooksPath);
  }

  const dispatchedBySailor =
    hooksDirectory === sailorPath(projectRoot, SAILOR_PATHS.hooks);

  return {
    hooksPath,
    hooksPathScope,
    hooksDirectory,
    dispatchedBySailor,
    priorHooks: dispatchedBySailor
      ? []
      : listExecutableHooks(hooksDirectory).map((hook) => ({
          hook,
          path: toProjectPath(projectRoot, join(hooksDirectory, hook)),
        })),
  };
};
