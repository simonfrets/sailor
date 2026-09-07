import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { SailorError } from "../../../src/sailor/sailor-error.js";
import {
  readPackageRepository,
  readPackageVersion,
} from "../../../src/sailor/package-version.js";
import { captureError } from "../../helpers/expect-error.js";
import {
  createTempDirectory,
  removeTempDirectories,
} from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const withManifest = (contents: string): string => {
  const directory = createTempDirectory("sailor-version-");

  writeFileSync(join(directory, "package.json"), contents);

  return directory;
};

describe("readPackageVersion", () => {
  it("reads the version from a package manifest", () => {
    const directory = withManifest('{ "name": "x", "version": "1.2.3" }');

    expect(readPackageVersion(directory)).toBe("1.2.3");
  });

  it("rejects a manifest that cannot be read", () => {
    const directory = createTempDirectory("sailor-version-");

    expect(() => readPackageVersion(directory)).toThrow(SailorError);
  });

  it("rejects a manifest that is not an object", () => {
    const directory = withManifest("[1, 2, 3]");

    expect(() => readPackageVersion(directory)).toThrow(
      /does not declare a string `version`/
    );
  });

  it("rejects a manifest without a string version", () => {
    const directory = withManifest('{ "name": "x" }');

    expect(() => readPackageVersion(directory)).toThrow(
      /does not declare a string `version`/
    );
  });
});

describe("readPackageRepository", () => {
  const build = (manifest: Record<string, unknown>): string => {
    const directory = createTempDirectory("sailor-repository-");

    writeFileSync(
      join(directory, "package.json"),
      `${JSON.stringify(manifest)}\n`
    );

    return directory;
  };

  it("reads owner and name from the git url", () => {
    expect(
      readPackageRepository(
        build({
          repository: {
            type: "git",
            url: "git+https://github.com/an-owner/a-repo.git",
          },
        })
      )
    ).toBe("an-owner/a-repo");
  });

  it("accepts the shorthand string form", () => {
    expect(
      readPackageRepository(build({ repository: "https://github.com/o/r" }))
    ).toBe("o/r");
  });

  it("accepts an ssh remote", () => {
    expect(
      readPackageRepository(build({ repository: "git@github.com:o/r.git" }))
    ).toBe("o/r");
  });

  it("refuses a package that names no GitHub repository", () => {
    // Without it there is no release to install from, and a constant here
    // would name the wrong repository the moment anyone forked this one.
    const error = captureError(
      () => readPackageRepository(build({ name: "x" })),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("repository");
  });

  it("refuses a repository that is not on GitHub", () => {
    const error = captureError(
      () =>
        readPackageRepository(build({ repository: "https://gitlab.com/o/r" })),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
  });
});
