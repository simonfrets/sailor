import {
  projectRelativeGlobSchema,
  projectRelativePathSchema,
} from "../../../src/sailor/project-path.js";

/** Every write scope the sailor ships, across the six agent definitions. */
const SHIPPED_SCOPES = [
  "src/**",
  "tests/**",
  "docs/specs/**",
  "docs/qa/**",
  "features/**",
];

/**
 * Globs that leave the project while satisfying the plain-path rule.
 *
 * None contains a leading `/`, a `..` segment or a backslash, so
 * `projectRelativePathSchema` accepts all of them - which is the whole reason
 * the glob schema exists. `minimatch` matches `../outside.txt` against the
 * first three and `/etc/passwd` against the last two.
 */
const ESCAPING_GLOBS = [
  "{..,src}/**",
  "@(..|src)/**",
  "[.][.]/**",
  "{/etc,src}/**",
  "!(src)/**",
];

describe("projectRelativeGlobSchema", () => {
  it("accepts every write scope the sailor ships", () => {
    for (const scope of SHIPPED_SCOPES) {
      expect(projectRelativeGlobSchema.safeParse(scope).success).toBe(true);
    }
  });

  it("refuses what a recorded path refuses", () => {
    for (const scope of ["/etc/**", "../**", "src/../../etc/**"]) {
      expect(projectRelativeGlobSchema.safeParse(scope).success).toBe(false);
    }
  });

  it("refuses the alternation a plain-path check cannot see through", () => {
    for (const scope of ESCAPING_GLOBS) {
      // The premise: each of these passes the path rule. If one day it does
      // not, this case is no longer the one being guarded against.
      expect(projectRelativePathSchema.safeParse(scope).success).toBe(true);
      expect(projectRelativeGlobSchema.safeParse(scope).success).toBe(false);
    }
  });

  it("keeps the wildcards a write scope is written with", () => {
    for (const scope of ["src/**/*.ts", "docs/qa/*", "src/?.ts"]) {
      expect(projectRelativeGlobSchema.safeParse(scope).success).toBe(true);
    }
  });
});
