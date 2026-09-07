/**
 * Failure kinds the CLI has to distinguish. They exist so an exit code is
 * chosen from a named condition rather than from matching an error message,
 * which would silently change meaning the first time a message is reworded.
 */
export const SAILOR_ERROR_KINDS = [
  "dependency-install-failed",
  "git-config-failed",
  "invalid-config",
  "invalid-transition",
  "missing-context",
  "not-a-git-repository",
  "not-installed",
  "stale-task-revision",
  "task-lock-failed",
  "unknown-task",
  "unsafe-hook-chain",
  "unsafe-overwrite",
] as const;

export type SailorErrorKind = (typeof SAILOR_ERROR_KINDS)[number];

/**
 * An expected, reportable sailor failure.
 *
 * Details are carried as separate lines rather than pre-joined so a caller can
 * render them differently without re-parsing the message.
 */
export class SailorError extends Error {
  public readonly kind: SailorErrorKind;
  public readonly details: readonly string[];

  public constructor(
    kind: SailorErrorKind,
    message: string,
    details: readonly string[] = []
  ) {
    super(
      details.length === 0
        ? message
        : `${message}\n${details.map((detail) => `  ${detail}`).join("\n")}`
    );
    this.name = "SailorError";
    this.kind = kind;
    this.details = details;
  }
}

/**
 * Renders any thrown value as one message.
 *
 * Shared rather than repeated at each `catch`, because a call site that
 * narrowed to `Error` on its own would carry a branch for the non-error case
 * that nothing there could reach, let alone test.
 */
export const describeFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
