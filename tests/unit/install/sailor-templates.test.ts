import { SailorError } from "../../../src/sailor/sailor-error.js";
import {
  SEEDED_TEMPLATE_PATHS,
  isSeededTemplate,
  listSailorTemplateFiles,
  readSailorTemplateFile,
  sailorTemplateRoot,
} from "../../../src/install/sailor-templates.js";
import { captureError } from "../../helpers/expect-error.js";
import {
  createTempDirectory,
  removeTempDirectories,
} from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const packageRoot = process.cwd();

describe("listSailorTemplateFiles", () => {
  it("lists exactly the shipped template files", () => {
    expect(
      listSailorTemplateFiles(packageRoot).map((file) => file.installedPath)
    ).toEqual([
      ".gitignore",
      "agents/architect.yaml",
      "agents/cleaner.yaml",
      "agents/coder.yaml",
      "agents/hardener.yaml",
      "agents/qa.yaml",
      "agents/specifier.yaml",
      "ci/github-actions.yml",
      "config/hooks.yaml",
      "config/project.yaml",
      "rules/base.yaml",
      "rules/custom/README.md",
      "rules/git.yaml",
      "rules/typescript.yaml",
    ]);
  });

  it("renames the undotted gitignore template to its installed name", () => {
    const gitignore = listSailorTemplateFiles(packageRoot).find(
      (file) => file.installedPath === ".gitignore"
    );

    // npm drops a file named `.gitignore` from the published tarball, so the
    // template has to ship undotted and be renamed on the way in.
    expect(gitignore?.templatePath).toBe("gitignore");
  });

  it("refuses a package that has no templates directory", () => {
    const empty = createTempDirectory("sailor-no-templates-");
    const error = captureError(
      () => listSailorTemplateFiles(empty),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("templates");
  });
});

describe("seeded templates", () => {
  it("hands exactly the two configuration files to the project", () => {
    // Adding a template is a decision about who owns it, so this list is
    // asserted rather than derived from a path prefix.
    expect(
      listSailorTemplateFiles(packageRoot)
        .filter((file) => file.seeded)
        .map((file) => file.installedPath)
    ).toEqual([...SEEDED_TEMPLATE_PATHS]);
  });

  it("names only paths the package actually ships", () => {
    const shipped = listSailorTemplateFiles(packageRoot).map(
      (file) => file.installedPath
    );

    expect(SEEDED_TEMPLATE_PATHS.length).toBeGreaterThan(0);

    for (const path of SEEDED_TEMPLATE_PATHS) {
      expect(shipped).toContain(path);
    }
  });

  it("keeps the rules and agents the sailor maintains", () => {
    for (const path of [
      "rules/base.yaml",
      "rules/custom/README.md",
      "agents/coder.yaml",
      ".gitignore",
    ]) {
      expect(isSeededTemplate(path)).toBe(false);
    }
  });
});

describe("readSailorTemplateFile", () => {
  it("reads a template by its template path", () => {
    const contents = readSailorTemplateFile(packageRoot, "rules/base.yaml");

    expect(contents).toContain("id: sailor-base");
  });
});

describe("sailorTemplateRoot", () => {
  it("points at the sailor template tree inside the package", () => {
    expect(sailorTemplateRoot("/pkg")).toMatch(/templates.\.sailor$/);
  });
});
