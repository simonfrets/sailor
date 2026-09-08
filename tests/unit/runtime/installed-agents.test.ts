import { SailorError } from "../../../src/sailor/sailor-error.js";
import {
  installedAgentPath,
  readInstalledAgentDefinition,
} from "../../../src/runtime/installed-agents.js";
import { captureError } from "../../helpers/expect-error.js";
import { buildSailorProject } from "../../helpers/sailor-project.js";
import { removeTempDirectories } from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const CODER = `version: 1
id: coder
displayName: Coder
summary: Implements an approved specification.
modelProfile: coding-high
tools:
  read: true
  search: true
  edit: true
  execute: true
writeScopes:
  - "src/**"
projectScripts:
  - test
`;

describe("installedAgentPath", () => {
  it("names the file inside the installed sailor", () => {
    expect(installedAgentPath("coder")).toBe(".sailor/agents/coder.yaml");
  });
});

describe("readInstalledAgentDefinition", () => {
  it("reads the definition the project has for an agent", () => {
    const root = buildSailorProject({
      files: { ".sailor/agents/coder.yaml": CODER },
    });
    const definition = readInstalledAgentDefinition(root, "coder");

    expect(definition.displayName).toBe("Coder");
    expect(definition.writeScopes).toEqual(["src/**"]);
  });

  it("names the file when the installation is missing one", () => {
    const error = captureError(
      () => readInstalledAgentDefinition(buildSailorProject(), "coder"),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain(".sailor/agents/coder.yaml");
  });

  it("refuses a file whose id is not the agent it is named for", () => {
    // Two records of one fact. Believing the file name would run the stage
    // under the other agent's tools and write scopes.
    const root = buildSailorProject({
      files: {
        ".sailor/agents/coder.yaml": CODER.replace("id: coder", "id: cleaner"),
      },
    });
    const error = captureError(
      () => readInstalledAgentDefinition(root, "coder"),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("declares the `cleaner` agent");
  });

  it("reports a definition that does not validate, against its own source", () => {
    const root = buildSailorProject({
      files: {
        ".sailor/agents/coder.yaml": CODER.replace("  execute: true", ""),
      },
    });
    const error = captureError(
      () => readInstalledAgentDefinition(root, "coder"),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.details.join("\n")).toContain(".sailor/agents/coder.yaml:");
  });
});
