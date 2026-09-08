import { modelsConfigSchema } from "../../../src/config/models-config.js";
import { providersConfigSchema } from "../../../src/config/providers-config.js";
import type { ProvidersConfig } from "../../../src/config/providers-config.js";
import { SailorError } from "../../../src/sailor/sailor-error.js";
import { PROVIDER_IDS } from "../../../src/providers/provider-adapter.js";
import {
  createProviderAdapter,
  hasProviderAdapter,
  requireProviderAdapters,
} from "../../../src/runtime/provider-adapters.js";
import { captureError } from "../../helpers/expect-error.js";
import {
  createFakeCommandRunner,
  exited,
} from "../../helpers/fake-command-runner.js";

const models = modelsConfigSchema.parse({ version: 1 });

const providers = (overrides: Record<string, unknown> = {}): ProvidersConfig =>
  providersConfigSchema.parse({ version: 1, ...overrides });

const adapterFor = (provider: "claude" | "codex", config = providers()) =>
  createProviderAdapter({
    provider,
    models,
    providers: config,
    runner: createFakeCommandRunner(exited(0)).run,
    packageRootDirectory: "/pkg",
    nodeExecutable: "/usr/bin/node",
  });

describe("hasProviderAdapter", () => {
  it("says which providers this package can drive", () => {
    expect(hasProviderAdapter("claude")).toBe(true);
    expect(hasProviderAdapter("codex")).toBe(false);
  });

  it("agrees with what `createProviderAdapter` will build", () => {
    // The two answers are separate reads of `PROVIDER_CLI_VERSIONS` and a
    // switch, so a provider one admitted and the other refused would refuse a
    // run the driver had already accepted, three stages in.
    for (const provider of PROVIDER_IDS) {
      let built = true;

      try {
        adapterFor(provider);
      } catch {
        built = false;
      }

      expect(built).toBe(hasProviderAdapter(provider));
    }
  });
});

describe("createProviderAdapter", () => {
  it("builds the Claude adapter from the installed configuration", () => {
    // No `toolGate` is passed, so this is also the default: the built gate
    // program under the package root, which is where an installation has it.
    expect(adapterFor("claude").provider).toBe("claude");
    expect(
      adapterFor(
        "claude",
        providers({ claude: { command: ["claude"], maxBudgetUsd: 3 } })
      ).provider
    ).toBe("claude");
  });

  it("refuses a provider it has no adapter for", () => {
    const error = captureError(() => adapterFor("codex"), SailorError);

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("no adapter for codex");
  });
});

describe("requireProviderAdapters", () => {
  it("accepts a run every agent of which has an adapter", () => {
    expect(() => {
      requireProviderAdapters(providers(), ["coder", "cleaner", "qa"]);
    }).not.toThrow();
  });

  it("refuses a run before it starts, naming the agents that are misrouted", () => {
    // The whole point of deciding it up front: the hardener is three stages
    // after the coder, so probing at its turn would spend two live runs
    // before reporting a fact that was knowable from the file.
    const error = captureError(() => {
      requireProviderAdapters(
        providers({ agents: { hardener: "codex", qa: "codex" } }),
        ["coder", "cleaner", "architect", "hardener", "qa"]
      );
    }, SailorError);

    expect(error.kind).toBe("invalid-config");
    expect(error.details).toHaveLength(1);
    expect(error.details.join("\n")).toContain("no adapter for codex");
    expect(error.details.join("\n")).toContain("`hardener`, `qa`");
  });

  it("refuses a default that has no adapter", () => {
    const error = captureError(() => {
      requireProviderAdapters(providers({ default: "codex" }), ["coder"]);
    }, SailorError);

    expect(error.details.join("\n")).toContain("`coder`");
  });
});
