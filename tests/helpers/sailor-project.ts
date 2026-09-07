import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createTempDirectory } from "./temp-directory.js";

export interface SailorProjectFixture {
  /** Written to the project's own package.json. Omit for no manifest. */
  readonly manifest?: Record<string, unknown>;
  /** Bundles under `.sailor/rules`, keyed by file name. */
  readonly rules?: Readonly<Record<string, string>>;
  /** Bundles under `.sailor/rules/custom`, keyed by file name. */
  readonly customRules?: Readonly<Record<string, string>>;
  /** Any other file, keyed by path relative to the project root. */
  readonly files?: Readonly<Record<string, string>>;
}

const writeFile = (root: string, path: string, contents: string): void => {
  const absolute = join(root, path);

  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
};

/**
 * Materialises a project the sailor is installed into.
 *
 * The `.sailor` directory is created even when the fixture puts nothing in it,
 * because its presence is what tells the sailor a project is installed: the
 * task lock refuses to record a transition into a project that has none rather
 * than creating one. A fixture standing in for an uninstalled project is a bare
 * `createTempDirectory`, not this.
 */
export const buildSailorProject = (
  fixture: SailorProjectFixture = {}
): string => {
  const root = createTempDirectory("sailor-installed-");

  mkdirSync(join(root, ".sailor"), { recursive: true });

  if (fixture.manifest !== undefined) {
    writeFile(
      root,
      "package.json",
      `${JSON.stringify(fixture.manifest, null, 2)}\n`
    );
  }

  for (const [name, contents] of Object.entries(fixture.rules ?? {})) {
    writeFile(root, join(".sailor", "rules", name), contents);
  }

  for (const [name, contents] of Object.entries(fixture.customRules ?? {})) {
    writeFile(root, join(".sailor", "rules", "custom", name), contents);
  }

  for (const [path, contents] of Object.entries(fixture.files ?? {})) {
    writeFile(root, path, contents);
  }

  return root;
};
