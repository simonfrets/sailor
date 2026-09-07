import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const checkerPath = resolve("scripts/check-shell-syntax.sh");
const temporaryDirectories: string[] = [];

const createFixture = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "sailor-shell-"));
  temporaryDirectories.push(directory);
  return directory;
};

const runChecker = (directory: string) =>
  spawnSync("bash", [checkerPath, directory], {
    encoding: "utf8",
  });

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("check-shell-syntax.sh", () => {
  it("accepts valid shell files recursively", () => {
    const directory = createFixture();
    const nestedDirectory = join(directory, "nested");
    mkdirSync(nestedDirectory);
    writeFileSync(
      join(nestedDirectory, "valid.sh"),
      "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'ok\\n'\n"
    );

    const result = runChecker(directory);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Checked 1 shell script(s)");
  });

  it("descends far enough to reject a nested invalid file", () => {
    // The recursion test above uses a *valid* file, so a checker that never
    // descended would pass it by finding nothing. This is the one that fails
    // if `-maxdepth 1` is ever added.
    const directory = createFixture();
    const nestedDirectory = join(directory, "nested");

    mkdirSync(nestedDirectory);
    writeFileSync(join(nestedDirectory, "broken.sh"), "if true; then\n");

    const result = runChecker(directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("broken.sh");
  });

  it("says how many files it checked, so an empty scan is visible", () => {
    // A gate that reports success having examined nothing is the failure this
    // is here to make loud.
    const result = runChecker(createFixture());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Checked 0 shell script(s)");
  });

  it("fails when the scan itself could not complete", () => {
    const directory = createFixture();
    const unreadable = join(directory, "unreadable");

    mkdirSync(unreadable);
    writeFileSync(join(unreadable, "valid.sh"), "#!/usr/bin/env bash\ntrue\n");
    chmodSync(unreadable, 0o000);

    const result = runChecker(directory);

    chmodSync(unreadable, 0o755);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scan failed");
  });

  it("rejects invalid shell files", () => {
    const directory = createFixture();
    writeFileSync(join(directory, "invalid.sh"), "if true; then\n");

    const result = runChecker(directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid.sh");
  });

  it("returns a usage error for a missing directory", () => {
    const directory = join(createFixture(), "missing");

    const result = runChecker(directory);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("is not a directory");
  });
});
