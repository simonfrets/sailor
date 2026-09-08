import {
  globMatches,
  matchingWriteScope,
  toProjectRelativePath,
} from "../../../src/enforcement/write-scope.js";

describe("globMatches", () => {
  it("lets `**` name a whole subtree, dotfiles included", () => {
    for (const path of ["src/a.ts", "src/a/b/c.ts", "src/.eslintrc"]) {
      expect(globMatches("src/**", path)).toBe(true);
    }

    for (const path of ["srcx/a.ts", "tests/a.ts", "a/src/b.ts", "src"]) {
      expect(globMatches("src/**", path)).toBe(false);
    }
  });

  it("lets `**` stand for zero directories as well as many", () => {
    expect(globMatches("**/*.ts", "a.ts")).toBe(true);
    expect(globMatches("**/*.ts", "x/y/a.ts")).toBe(true);
    expect(globMatches("**/*.ts", "a.js")).toBe(false);
    expect(globMatches("**", "a")).toBe(true);
    expect(globMatches("**", "a/b/c")).toBe(true);
  });

  it("keeps `*` and `?` inside one path segment", () => {
    expect(globMatches("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatches("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(globMatches("src/*.ts", "src/a.tsx")).toBe(false);
    expect(globMatches("src/?.ts", "src/a.ts")).toBe(true);
    expect(globMatches("src/?.ts", "src/ab.ts")).toBe(false);
    expect(globMatches("docs/qa/*", "docs/qa/x.md")).toBe(true);
    expect(globMatches("docs/qa/*", "docs/qa/x/y.md")).toBe(false);
    expect(globMatches("docs/qa/*", "docs/qa")).toBe(false);
  });

  it("treats `**` glued to other characters as a plain `*`", () => {
    expect(globMatches("src/**.ts", "src/a.ts")).toBe(true);
    expect(globMatches("src/**.ts", "src/a/b.ts")).toBe(false);
  });

  it("reads every other character literally", () => {
    expect(globMatches("src/a.b", "src/a.b")).toBe(true);
    expect(globMatches("src/a.b", "src/aXb")).toBe(false);
    expect(globMatches("a+b/c", "a+b/c")).toBe(true);
    expect(globMatches("a+b/c", "aab/c")).toBe(false);
    expect(globMatches("src/$x", "src/$x")).toBe(true);
  });

  it("matches the whole path, not a prefix or a suffix of it", () => {
    expect(globMatches("src/a.ts", "src/a.ts.bak")).toBe(false);
    expect(globMatches("a.ts", "src/a.ts")).toBe(false);
  });
});

describe("matchingWriteScope", () => {
  const SCOPES = ["src/**", "tests/**"];

  it("names the scope a path falls under", () => {
    expect(matchingWriteScope(SCOPES, "src/index.ts")).toBe("src/**");
    expect(matchingWriteScope(SCOPES, "tests/unit/a.test.ts")).toBe("tests/**");
  });

  it("finds no scope for a path outside every one of them", () => {
    expect(matchingWriteScope(SCOPES, "docs/readme.md")).toBeNull();
    expect(matchingWriteScope(SCOPES, "package.json")).toBeNull();
    expect(matchingWriteScope([], "src/index.ts")).toBeNull();
  });

  it("puts nothing outside the project inside a scope, whatever the scope says", () => {
    for (const path of [
      "/etc/passwd",
      "../src/a.ts",
      "src/../../a.ts",
      "src\\a.ts",
      "",
    ]) {
      expect(matchingWriteScope(["**"], path)).toBeNull();
    }
  });
});

describe("toProjectRelativePath", () => {
  const ROOT = "/tmp/project";

  it("relativises a path inside the project, absolute or not", () => {
    expect(toProjectRelativePath(ROOT, "/tmp/project/src/a.ts")).toBe(
      "src/a.ts"
    );
    expect(toProjectRelativePath(ROOT, "src/a.ts")).toBe("src/a.ts");
    expect(toProjectRelativePath(ROOT, "./src//a.ts")).toBe("src/a.ts");
    expect(toProjectRelativePath(ROOT, "src/x/../a.ts")).toBe("src/a.ts");
  });

  it("reports a path that leaves the project as outside it", () => {
    for (const path of [
      "/etc/passwd",
      "../a.ts",
      "src/../../a.ts",
      "/tmp/project/../other/a.ts",
    ]) {
      expect(toProjectRelativePath(ROOT, path)).toBeNull();
    }
  });

  it("does not mistake a sibling directory sharing the prefix for the project", () => {
    expect(toProjectRelativePath(ROOT, "/tmp/project-2/a.ts")).toBeNull();
    expect(toProjectRelativePath(ROOT, "/tmp/projectile")).toBeNull();
  });

  it("does not count the project root itself as a file inside it", () => {
    expect(toProjectRelativePath(ROOT, ROOT)).toBeNull();
    expect(toProjectRelativePath(ROOT, ".")).toBeNull();
    expect(toProjectRelativePath(ROOT, "")).toBeNull();
  });
});
