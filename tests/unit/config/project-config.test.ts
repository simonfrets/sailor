import { loadProjectConfig } from "../../../src/config/project-config.js";
import { SailorError } from "../../../src/sailor/sailor-error.js";
import { captureError } from "../../helpers/expect-error.js";

const load = (text: string) =>
  loadProjectConfig(text, { source: "config/project.yaml" });

describe("loadProjectConfig", () => {
  it("defaults to running the project's own scripts alongside the sailor", () => {
    expect(load("version: 1\n")).toEqual({
      version: 1,
      validationMode: "native-plus-sailor",
      packageManager: null,
    });
  });

  it("lets a project drop one side of validation without editing a rule", () => {
    expect(
      load("version: 1\nvalidationMode: sailor-only\n").validationMode
    ).toBe("sailor-only");
  });

  it("pins a package manager to resolve an ambiguous repository", () => {
    expect(load("version: 1\npackageManager: pnpm\n").packageManager).toBe(
      "pnpm"
    );
  });

  it("rejects an unknown validation mode", () => {
    const error = captureError(
      () => load("version: 1\nvalidationMode: whatever\n"),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.details.join("\n")).toContain("validationMode");
  });

  it("rejects a package manager the sailor cannot drive", () => {
    const error = captureError(
      () => load("version: 1\npackageManager: make\n"),
      SailorError
    );

    expect(error.details.join("\n")).toContain("packageManager");
  });

  it("rejects a config from a future schema version", () => {
    const error = captureError(() => load("version: 2\n"), SailorError);

    expect(error.kind).toBe("invalid-config");
  });
});
