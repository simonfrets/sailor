import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { cleanEnvironment } from "./git.js";

/** Installs the hooks that make `src/*.ts` importable from a child process. */
const REGISTER_HOOKS = "tests/helpers/register-typescript-sources.mjs";

export interface NodeScriptRequest {
  /** This repository's root, which is also where the sources are read from. */
  readonly packageRoot: string;
  /** The script to run, relative to `packageRoot`. */
  readonly script: string;
  readonly args: readonly string[];
  /** The directory the script runs in, as a real invocation would have one. */
  readonly cwd: string;
  /** Fed to the script's standard input. Omit for none. */
  readonly input?: string;
  /** Added to the child's environment, over the cleaned one. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface NodeScriptResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a script in a genuinely separate Node process.
 *
 * A test that wants to prove something survives a process boundary cannot fake
 * the boundary: a second module registry, a reset mock or a fresh object graph
 * all still share the heap the first half of the test built. This starts a new
 * interpreter, so the only thing the two halves can share is the filesystem.
 *
 * `GIT_*` is stripped for the same reason `runGit` strips it: this repository's
 * own pre-commit hook runs the suite with `GIT_DIR` set, and a child that
 * inherited it would act on this repository rather than on its fixture.
 */
export const runNodeScript = (request: NodeScriptRequest): NodeScriptResult => {
  const result = spawnSync(
    process.execPath,
    [
      // Type stripping is on by default but still announces itself, and a
      // warning on stderr would be indistinguishable from a real complaint.
      "--disable-warning=ExperimentalWarning",
      "--import",
      join(request.packageRoot, REGISTER_HOOKS),
      join(request.packageRoot, request.script),
      ...request.args,
    ],
    {
      cwd: request.cwd,
      encoding: "utf8",
      env: cleanEnvironment(request.env ?? {}),
      ...(request.input === undefined ? {} : { input: request.input }),
    }
  );

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};
