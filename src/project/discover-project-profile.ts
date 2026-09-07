import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { loadProjectConfig } from "../config/project-config.js";
import type { ProjectConfig } from "../config/project-config.js";
import {
  SAILOR_DIRECTORY,
  SAILOR_PATHS,
  sailorPath,
} from "../sailor/layout.js";
import { readTextFileIfPresent } from "../sailor/read-text-file.js";
import type { CommandRunner } from "../processes/command-runner.js";
import { PROJECT_SCRIPT_NAMES } from "../rules/rule-schema.js";
import type { ProjectScriptName } from "../rules/rule-schema.js";
import {
  parseDeclaredPackageManager,
  resolvePackageManager,
} from "./package-manager.js";
import { projectProfileSchema } from "./project-profile-schema.js";
import type {
  HookEntrypoint,
  ProjectProfile,
} from "./project-profile-schema.js";

const GIT_CONFIG_TIMEOUT_MS = 10_000;

const TYPESCRIPT_CONFIG_PATTERN = /^tsconfig(?:\..+)?\.json$/;
const ESLINT_CONFIG_PATTERN =
  /^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\..+)?)$/;

const HOOK_NAMES = ["pre-commit", "pre-push"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonFile = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const listDirectory = (path: string): readonly string[] => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Reads the script names the sailor is allowed to resolve.
 *
 * Only the five semantic names are considered; an arbitrary package script is
 * never treated as safe to execute.
 */
const readAvailableScripts = (
  manifest: unknown
): readonly ProjectScriptName[] => {
  if (!isRecord(manifest) || !isRecord(manifest.scripts)) {
    return [];
  }

  const scripts = manifest.scripts;

  return PROJECT_SCRIPT_NAMES.filter(
    (name) => typeof scripts[name] === "string"
  );
};

const readDeclaredPackageManager = (manifest: unknown): string | null => {
  if (!isRecord(manifest)) {
    return null;
  }

  const declared = manifest.packageManager;

  return typeof declared === "string" ? declared : null;
};

const detectHookEntrypoints = (root: string): readonly HookEntrypoint[] => {
  const entrypoints: HookEntrypoint[] = [];

  for (const hook of HOOK_NAMES) {
    const huskyPath = join(".husky", hook);
    const gitPath = join(".git", "hooks", hook);

    if (isFile(join(root, huskyPath))) {
      entrypoints.push({ runner: "husky", hook, path: huskyPath });
    }

    if (isFile(join(root, gitPath))) {
      entrypoints.push({ runner: "git", hook, path: gitPath });
    }
  }

  if (isFile(join(root, "lefthook.yml"))) {
    for (const hook of HOOK_NAMES) {
      entrypoints.push({ runner: "lefthook", hook, path: "lefthook.yml" });
    }
  }

  return entrypoints;
};

/**
 * Reads the two decisions discovery cannot make for itself.
 *
 * A project that has not installed the sailor has no file here, and the schema
 * defaults stand in for it. A file that is present and invalid is reported
 * rather than ignored: silently falling back would mean a project that set
 * `validationMode` and mistyped it gets the opposite of what it asked for.
 */
const readInstalledConfig = (root: string): ProjectConfig => {
  const source = `${SAILOR_DIRECTORY}/${SAILOR_PATHS.projectConfig}`;
  const text = readTextFileIfPresent(
    sailorPath(root, SAILOR_PATHS.projectConfig)
  );

  return text === null
    ? {
        version: 1,
        validationMode: "native-plus-sailor",
        packageManager: null,
      }
    : loadProjectConfig(text, { source });
};

export interface DiscoverProjectProfileOptions {
  /** Absolute path to the project root. */
  readonly root: string;
  /** Injected so tests never depend on the developer's own git configuration. */
  readonly runner: CommandRunner;
}

/**
 * Builds a `ProjectProfile` by reading the project's files, its installed
 * sailor configuration, and its local git configuration.
 *
 * Discovery is read-only: it never executes a project script. The one command
 * it runs is `git config --local --get core.hooksPath`, because git resolves
 * worktrees and includes in ways that parsing `.git/config` by hand would not.
 */
export const discoverProjectProfile = async (
  options: DiscoverProjectProfileOptions
): Promise<ProjectProfile> => {
  const { root, runner } = options;
  const entries = listDirectory(root);
  const manifest = readJsonFile(join(root, "package.json"));
  const config = readInstalledConfig(root);

  const hooksPathResult = await runner({
    command: {
      executable: "git",
      args: ["config", "--local", "--get", "core.hooksPath"],
    },
    cwd: root,
    env: null,
    timeoutMs: GIT_CONFIG_TIMEOUT_MS,
  });

  // git exits non-zero when the key is unset, which is not an error here.
  const gitHooksPath =
    hooksPathResult.outcome === "exited" && hooksPathResult.exitCode === 0
      ? hooksPathResult.output.stdout.trim()
      : "";

  return projectProfileSchema.parse({
    root,
    packageManager: resolvePackageManager({
      // A pin in the sailor config wins over the host manifest: it exists
      // precisely to settle a repository whose lockfiles disagree, which is
      // the case the host manifest had already failed to settle.
      declared:
        config.packageManager ??
        parseDeclaredPackageManager(readDeclaredPackageManager(manifest)),
      lockfiles: entries,
    }),
    availableScripts: [...readAvailableScripts(manifest)],
    typescriptConfigFiles: entries
      .filter((entry) => TYPESCRIPT_CONFIG_PATTERN.test(entry))
      .sort(),
    eslintConfigFiles: entries
      .filter((entry) => ESLINT_CONFIG_PATTERN.test(entry))
      .sort(),
    gitHooksPath: gitHooksPath === "" ? null : gitHooksPath,
    existingHookEntrypoints: [...detectHookEntrypoints(root)],
    validationMode: config.validationMode,
  } satisfies ProjectProfile);
};
