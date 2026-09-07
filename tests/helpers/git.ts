import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";

/**
 * An environment with every `GIT_*` variable removed.
 *
 * Git exports `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` to the hooks it
 * runs, and this repository's own pre-commit hook runs the whole suite. A test
 * that spawned git with the ambient environment would therefore act on *this*
 * repository rather than on its temporary fixture.
 *
 * That is not a hypothetical: before this helper existed it rewrote this
 * branch's HEAD, created a stray branch, registered a worktree pointing into a
 * temporary directory, and wrote the fixture's identity into this repository's
 * `.git/config`, where it went on to author four commits.
 *
 * `nodeCommandRunner` is unaffected — its environment allowlist already drops
 * every `GIT_*` variable — so only tests that spawn a process themselves need
 * this.
 */
export const cleanEnvironment = (
  overrides: Readonly<Record<string, string>> = {}
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) {
      environment[key] = value;
    }
  }

  return { ...environment, ...overrides };
};

/**
 * The identity fixture commits are made with.
 *
 * Passed per invocation rather than written with `git config`, so that even a
 * fixture that somehow resolves to the wrong repository cannot leave anything
 * behind in it. Writing this identity into a config file is what silently
 * re-authored four real commits.
 */
const IDENTITY = [
  "-c",
  "user.name=Sailor Test",
  "-c",
  "user.email=sailor@example.invalid",
] as const;

/** Runs git against a fixture, never against the repository under test. */
export const runGit = (
  cwd: string,
  args: readonly string[],
  overrides: Readonly<Record<string, string>> = {}
): SpawnSyncReturns<string> =>
  spawnSync("git", [...IDENTITY, ...args], {
    cwd,
    encoding: "utf8",
    env: cleanEnvironment(overrides),
  });

/**
 * Creates a repository and proves it is the one git will act on.
 *
 * The assertion runs before anything is written, so a leaked `GIT_DIR` fails
 * loudly in a test's first line instead of quietly modifying whichever
 * repository the environment happened to point at.
 */
export const initRepository = (root: string): void => {
  runGit(root, ["init", "--quiet"]);

  const resolved = runGit(root, ["rev-parse", "--show-toplevel"]).stdout.trim();

  if (resolved !== root) {
    throw new Error(
      `git resolved ${root} to ${resolved}; the fixture is not the repository git would act on`
    );
  }
};
