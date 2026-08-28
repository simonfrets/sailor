import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import { SailorError } from "../sailor/sailor-error.js";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  commandSucceeded,
  describeCommand,
  describeCommandResult,
} from "../processes/command-runner.js";
import type {
  CommandRunner,
  CommandSpec,
} from "../processes/command-runner.js";
import { evaluateToolAction } from "./tool-policy.js";
import type { DeniedToolDecision, ToolPolicy } from "./tool-policy.js";

export const WORKING_TREE_AUDIT_TIMEOUT_MS = DEFAULT_COMMAND_TIMEOUT_MS;

/** A SHA-1 or, in a repository initialised with it, a SHA-256 object id. */
const TREE_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The working tree at one instant, as the id of the tree object it hashes to. */
export interface WorkingTreeSnapshot {
  readonly tree: string;
}

const nonEmptyLines = (text: string): readonly string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");

interface GitInvocation {
  readonly projectRoot: string;
  readonly runner: CommandRunner;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>> | null;
  readonly timeoutMs: number;
}

/**
 * Runs one git command and returns its standard output, or throws.
 *
 * Nothing here fails open. A git that exits non-zero, cannot be started, is
 * killed or times out is reported as an audit that could not be made, with
 * git's own words beneath it. An output that hit the capture cap is refused
 * too: a path list cut short is a path list with paths missing, and the
 * missing ones are exactly the ones nobody would check.
 */
const git = async (invocation: GitInvocation): Promise<string> => {
  const command: CommandSpec = { executable: "git", args: invocation.args };
  const result = await invocation.runner({
    command,
    cwd: invocation.projectRoot,
    env: invocation.env,
    timeoutMs: invocation.timeoutMs,
  });

  if (!commandSucceeded(result)) {
    throw new SailorError(
      "working-tree-audit-failed",
      `${describeCommand(command)} ${describeCommandResult(result)}`,
      nonEmptyLines(result.output.stderr)
    );
  }

  if (result.output.truncated) {
    throw new SailorError(
      "working-tree-audit-failed",
      `${describeCommand(command)} printed more than could be captured, so its output is truncated`
    );
  }

  return result.output.stdout;
};

export interface SnapshotWorkingTreeOptions {
  readonly projectRoot: string;
  readonly runner: CommandRunner;
  /**
   * An absolute path for the private index the snapshot stages into. It is
   * recreated on every snapshot, so the only requirement is that no two
   * audits running at once share it.
   */
  readonly indexFile: string;
  readonly timeoutMs?: number;
}

/**
 * Hashes the working tree without touching the repository's index.
 *
 * Everything git would track is staged into a private index named by
 * `GIT_INDEX_FILE`, and that index is written as a tree object. Two such
 * snapshots either side of an agent run then differ in exactly the paths the
 * agent changed - added, modified or deleted - and git does the comparison,
 * which is the one part of this worth not writing twice.
 *
 * The real index is never read or written: a gate that staged files would
 * change what the next commit contains. Ignored files are outside the
 * snapshot, because they are outside the project as git records it: the
 * agent's scratch under `.sailor/state/` is ignored by the shipped
 * `.gitignore`, which is what makes it scratch.
 *
 * The private index starts empty every time. Reusing one left by an earlier
 * snapshot would carry its entries forward, and a stale entry for a file that
 * has since been deleted is a deletion the audit would not see.
 */
export const snapshotWorkingTree = async (
  options: SnapshotWorkingTreeOptions
): Promise<WorkingTreeSnapshot> => {
  const timeoutMs = options.timeoutMs ?? WORKING_TREE_AUDIT_TIMEOUT_MS;
  const env = { GIT_INDEX_FILE: options.indexFile };

  mkdirSync(dirname(options.indexFile), { recursive: true });
  rmSync(options.indexFile, { force: true });

  await git({
    projectRoot: options.projectRoot,
    runner: options.runner,
    args: ["add", "--all"],
    env,
    timeoutMs,
  });

  const stdout = await git({
    projectRoot: options.projectRoot,
    runner: options.runner,
    args: ["write-tree"],
    env,
    timeoutMs,
  });
  const tree = stdout.trim();

  if (!TREE_ID.test(tree)) {
    throw new SailorError(
      "working-tree-audit-failed",
      "git write-tree did not print a tree id",
      nonEmptyLines(stdout)
    );
  }

  return { tree };
};

export interface WorkingTreeViolation {
  readonly path: string;
  readonly decision: DeniedToolDecision;
}

export interface WorkingTreeAudit {
  /** Every path that differs between the two snapshots, in git's order. */
  readonly changedPaths: readonly string[];
  readonly violations: readonly WorkingTreeViolation[];
  readonly clean: boolean;
}

export interface AuditWorkingTreeOptions {
  readonly projectRoot: string;
  readonly runner: CommandRunner;
  readonly before: WorkingTreeSnapshot;
  readonly after: WorkingTreeSnapshot;
  readonly policy: ToolPolicy;
  readonly timeoutMs?: number;
}

/**
 * Holds every change between two snapshots to an agent's write policy.
 *
 * This is the enforcement a provider cannot opt out of. An adapter that can
 * ask before the agent acts asks `evaluateToolAction`; whether or not it can,
 * the tree is compared afterwards and every changed path is put to the same
 * question. A change outside the scopes is a violation whatever the provider
 * reported, and a deletion is a change: removing a file the agent may not
 * write is writing it.
 *
 * The result is a report rather than an exception, because a violation is a
 * finding about the run, and what to do with the run is the caller's
 * decision. Git failing is an exception, because then there is no finding.
 */
export const auditWorkingTree = async (
  options: AuditWorkingTreeOptions
): Promise<WorkingTreeAudit> => {
  const changedPaths =
    options.before.tree === options.after.tree
      ? []
      : (
          await git({
            projectRoot: options.projectRoot,
            runner: options.runner,
            args: [
              "diff-tree",
              "-r",
              "--name-only",
              "-z",
              options.before.tree,
              options.after.tree,
            ],
            env: null,
            timeoutMs: options.timeoutMs ?? WORKING_TREE_AUDIT_TIMEOUT_MS,
          })
        )
          .split("\0")
          .filter((path) => path !== "");

  const violations = changedPaths.flatMap((path): WorkingTreeViolation[] => {
    const decision = evaluateToolAction(
      { kind: "write", path },
      options.policy
    );

    return decision.verdict === "denied" ? [{ path, decision }] : [];
  });

  return { changedPaths, violations, clean: violations.length === 0 };
};
