import type { SailorErrorKind } from "../sailor/sailor-error.js";

/**
 * Exit codes are part of the CLI's contract: a git hook, a CI step or a script
 * branches on them, so they are named constants that must stay stable rather
 * than numbers chosen at each call site.
 */
export const CLI_EXIT_CODES = {
  /** The command did what was asked. */
  ok: 0,
  /** An unexpected failure. Nothing about the request was wrong. */
  failure: 1,
  /** The command line could not be understood. */
  usage: 2,
  /** Rules or sailor configuration are invalid, or absent. */
  invalidConfig: 3,
  /** A required check on an error rule failed and blocked the phase. */
  gateBlocked: 4,
  /** The action was understood, was unsafe, and was deliberately not taken. */
  refused: 5,
} as const;

export const exitCodeForSailorError = (kind: SailorErrorKind): number => {
  switch (kind) {
    case "invalid-config":
    case "missing-context":
    case "not-installed":
    case "unknown-task":
      return CLI_EXIT_CODES.invalidConfig;
    case "dependency-install-failed":
    case "git-config-failed":
    case "invalid-transition":
    case "not-a-git-repository":
    case "stale-task-revision":
    case "task-lock-failed":
    case "unsafe-hook-chain":
    case "unsafe-overwrite":
      return CLI_EXIT_CODES.refused;
  }
};
