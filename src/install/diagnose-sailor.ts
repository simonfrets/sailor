import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { loadHooksConfig } from "../config/hooks-config.js";
import type { HooksConfig } from "../config/hooks-config.js";
import { loadProjectConfig } from "../config/project-config.js";
import { describeFailure } from "../sailor/sailor-error.js";
import {
  SAILOR_DIRECTORY,
  SAILOR_GIT_HOOKS_PATH,
  SAILOR_PATHS,
  sailorPath,
} from "../sailor/layout.js";
import { loadSailorRuleSet } from "../sailor/load-sailor-rule-set.js";
import { discoverProjectProfile } from "../project/discover-project-profile.js";
import type { ProjectProfile } from "../project/project-profile-schema.js";
import type { ResolvedRuleSet } from "../rules/resolve-rule-set.js";
import { readPackageVersion } from "../sailor/package-version.js";
import { readTextFileIfPresent } from "../sailor/read-text-file.js";
import { describeCommandResult } from "../processes/command-runner.js";
import type { CommandRunner } from "../processes/command-runner.js";
import { readInstallManifest } from "./install-manifest.js";
import type { HookRecord } from "./install-manifest.js";
import { SAILOR_PACKAGE_NAME } from "./runtime-dependencies.js";

/** Where a GitHub Actions workflow has to live to run at all. */
export const WORKFLOW_DIRECTORY = join(".github", "workflows");

/** Path of the workflow the sailor ships for a project to copy out. */
export const CI_TEMPLATE_PATH = "ci/github-actions.yml";

/**
 * What a workflow has to contain to count as running the gates.
 *
 * Matching the command rather than the launcher's path accepts every way a
 * project might reach the CLI — the installed `bin/sailor`, an `npx` call, or
 * a script of its own that wraps it.
 */
const GATE_INVOCATION = "sailor gate";

const TOOL_TIMEOUT_MS = 10_000;

/**
 * The Node version the sailor needs, kept beside the check that enforces it.
 * A test asserts it still matches `engines.node`, so the two cannot drift.
 */
export const REQUIRED_NODE_VERSION = "22.22.1";

/**
 * External programs the sailor runs. Each is probed with its own version
 * flag rather than assumed present: a missing `bash` fails a git hook at the
 * worst possible moment, and a diagnosis is the cheap place to find out.
 */
export const REQUIRED_TOOLS = [
  { id: "npm", title: "npm", executable: "npm", args: ["--version"] },
  { id: "git", title: "Git", executable: "git", args: ["--version"] },
  { id: "bash", title: "Bash", executable: "bash", args: ["--version"] },
] as const;

export const DIAGNOSTIC_STATUSES = ["ok", "warning", "problem"] as const;
export type DiagnosticStatus = (typeof DIAGNOSTIC_STATUSES)[number];

export interface Diagnostic {
  readonly id: string;
  readonly title: string;
  readonly status: DiagnosticStatus;
  /** One printable explanation. May span lines; always populated. */
  readonly detail: string;
}

export interface SailorDiagnosis {
  readonly projectRoot: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly problemCount: number;
  readonly warningCount: number;
  /** False when at least one diagnostic is a problem. Warnings do not count. */
  readonly healthy: boolean;
}

export interface DiagnoseSailorOptions {
  readonly projectRoot: string;
  readonly runner: CommandRunner;
  /** The Node runtime executing the sailor, as `process.versions.node`. */
  readonly nodeVersion: string;
  /** The version of the `sailor` package that is running. */
  readonly sailorVersion: string;
}

const diagnostic = (
  id: string,
  title: string,
  status: DiagnosticStatus,
  detail: string
): Diagnostic => ({ id, title, status, detail });

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)/;

/**
 * Orders a dotted version for comparison. Returns null when the string is not
 * a version at all, which is reported rather than silently treated as zero.
 */
export const versionOrder = (version: string): number | null => {
  const match = VERSION_PATTERN.exec(version);

  if (match === null) {
    return null;
  }

  const [major = 0, minor = 0, patch = 0] = match
    .slice(1)
    .map((part) => Number.parseInt(part, 10));

  return major * 1_000_000 + minor * 1_000 + patch;
};

const diagnoseNode = (nodeVersion: string): Diagnostic => {
  const running = versionOrder(nodeVersion);
  const required = versionOrder(REQUIRED_NODE_VERSION);

  if (running === null || required === null) {
    return diagnostic(
      "node",
      "Node.js",
      "problem",
      `\`${nodeVersion}\` is not a version this check can compare against ${REQUIRED_NODE_VERSION}`
    );
  }

  return running >= required
    ? diagnostic("node", "Node.js", "ok", nodeVersion)
    : diagnostic(
        "node",
        "Node.js",
        "problem",
        `${nodeVersion} is older than the required ${REQUIRED_NODE_VERSION}`
      );
};

const diagnoseTool = async (
  tool: (typeof REQUIRED_TOOLS)[number],
  projectRoot: string,
  runner: CommandRunner
): Promise<Diagnostic> => {
  const result = await runner({
    command: { executable: tool.executable, args: [...tool.args] },
    cwd: projectRoot,
    env: null,
    timeoutMs: TOOL_TIMEOUT_MS,
  });

  if (result.outcome !== "exited" || result.exitCode !== 0) {
    return diagnostic(
      tool.id,
      tool.title,
      "problem",
      `\`${tool.executable} ${tool.args.join(" ")}\` ${describeCommandResult(result)}`
    );
  }

  // `split(sep, 1).join("")` rather than `[0] ?? ""`: it needs no fallback
  // branch that nothing could ever reach.
  const reported = result.output.stdout.trim().split("\n", 1).join("");

  return diagnostic(tool.id, tool.title, "ok", reported);
};

const isExecutableFile = (path: string): boolean => {
  try {
    const stats = statSync(path);

    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

const diagnoseInstallation = (
  projectRoot: string,
  sailorVersion: string
): Diagnostic => {
  let installedVersion: string;

  try {
    const manifest = readInstallManifest(projectRoot);

    if (manifest === null) {
      return diagnostic(
        "installation",
        "Installation",
        "problem",
        `${SAILOR_DIRECTORY}/${SAILOR_PATHS.manifest} is missing; run \`sailor init\``
      );
    }

    installedVersion = manifest.sailorVersion;
  } catch (error: unknown) {
    return diagnostic(
      "installation",
      "Installation",
      "problem",
      describeFailure(error)
    );
  }

  return installedVersion === sailorVersion
    ? diagnostic(
        "installation",
        "Installation",
        "ok",
        `installed by sailor ${installedVersion}`
      )
    : diagnostic(
        "installation",
        "Installation",
        "warning",
        `installed by sailor ${installedVersion}, but ${sailorVersion} is running; run \`sailor init --update\``
      );
};

interface ConfigDiagnosis {
  readonly diagnostic: Diagnostic;
  /** Null when the file is missing or invalid, so the hook check can say so. */
  readonly hooks: HooksConfig | null;
}

const diagnoseConfig = (projectRoot: string): ConfigDiagnosis => {
  const problems: string[] = [];
  let hooks: HooksConfig | null = null;

  const projectSource = `${SAILOR_DIRECTORY}/${SAILOR_PATHS.projectConfig}`;
  const projectText = readTextFileIfPresent(
    sailorPath(projectRoot, SAILOR_PATHS.projectConfig)
  );

  if (projectText === null) {
    problems.push(`${projectSource} is missing`);
  } else {
    try {
      loadProjectConfig(projectText, { source: projectSource });
    } catch (error: unknown) {
      problems.push(describeFailure(error));
    }
  }

  const hooksSource = `${SAILOR_DIRECTORY}/${SAILOR_PATHS.hooksConfig}`;
  const hooksText = readTextFileIfPresent(
    sailorPath(projectRoot, SAILOR_PATHS.hooksConfig)
  );

  if (hooksText === null) {
    problems.push(`${hooksSource} is missing`);
  } else {
    try {
      hooks = loadHooksConfig(hooksText, { source: hooksSource });
    } catch (error: unknown) {
      problems.push(describeFailure(error));
    }
  }

  return {
    hooks,
    diagnostic:
      problems.length === 0
        ? diagnostic(
            "config",
            "Configuration",
            "ok",
            `${projectSource} and ${hooksSource} are valid`
          )
        : diagnostic("config", "Configuration", "problem", problems.join("\n")),
  };
};

interface RulesDiagnosis {
  readonly diagnostic: Diagnostic;
  /** Null when the rules could not be resolved at all. */
  readonly ruleSet: ResolvedRuleSet | null;
}

const diagnoseRules = (projectRoot: string): RulesDiagnosis => {
  try {
    const ruleSet = loadSailorRuleSet({ projectRoot });

    return {
      ruleSet,
      diagnostic: diagnostic(
        "rules",
        "Rules",
        "ok",
        `${String(ruleSet.rules.length)} rule(s) resolved, sha256 ${ruleSet.sha256}`
      ),
    };
  } catch (error: unknown) {
    return {
      ruleSet: null,
      diagnostic: diagnostic(
        "rules",
        "Rules",
        "problem",
        describeFailure(error)
      ),
    };
  }
};

/**
 * Reports checks that name a project script the project does not have.
 *
 * A rule with `whenMissing: fail` is stating that the absence of the script is
 * itself the defect, which is right for the project the rule was written for
 * and wrong for one that never had it. Installing the shipped TypeScript
 * bundle into a project with no `lint` script blocked every commit from then
 * on, while `doctor` reported no problems at all: the gate that would fire was
 * perfectly discoverable, and nothing looked.
 */
const diagnoseProjectScripts = (
  ruleSet: ResolvedRuleSet | null,
  profile: ProjectProfile | null
): Diagnostic | null => {
  const title = "Project scripts";

  if (ruleSet === null || profile === null) {
    return null;
  }

  const available = new Set<string>(profile.availableScripts);
  const missing = ruleSet.rules.flatMap((rule) =>
    rule.checks.flatMap((check) =>
      check.runner === "project-script" &&
      check.whenMissing === "fail" &&
      !available.has(check.script)
        ? [
            {
              detail: `${rule.id} / ${check.id} runs \`${check.script}\`,`,
              blocking: check.required && rule.severity === "error",
            },
          ]
        : []
    )
  );

  if (missing.length === 0) {
    return diagnostic(
      "scripts",
      title,
      "ok",
      `every check resolves a script this project defines`
    );
  }

  const blocking = missing.filter((entry) => entry.blocking);

  return diagnostic(
    "scripts",
    title,
    blocking.length === 0 ? "warning" : "problem",
    [
      ...missing.map(
        (entry) => `${entry.detail} which package.json does not define`
      ),
      blocking.length === 0
        ? "None of them blocks a phase."
        : `${String(blocking.length)} of them will block every commit until the script exists or the rule is overridden in ${SAILOR_DIRECTORY}/${SAILOR_PATHS.customRules}`,
    ].join("\n")
  );
};

const diagnoseRuntime = (projectRoot: string): Diagnostic => {
  const title = "Runtime dependencies";

  if (
    readTextFileIfPresent(
      sailorPath(projectRoot, SAILOR_PATHS.packageManifest)
    ) === null
  ) {
    return diagnostic(
      "runtime",
      title,
      "problem",
      `${SAILOR_DIRECTORY}/${SAILOR_PATHS.packageManifest} is missing; run \`sailor init\``
    );
  }

  const installed = sailorPath(
    projectRoot,
    "node_modules",
    SAILOR_PACKAGE_NAME
  );

  if (readTextFileIfPresent(join(installed, "package.json")) === null) {
    return diagnostic(
      "runtime",
      title,
      "problem",
      `${SAILOR_PACKAGE_NAME} is not resolved in ${SAILOR_DIRECTORY}/node_modules; run \`sailor init\``
    );
  }

  try {
    return diagnostic(
      "runtime",
      title,
      "ok",
      `${SAILOR_PACKAGE_NAME} ${readPackageVersion(installed)} is resolved in ${SAILOR_DIRECTORY}/node_modules`
    );
  } catch (error: unknown) {
    return diagnostic("runtime", title, "problem", describeFailure(error));
  }
};

const diagnoseHooks = (
  projectRoot: string,
  hooks: HooksConfig | null,
  gitHooksPath: string | null
): Diagnostic => {
  const title = "Git hooks";

  if (hooks === null) {
    return diagnostic(
      "hooks",
      title,
      "warning",
      `hook dispatch cannot be checked while ${SAILOR_DIRECTORY}/${SAILOR_PATHS.hooksConfig} is unreadable`
    );
  }

  const managed = hooks.hooks.filter((entry) => entry.enabled);

  if (managed.length === 0) {
    return diagnostic("hooks", title, "ok", "no git hook is managed");
  }

  if (gitHooksPath !== SAILOR_GIT_HOOKS_PATH) {
    return diagnostic(
      "hooks",
      title,
      "warning",
      gitHooksPath === null
        ? `git runs its own hooks: \`core.hooksPath\` is unset, so no sailor gate runs on commit`
        : `git dispatches hooks through \`${gitHooksPath}\`, not \`${SAILOR_GIT_HOOKS_PATH}\``
    );
  }

  const unreachable = managed
    .map((entry) => entry.hook)
    .filter(
      (hook) =>
        !isExecutableFile(sailorPath(projectRoot, SAILOR_PATHS.hooks, hook))
    );

  return unreachable.length === 0
    ? diagnostic(
        "hooks",
        title,
        "ok",
        `git dispatches ${managed.map((entry) => `${entry.hook} (${entry.phase})`).join(", ")} through ${SAILOR_GIT_HOOKS_PATH}`
      )
    : diagnostic(
        "hooks",
        title,
        "problem",
        `\`core.hooksPath\` is ${SAILOR_GIT_HOOKS_PATH} but ${unreachable.join(", ")} is missing or not executable; run \`sailor init\``
      );
};

/**
 * Reports whether the gates also run somewhere a developer cannot skip them.
 *
 * A git hook is bypassable with `git commit --no-verify`, so the hooks the
 * installer writes are a convenience; only CI is an enforcement. Nothing here
 * can install a workflow — `.github/` is outside the boundary the sailor
 * keeps to — so the hole is reported instead.
 *
 * It is a warning rather than a problem because a project may enforce the same
 * gates somewhere this check cannot see, on GitLab, Jenkins or a server-side
 * hook. Saying "no GitHub workflow runs them" is the honest claim; "you have no
 * CI" is not one this check is in a position to make.
 */
const diagnoseContinuousIntegration = (projectRoot: string): Diagnostic => {
  const title = "Continuous integration";
  const directory = join(projectRoot, WORKFLOW_DIRECTORY);
  let names: readonly string[];

  try {
    names = readdirSync(directory);
  } catch {
    names = [];
  }

  const running = names.filter((name) => {
    const contents = readTextFileIfPresent(join(directory, name));

    return contents?.includes(GATE_INVOCATION) ?? false;
  });

  return running.length === 0
    ? diagnostic(
        "ci",
        title,
        "warning",
        `no workflow in ${WORKFLOW_DIRECTORY} runs the sailor gates, so a commit made with \`--no-verify\` is checked by nothing; copy ${SAILOR_DIRECTORY}/${CI_TEMPLATE_PATH} there`
      )
    : diagnostic(
        "ci",
        title,
        "ok",
        `${running.join(", ")} runs the sailor gates`
      );
};

/**
 * Reports chained hooks recorded by absolute path.
 *
 * A dispatcher is committed with the project, so a preserved hook is re-joined
 * to the repository at run time whenever it lives inside it. One that does not
 * — a hook behind a `core.hooksPath` set in the user's global config, say — can
 * only be named absolutely, and that name means nothing on anyone else's
 * machine. The dispatcher skips it silently there, which is the failure worth
 * naming out loud.
 */
const diagnoseChainedHooks = (
  hooks: readonly HookRecord[]
): Diagnostic | null => {
  const external = hooks.filter(
    (hook) => hook.chained !== null && isAbsolute(hook.chained)
  );

  return external.length === 0
    ? null
    : diagnostic(
        "chained-hooks",
        "Chained hooks",
        "warning",
        `${external
          .map((hook) => `${hook.hook} runs ${String(hook.chained)}`)
          .join(
            ", "
          )} — outside the repository, so it will not exist for anyone else who checks the project out`
      );
};

/**
 * The project's profile, or null when it cannot be built.
 *
 * Discovery raises on a repository whose lockfiles disagree about the package
 * manager. That is a real problem, but it is not this check's to report, and a
 * diagnosis that crashed would take the other nine checks down with it.
 */
const readProjectProfile = async (
  projectRoot: string,
  runner: CommandRunner
): Promise<ProjectProfile | null> => {
  try {
    return await discoverProjectProfile({ root: projectRoot, runner });
  } catch {
    return null;
  }
};

/** Hooks the manifest recorded, or none when it cannot be read. */
const readRecordedHooks = (projectRoot: string): readonly HookRecord[] => {
  try {
    return readInstallManifest(projectRoot)?.hooks ?? [];
  } catch {
    // An unreadable manifest is already reported by the installation check.
    return [];
  }
};

const readGitHooksPath = async (
  projectRoot: string,
  runner: CommandRunner
): Promise<string | null> => {
  const result = await runner({
    command: {
      // The effective value, from any config scope. Asking only `--local`
      // reports "unset" for a repository whose hooks run from the user's
      // global config, which is the case worth noticing.
      executable: "git",
      args: ["config", "--get", "core.hooksPath"],
    },
    cwd: projectRoot,
    env: null,
    timeoutMs: TOOL_TIMEOUT_MS,
  });

  // git exits non-zero when the key is unset, which is not an error here.
  const value =
    result.outcome === "exited" && result.exitCode === 0
      ? result.output.stdout.trim()
      : "";

  return value === "" ? null : value;
};

/**
 * Reports whether an installed sailor can actually run.
 *
 * Every check runs even after one fails, because someone repairing an
 * installation should see the whole list once rather than fix one thing, re-run
 * and discover the next. Nothing here writes, installs or repairs: a diagnosis
 * that changed the thing it was diagnosing could not be trusted twice.
 */
export const diagnoseSailor = async (
  options: DiagnoseSailorOptions
): Promise<SailorDiagnosis> => {
  const { projectRoot, runner } = options;
  const tools: Diagnostic[] = [];

  for (const tool of REQUIRED_TOOLS) {
    tools.push(await diagnoseTool(tool, projectRoot, runner));
  }

  const config = diagnoseConfig(projectRoot);
  const rules = diagnoseRules(projectRoot);
  const profile = await readProjectProfile(projectRoot, runner);
  const scripts = diagnoseProjectScripts(rules.ruleSet, profile);
  const gitHooksPath = await readGitHooksPath(projectRoot, runner);
  const chained = diagnoseChainedHooks(readRecordedHooks(projectRoot));

  const diagnostics: readonly Diagnostic[] = [
    diagnoseNode(options.nodeVersion),
    ...tools,
    diagnoseInstallation(projectRoot, options.sailorVersion),
    config.diagnostic,
    rules.diagnostic,
    ...(scripts === null ? [] : [scripts]),
    diagnoseRuntime(projectRoot),
    diagnoseHooks(projectRoot, config.hooks, gitHooksPath),
    // Only reported when there is something to report: a project with no
    // chained hook outside itself should not be told about a hazard it has
    // no instance of.
    ...(chained === null ? [] : [chained]),
    diagnoseContinuousIntegration(projectRoot),
  ];

  const problemCount = diagnostics.filter(
    (entry) => entry.status === "problem"
  ).length;

  return {
    projectRoot,
    diagnostics,
    problemCount,
    warningCount: diagnostics.filter((entry) => entry.status === "warning")
      .length,
    healthy: problemCount === 0,
  };
};
