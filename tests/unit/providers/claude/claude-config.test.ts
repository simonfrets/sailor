import { modelsConfigSchema } from "../../../../src/config/models-config.js";
import { providersConfigSchema } from "../../../../src/config/providers-config.js";
import { DEFAULT_CLAUDE_MODELS } from "../../../../src/providers/claude/claude-cli-adapter.js";
import { claudeAdapterOptions } from "../../../../src/providers/claude/claude-config.js";
import type { CommandRunner } from "../../../../src/processes/command-runner.js";
import {
  createFakeCommandRunner,
  exited,
} from "../../../helpers/fake-command-runner.js";

const runner: CommandRunner = createFakeCommandRunner(() => exited(0)).run;

const toolGate = { executable: "/usr/bin/node", args: ["/pkg/gate.js"] };

const optionsFrom = (
  models: unknown,
  providers: unknown = { version: 1 }
): ReturnType<typeof claudeAdapterOptions> =>
  claudeAdapterOptions({
    models: modelsConfigSchema.parse(models),
    providers: providersConfigSchema.parse(providers),
    runner,
    toolGate,
  });

describe("claudeAdapterOptions", () => {
  it("runs every profile on the adapter's own model where the project named none", () => {
    expect(optionsFrom({ version: 1 }).models).toEqual(DEFAULT_CLAUDE_MODELS);
  });

  it("takes the model the project named for a profile", () => {
    const options = optionsFrom({
      version: 1,
      models: { claude: { verification: "haiku" } },
    });

    expect(options.models).toEqual({
      ...DEFAULT_CLAUDE_MODELS,
      verification: "haiku",
    });
  });

  it("leaves the profiles the project did not name on the adapter's models", () => {
    // Which is what lets a project override one model without having to
    // restate - and then maintain - the other two.
    const options = optionsFrom({
      version: 1,
      models: { claude: { "coding-high": "opus-4-6" } },
    });

    expect(options.models?.["coding-high"]).toBe("opus-4-6");
    expect(options.models?.["reasoning-high"]).toBe(
      DEFAULT_CLAUDE_MODELS["reasoning-high"]
    );
    expect(options.models?.verification).toBe(
      DEFAULT_CLAUDE_MODELS.verification
    );
  });

  it("ignores the models named for another provider", () => {
    expect(
      optionsFrom({
        version: 1,
        models: { codex: { "coding-high": "gpt-please-no" } },
      }).models
    ).toEqual(DEFAULT_CLAUDE_MODELS);
  });

  it("starts the CLI with the configured command, first word as the executable", () => {
    const options = optionsFrom(
      { version: 1 },
      { version: 1, claude: { command: ["npx", "--yes", "claude-code"] } }
    );

    expect(options.claude).toEqual({
      executable: "npx",
      args: ["--yes", "claude-code"],
    });
  });

  it("caps the spend when the project set a cap", () => {
    expect(
      optionsFrom({ version: 1 }, { version: 1, claude: { maxBudgetUsd: 2.5 } })
        .maxBudgetUsd
    ).toBe(2.5);
  });

  it("passes no cap at all rather than a cap of nothing", () => {
    // `maxBudgetUsd: undefined` is not the same as an absent key under
    // `exactOptionalPropertyTypes`, and a cap of `null` would reach
    // `--max-budget-usd` as the string "null".
    const options = optionsFrom({ version: 1 });

    expect("maxBudgetUsd" in options).toBe(false);
  });

  it("hands the adapter the runner and the gate it was given", () => {
    const options = optionsFrom({ version: 1 });

    expect(options.runner).toBe(runner);
    expect(options.toolGate).toBe(toolGate);
  });
});
