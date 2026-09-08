import {
  DEFAULT_PROVIDER_COMMANDS,
  loadProvidersConfig,
  providerCommand,
  providerForAgent,
  providersConfigSchema,
  readInstalledProvidersConfig,
} from "../../../src/config/providers-config.js";
import { PROVIDER_IDS } from "../../../src/providers/provider-adapter.js";
import { DEFAULT_CLAUDE_COMMAND } from "../../../src/providers/claude/claude-cli-adapter.js";
import { SailorError } from "../../../src/sailor/sailor-error.js";
import { captureError } from "../../helpers/expect-error.js";
import { buildSailorProject } from "../../helpers/sailor-project.js";
import { removeTempDirectories } from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

describe("providersConfigSchema", () => {
  it("validates with nothing but a version, so an older seeded file keeps parsing", () => {
    expect(providersConfigSchema.parse({ version: 1 })).toEqual({
      version: 1,
      default: "claude",
      agents: {},
      claude: { command: ["claude"], maxBudgetUsd: null },
      codex: { command: ["codex"] },
    });
  });

  it("takes a command as an argument vector rather than a shell string", () => {
    const config = providersConfigSchema.parse({
      version: 1,
      claude: { command: ["npx", "--yes", "@anthropic-ai/claude-code"] },
    });

    expect(config.claude.command).toEqual([
      "npx",
      "--yes",
      "@anthropic-ai/claude-code",
    ]);
    expect(
      providersConfigSchema.safeParse({
        version: 1,
        claude: { command: "claude --print" },
      }).success
    ).toBe(false);
  });

  it("refuses a command with nothing to run", () => {
    // The first word is the executable, so an empty vector names no program.
    expect(
      providersConfigSchema.safeParse({ version: 1, claude: { command: [] } })
        .success
    ).toBe(false);
    expect(
      providersConfigSchema.safeParse({ version: 1, claude: { command: [""] } })
        .success
    ).toBe(false);
  });

  it("refuses a provider the sailor has no contract for", () => {
    expect([...PROVIDER_IDS]).toEqual(["claude", "codex"]);
    expect(
      providersConfigSchema.safeParse({ version: 1, default: "gemini" }).success
    ).toBe(false);
    expect(
      providersConfigSchema.safeParse({ version: 1, agents: { qa: "gemini" } })
        .success
    ).toBe(false);
  });

  it("refuses a per-agent override whose key is not an agent id", () => {
    expect(
      providersConfigSchema.safeParse({
        version: 1,
        agents: { "Not An Agent": "claude" },
      }).success
    ).toBe(false);
  });

  it("refuses a spending cap that could never allow a run", () => {
    for (const maxBudgetUsd of [0, -1]) {
      expect(
        providersConfigSchema.safeParse({
          version: 1,
          claude: { maxBudgetUsd },
        }).success
      ).toBe(false);
    }

    expect(
      providersConfigSchema.parse({ version: 1, claude: { maxBudgetUsd: 3 } })
        .claude.maxBudgetUsd
    ).toBe(3);
  });

  it("refuses a key it does not know", () => {
    expect(
      providersConfigSchema.safeParse({ version: 1, provider: "claude" })
        .success
    ).toBe(false);
  });
});

describe("providerForAgent", () => {
  const config = providersConfigSchema.parse({
    version: 1,
    default: "claude",
    agents: { qa: "codex" },
  });

  it("runs an agent on the provider named for it", () => {
    expect(providerForAgent(config, "qa")).toBe("codex");
  });

  it("runs every other agent on the default", () => {
    expect(providerForAgent(config, "coder")).toBe("claude");
  });
});

describe("providerCommand", () => {
  it("names the command that starts each provider's CLI", () => {
    const config = providersConfigSchema.parse({
      version: 1,
      claude: { command: ["claude-next"] },
    });

    expect(providerCommand(config, "claude")).toEqual(["claude-next"]);
    expect(providerCommand(config, "codex")).toEqual(["codex"]);
  });
});

describe("DEFAULT_PROVIDER_COMMANDS", () => {
  it("starts the Claude CLI the way the adapter does when it is given no command", () => {
    // Two defaults for one fact: the adapter's, which a caller with no
    // configuration gets, and the seeded file's. This is what pins them
    // together rather than letting one be changed alone.
    expect(DEFAULT_PROVIDER_COMMANDS.claude).toEqual([
      DEFAULT_CLAUDE_COMMAND.executable,
      ...DEFAULT_CLAUDE_COMMAND.args,
    ]);
  });

  it("names a command for every provider the contract admits", () => {
    for (const provider of PROVIDER_IDS) {
      expect(DEFAULT_PROVIDER_COMMANDS[provider].length).toBeGreaterThan(0);
    }
  });
});

describe("readInstalledProvidersConfig", () => {
  it("reads the installed file", () => {
    const root = buildSailorProject({
      files: {
        ".sailor/config/providers.yaml": [
          "version: 1",
          "default: claude",
          "agents:",
          "  architect: codex",
          "claude:",
          "  command: [claude]",
          "  maxBudgetUsd: 3",
          "",
        ].join("\n"),
      },
    });

    expect(readInstalledProvidersConfig(root)).toEqual({
      version: 1,
      default: "claude",
      agents: { architect: "codex" },
      claude: { command: ["claude"], maxBudgetUsd: 3 },
      codex: { command: ["codex"] },
    });
  });

  it("falls back to the defaults when the file was never installed", () => {
    expect(readInstalledProvidersConfig(buildSailorProject())).toEqual(
      providersConfigSchema.parse({ version: 1 })
    );
  });

  it("reports an invalid installed file rather than quietly using defaults", () => {
    const root = buildSailorProject({
      files: {
        ".sailor/config/providers.yaml": "version: 1\ndefault: anthropic\n",
      },
    });
    const error = captureError(
      () => readInstalledProvidersConfig(root),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain(".sailor/config/providers.yaml");
  });
});

describe("loadProvidersConfig", () => {
  it("names the source and the line in a validation error", () => {
    const error = captureError(
      () =>
        loadProvidersConfig("version: 1\ndefault: anthropic\n", {
          source: "config/providers.yaml",
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.details.join("\n")).toContain("config/providers.yaml:2:10");
  });
});
