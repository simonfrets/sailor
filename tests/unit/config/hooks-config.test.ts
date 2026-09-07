import {
  EXISTING_HOOK_POLICIES,
  loadHooksConfig,
} from "../../../src/config/hooks-config.js";
import { SailorError } from "../../../src/sailor/sailor-error.js";
import { captureError } from "../../helpers/expect-error.js";

const load = (text: string) =>
  loadHooksConfig(text, { source: "config/hooks.yaml" });

const BOTH_HOOKS =
  "version: 1\nhooks:\n  - hook: pre-commit\n    phase: pre-commit\n  - hook: pre-push\n    phase: pre-push\n";

describe("loadHooksConfig", () => {
  it("chains onto an existing hook by default", () => {
    expect(load("version: 1\n")).toEqual({
      version: 1,
      onExistingHook: "chain",
      hooks: [],
    });
  });

  it("offers no policy that discards a hook the project wrote", () => {
    expect([...EXISTING_HOOK_POLICIES]).toEqual(["abort", "chain"]);
  });

  it("enables a configured hook unless it says otherwise", () => {
    expect(load(BOTH_HOOKS).hooks).toEqual([
      { hook: "pre-commit", enabled: true, phase: "pre-commit" },
      { hook: "pre-push", enabled: true, phase: "pre-push" },
    ]);
  });

  it("lets a hook be configured but switched off", () => {
    const parsed = load(
      "version: 1\nhooks:\n  - hook: pre-push\n    enabled: false\n    phase: pre-push\n"
    );

    expect(parsed.hooks[0]?.enabled).toBe(false);
  });

  it("rejects the same hook configured twice", () => {
    const error = captureError(
      () =>
        load(
          "version: 1\nhooks:\n  - hook: pre-commit\n    phase: pre-commit\n  - hook: pre-commit\n    phase: pre-push\n"
        ),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.details.join("\n")).toContain("more than once");
  });

  it("rejects a git hook the sailor does not manage", () => {
    const error = captureError(
      () =>
        load(
          "version: 1\nhooks:\n  - hook: post-merge\n    phase: pre-commit\n"
        ),
      SailorError
    );

    expect(error.details.join("\n")).toContain("hook");
  });

  it("rejects a phase that is not a gate phase", () => {
    const error = captureError(
      () =>
        load("version: 1\nhooks:\n  - hook: pre-commit\n    phase: deploy\n"),
      SailorError
    );

    expect(error.details.join("\n")).toContain("phase");
  });

  it("rejects an existing-hook policy that would replace a hook", () => {
    const error = captureError(
      () => load("version: 1\nonExistingHook: replace\n"),
      SailorError
    );

    expect(error.details.join("\n")).toContain("onExistingHook");
  });
});
