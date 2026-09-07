import { chmodSync, unlinkSync } from "node:fs";

import { loadHooksConfig } from "../config/hooks-config.js";
import type { HooksConfig } from "../config/hooks-config.js";
import { writeFileAtomic } from "../sailor/atomic-write.js";
import { SailorError, describeFailure } from "../sailor/sailor-error.js";
import {
  SAILOR_DIRECTORY,
  SAILOR_GIT_HOOKS_PATH,
  SAILOR_PATHS,
  sailorPath,
} from "../sailor/layout.js";
import {
  readPackageRepository,
  readPackageVersion,
} from "../sailor/package-version.js";
import { readTextFileIfPresent } from "../sailor/read-text-file.js";
import { resolveProjectRoot } from "../sailor/resolve-project-root.js";
import { describeCommandResult } from "../processes/command-runner.js";
import type { CommandRunner } from "../processes/command-runner.js";
import { compareCodeUnits } from "../rules/hash-rule-set.js";
import { discoverHookEnvironment } from "./discover-hooks.js";
import type { HooksPathScope } from "./discover-hooks.js";
import {
  listSailorTemplateFiles,
  readSailorTemplateFile,
} from "./sailor-templates.js";
import {
  EXECUTABLE_MODE,
  LAUNCHER_PATH,
  buildSailorLauncher,
  buildHookDispatcher,
  hookScriptPath,
} from "./hook-scripts.js";
import {
  INSTALL_MANIFEST_VERSION,
  hashManagedFile,
  readInstallManifest,
  writeInstallManifest,
} from "./install-manifest.js";
import type {
  HookRecord,
  InstallManifest,
  ManagedFileEntry,
} from "./install-manifest.js";
import { planHooks } from "./plan-hooks.js";
import { planInstallation, toPlannedFileSource } from "./plan-installation.js";
import type {
  InstallationPlan,
  PlannedFileSource,
} from "./plan-installation.js";
import {
  buildRuntimePackageManifest,
  installRuntimeDependencies,
} from "./runtime-dependencies.js";

const REGULAR_FILE_MODE = 0o644;
const GIT_TIMEOUT_MS = 10_000;

/**
 * The launcher and the hook dispatchers are the only managed files git or a
 * developer executes, so they are the only ones that need the executable bit.
 */
const modeFor = (path: string): number =>
  path === LAUNCHER_PATH || path.startsWith(`${SAILOR_PATHS.hooks}/`)
    ? EXECUTABLE_MODE
    : REGULAR_FILE_MODE;

export interface InstallSailorOptions {
  readonly cwd: string;
  /** Root of the installed `sailor` package; resolved by the bin entry. */
  readonly packageRootDirectory: string;
  readonly runner: CommandRunner;
  readonly now: () => Date;
  readonly update: boolean;
  /** Set false to write the files without resolving the private tree. */
  readonly installDependencies?: boolean;
}

interface StaleHooks {
  /** Dispatchers deleted because this install no longer wants them. */
  readonly removed: readonly string[];
  /** Dispatchers left alone because the project had changed them. */
  readonly retained: readonly string[];
}

/**
 * Deletes hook dispatchers a previous install wrote and this one does not want.
 *
 * Every other orphaned managed file is reported and left in place, because a
 * stale rule or agent definition is inert. A stale dispatcher is not: git runs
 * whatever is in the hooks directory, so a `pre-commit` left behind after the
 * project disabled it keeps gating every commit, with nothing in the manifest
 * left to explain why. Reporting is the safe answer for a file nobody executes
 * and the wrong one for a file everybody does.
 *
 * A dispatcher whose content no longer matches what the sailor wrote is kept
 * and reported instead: the project changed it, so deleting it would discard
 * work, and that is the one thing this installer never does unprompted.
 */
const removeStaleHooks = (
  projectRoot: string,
  orphaned: readonly string[],
  previous: InstallManifest | null
): StaleHooks => {
  const recorded = new Map(
    (previous?.managedFiles ?? []).map((entry) => [entry.path, entry.sha256])
  );
  const removed: string[] = [];
  const retained: string[] = [];

  for (const path of orphaned) {
    if (!path.startsWith(`${SAILOR_PATHS.hooks}/`)) {
      retained.push(path);
      continue;
    }

    const absolute = sailorPath(projectRoot, ...path.split("/"));
    const existing = readTextFileIfPresent(absolute);

    if (existing === null) {
      continue;
    }

    if (hashManagedFile(existing) === recorded.get(path)) {
      unlinkSync(absolute);
      removed.push(path);
    } else {
      retained.push(path);
    }
  }

  return { removed, retained };
};

export interface InstallSailorResult {
  readonly projectRoot: string;
  readonly sailorVersion: string;
  readonly created: readonly string[];
  readonly replaced: readonly string[];
  readonly kept: readonly string[];
  readonly orphaned: readonly string[];
  /** Hook dispatchers deleted because git would otherwise still run them. */
  readonly removed: readonly string[];
  readonly dependenciesInstalled: boolean;
  /** Why the private tree could not be resolved, or null when it could. */
  readonly dependencyFailure: string | null;
  /** The hooks git now dispatches, and what each of them preserved. */
  readonly hooks: readonly HookRecord[];
  /** `core.hooksPath` as it was before this install, or null when unset. */
  readonly previousHooksPath: string | null;
  /** Which config that value came from. `inherited` is not part of the repo. */
  readonly previousHooksPathScope: HooksPathScope | null;
  /** True when this install changed git's `core.hooksPath`. */
  readonly gitHooksPathChanged: boolean;
}

const collect = (plan: InstallationPlan, action: string): readonly string[] =>
  plan.files.filter((file) => file.action === action).map((file) => file.path);

/**
 * Reads the hook policy this install has to honour.
 *
 * The installed copy wins over the template. `config/hooks.yaml` is seeded, so
 * a project that disabled a hook or set `onExistingHook: abort` owns that file
 * — and an installer that read the template anyway would let the edit be
 * accepted and then ignore it, which is worse than refusing it outright.
 */
const readHooksConfig = (
  projectRoot: string,
  desired: readonly PlannedFileSource[]
): HooksConfig => {
  const source = `${SAILOR_DIRECTORY}/${SAILOR_PATHS.hooksConfig}`;
  const template = desired.find(
    (file) => file.path === SAILOR_PATHS.hooksConfig
  );

  if (template === undefined) {
    throw new SailorError(
      "invalid-config",
      `this build of the sailor ships no ${source}, so it cannot decide which git hooks to manage`
    );
  }

  const installed = readTextFileIfPresent(
    sailorPath(projectRoot, SAILOR_PATHS.hooksConfig)
  );

  return loadHooksConfig(installed ?? template.contents, { source });
};

const setGitHooksPath = async (
  projectRoot: string,
  runner: CommandRunner
): Promise<void> => {
  const result = await runner({
    command: {
      executable: "git",
      args: ["config", "--local", "core.hooksPath", SAILOR_GIT_HOOKS_PATH],
    },
    cwd: projectRoot,
    env: null,
    timeoutMs: GIT_TIMEOUT_MS,
  });

  if (result.outcome !== "exited" || result.exitCode !== 0) {
    throw new SailorError(
      "git-config-failed",
      `\`git config --local core.hooksPath ${SAILOR_GIT_HOOKS_PATH}\` ${describeCommandResult(result)}, so git still runs its own hooks`,
      result.output.stderr.trim() === ""
        ? []
        : result.output.stderr.trim().split("\n")
    );
  }
};

/**
 * Installs, or updates, the sailor inside the project that owns `cwd`.
 *
 * The order is deliberate. Files are written first, then the manifest, then
 * git's hooks path, then the private dependency tree. Writing the manifest
 * before the rest means an install interrupted by a failing `npm install`
 * leaves a project the sailor still recognises as its own, so re-running
 * repairs it instead of reporting every file it just wrote as an unmanaged
 * conflict — and pointing git at dispatchers that exist beats pointing it at
 * ones that do not.
 */
export const installSailor = async (
  options: InstallSailorOptions
): Promise<InstallSailorResult> => {
  const projectRoot = await resolveProjectRoot({
    cwd: options.cwd,
    runner: options.runner,
  });
  const sailorVersion = readPackageVersion(options.packageRootDirectory);
  const templates = listSailorTemplateFiles(options.packageRootDirectory);

  const managedContent: readonly PlannedFileSource[] = [
    ...templates.map((file) =>
      toPlannedFileSource(
        file,
        readSailorTemplateFile(options.packageRootDirectory, file.templatePath)
      )
    ),
    {
      path: SAILOR_PATHS.packageManifest,
      contents: buildRuntimePackageManifest({
        sailorVersion,
        repository: readPackageRepository(options.packageRootDirectory),
      }),
      kind: "managed",
    },
  ];

  const previous = readInstallManifest(projectRoot);
  const environment = await discoverHookEnvironment({
    projectRoot,
    runner: options.runner,
  });
  const dispatchers = planHooks({
    hooks: readHooksConfig(projectRoot, managedContent),
    environment,
    recorded: previous?.hooks ?? [],
  });

  const desired: readonly PlannedFileSource[] = [
    ...managedContent,
    // Always installed, even when no git hook is managed: it is the
    // executable a project runs the sailor with, and the shipped CI workflow
    // calls it. Tying it to hook dispatch would take it away from exactly the
    // project that turned hooks off and relies on CI instead.
    {
      path: LAUNCHER_PATH,
      contents: buildSailorLauncher(),
      kind: "managed" as const,
    },
    ...dispatchers.map((dispatcher) => ({
      path: hookScriptPath(dispatcher.hook),
      contents: buildHookDispatcher(dispatcher),
      kind: "managed" as const,
    })),
  ].sort((a, b) => compareCodeUnits(a.path, b.path));

  const plan = planInstallation({
    projectRoot,
    desired,
    manifest: previous,
    update: options.update,
  });

  for (const file of plan.files) {
    const absolute = sailorPath(projectRoot, ...file.path.split("/"));
    const mode = modeFor(file.path);

    if (file.action === "keep") {
      // The mode is the sailor's to own, and re-applying it is what repairs
      // the hook `sailor doctor` reports as present but not executable.
      chmodSync(absolute, mode);
      continue;
    }

    writeFileAtomic(absolute, file.contents, mode);
  }

  const stale = removeStaleHooks(projectRoot, plan.orphaned, previous);
  const timestamp = options.now().toISOString();
  const managedFiles: ManagedFileEntry[] = plan.files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    kind: file.kind,
  }));
  const hooks: HookRecord[] = dispatchers.map((dispatcher) => ({
    hook: dispatcher.hook,
    chained: dispatcher.chained,
  }));
  const previousHooksPath = environment.dispatchedBySailor
    ? (previous?.previousHooksPath ?? null)
    : environment.hooksPath;
  const previousHooksPathScope = environment.dispatchedBySailor
    ? null
    : environment.hooksPathScope;

  writeInstallManifest(projectRoot, {
    version: INSTALL_MANIFEST_VERSION,
    sailorVersion,
    installedAt: previous?.installedAt ?? timestamp,
    updatedAt: timestamp,
    managedFiles,
    hooks,
    previousHooksPath,
  });

  const installDependencies = options.installDependencies ?? true;
  let dependencyFailure: string | null = null;

  if (installDependencies) {
    try {
      await installRuntimeDependencies({
        projectRoot,
        runner: options.runner,
      });
    } catch (error: unknown) {
      // Recorded rather than thrown, so the caller can still report what was
      // installed. Throwing here discarded the whole summary - which hooks
      // were taken over, what they chained - and left a npm error as the only
      // thing a person saw.
      dependencyFailure = describeFailure(error);
    }
  }

  // Hooks are pointed at the sailor only once the thing they invoke exists.
  // Redirecting core.hooksPath first meant a failed dependency install left a
  // repository that could not commit at all: every hook ran a launcher with no
  // runtime behind it, and re-running `init` failed at the same step.
  const gitHooksPathChanged =
    dependencyFailure === null &&
    dispatchers.length > 0 &&
    environment.hooksPath !== SAILOR_GIT_HOOKS_PATH;

  if (gitHooksPathChanged) {
    await setGitHooksPath(projectRoot, options.runner);
  }

  return {
    projectRoot,
    sailorVersion,
    created: collect(plan, "create"),
    replaced: collect(plan, "replace"),
    kept: collect(plan, "keep"),
    orphaned: stale.retained,
    removed: stale.removed,
    dependenciesInstalled: installDependencies && dependencyFailure === null,
    dependencyFailure,
    hooks,
    previousHooksPath,
    previousHooksPathScope,
    gitHooksPathChanged,
  };
};
