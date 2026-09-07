import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { lock } from "proper-lockfile";

import { SailorError, describeFailure } from "../sailor/sailor-error.js";
import { SAILOR_DIRECTORY } from "../sailor/layout.js";
import { TASK_FILE_SOURCE, taskFilePath } from "./task-file.js";

export interface TaskLockOptions {
  /**
   * How long a lock left behind by a dead process stays honoured.
   *
   * `proper-lockfile` raises anything below `STALE_FLOOR_MS` to it, so a
   * smaller value here is a request rather than a setting. `taskLockStaleMs`
   * reports the window that is actually in force.
   */
  readonly staleMs: number;
  /** How many times to wait for a lock another process is holding. */
  readonly retries: number;
}

/**
 * The shortest stale window `proper-lockfile` implements. It raises anything
 * below this to it, so this is the floor of what the sailor can ask for.
 */
const STALE_FLOOR_MS = 2_000;

const MIN_RETRY_MS = 25;
const RETRY_FACTOR = 1.5;

/**
 * The code `proper-lockfile` reports genuine contention with.
 *
 * It is the one failure of acquisition that means what the operator can act on
 * by waiting. Everything else the call can fail with - `EACCES` on a directory
 * the process cannot write, `ENOSPC`, `ENOTDIR` where `.sailor` is not a
 * directory at all - comes from the filesystem and is answered by fixing the
 * filesystem.
 */
const CONTENTION_CODE = "ELOCKED";

/** The `code` of a thrown value, for the errors that carry one. */
const failureCode = (error: unknown): string | null =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : null;

/** The stale window in force, which is not always the one that was asked for. */
export const taskLockStaleMs = (options: TaskLockOptions): number =>
  Math.max(options.staleMs, STALE_FLOOR_MS);

/**
 * How long acquiring the lock keeps trying before giving up.
 *
 * This has to outlast the stale window, and that is the whole reason it is
 * computed rather than described: a lock abandoned by a process that was
 * killed is honoured until it goes stale, so a budget that runs out first
 * turns every attempt in between into `ELOCKED` - a hard failure reporting
 * contention that nothing is causing. `sailor gate pre-commit` exits non-zero
 * on it, so a crash would block commits until the window passed.
 *
 * It mirrors the schedule `retry` computes from the options passed below,
 * which is a geometric backoff clamped at `maxTimeout`.
 */
export const taskLockRetryBudgetMs = (options: TaskLockOptions): number => {
  const ceiling = taskLockStaleMs(options);
  let total = 0;

  for (let attempt = 0; attempt < options.retries; attempt += 1) {
    total += Math.min(MIN_RETRY_MS * RETRY_FACTOR ** attempt, ceiling);
  }

  return total;
};

/**
 * The lock is held for one read-modify-write of `tasks.yaml` and, at most, the
 * context written beside it - milliseconds of work. `staleMs` is therefore the
 * floor the library allows, because every millisecond beyond the work the lock
 * covers is a millisecond in which a lock left behind by a killed process is
 * still believed, and nothing else can record a transition.
 *
 * Ten retries with the backoff above wait roughly 2.8 seconds, which outlasts
 * that window, so a lock nobody holds is taken over on one of them instead of
 * being reported as contention. It also still covers one gate run finishing
 * its own transition, and a git hook that waits longer than this is hanging on
 * a workflow that is not coming back.
 */
export const TASK_LOCK_DEFAULTS: TaskLockOptions = {
  staleMs: STALE_FLOOR_MS,
  retries: 10,
};

/**
 * Runs something while holding an exclusive lock on the task file.
 *
 * `proper-lockfile` is used rather than a lock written here: it already
 * implements the parts that are easy to get wrong - a directory `mkdir` as the
 * atomic primitive, an mtime heartbeat so a lock held by a process that died
 * expires, and a compromise callback for the case where the heartbeat itself
 * fails. The design says to prefer a reviewed library over a partial protocol,
 * and this is the protocol it meant.
 *
 * A lock is needed at all because two sailor processes genuinely overlap: a
 * git hook runs `sailor gate pre-commit` while an agent runtime is recording
 * the transition that produced the commit. Both do read-modify-write on one
 * file, so without a lock the later writer silently discards the earlier one's
 * revision.
 *
 * The default `onCompromised` throws from inside a timer callback, which is an
 * uncaught exception and takes the process down. It is replaced with one that
 * records the failure, so the caller's work finishes and then the loss of the
 * lock is reported as an error it can act on.
 *
 * A project with no sailor in it is refused rather than given one. `tasks.yaml`
 * is not installed by `sailor init`, so on the first transition it does not
 * exist and the lock has nowhere to live but the directory beside it - but that
 * directory is `.sailor` itself, which `sailor init` does install. Creating it
 * here would mean any task call against any path left a `.sailor` behind in a
 * project that never asked for one, and the sailor would be neither installed
 * nor absent but half of each: a directory holding task state and no agents,
 * rules or hooks to act on it.
 */
export const withTaskLock = async <T>(
  projectRoot: string,
  run: () => T | Promise<T>,
  options: TaskLockOptions = TASK_LOCK_DEFAULTS
): Promise<T> => {
  const path = taskFilePath(projectRoot);

  if (!existsSync(dirname(path))) {
    throw new SailorError(
      "not-installed",
      `${SAILOR_DIRECTORY} is not installed in this project, so there is nowhere to record a task; run \`sailor init\``
    );
  }

  const compromises: Error[] = [];
  const staleMs = taskLockStaleMs(options);
  let release: () => Promise<void>;

  try {
    release = await lock(path, {
      // The file legitimately does not exist before the first write, and
      // `realpath` would refuse to lock a path it cannot resolve.
      realpath: false,
      // The window the library would raise this to anyway, passed explicitly
      // so the schedule below is built from the same number.
      stale: staleMs,
      retries: {
        retries: options.retries,
        factor: RETRY_FACTOR,
        minTimeout: MIN_RETRY_MS,
        maxTimeout: staleMs,
      },
      onCompromised: (error: Error) => {
        compromises.push(error);
      },
    });
  } catch (error: unknown) {
    // The cause survived in `details` before this, but the headline claimed
    // contention whatever had happened, so the first line an operator read was
    // wrong for every cause but one - and the one it named is the only cause
    // that resolves itself.
    throw new SailorError(
      "task-lock-failed",
      failureCode(error) === CONTENTION_CODE
        ? `another process is holding the lock on ${TASK_FILE_SOURCE}`
        : `the lock on ${TASK_FILE_SOURCE} could not be taken`,
      [describeFailure(error)]
    );
  }

  let outcome: T;

  try {
    outcome = await run();
  } finally {
    await release().catch((error: unknown) => {
      // Releasing a lock that was already compromised fails for the reason
      // that is about to be reported, and releasing one that is simply gone
      // leaves nothing behind that `stale` will not clear. Neither is worth
      // replacing whatever the caller was already throwing.
      compromises.push(new Error(describeFailure(error)));
    });
  }

  const [compromised] = compromises;

  if (compromised !== undefined) {
    throw new SailorError(
      "task-lock-failed",
      `the lock on ${TASK_FILE_SOURCE} was lost while the sailor held it, so the write cannot be trusted`,
      [compromised.message]
    );
  }

  return outcome;
};
