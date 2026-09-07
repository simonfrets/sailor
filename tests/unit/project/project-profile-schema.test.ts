import {
  PACKAGE_MANAGERS,
  VALIDATION_MODES,
  packageManagerSchema,
  portableProjectProfileSchema,
  projectProfileSchema,
  toPortableProjectProfile,
} from "../../../src/project/project-profile-schema.js";
import type { ProjectProfile } from "../../../src/project/project-profile-schema.js";

const PROFILE: ProjectProfile = {
  root: "/tmp/example-project",
  packageManager: "pnpm",
  availableScripts: ["lint", "test"],
  typescriptConfigFiles: ["tsconfig.json"],
  eslintConfigFiles: ["eslint.config.js"],
  gitHooksPath: ".husky",
  existingHookEntrypoints: [
    { runner: "husky", hook: "pre-commit", path: ".husky/pre-commit" },
  ],
  validationMode: "native-plus-sailor",
};

describe("package manager and validation mode enums", () => {
  it("supports the four package managers the gates construct commands for", () => {
    expect([...PACKAGE_MANAGERS]).toEqual(["bun", "npm", "pnpm", "yarn"]);
    expect(packageManagerSchema.safeParse("cargo").success).toBe(false);
  });

  it("offers exactly the three validation modes", () => {
    // `toContain` let the set grow or the default move without failing. The
    // default itself is pinned in tests/unit/config/project-config.test.ts,
    // which is where it is actually decided.
    expect([...VALIDATION_MODES]).toEqual([
      "sailor-only",
      "native-only",
      "native-plus-sailor",
    ]);
  });
});

describe("projectProfileSchema", () => {
  it("accepts a fully discovered profile", () => {
    expect(projectProfileSchema.parse(PROFILE)).toEqual(PROFILE);
  });

  it("rejects an unknown key so a typo is never silently ignored", () => {
    expect(
      projectProfileSchema.safeParse({ ...PROFILE, packagemanager: "npm" })
        .success
    ).toBe(false);
  });

  it("rejects an unknown hook runner and an unknown hook name", () => {
    expect(
      projectProfileSchema.safeParse({
        ...PROFILE,
        existingHookEntrypoints: [
          { runner: "overcommit", hook: "pre-commit", path: "x" },
        ],
      }).success
    ).toBe(false);

    expect(
      projectProfileSchema.safeParse({
        ...PROFILE,
        existingHookEntrypoints: [
          { runner: "git", hook: "post-merge", path: "x" },
        ],
      }).success
    ).toBe(false);
  });

  it("allows an absent git hooks path", () => {
    expect(
      projectProfileSchema.parse({ ...PROFILE, gitHooksPath: null })
        .gitHooksPath
    ).toBeNull();
  });

  it("rejects an unknown script name", () => {
    expect(
      projectProfileSchema.safeParse({
        ...PROFILE,
        availableScripts: ["deploy"],
      }).success
    ).toBe(false);
  });
});

describe("toPortableProjectProfile", () => {
  it("drops the absolute root so the persisted profile is machine-independent", () => {
    const portable = toPortableProjectProfile(PROFILE);

    expect(portable).not.toHaveProperty("root");
    expect(JSON.stringify(portable)).not.toContain("/tmp/example-project");
    expect(portableProjectProfileSchema.parse(portable)).toEqual(portable);
  });

  it("rejects a portable profile that still carries a root", () => {
    expect(portableProjectProfileSchema.safeParse(PROFILE).success).toBe(false);
  });
});
