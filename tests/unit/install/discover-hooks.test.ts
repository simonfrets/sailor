import { chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import {
  discoverHookEnvironment,
  toProjectPath,
} from "../../../src/install/discover-hooks.js";
import type { HookEnvironment } from "../../../src/install/discover-hooks.js";
import { buildSailorProject } from "../../helpers/sailor-project.js";
import {
  createFakeCommandRunner,
  exited,
} from "../../helpers/fake-command-runner.js";
import { removeTempDirectories } from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const HOOK = "#!/usr/bin/env bash\nexit 0\n";

const project = (files: Readonly<Record<string, string>> = {}): string => {
  const root = buildSailorProject({ manifest: { name: "host" }, files });

  for (const path of Object.keys(files)) {
    chmodSync(join(root, ...path.split("/")), 0o755);
  }

  return root;
};

const discover = async (
  projectRoot: string,
  options: {
    /** The effective value, from any config scope. */
    readonly hooksPath?: string;
    /** Which config set it. `inherited` leaves the repository's own unset. */
    readonly scope?: "local" | "inherited";
    readonly commonDirectory?: string;
  } = {}
): Promise<HookEnvironment> =>
  discoverHookEnvironment({
    projectRoot,
    runner: createFakeCommandRunner((request) => {
      const { args } = request.command;

      if (args[1] === "--git-common-dir") {
        return exited(0, { stdout: `${options.commonDirectory ?? ".git"}\n` });
      }

      // `config --local --get` asks the repository; `config --get` asks for
      // the effective value, whichever scope set it.
      const value =
        args[1] === "--local" && options.scope === "inherited"
          ? undefined
          : options.hooksPath;

      return value === undefined
        ? exited(1)
        : exited(0, { stdout: `${value}\n` });
    }).run,
  });

describe("discoverHookEnvironment", () => {
  it("finds the hooks git runs when core.hooksPath is unset", async () => {
    const root = project({ ".git/hooks/pre-commit": HOOK });
    const environment = await discover(root);

    expect(environment.hooksPath).toBeNull();
    expect(environment.hooksDirectory).toBe(join(root, ".git", "hooks"));
    expect(environment.priorHooks).toEqual([
      { hook: "pre-commit", path: ".git/hooks/pre-commit" },
    ]);
  });

  it("resolves a relative core.hooksPath against the working tree root", async () => {
    // git runs a hook from the top of the working tree, which is what a
    // relative core.hooksPath is relative to.
    const root = project({ ".husky/pre-commit": HOOK });
    const environment = await discover(root, { hooksPath: ".husky" });

    expect(environment.hooksDirectory).toBe(join(root, ".husky"));
    expect(environment.priorHooks).toEqual([
      { hook: "pre-commit", path: ".husky/pre-commit" },
    ]);
  });

  it("keeps an absolute core.hooksPath and reports its hooks absolutely", async () => {
    const elsewhere = project({ "pre-commit": HOOK });
    const root = project();
    const environment = await discover(root, {
      hooksPath: elsewhere,
      scope: "inherited",
    });

    expect(environment.hooksDirectory).toBe(elsewhere);
    expect(environment.priorHooks).toEqual([
      { hook: "pre-commit", path: join(elsewhere, "pre-commit") },
    ]);
  });

  it("looks in the common git directory, which is where a worktree's hooks live", async () => {
    const main = project({ ".git/hooks/pre-push": HOOK });
    const worktree = project();
    const environment = await discover(worktree, {
      commonDirectory: join(main, ".git"),
    });

    expect(environment.hooksDirectory).toBe(join(main, ".git", "hooks"));
    expect(environment.priorHooks).toEqual([
      { hook: "pre-push", path: join(main, ".git", "hooks", "pre-push") },
    ]);
  });

  it("ignores git's own samples, which git never runs", async () => {
    const root = project({
      ".git/hooks/pre-commit.sample": HOOK,
      ".git/hooks/pre-commit": HOOK,
    });

    expect(
      (await discover(root)).priorHooks.map((prior) => prior.hook)
    ).toEqual(["pre-commit"]);
  });

  it("ignores a hook that is not executable, because git would not run it", async () => {
    const root = buildSailorProject({
      files: { ".git/hooks/pre-commit": HOOK },
    });

    expect((await discover(root)).priorHooks).toEqual([]);
  });

  it("ignores an entry it cannot stat, such as a dangling symlink", async () => {
    const root = project({ ".git/hooks/pre-push": HOOK });

    symlinkSync(
      join(root, ".git", "hooks", "gone"),
      join(root, ".git", "hooks", "pre-commit")
    );

    expect(
      (await discover(root)).priorHooks.map((prior) => prior.hook)
    ).toEqual(["pre-push"]);
  });

  it("reports no hooks when the directory does not exist", async () => {
    expect((await discover(project())).priorHooks).toEqual([]);
  });

  it("finds every executable hook, sorted, not only the ones it manages", async () => {
    const root = project({
      ".git/hooks/pre-push": HOOK,
      ".git/hooks/commit-msg": HOOK,
      ".git/hooks/pre-commit": HOOK,
    });

    expect(
      (await discover(root)).priorHooks.map((prior) => prior.hook)
    ).toEqual(["commit-msg", "pre-commit", "pre-push"]);
  });

  it("recognises its own dispatchers and claims no prior hook", async () => {
    // Otherwise a second `sailor init` would chain the sailor to itself.
    const root = project({ ".sailor/hooks/pre-commit": HOOK });
    const environment = await discover(root, { hooksPath: ".sailor/hooks" });

    expect(environment.dispatchedBySailor).toBe(true);
    expect(environment.priorHooks).toEqual([]);
  });

  it("does not mistake another directory for its own", async () => {
    const root = project({ ".husky/pre-commit": HOOK });

    expect(
      (await discover(root, { hooksPath: ".husky" })).dispatchedBySailor
    ).toBe(false);
  });

  it("falls back to .git when git names no common directory", async () => {
    const root = project({ ".git/hooks/pre-commit": HOOK });
    const environment = await discover(root, { commonDirectory: "" });

    expect(environment.hooksDirectory).toBe(join(root, ".git", "hooks"));
  });
});

describe("toProjectPath", () => {
  it("reports a path inside the project relative to it", () => {
    expect(toProjectPath("/tmp/host", join("/tmp/host", ".git/hooks/x"))).toBe(
      ".git/hooks/x"
    );
  });

  it("keeps a path outside the project absolute", () => {
    expect(toProjectPath("/tmp/host", "/opt/hooks/x")).toBe("/opt/hooks/x");
  });

  it("keeps the project root itself absolute rather than empty", () => {
    expect(toProjectPath("/tmp/host", "/tmp/host")).toBe("/tmp/host");
  });
});

describe("discoverHookEnvironment and config scope", () => {
  it("chains hooks configured outside the repository", async () => {
    // A `core.hooksPath` in the user's global config governs this repository
    // without being part of it. Asking only `--local` reported no hooks at
    // all, and the installer then switched them off without a word.
    const elsewhere = project({ "pre-commit": HOOK });
    const root = project();

    const environment = await discover(root, {
      hooksPath: elsewhere,
      scope: "inherited",
    });

    expect(environment.hooksPathScope).toBe("inherited");
    expect(environment.priorHooks).toEqual([
      { hook: "pre-commit", path: join(elsewhere, "pre-commit") },
    ]);
  });

  it("marks the repository's own value as local", async () => {
    const root = project({ ".husky/pre-commit": HOOK });
    const environment = await discover(root, { hooksPath: ".husky" });

    expect(environment.hooksPathScope).toBe("local");
  });

  it("reports no scope when nothing configures a hooks path", async () => {
    expect((await discover(project())).hooksPathScope).toBeNull();
  });

  it("prefers the effective value over the repository's own", async () => {
    // git resolves precedence itself; discovery must not second-guess it.
    const root = project({ ".husky/pre-commit": HOOK });
    const environment = await discover(root, {
      hooksPath: ".husky",
      scope: "inherited",
    });

    expect(environment.hooksDirectory).toBe(join(root, ".husky"));
  });
});
