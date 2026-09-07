import { spawn } from "node:child_process";
import type {
  SpawnOptionsWithStdioTuple,
  StdioNull,
  StdioPipe,
} from "node:child_process";

import {
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_KILL_SIGNAL,
  DEFAULT_MAX_OUTPUT_BYTES,
  toSpawnFailure,
} from "./command-runner.js";
import type {
  CommandOutput,
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "./command-runner.js";

/**
 * The one git variable a gate has to inherit.
 *
 * `git commit -- <path>`, `commit -p` and `commit --only` build a *temporary*
 * index and name it here. A check like the shipped `git diff --check --cached`
 * that cannot see it reads the stale on-disk index instead, and reports a clean
 * pass while conflict markers go into the commit. Stripping it does not make a
 * gate safer, it makes it answer a different question than the one being asked.
 *
 * Deliberately alone. `GIT_DIR`, `GIT_WORK_TREE` and `GIT_PREFIX` are not
 * forwarded: every command runs with an explicit absolute `cwd`, so git
 * discovers the repository, the worktree and the prefix for itself, and
 * inheriting them would let a hook running in one repository point a gate at
 * another. `GIT_AUTHOR_*` and `GIT_COMMITTER_*` are not forwarded either — a
 * gate has no business creating a commit, so it needs no identity for one.
 */
const GIT_INDEX_VARIABLE = "GIT_INDEX_FILE";

/**
 * Only these variables are forwarded to a child process. An allowlist means a
 * credential that happens to live in the parent environment is never handed to
 * a gate command, which is a structural guarantee rather than a redaction pass
 * that has to anticipate every secret's name.
 */
export const ENVIRONMENT_ALLOWLIST = [
  "CI",
  GIT_INDEX_VARIABLE,
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
] as const;

/**
 * Signals a child's whole process group, falling back to the child alone.
 *
 * A negative pid means "the process group", which is why the child is spawned
 * `detached`. Two cases must not reach that call. An absent pid would become
 * `process.kill(-0)`, and nought is not a group - it means *the caller's own*
 * group, so a spawn that never started would signal the sailor and everything
 * running alongside it. And a group that has already exited raises ESRCH
 * rather than returning quietly, which inside a timer callback is an unhandled
 * throw.
 *
 * Both fall back to signalling the child directly, which is a no-op on a
 * process that has already gone.
 */
export const killProcessTree = (
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback: () => void
): void => {
  if (pid === undefined) {
    fallback();

    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    fallback();
  }
};

export const buildChildEnvironment = (
  base: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string>> | null
): Record<string, string> => {
  const environment: Record<string, string> = {};

  for (const key of ENVIRONMENT_ALLOWLIST) {
    const value = base[key];

    if (value !== undefined) {
      environment[key] = value;
    }
  }

  if (overrides === null) {
    return environment;
  }

  return { ...environment, ...overrides };
};

interface StreamCollector {
  readonly push: (chunk: Buffer) => void;
  readonly text: () => string;
  readonly isTruncated: () => boolean;
}

/**
 * Chunks are concatenated and decoded once at the end. Decoding per chunk would
 * corrupt any multi-byte character that straddles a chunk boundary.
 */
const createStreamCollector = (limitBytes: number): StreamCollector => {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;

  return {
    push: (chunk: Buffer): void => {
      const remaining = limitBytes - size;

      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        size = limitBytes;
        truncated = true;

        return;
      }

      chunks.push(chunk);
      size += chunk.length;
    },
    text: (): string => Buffer.concat(chunks).toString("utf8"),
    isTruncated: (): boolean => truncated,
  };
};

export interface NodeCommandRunnerOptions {
  readonly baseEnv: NodeJS.ProcessEnv;
  /** Delay between the first termination signal and SIGKILL. */
  readonly killGraceMs: number;
  readonly killSignal: NodeJS.Signals;
  readonly maxOutputBytes: number;
  readonly now: () => Date;
}

export const NODE_COMMAND_RUNNER_DEFAULTS: NodeCommandRunnerOptions = {
  baseEnv: process.env,
  killGraceMs: DEFAULT_KILL_GRACE_MS,
  killSignal: DEFAULT_KILL_SIGNAL,
  maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  now: (): Date => new Date(),
};

/**
 * Runs a command with `shell: false` and an argument vector, so nothing in the
 * arguments is ever interpreted by a shell.
 *
 * `request.timeoutMs` must be positive; the timer is always armed. The timeout
 * is tracked here rather than through `spawn`'s own `timeout` option so that a
 * process the sailor killed is reported distinctly from one an external signal
 * killed.
 */
export const createNodeCommandRunner =
  (options: NodeCommandRunnerOptions): CommandRunner =>
  (request: CommandRequest): Promise<CommandResult> => {
    const startedAtDate = options.now();
    const startedAt = startedAtDate.toISOString();
    const stdout = createStreamCollector(options.maxOutputBytes);
    const stderr = createStreamCollector(options.maxOutputBytes);

    const output = (): CommandOutput => ({
      stdout: stdout.text(),
      stderr: stderr.text(),
      truncated: stdout.isTruncated() || stderr.isTruncated(),
    });

    return new Promise<CommandResult>((resolve) => {
      // The annotated tuple selects the overload where stdout and stderr are
      // non-nullable, removing a null check that no test could ever reach.
      const spawnOptions: SpawnOptionsWithStdioTuple<
        StdioNull,
        StdioPipe,
        StdioPipe
      > = {
        cwd: request.cwd,
        env: buildChildEnvironment(options.baseEnv, request.env),
        shell: false,
        windowsHide: true,
        // The child leads its own process group, so a timeout can signal the
        // whole tree. `npm run test` is a shell wrapping the real test runner:
        // signalling only the direct child reaped the wrapper and left the
        // runner alive, still holding the repository the gate had given up on.
        detached: true,
        // stdin is /dev/null so a command that prompts fails fast instead of
        // hanging until the timeout.
        stdio: ["ignore", "pipe", "pipe"],
      };

      const child = spawn(
        request.command.executable,
        [...request.command.args],
        spawnOptions
      );

      let settled = false;
      let timedOut = false;
      let forceKilled = false;
      let graceTimer: NodeJS.Timeout | undefined;

      const killTree = (signal: NodeJS.Signals): void => {
        killProcessTree(child.pid, signal, () => {
          child.kill(signal);
        });
      };

      const killTimer = setTimeout(() => {
        timedOut = true;
        killTree(options.killSignal);
        graceTimer = setTimeout(() => {
          forceKilled = true;
          killTree("SIGKILL");
        }, options.killGraceMs);
        graceTimer.unref();
      }, request.timeoutMs);

      killTimer.unref();

      // Node emits `error` and then `close` for a failed spawn, so resolution
      // is guarded rather than racing.
      const settle = (build: (durationMs: number) => CommandResult): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(killTimer);
        clearTimeout(graceTimer);
        resolve(build(options.now().getTime() - startedAtDate.getTime()));
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
      });

      child.on("error", (error: Error) => {
        settle((durationMs) =>
          toSpawnFailure({
            command: request.command,
            output: output(),
            startedAt,
            durationMs,
            error,
          })
        );
      });

      child.on(
        "close",
        (code: number | null, signal: NodeJS.Signals | null) => {
          settle((durationMs) => {
            const base = {
              command: request.command,
              output: output(),
              startedAt,
              durationMs,
            };

            if (timedOut) {
              return {
                ...base,
                outcome: "timed-out",
                timeoutMs: request.timeoutMs,
                forceKilled,
              };
            }

            if (code !== null) {
              return { ...base, outcome: "exited", exitCode: code };
            }

            if (signal !== null) {
              return { ...base, outcome: "signaled", signal };
            }

            return toSpawnFailure({
              ...base,
              error: new Error(
                "process closed without reporting an exit code or a signal"
              ),
            });
          });
        }
      );
    });
  };

export const nodeCommandRunner: CommandRunner = createNodeCommandRunner(
  NODE_COMMAND_RUNNER_DEFAULTS
);
