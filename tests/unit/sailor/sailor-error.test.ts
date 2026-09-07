import {
  SAILOR_ERROR_KINDS,
  SailorError,
} from "../../../src/sailor/sailor-error.js";

describe("SailorError", () => {
  it("carries a kind and renders its details in the message", () => {
    const error = new SailorError("invalid-config", "rules are invalid", [
      "base.yaml:3:1: bad",
      "git.yaml:9:2: worse",
    ]);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SailorError");
    expect(error.kind).toBe("invalid-config");
    expect(error.details).toEqual([
      "base.yaml:3:1: bad",
      "git.yaml:9:2: worse",
    ]);
    expect(error.message).toBe(
      "rules are invalid\n  base.yaml:3:1: bad\n  git.yaml:9:2: worse"
    );
  });

  it("omits the detail block when there are no details", () => {
    const error = new SailorError("not-installed", "nothing is installed");

    expect(error.message).toBe("nothing is installed");
    expect(error.details).toEqual([]);
  });

  it("declares every kind the CLI has to map to an exit code", () => {
    expect([...SAILOR_ERROR_KINDS]).toEqual([
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
    ]);
  });
});
