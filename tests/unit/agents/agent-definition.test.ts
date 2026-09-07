import {
  MODEL_PROFILES,
  loadAgentDefinition,
} from "../../../src/agents/agent-definition.js";
import { SailorError } from "../../../src/sailor/sailor-error.js";
import { captureError } from "../../helpers/expect-error.js";

const source = "agents/example.yaml";

const load = (text: string) => loadAgentDefinition(text, { source });

const definition = (body: string): string =>
  `version: 1\nid: example\ndisplayName: Example\nsummary: An example agent\nmodelProfile: coding-high\n${body}`;

const EDITING = definition(
  "tools:\n  read: true\n  search: true\n  edit: true\n  execute: true\nwriteScopes:\n  - 'src/**'\nprojectScripts:\n  - test\n"
);

const READ_ONLY = definition(
  "tools:\n  read: true\n  search: true\n  edit: false\n  execute: false\n"
);

describe("loadAgentDefinition", () => {
  it("parses a definition with an edit scope and a script allowance", () => {
    expect(load(EDITING)).toEqual({
      version: 1,
      id: "example",
      displayName: "Example",
      summary: "An example agent",
      modelProfile: "coding-high",
      tools: { read: true, search: true, edit: true, execute: true },
      writeScopes: ["src/**"],
      projectScripts: ["test"],
    });
  });

  it("defaults a read-only agent to no scopes and no scripts", () => {
    const parsed = load(READ_ONLY);

    expect(parsed.writeScopes).toEqual([]);
    expect(parsed.projectScripts).toEqual([]);
  });

  it("offers exactly the three logical model profiles", () => {
    expect([...MODEL_PROFILES]).toEqual([
      "coding-high",
      "reasoning-high",
      "verification",
    ]);
  });

  it("rejects a provider model id in place of a logical profile", () => {
    const error = captureError(
      () => load(EDITING.replace("coding-high", "claude-opus-5")),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.details.join("\n")).toContain("modelProfile");
  });

  it("rejects an editing agent that declares no write scope", () => {
    const error = captureError(
      () =>
        load(
          definition(
            "tools:\n  read: true\n  search: true\n  edit: true\n  execute: false\n"
          )
        ),
      SailorError
    );

    expect(error.details.join("\n")).toContain("at least one write scope");
  });

  it("rejects a write scope that leaves the project", () => {
    // Design decision 6 puts tool enforcement in the runtime, and this is what
    // the runtime reads to decide which files the agent may write, so a scope
    // outside the project is a grant rather than a mislabel. `{..,src}/**`
    // carries no `..` segment of its own and `minimatch` still matches
    // `../outside.txt` against it, which is why the check is not the one a
    // recorded path gets.
    for (const scope of ["/etc/**", "../**", "{..,src}/**"]) {
      const error = captureError(
        () => load(EDITING.replace("'src/**'", `'${scope}'`)),
        SailorError
      );

      expect(error.kind).toBe("invalid-config");
      expect(error.details.join("\n")).toContain("writeScopes");
    }
  });

  it("rejects a non-editing agent that declares a write scope", () => {
    const error = captureError(
      () =>
        load(
          definition(
            "tools:\n  read: true\n  search: true\n  edit: false\n  execute: false\nwriteScopes:\n  - 'src/**'\n"
          )
        ),
      SailorError
    );

    expect(error.details.join("\n")).toContain(
      "must not declare a write scope"
    );
  });

  it("rejects a script allowance without the capability to execute", () => {
    const error = captureError(
      () =>
        load(
          definition(
            "tools:\n  read: true\n  search: true\n  edit: false\n  execute: false\nprojectScripts:\n  - test\n"
          )
        ),
      SailorError
    );

    expect(error.details.join("\n")).toContain(
      "must not declare a project script"
    );
  });

  it("rejects the capability to execute without a script allowance", () => {
    // The mirror of the case above, and the one that was missing: permission
    // to run commands with nothing it is permitted to run. README claimed the
    // two directions were symmetric; only one of them was checked.
    const error = captureError(
      () =>
        load(
          definition(
            "tools:\n  read: true\n  search: true\n  edit: false\n  execute: true\n"
          )
        ),
      SailorError
    );

    expect(error.details.join("\n")).toContain(
      "must declare at least one project script"
    );
  });

  it("rejects an arbitrary command dressed up as a project script", () => {
    const error = captureError(
      () => load(EDITING.replace("  - test", "  - 'rm -rf /'")),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
  });

  it("rejects an unknown capability rather than ignoring it", () => {
    const error = captureError(
      () =>
        load(
          EDITING.replace("  execute: true", "  execute: true\n  push: true")
        ),
      SailorError
    );

    expect(error.details.join("\n")).toContain("push");
  });
});
