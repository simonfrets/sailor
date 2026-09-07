import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SailorError } from "../../../src/sailor/sailor-error.js";
import {
  readInstallManifest,
  writeInstallManifest,
} from "../../../src/install/install-manifest.js";
import type { InstallManifest } from "../../../src/install/install-manifest.js";
import { buildSailorProject } from "../../helpers/sailor-project.js";
import { captureError } from "../../helpers/expect-error.js";
import { removeTempDirectories } from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const MANIFEST: InstallManifest = {
  version: 1,
  sailorVersion: "0.1.0",
  installedAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
  managedFiles: [
    { path: "rules/base.yaml", sha256: "a".repeat(64), kind: "managed" },
  ],
  hooks: [{ hook: "pre-commit", chained: ".git/hooks/pre-commit" }],
  previousHooksPath: null,
};

describe("readInstallManifest", () => {
  it("returns null when the sailor has never been installed", () => {
    expect(readInstallManifest(buildSailorProject())).toBeNull();
  });

  it("round-trips a manifest through the filesystem", () => {
    const root = buildSailorProject();

    writeInstallManifest(root, MANIFEST);

    expect(readInstallManifest(root)).toEqual(MANIFEST);
  });

  it("writes the manifest as formatted json with a trailing newline", () => {
    const root = buildSailorProject();

    writeInstallManifest(root, MANIFEST);

    const text = readFileSync(join(root, ".sailor", "version.json"), "utf8");

    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "sailorVersion": "0.1.0"');
  });

  it("refuses a manifest that is not json", () => {
    const root = buildSailorProject({
      files: { ".sailor/version.json": "{" },
    });
    const error = captureError(() => readInstallManifest(root), SailorError);

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("version.json");
  });

  it("defaults a manifest written before hooks were recorded", () => {
    // A project installed by an earlier sailor has no `hooks` key. Reading it
    // as "no hooks were taken over" is correct, and is what lets `sailor init`
    // upgrade such a project instead of refusing its own manifest.
    const root = buildSailorProject({
      files: {
        ".sailor/version.json": JSON.stringify({
          version: 1,
          sailorVersion: "0.1.0",
          installedAt: "2026-08-26T00:00:00.000Z",
          updatedAt: "2026-08-26T00:00:00.000Z",
          managedFiles: [],
        }),
      },
    });

    expect(readInstallManifest(root)).toMatchObject({
      hooks: [],
      previousHooksPath: null,
    });
  });

  it("refuses a manifest that does not match the schema", () => {
    const root = buildSailorProject({
      files: { ".sailor/version.json": JSON.stringify({ version: 2 }) },
    });
    const error = captureError(() => readInstallManifest(root), SailorError);

    expect(error.kind).toBe("invalid-config");
    expect(error.details.join(" ")).toContain("version");
  });
});
