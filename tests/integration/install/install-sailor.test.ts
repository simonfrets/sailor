import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { SailorError } from "../../../src/sailor/sailor-error.js";
import { installSailor } from "../../../src/install/install-sailor.js";
import type { InstallSailorResult } from "../../../src/install/install-sailor.js";
import { readInstallManifest } from "../../../src/install/install-manifest.js";
import { hashManagedFile } from "../../../src/install/install-manifest.js";
import { listSailorTemplateFiles } from "../../../src/install/sailor-templates.js";
import { updateTaskFile } from "../../../src/tasks/update-task-file.js";
import { captureRejection } from "../../helpers/expect-error.js";
import {
  at,
  createFakeCommandRunner,
  exited,
} from "../../helpers/fake-command-runner.js";
import type {
  FakeCommandRunner,
  PlannedCommandResult,
} from "../../helpers/fake-command-runner.js";
import { buildTask } from "../../helpers/tasks.js";
import {
  createTempDirectory,
  removeTempDirectories,
} from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const NOW = new Date("2026-08-26T12:00:00.000Z");
const LATER = new Date("2026-09-01T09:30:00.000Z");

/** A synthetic `sailor` package, so a test controls what ships. */
const buildPackage = (
  templates: Readonly<Record<string, string>>,
  version = "0.1.0"
): string => {
  const root = createTempDirectory("sailor-package-");

  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "sailor",
        version,
        repository: {
          type: "git",
          url: "git+https://github.com/an-owner/a-repo.git",
        },
      },
      null,
      2
    )}\n`
  );

  for (const [path, contents] of Object.entries(templates)) {
    const absolute = join(root, "templates", ".sailor", ...path.split("/"));

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }

  return root;
};

/** A host project that already has its own toolchain configuration. */
const buildHostProject = (): string => {
  const root = createTempDirectory("sailor-host-");

  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      { name: "host", version: "1.0.0", scripts: { test: "jest" } },
      null,
      2
    )}\n`
  );
  writeFileSync(join(root, "eslint.config.js"), "export default [];\n");
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.ts"), "export const a = 1;\n");

  return root;
};

interface Installation {
  readonly result: InstallSailorResult;
  readonly runner: FakeCommandRunner;
}

const install = async (options: {
  readonly root: string;
  readonly packageRoot: string;
  readonly update?: boolean;
  readonly installDependencies?: boolean;
  readonly now?: Date;
  readonly npm?: PlannedCommandResult;
  readonly git?: PlannedCommandResult;
  readonly hooksPath?: string;
  readonly gitConfigWrite?: PlannedCommandResult;
}): Promise<Installation> => {
  const runner = createFakeCommandRunner((request) => {
    const { executable, args } = request.command;

    if (executable !== "git") {
      return options.npm ?? exited(0);
    }

    if (args[1] === "--show-toplevel") {
      return options.git ?? exited(0, { stdout: `${options.root}\n` });
    }

    if (args[1] === "--git-common-dir") {
      return exited(0, { stdout: ".git\n" });
    }

    // `config --local --get` reads; `config --local <key> <value>` writes.
    return args[2] === "--get"
      ? options.hooksPath === undefined
        ? exited(1)
        : exited(0, { stdout: `${options.hooksPath}\n` })
      : (options.gitConfigWrite ?? exited(0));
  });

  const result = await installSailor({
    cwd: options.root,
    packageRootDirectory: options.packageRoot,
    runner: runner.run,
    now: () => options.now ?? NOW,
    update: options.update ?? false,
    ...(options.installDependencies === undefined
      ? {}
      : { installDependencies: options.installDependencies }),
  });

  return { result, runner };
};

/** Every file under a root, keyed by relative path, with its contents. */
const snapshotTree = (root: string): ReadonlyMap<string, string> => {
  const files = new Map<string, string>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath =
        prefix === "" ? entry.name : `${prefix}/${entry.name}`;

      if (entry.isDirectory()) {
        walk(join(directory, entry.name), relativePath);
      } else {
        files.set(
          relativePath,
          readFileSync(join(directory, entry.name), "utf8")
        );
      }
    }
  };

  walk(root, "");

  return files;
};

const read = (root: string, path: string): string =>
  readFileSync(join(root, ".sailor", ...path.split("/")), "utf8");

describe("installSailor against the real shipped package", () => {
  const packageRoot = process.cwd();

  it("installs every shipped template plus the private manifest", async () => {
    const root = buildHostProject();
    const { result } = await install({ root, packageRoot });

    expect(result.created).toEqual(
      [
        ...listSailorTemplateFiles(packageRoot).map(
          (file) => file.installedPath
        ),
        "package.json",
        "bin/sailor",
        "hooks/pre-commit",
        "hooks/pre-push",
      ].sort()
    );
    expect(result.replaced).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(result.orphaned).toEqual([]);
    expect(read(root, "rules/base.yaml")).toContain("id: sailor-base");
  });

  it("leaves task state out of the installation entirely", async () => {
    // `tasks.yaml` is neither managed nor seeded: the sailor rewrites it on
    // every transition and the project never hand-edits it, so putting it
    // through the plan would mean either reporting the workflow's own writes
    // as a conflict or replacing them on the next `init --update`.
    const root = buildHostProject();
    const { result } = await install({ root, packageRoot });

    expect(result.created).not.toContain("tasks.yaml");
    expect(existsSync(join(root, ".sailor", "tasks.yaml"))).toBe(false);
    expect(
      readInstallManifest(root)?.managedFiles.map((f) => f.path)
    ).not.toContain("tasks.yaml");
  });

  it("does not touch task state written between two installs", async () => {
    const root = buildHostProject();

    await install({ root, packageRoot });
    await updateTaskFile(root, (file) => ({
      ...file,
      tasks: [...file.tasks, buildTask()],
    }));

    const before = readFileSync(join(root, ".sailor", "tasks.yaml"), "utf8");
    const { result } = await install({ root, packageRoot, update: true });

    expect(result.orphaned).toEqual([]);
    expect(readFileSync(join(root, ".sailor", "tasks.yaml"), "utf8")).toBe(
      before
    );
  });

  it("renames the undotted gitignore template on the way in", async () => {
    const root = buildHostProject();

    await install({ root, packageRoot });

    expect(read(root, ".gitignore")).toContain("node_modules/");
    expect(existsSync(join(root, ".sailor", "gitignore"))).toBe(false);
  });

  it("confines its footprint to .sailor and changes no host file", async () => {
    // This stands behind acceptance criteria 1 and 2, and used to check only
    // the top-level listing plus two named files - so a write into `src/` or
    // `.git/` would have passed it.
    const root = buildHostProject();
    const before = snapshotTree(root);

    await install({ root, packageRoot });

    const after = snapshotTree(root);
    const changed = [...after.keys()].filter(
      (path) => before.get(path) !== after.get(path)
    );

    expect(before.size).toBeGreaterThan(0);
    expect(changed.every((path) => path.startsWith(".sailor/"))).toBe(true);
    expect([...before.keys()].filter((path) => !after.has(path))).toEqual([]);
  });

  it("records the running sailor version in the project manifest", async () => {
    const root = buildHostProject();
    const { result } = await install({ root, packageRoot });
    const stored = readInstallManifest(root);

    expect(stored?.sailorVersion).toBe(result.sailorVersion);
    expect(stored?.managedFiles.map((entry) => entry.path)).toEqual(
      result.created
    );
  });
});

describe("installSailor", () => {
  const TEMPLATES = {
    "rules/base.yaml": "version: 1\nid: sailor-base\n",
    "config/project.yaml": "version: 1\n",
    "config/hooks.yaml": [
      "version: 1",
      "hooks:",
      "  - hook: pre-commit",
      "    phase: pre-commit",
      "",
    ].join("\n"),
  } as const;

  /** Everything a synthetic install writes, in the order it reports them. */
  const ALL_FILES = [
    "bin/sailor",
    "config/hooks.yaml",
    "config/project.yaml",
    "hooks/pre-commit",
    "package.json",
    "rules/base.yaml",
  ];

  it("resolves the project root from git rather than from the cwd", async () => {
    const root = buildHostProject();
    const nested = join(root, "src");
    const runner = createFakeCommandRunner((request) =>
      request.command.executable === "git"
        ? exited(0, { stdout: `${root}\n` })
        : exited(0)
    );

    const result = await installSailor({
      cwd: nested,
      packageRootDirectory: buildPackage(TEMPLATES),
      runner: runner.run,
      now: () => NOW,
      update: false,
    });

    expect(result.projectRoot).toBe(root);
    expect(at(runner.requests, 0).command).toEqual({
      executable: "git",
      args: ["rev-parse", "--show-toplevel"],
    });
    expect(at(runner.requests, 0).cwd).toBe(nested);
    expect(existsSync(join(root, ".sailor", "rules", "base.yaml"))).toBe(true);
  });

  it("refuses to install outside a git repository", async () => {
    const root = buildHostProject();
    const error = await captureRejection(
      () =>
        install({
          root,
          packageRoot: buildPackage(TEMPLATES),
          git: exited(128, { stderr: "fatal: not a git repository\n" }),
        }),
      SailorError
    );

    expect(error.kind).toBe("not-a-git-repository");
    expect(existsSync(join(root, ".sailor"))).toBe(false);
  });

  it("installs the private dependency tree inside .sailor", async () => {
    const root = buildHostProject();
    const { result, runner } = await install({
      root,
      packageRoot: buildPackage(TEMPLATES, "2.0.0"),
    });
    const npm = runner.requests.filter(
      (request) => request.command.executable === "npm"
    );

    expect(result.dependenciesInstalled).toBe(true);
    expect(at(npm, 0).cwd).toBe(join(root, ".sailor"));
    expect(read(root, "package.json")).toContain(
      "https://github.com/an-owner/a-repo/releases/download/v2.0.0/sailor-2.0.0.tgz"
    );
  });

  it("writes the files and the manifest before resolving dependencies", async () => {
    // An install interrupted by a failing `npm install` must leave a project
    // the sailor still recognises as its own, so re-running repairs it.
    const root = buildHostProject();
    const { result } = await install({
      root,
      packageRoot: buildPackage(TEMPLATES),
      npm: exited(1, { stderr: "npm error code E404\n" }),
    });

    expect(result.dependencyFailure).toContain("E404");
    expect(result.dependenciesInstalled).toBe(false);
    expect(readInstallManifest(root)?.managedFiles).toHaveLength(
      ALL_FILES.length
    );
    expect(read(root, "rules/base.yaml")).toBe(TEMPLATES["rules/base.yaml"]);
  });

  it("leaves git hooks alone when the runtime never resolved", async () => {
    // Redirecting core.hooksPath first left a repository that could not commit
    // at all: every hook ran a launcher with no runtime behind it, and
    // re-running `init` failed at the same step.
    const root = buildHostProject();
    const { result, runner } = await install({
      root,
      packageRoot: buildPackage(TEMPLATES),
      npm: exited(1, { stderr: "npm error code E404\n" }),
    });

    expect(result.gitHooksPathChanged).toBe(false);
    expect(
      runner.requests.filter(
        (request) =>
          request.command.args[0] === "config" &&
          request.command.args[1] === "--local" &&
          request.command.args[2] === "core.hooksPath"
      )
    ).toEqual([]);
  });

  it("resolves the runtime before it points git at the sailor", async () => {
    const root = buildHostProject();
    const { runner } = await install({
      root,
      packageRoot: buildPackage(TEMPLATES),
    });
    const order = runner.requests.map((request) =>
      request.command.executable === "npm"
        ? "npm"
        : request.command.args.slice(0, 3).join(" ")
    );

    expect(order.indexOf("npm")).toBeLessThan(
      order.indexOf("config --local core.hooksPath")
    );
  });

  it("skips the dependency install when asked to write files only", async () => {
    const root = buildHostProject();
    const { result, runner } = await install({
      root,
      packageRoot: buildPackage(TEMPLATES),
      installDependencies: false,
    });

    expect(result.dependenciesInstalled).toBe(false);
    expect(
      runner.requests.map((request) => request.command.executable)
    ).not.toContain("npm");
  });

  it("is idempotent: a second run keeps every file", async () => {
    const root = buildHostProject();
    const packageRoot = buildPackage(TEMPLATES);

    await install({ root, packageRoot });
    const { result } = await install({ root, packageRoot });

    expect(result.created).toEqual([]);
    expect(result.replaced).toEqual([]);
    expect(result.kept).toEqual(ALL_FILES);
  });

  it("refuses to replace an out-of-date managed file without --update", async () => {
    const root = buildHostProject();

    await install({ root, packageRoot: buildPackage(TEMPLATES) });

    const error = await captureRejection(
      () =>
        install({
          root,
          packageRoot: buildPackage(
            { ...TEMPLATES, "rules/base.yaml": "version: 1\nid: renamed\n" },
            "0.2.0"
          ),
        }),
      SailorError
    );

    expect(error.kind).toBe("unsafe-overwrite");
    expect(error.details.join("")).toContain("re-run with `--update`");
    expect(read(root, "rules/base.yaml")).toBe(TEMPLATES["rules/base.yaml"]);
  });

  it("replaces an out-of-date managed file when --update is given", async () => {
    const root = buildHostProject();

    await install({ root, packageRoot: buildPackage(TEMPLATES) });

    const { result } = await install({
      root,
      update: true,
      now: LATER,
      packageRoot: buildPackage(
        { ...TEMPLATES, "rules/base.yaml": "version: 1\nid: renamed\n" },
        "0.2.0"
      ),
    });

    expect(result.replaced).toEqual(["package.json", "rules/base.yaml"]);
    expect(read(root, "rules/base.yaml")).toBe("version: 1\nid: renamed\n");
  });

  it("refuses to overwrite a managed file a project edited, even with --update", async () => {
    const root = buildHostProject();
    const packageRoot = buildPackage(TEMPLATES);

    await install({ root, packageRoot });
    writeFileSync(
      join(root, ".sailor", "rules", "base.yaml"),
      "version: 1\nid: locally-tuned\n"
    );

    const error = await captureRejection(
      () => install({ root, packageRoot, update: true }),
      SailorError
    );

    expect(error.details.join("")).toContain(
      "was changed after it was installed"
    );
    expect(read(root, "rules/base.yaml")).toContain("locally-tuned");
  });

  it("reports a managed file a newer version dropped without deleting it", async () => {
    const root = buildHostProject();

    await install({
      root,
      packageRoot: buildPackage({
        ...TEMPLATES,
        "rules/retired.yaml": "old\n",
      }),
    });

    const { result } = await install({
      root,
      update: true,
      packageRoot: buildPackage(TEMPLATES, "0.2.0"),
    });

    expect(result.orphaned).toEqual(["rules/retired.yaml"]);
    expect(read(root, "rules/retired.yaml")).toBe("old\n");
  });

  it("keeps the original installation date and advances the update date", async () => {
    const root = buildHostProject();
    const packageRoot = buildPackage(TEMPLATES);

    await install({ root, packageRoot });
    await install({ root, packageRoot, now: LATER });

    expect(readInstallManifest(root)).toMatchObject({
      installedAt: NOW.toISOString(),
      updatedAt: LATER.toISOString(),
    });
  });

  it("refuses a build of itself that ships no hooks configuration", async () => {
    const error = await captureRejection(
      () =>
        install({
          root: buildHostProject(),
          packageRoot: buildPackage({ "rules/base.yaml": "version: 1\n" }),
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("config/hooks.yaml");
  });

  it("reports a core.hooksPath it could not write rather than assuming it took", async () => {
    const root = buildHostProject();
    const error = await captureRejection(
      () =>
        install({
          root,
          packageRoot: buildPackage(TEMPLATES),
          gitConfigWrite: exited(1, {
            stderr: "error: could not lock config\n",
          }),
        }),
      SailorError
    );

    expect(error.kind).toBe("git-config-failed");
    expect(error.message).toContain("git still runs its own hooks");
    expect(error.details).toEqual(["error: could not lock config"]);
    // The dispatchers are on disk, so re-running repairs the setting alone.
    expect(read(root, "hooks/pre-commit")).toContain("gate pre-commit");
  });

  it("reports a silent git failure without inventing detail", async () => {
    const error = await captureRejection(
      () =>
        install({
          root: buildHostProject(),
          packageRoot: buildPackage(TEMPLATES),
          gitConfigWrite: exited(1),
        }),
      SailorError
    );

    expect(error.details).toEqual([]);
  });

  it("still installs the launcher for a project that manages no hook", async () => {
    const root = buildHostProject();
    const { result, runner } = await install({
      root,
      packageRoot: buildPackage({
        ...TEMPLATES,
        "config/hooks.yaml": "version: 1\nhooks: []\n",
      }),
    });

    expect(result.hooks).toEqual([]);
    expect(result.gitHooksPathChanged).toBe(false);
    // The CI workflow calls the launcher, so a project that turned hooks off
    // and relies on CI instead is exactly the one that must still have it.
    expect(result.created).toContain("bin/sailor");
    expect(existsSync(join(root, ".sailor", "bin", "sailor"))).toBe(true);
    // git keeps running its own hooks, so its configuration is left alone.
    // A *write* specifically: `config --local core.hooksPath <value>`. The
    // reads name the same key, so matching the key alone would catch those too.
    expect(
      runner.requests.filter(
        (request) =>
          request.command.args[0] === "config" &&
          request.command.args[1] === "--local" &&
          request.command.args[2] === "core.hooksPath"
      )
    ).toEqual([]);
  });

  it("lets a project edit its own configuration and still re-install", async () => {
    const root = buildHostProject();
    const packageRoot = buildPackage(TEMPLATES);

    await install({ root, packageRoot });
    writeFileSync(
      join(root, ".sailor", "config", "project.yaml"),
      "version: 1\nvalidationMode: native-only\n"
    );

    const { result } = await install({ root, packageRoot });

    expect(result.kept).toContain("config/project.yaml");
    expect(read(root, "config/project.yaml")).toContain(
      "validationMode: native-only"
    );
    expect(
      readInstallManifest(root)?.managedFiles.filter(
        (entry) => entry.kind === "seeded"
      )
    ).toEqual([
      {
        path: "config/hooks.yaml",
        sha256: hashManagedFile(read(root, "config/hooks.yaml")),
        kind: "seeded",
      },
      {
        path: "config/project.yaml",
        sha256: hashManagedFile("version: 1\nvalidationMode: native-only\n"),
        kind: "seeded",
      },
    ]);
  });

  it("records the hash of every managed file, including the generated manifest", async () => {
    const root = buildHostProject();

    await install({ root, packageRoot: buildPackage(TEMPLATES) });

    const stored = readInstallManifest(root);

    // Without the length assertion an empty `managedFiles` made the loop
    // vacuous - and an empty `managedFiles` is precisely the regression this
    // exists to catch.
    expect(stored?.managedFiles).toHaveLength(ALL_FILES.length);

    for (const entry of stored?.managedFiles ?? []) {
      expect(entry.sha256).toBe(hashManagedFile(read(root, entry.path)));
    }
  });
});
