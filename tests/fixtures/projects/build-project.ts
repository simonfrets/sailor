import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createTempDirectory } from "../../helpers/temp-directory.js";

export interface ProjectFixture {
  /** Written to package.json. Omit to create a project with no manifest. */
  readonly manifest?: Record<string, unknown>;
  /** Extra files, keyed by path relative to the project root. */
  readonly files?: Readonly<Record<string, string>>;
}

/**
 * Materialises a throwaway project in a temporary directory.
 *
 * Fixtures are built at run time rather than committed because `npm run check`
 * runs Prettier over the whole repository, and a committed fixture with a
 * deliberate formatting quirk could not pass that gate.
 */
export const buildProject = (fixture: ProjectFixture): string => {
  const root = createTempDirectory("sailor-project-");

  if (fixture.manifest !== undefined) {
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify(fixture.manifest, null, 2)}\n`
    );
  }

  for (const [path, contents] of Object.entries(fixture.files ?? {})) {
    const absolute = join(root, path);

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }

  return root;
};
