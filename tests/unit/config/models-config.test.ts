import { MODEL_PROFILES } from "../../../src/agents/agent-definition.js";
import {
  loadModelsConfig,
  modelsConfigSchema,
  modelsForProvider,
  readInstalledModelsConfig,
} from "../../../src/config/models-config.js";
import { SailorError } from "../../../src/sailor/sailor-error.js";
import { captureError } from "../../helpers/expect-error.js";
import { buildSailorProject } from "../../helpers/sailor-project.js";
import { removeTempDirectories } from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

describe("modelsConfigSchema", () => {
  it("validates with nothing but a version, so an older seeded file keeps parsing", () => {
    expect(modelsConfigSchema.parse({ version: 1 })).toEqual({
      version: 1,
      models: {},
    });
  });

  it("takes a model id for each logical profile of a provider", () => {
    expect(
      modelsConfigSchema.parse({
        version: 1,
        models: {
          claude: {
            "coding-high": "opus",
            "reasoning-high": "opus",
            verification: "sonnet",
          },
        },
      }).models.claude
    ).toEqual({
      "coding-high": "opus",
      "reasoning-high": "opus",
      verification: "sonnet",
    });
  });

  it("takes one profile without demanding the other two", () => {
    // A profile the file leaves out runs on the adapter's own default, so a
    // project overriding one model does not have to restate the rest.
    expect(
      modelsConfigSchema.parse({
        version: 1,
        models: { claude: { verification: "haiku" } },
      }).models.claude
    ).toEqual({ verification: "haiku" });
  });

  it("refuses a provider the sailor has no adapter contract for", () => {
    expect(
      modelsConfigSchema.safeParse({
        version: 1,
        models: { gemini: { "coding-high": "pro" } },
      }).success
    ).toBe(false);
  });

  it("refuses a profile that is not one of the logical three", () => {
    expect([...MODEL_PROFILES]).toEqual([
      "coding-high",
      "reasoning-high",
      "verification",
    ]);
    expect(
      modelsConfigSchema.safeParse({
        version: 1,
        models: { claude: { "coding-highest": "opus" } },
      }).success
    ).toBe(false);
  });

  it("refuses an empty model id, which `--model` would be given verbatim", () => {
    expect(
      modelsConfigSchema.safeParse({
        version: 1,
        models: { claude: { "coding-high": "" } },
      }).success
    ).toBe(false);
  });

  it("refuses a key it does not know", () => {
    expect(
      modelsConfigSchema.safeParse({ version: 1, model: {} }).success
    ).toBe(false);
  });
});

describe("modelsForProvider", () => {
  it("reads the provider's own overrides", () => {
    const config = modelsConfigSchema.parse({
      version: 1,
      models: { claude: { "coding-high": "opus-4-6" } },
    });

    expect(modelsForProvider(config, "claude")).toEqual({
      "coding-high": "opus-4-6",
    });
  });

  it("has nothing to say about a provider the file never mentions", () => {
    // Which is what leaves every profile on the adapter's default rather than
    // on an empty `--model`.
    expect(
      modelsForProvider(modelsConfigSchema.parse({ version: 1 }), "codex")
    ).toEqual({});
  });
});

describe("readInstalledModelsConfig", () => {
  it("reads the installed file", () => {
    const root = buildSailorProject({
      files: {
        ".sailor/config/models.yaml": [
          "version: 1",
          "models:",
          "  claude:",
          "    verification: haiku",
          "",
        ].join("\n"),
      },
    });

    expect(readInstalledModelsConfig(root)).toEqual({
      version: 1,
      models: { claude: { verification: "haiku" } },
    });
  });

  it("falls back to the defaults when the file was never installed", () => {
    expect(readInstalledModelsConfig(buildSailorProject())).toEqual(
      modelsConfigSchema.parse({ version: 1 })
    );
  });

  it("reports an invalid installed file rather than quietly using defaults", () => {
    // A mistyped profile would otherwise run the agent on a model the project
    // did not ask for, and the bill is the first thing that would say so.
    const root = buildSailorProject({
      files: {
        ".sailor/config/models.yaml":
          "version: 1\nmodels:\n  claude:\n    coding: opus\n",
      },
    });
    const error = captureError(
      () => readInstalledModelsConfig(root),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain(".sailor/config/models.yaml");
  });
});

describe("loadModelsConfig", () => {
  it("names the source and the line in a validation error", () => {
    const error = captureError(
      () =>
        loadModelsConfig("version: 1\nmodels:\n  claude: nope\n", {
          source: "config/models.yaml",
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.details.join("\n")).toContain("config/models.yaml:3:11");
  });
});
