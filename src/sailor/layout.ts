import { join } from "node:path";

/**
 * The single directory an installed sailor owns inside a host project.
 *
 * Everything the sailor writes lives here, with one deliberate exception:
 * the repository-local `core.hooksPath` git setting, which cannot live inside
 * a directory git is being told to look at.
 */
export const SAILOR_DIRECTORY = ".sailor";

/**
 * Paths of the managed layout, relative to the sailor directory.
 *
 * They are collected here rather than spelled out at each use site so the
 * installer, the doctor, the hook dispatchers and the CLI cannot drift into
 * disagreeing about where a file lives.
 */
export const SAILOR_PATHS = {
  agents: "agents",
  bin: "bin",
  config: "config",
  customRules: join("rules", "custom"),
  gitignore: ".gitignore",
  hooks: "hooks",
  hooksConfig: join("config", "hooks.yaml"),
  launcher: join("bin", "sailor"),
  manifest: "version.json",
  packageManifest: "package.json",
  projectConfig: join("config", "project.yaml"),
  rules: "rules",
  runtime: "runtime",
  runs: join("state", "runs"),
  state: "state",
  tasks: "tasks.yaml",
} as const;

/** Resolves a path inside a project's sailor directory. */
export const sailorPath = (
  projectRoot: string,
  ...segments: readonly string[]
): string => join(projectRoot, SAILOR_DIRECTORY, ...segments);

/**
 * The value written to git's `core.hooksPath`.
 *
 * It is deliberately relative: git resolves a relative hooks path against the
 * top of the working tree the hook is running in, so one setting works in the
 * main checkout and in every linked worktree, which an absolute path recorded
 * once would not.
 */
export const SAILOR_GIT_HOOKS_PATH = `${SAILOR_DIRECTORY}/${SAILOR_PATHS.hooks}`;
