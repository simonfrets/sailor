import { loadHooksConfig } from "../../../src/config/hooks-config.js";
import type { HooksConfig } from "../../../src/config/hooks-config.js";
import { SailorError } from "../../../src/sailor/sailor-error.js";
import type {
  HookEnvironment,
  PriorHook,
} from "../../../src/install/discover-hooks.js";
import type { HookDispatcher } from "../../../src/install/hook-scripts.js";
import type { HookRecord } from "../../../src/install/install-manifest.js";
import { planHooks } from "../../../src/install/plan-hooks.js";
import { captureError } from "../../helpers/expect-error.js";

const config = (
  onExistingHook: "abort" | "chain" = "chain",
  hooks = ["pre-commit", "pre-push"]
): HooksConfig =>
  loadHooksConfig(
    [
      "version: 1",
      `onExistingHook: ${onExistingHook}`,
      "hooks:",
      ...hooks.flatMap((hook) => [
        `  - hook: ${hook}`,
        "    enabled: true",
        `    phase: ${hook}`,
      ]),
      "",
    ].join("\n"),
    { source: "config/hooks.yaml" }
  );

const environment = (
  priorHooks: readonly PriorHook[] = [],
  dispatchedBySailor = false
): HookEnvironment => ({
  hooksPath: dispatchedBySailor ? ".sailor/hooks" : null,
  hooksPathScope: dispatchedBySailor ? "local" : null,
  hooksDirectory: "/tmp/host/.git/hooks",
  dispatchedBySailor,
  priorHooks,
});

const plan = (input: {
  readonly hooks?: HooksConfig;
  readonly priorHooks?: readonly PriorHook[];
  readonly dispatchedBySailor?: boolean;
  readonly recorded?: readonly HookRecord[];
}): readonly HookDispatcher[] =>
  planHooks({
    hooks: input.hooks ?? config(),
    environment: environment(
      input.priorHooks ?? [],
      input.dispatchedBySailor ?? false
    ),
    recorded: input.recorded ?? [],
  });

describe("planHooks", () => {
  it("installs a gate dispatcher for every enabled managed hook", () => {
    expect(plan({})).toEqual([
      { kind: "gate", hook: "pre-commit", phase: "pre-commit", chained: null },
      { kind: "gate", hook: "pre-push", phase: "pre-push", chained: null },
    ]);
  });

  it("manages nothing a config disables", () => {
    const hooks = loadHooksConfig(
      [
        "version: 1",
        "hooks:",
        "  - hook: pre-commit",
        "    enabled: false",
        "    phase: pre-commit",
        "",
      ].join("\n"),
      { source: "config/hooks.yaml" }
    );

    expect(plan({ hooks })).toEqual([]);
  });

  it("chains a hook the project already had", () => {
    expect(
      plan({ priorHooks: [{ hook: "pre-commit", path: ".husky/pre-commit" }] })
    ).toContainEqual({
      kind: "gate",
      hook: "pre-commit",
      phase: "pre-commit",
      chained: ".husky/pre-commit",
    });
  });

  it("passes through a hook it has no gate for", () => {
    // Pointing core.hooksPath at the sailor stops `commit-msg` running too,
    // and a hook that disappears because a tool was installed was discarded.
    expect(
      plan({
        priorHooks: [{ hook: "commit-msg", path: ".git/hooks/commit-msg" }],
      })
    ).toContainEqual({
      kind: "passthrough",
      hook: "commit-msg",
      chained: ".git/hooks/commit-msg",
    });
  });

  it("sorts dispatchers so the plan does not depend on directory order", () => {
    const dispatchers = plan({
      priorHooks: [
        { hook: "prepare-commit-msg", path: ".git/hooks/prepare-commit-msg" },
        { hook: "commit-msg", path: ".git/hooks/commit-msg" },
      ],
    });

    expect(dispatchers.map((dispatcher) => dispatcher.hook)).toEqual([
      "commit-msg",
      "pre-commit",
      "pre-push",
      "prepare-commit-msg",
    ]);
  });

  it("refuses to take over hooks when the policy is abort", () => {
    const error = captureError(
      () =>
        plan({
          hooks: config("abort"),
          priorHooks: [{ hook: "pre-commit", path: ".husky/pre-commit" }],
        }),
      SailorError
    );

    expect(error.kind).toBe("unsafe-hook-chain");
    expect(error.details).toEqual([
      ".husky/pre-commit would have to be chained",
    ]);
  });

  it("installs under an abort policy when there is nothing to discard", () => {
    expect(plan({ hooks: config("abort") })).toHaveLength(2);
  });

  it("reads what it preserved from the manifest once git dispatches through it", () => {
    // The dispatchers are the only hooks git can see by then, so looking at
    // the directory would conclude the project never had a hook.
    expect(
      plan({
        dispatchedBySailor: true,
        recorded: [
          { hook: "pre-commit", chained: ".husky/pre-commit" },
          { hook: "commit-msg", chained: ".git/hooks/commit-msg" },
        ],
      })
    ).toEqual([
      {
        kind: "passthrough",
        hook: "commit-msg",
        chained: ".git/hooks/commit-msg",
      },
      {
        kind: "gate",
        hook: "pre-commit",
        phase: "pre-commit",
        chained: ".husky/pre-commit",
      },
      { kind: "gate", hook: "pre-push", phase: "pre-push", chained: null },
    ]);
  });

  it("does not abort on a re-install it already adopted", () => {
    expect(
      plan({
        hooks: config("abort"),
        dispatchedBySailor: true,
        recorded: [{ hook: "pre-commit", chained: ".husky/pre-commit" }],
      })
    ).toHaveLength(2);
  });

  it("drops a recorded hook that never chained anything", () => {
    expect(
      plan({
        hooks: config("chain", ["pre-commit"]),
        dispatchedBySailor: true,
        recorded: [
          { hook: "pre-commit", chained: null },
          { hook: "pre-push", chained: null },
        ],
      })
    ).toEqual([
      { kind: "gate", hook: "pre-commit", phase: "pre-commit", chained: null },
    ]);
  });
});
