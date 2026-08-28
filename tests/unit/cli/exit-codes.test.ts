import {
  CLI_EXIT_CODES,
  exitCodeForSailorError,
} from "../../../src/cli/exit-codes.js";
import { SAILOR_ERROR_KINDS } from "../../../src/sailor/sailor-error.js";

describe("CLI exit codes", () => {
  it("keeps the documented codes stable", () => {
    expect(CLI_EXIT_CODES).toEqual({
      ok: 0,
      failure: 1,
      usage: 2,
      invalidConfig: 3,
      gateBlocked: 4,
      refused: 5,
    });
  });

  it("maps every sailor error kind to a nonzero code", () => {
    expect(SAILOR_ERROR_KINDS.length).toBeGreaterThan(0);

    for (const kind of SAILOR_ERROR_KINDS) {
      expect(exitCodeForSailorError(kind)).toBeGreaterThan(0);
    }
  });

  it("separates a broken configuration from a refused action", () => {
    expect(exitCodeForSailorError("invalid-config")).toBe(
      CLI_EXIT_CODES.invalidConfig
    );
    expect(exitCodeForSailorError("not-installed")).toBe(
      CLI_EXIT_CODES.invalidConfig
    );
    expect(exitCodeForSailorError("not-a-git-repository")).toBe(
      CLI_EXIT_CODES.refused
    );
    expect(exitCodeForSailorError("unsafe-overwrite")).toBe(
      CLI_EXIT_CODES.refused
    );
    expect(exitCodeForSailorError("unsafe-hook-chain")).toBe(
      CLI_EXIT_CODES.refused
    );
    expect(exitCodeForSailorError("dependency-install-failed")).toBe(
      CLI_EXIT_CODES.refused
    );
    expect(exitCodeForSailorError("git-config-failed")).toBe(
      CLI_EXIT_CODES.refused
    );
  });

  it("refuses a rejected task write rather than calling it a broken config", () => {
    // A stale revision, an illegal transition and a lock another process holds
    // are all requests the sailor understood and deliberately did not carry
    // out, which is what code 5 means. Only a task that is simply not there is
    // a question about the state on disk.
    expect(exitCodeForSailorError("stale-task-revision")).toBe(
      CLI_EXIT_CODES.refused
    );
    expect(exitCodeForSailorError("invalid-transition")).toBe(
      CLI_EXIT_CODES.refused
    );
    expect(exitCodeForSailorError("task-lock-failed")).toBe(
      CLI_EXIT_CODES.refused
    );
    expect(exitCodeForSailorError("unknown-task")).toBe(
      CLI_EXIT_CODES.invalidConfig
    );
    // A context the machine never wrote is a question about the state on disk
    // too: nothing was refused, the file the caller named is simply not here.
    expect(exitCodeForSailorError("missing-context")).toBe(
      CLI_EXIT_CODES.invalidConfig
    );
  });

  it("refuses to hand a task to an agent under a context that is not its own", () => {
    // Running the stage anyway would run it under whatever policy the
    // mismatched context carries, which is the outcome the check exists to
    // prevent, so the invocation is refused rather than repaired.
    expect(exitCodeForSailorError("invalid-invocation")).toBe(
      CLI_EXIT_CODES.refused
    );
  });

  it("refuses a handoff whose working tree could not be audited", () => {
    // Git failing to hash or compare the tree leaves the sailor unable to say
    // whether the agent stayed in scope. Accepting the work anyway would be
    // the unsafe action, so the handoff is what gets refused.
    expect(exitCodeForSailorError("working-tree-audit-failed")).toBe(
      CLI_EXIT_CODES.refused
    );
  });
});
