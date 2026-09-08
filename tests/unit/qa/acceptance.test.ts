import { createHash } from "node:crypto";

import { SailorError } from "../../../src/sailor/sailor-error.js";
import { prepareAcceptance } from "../../../src/qa/acceptance.js";
import { captureError } from "../../helpers/expect-error.js";
import { buildSailorProject } from "../../helpers/sailor-project.js";
import { removeTempDirectories } from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const LOGIN_FEATURE = [
  "Feature: Login",
  "  Scenario: Happy path",
  "    When they log in",
  "  Scenario: Wrong password",
  "    When they log in badly",
  "",
].join("\n");

const LOGOUT_FEATURE = [
  "Feature: Logout",
  "  Scenario: Clean exit",
  "    When they log out",
  "",
].join("\n");

const PROCEDURE = [
  "version: 1",
  "steps:",
  "  - id: acceptance-suite",
  "    runner: command",
  "    argv: [node, --test, acceptance]",
  "    covers: [Happy path, Wrong password]",
  "  - id: exit-check",
  "    runner: project-script",
  "    script: test",
  "    covers: [Clean exit]",
  "",
].join("\n");

const buildProject = (files: Readonly<Record<string, string>> = {}): string =>
  buildSailorProject({
    files: {
      "features/login.feature": LOGIN_FEATURE,
      "features/logout.feature": LOGOUT_FEATURE,
      "docs/qa/add-login.yaml": PROCEDURE,
      ...files,
    },
  });

const prepare = (root: string, overrides: Record<string, unknown> = {}) =>
  prepareAcceptance({
    projectRoot: root,
    featurePaths: ["features/login.feature", "features/logout.feature"],
    procedurePath: "docs/qa/add-login.yaml",
    ...overrides,
  });

describe("prepareAcceptance", () => {
  it("pins every accepted file to its content and lists what it accepts", () => {
    const prepared = prepare(buildProject());

    expect(prepared.acceptance).toEqual({
      features: [
        { path: "features/login.feature", sha256: sha256(LOGIN_FEATURE) },
        { path: "features/logout.feature", sha256: sha256(LOGOUT_FEATURE) },
      ],
      procedure: { path: "docs/qa/add-login.yaml", sha256: sha256(PROCEDURE) },
    });
    expect(prepared.scenarios).toEqual([
      "Happy path",
      "Wrong password",
      "Clean exit",
    ]);
    expect(prepared.procedure.steps).toHaveLength(2);
  });

  it("refuses a feature nothing will demonstrate", () => {
    const root = buildProject({
      "docs/qa/add-login.yaml": [
        "version: 1",
        "steps:",
        "  - id: acceptance-suite",
        "    runner: command",
        "    argv: [node, --test]",
        "    covers: [Happy path, Clean exit]",
        "",
      ].join("\n"),
    });
    const error = captureError(() => prepare(root), SailorError);

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("no step covers `Wrong password`");
  });

  it("refuses a step that claims to cover a scenario no feature declares", () => {
    const root = buildProject({
      "features/logout.feature": "Feature: Logout\n",
    });
    const error = captureError(() => prepare(root), SailorError);

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain(
      "covers `Clean exit`, which no accepted feature declares"
    );
    expect(error.message).toContain(
      "features/logout.feature declares no scenario"
    );
  });

  it("refuses two features declaring the same scenario name", () => {
    const root = buildProject({
      "features/logout.feature": [
        "Feature: Logout",
        "  Scenario: Happy path",
        "    When they log out",
        "",
      ].join("\n"),
    });
    const error = captureError(() => prepare(root), SailorError);

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain(
      "`Happy path` is declared by more than one"
    );
  });

  it("names every missing or escaping file rather than the first", () => {
    const error = captureError(
      () =>
        prepare(buildProject(), {
          featurePaths: [
            "features/absent.feature",
            "../outside.feature",
            "features/login.feature",
          ],
          procedurePath: "docs/qa/absent.yaml",
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("features/absent.feature does not exist");
    expect(error.message).toContain("../outside.feature");
    expect(error.message).toContain("docs/qa/absent.yaml does not exist");
  });

  it("refuses the same feature accepted twice", () => {
    const error = captureError(
      () =>
        prepare(buildProject(), {
          featurePaths: ["features/login.feature", "features/login.feature"],
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("accepted more than once");
  });

  it("carries a broken feature or procedure through as its own issues", () => {
    const root = buildProject({
      "features/login.feature": "not gherkin at all\n",
      "docs/qa/add-login.yaml": "version: 1\nsteps: []\n",
    });
    const error = captureError(() => prepare(root), SailorError);

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("features/login.feature");
    expect(error.message).toContain("docs/qa/add-login.yaml");
  });
});
