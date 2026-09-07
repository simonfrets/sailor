import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CI_TEMPLATE_PATH,
  REQUIRED_NODE_VERSION,
  REQUIRED_TOOLS,
  WORKFLOW_DIRECTORY,
  diagnoseSailor,
  versionOrder,
} from "../../../src/install/diagnose-sailor.js";
import type {
  Diagnostic,
  SailorDiagnosis,
} from "../../../src/install/diagnose-sailor.js";
import { buildSailorProject } from "../../helpers/sailor-project.js";
import {
  createFakeCommandRunner,
  exited,
  spawnFailed,
} from "../../helpers/fake-command-runner.js";
import type { PlannedCommandResult } from "../../helpers/fake-command-runner.js";
import {
  projectScriptCheckYaml,
  ruleBundleYaml,
} from "../../helpers/rule-yaml.js";
import { removeTempDirectories } from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const SAILOR_VERSION = "0.1.0";

const HOOKS_YAML = [
  "version: 1",
  "onExistingHook: chain",
  "hooks:",
  "  - hook: pre-commit",
  "    enabled: true",
  "    phase: pre-commit",
  "  - hook: pre-push",
  "    enabled: true",
  "    phase: pre-push",
  "",
].join("\n");

const MANIFEST = (version = SAILOR_VERSION): string =>
  `${JSON.stringify(
    {
      version: 1,
      sailorVersion: version,
      installedAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
      managedFiles: [],
    },
    null,
    2
  )}\n`;

const INSTALLED: Readonly<Record<string, string>> = {
  ".sailor/version.json": MANIFEST(),
  ".sailor/config/project.yaml": "version: 1\n",
  ".sailor/config/hooks.yaml": HOOKS_YAML,
  ".sailor/rules/base.yaml": ruleBundleYaml({
    bundleId: "sailor-base",
    ruleId: "base.tests",
  }),
  ".sailor/package.json": '{ "name": "sailor-runtime" }\n',
  ".sailor/node_modules/sailor/package.json":
    '{ "name": "sailor", "version": "0.1.0" }\n',
  ".sailor/hooks/pre-commit": "#!/usr/bin/env bash\n",
  ".sailor/hooks/pre-push": "#!/usr/bin/env bash\n",
};

const buildInstalled = (
  options: {
    readonly files?: Readonly<Record<string, string>>;
    readonly omit?: readonly string[];
    readonly executableHooks?: boolean;
  } = {}
): string => {
  const omit = options.omit ?? [];
  const root = buildSailorProject({
    manifest: { name: "host" },
    files: {
      ...Object.fromEntries(
        Object.entries(INSTALLED).filter(([path]) => !omit.includes(path))
      ),
      ...options.files,
    },
  });

  if (options.executableHooks !== false) {
    for (const hook of ["pre-commit", "pre-push"]) {
      const path = join(root, ".sailor", "hooks", hook);

      if (existsSync(path)) {
        chmodSync(path, 0o755);
      }
    }
  }

  return root;
};

const diagnose = async (
  projectRoot: string,
  options: {
    readonly nodeVersion?: string;
    readonly sailorVersion?: string;
    readonly hooksPath?: string;
    readonly tools?: Readonly<Record<string, PlannedCommandResult>>;
  } = {}
): Promise<SailorDiagnosis> =>
  diagnoseSailor({
    projectRoot,
    nodeVersion: options.nodeVersion ?? "22.22.1",
    sailorVersion: options.sailorVersion ?? SAILOR_VERSION,
    runner: createFakeCommandRunner((request) => {
      const { executable, args } = request.command;

      if (executable === "git" && args[0] === "config") {
        return options.hooksPath === undefined
          ? exited(1)
          : exited(0, { stdout: `${options.hooksPath}\n` });
      }

      return (
        options.tools?.[executable] ??
        exited(0, { stdout: `${executable} 1.2.3\n` })
      );
    }).run,
  });

const find = (diagnosis: SailorDiagnosis, id: string): Diagnostic => {
  const found = diagnosis.diagnostics.find((entry) => entry.id === id);

  if (found === undefined) {
    throw new Error(`no diagnostic with id ${id}`);
  }

  return found;
};

const WORKFLOW = [
  "name: Sailor gates",
  "jobs:",
  "  gates:",
  "    steps:",
  "      - run: ./.sailor/bin/sailor gate pre-commit",
  "",
].join("\n");

const healthyRoot = (): string =>
  buildInstalled({
    files: { ".github/workflows/sailor.yml": WORKFLOW },
  });

describe("versionOrder", () => {
  it("orders dotted versions", () => {
    // `?? 0` masked a null return on a perfectly valid version, so a
    // regression that stopped parsing them would have gone unnoticed.
    const order = (version: string): number => {
      const value = versionOrder(version);

      expect(value).not.toBeNull();

      return value ?? Number.NaN;
    };

    expect(order("22.22.1")).toBeGreaterThan(order("22.21.9"));
    expect(order("23.0.0")).toBeGreaterThan(order("22.99.99"));
  });

  it("ignores a prerelease suffix", () => {
    expect(versionOrder("24.0.0-nightly")).toBe(versionOrder("24.0.0"));
  });

  it("reports a string that is not a version at all", () => {
    expect(versionOrder("banana")).toBeNull();
  });
});

describe("diagnoseSailor on a healthy installation", () => {
  it("reports every check as ok", async () => {
    const diagnosis = await diagnose(healthyRoot(), {
      hooksPath: ".sailor/hooks",
    });

    expect(
      diagnosis.diagnostics.filter((entry) => entry.status !== "ok")
    ).toEqual([]);
    expect(diagnosis.healthy).toBe(true);
    expect(diagnosis.problemCount).toBe(0);
    expect(diagnosis.warningCount).toBe(0);
  });

  it("checks Node, every external tool, and the installed sailor", async () => {
    const diagnosis = await diagnose(healthyRoot(), {
      hooksPath: ".sailor/hooks",
    });

    expect(diagnosis.diagnostics.map((entry) => entry.id)).toEqual([
      "node",
      "npm",
      "git",
      "bash",
      "installation",
      "config",
      "rules",
      "scripts",
      "runtime",
      "hooks",
      "ci",
    ]);
  });

  it("reports the resolved rule set and its hash", async () => {
    const diagnosis = await diagnose(healthyRoot());

    expect(find(diagnosis, "rules").detail).toMatch(
      /^1 rule\(s\) resolved, sha256 [0-9a-f]{64}$/
    );
  });

  it("names the version each external tool reported", async () => {
    const diagnosis = await diagnose(healthyRoot(), {
      tools: { npm: exited(0, { stdout: "10.9.4\n" }) },
    });

    expect(find(diagnosis, "npm").detail).toBe("10.9.4");
  });

  it("probes each tool with its own version flag and nothing else", () => {
    expect(REQUIRED_TOOLS.map((tool) => tool.executable)).toEqual([
      "npm",
      "git",
      "bash",
    ]);
    expect(REQUIRED_TOOLS.length).toBeGreaterThan(0);

    for (const tool of REQUIRED_TOOLS) {
      expect(tool.args).toEqual(["--version"]);
    }
  });
});

describe("diagnoseSailor on the runtime", () => {
  it("refuses a Node older than the sailor requires", async () => {
    const diagnosis = await diagnose(healthyRoot(), { nodeVersion: "20.11.0" });

    expect(find(diagnosis, "node")).toMatchObject({ status: "problem" });
    expect(find(diagnosis, "node").detail).toContain(REQUIRED_NODE_VERSION);
    expect(diagnosis.healthy).toBe(false);
  });

  it("reports a Node version it cannot compare rather than guessing", async () => {
    const diagnosis = await diagnose(healthyRoot(), {
      nodeVersion: "unstable",
    });

    expect(find(diagnosis, "node").status).toBe("problem");
    expect(find(diagnosis, "node").detail).toContain("`unstable`");
  });

  it("reports a tool that is not installed", async () => {
    const diagnosis = await diagnose(healthyRoot(), {
      tools: { bash: spawnFailed("ENOENT") },
    });

    expect(find(diagnosis, "bash").status).toBe("problem");
    expect(find(diagnosis, "bash").detail).toContain("bash --version");
    expect(find(diagnosis, "bash").detail).toContain("could not be started");
  });

  it("reports a tool that failed rather than treating it as present", async () => {
    const diagnosis = await diagnose(healthyRoot(), {
      tools: { git: exited(127) },
    });

    expect(find(diagnosis, "git").status).toBe("problem");
    expect(find(diagnosis, "git").detail).toContain("exited with code 127");
  });
});

describe("diagnoseSailor on the installation record", () => {
  it("reports a project the sailor was never installed into", async () => {
    const diagnosis = await diagnose(
      buildInstalled({ omit: [".sailor/version.json"] })
    );

    expect(find(diagnosis, "installation").status).toBe("problem");
    expect(find(diagnosis, "installation").detail).toContain("sailor init");
  });

  it("reports a manifest that does not parse", async () => {
    const diagnosis = await diagnose(
      buildInstalled({ files: { ".sailor/version.json": "{" } })
    );

    expect(find(diagnosis, "installation").status).toBe("problem");
    expect(find(diagnosis, "installation").detail).toContain("valid JSON");
  });

  it("warns when the installed version is not the running one", async () => {
    const diagnosis = await diagnose(
      buildInstalled({ files: { ".sailor/version.json": MANIFEST("0.0.9") } })
    );

    expect(find(diagnosis, "installation").status).toBe("warning");
    expect(find(diagnosis, "installation").detail).toContain(
      "sailor init --update"
    );
    expect(diagnosis.healthy).toBe(true);
    expect(diagnosis.warningCount).toBeGreaterThan(0);
  });
});

describe("diagnoseSailor on configuration", () => {
  it("names every missing config file in one report", async () => {
    const diagnosis = await diagnose(
      buildInstalled({
        omit: [".sailor/config/project.yaml", ".sailor/config/hooks.yaml"],
      })
    );

    expect(find(diagnosis, "config").status).toBe("problem");
    expect(find(diagnosis, "config").detail).toContain(
      "config/project.yaml is missing"
    );
    expect(find(diagnosis, "config").detail).toContain(
      "config/hooks.yaml is missing"
    );
  });

  it("reports an invalid config file with its own diagnostics", async () => {
    const diagnosis = await diagnose(
      buildInstalled({
        files: { ".sailor/config/project.yaml": "version: 2\n" },
      })
    );

    expect(find(diagnosis, "config").status).toBe("problem");
    expect(find(diagnosis, "config").detail).toContain("config/project.yaml");
  });

  it("cannot check hook dispatch while the hooks config is unreadable", async () => {
    const diagnosis = await diagnose(
      buildInstalled({
        files: { ".sailor/config/hooks.yaml": "version: 1\nhooks: nope\n" },
      }),
      { hooksPath: ".sailor/hooks" }
    );

    expect(find(diagnosis, "hooks").status).toBe("warning");
    expect(find(diagnosis, "hooks").detail).toContain("unreadable");
  });

  it("reports rules that do not resolve", async () => {
    const diagnosis = await diagnose(
      buildInstalled({
        files: { ".sailor/rules/base.yaml": "version: 1\nid: 9bad\n" },
      })
    );

    expect(find(diagnosis, "rules").status).toBe("problem");
  });

  it("reports a project with no rules directory at all", async () => {
    const diagnosis = await diagnose(
      buildInstalled({ omit: [".sailor/rules/base.yaml"] })
    );

    expect(find(diagnosis, "rules").status).toBe("problem");
    expect(find(diagnosis, "rules").detail).toContain("is not installed");
  });
});

describe("diagnoseSailor on the private dependency tree", () => {
  it("reports a missing private manifest", async () => {
    const diagnosis = await diagnose(
      buildInstalled({ omit: [".sailor/package.json"] })
    );

    expect(find(diagnosis, "runtime").status).toBe("problem");
    expect(find(diagnosis, "runtime").detail).toContain(".sailor/package.json");
  });

  it("reports a dependency tree that was never resolved", async () => {
    const diagnosis = await diagnose(
      buildInstalled({
        omit: [".sailor/node_modules/sailor/package.json"],
      })
    );

    expect(find(diagnosis, "runtime").status).toBe("problem");
    expect(find(diagnosis, "runtime").detail).toContain(
      "is not resolved in .sailor/node_modules"
    );
  });

  it("reports a resolved package whose manifest is unreadable", async () => {
    const diagnosis = await diagnose(
      buildInstalled({
        files: { ".sailor/node_modules/sailor/package.json": "{" },
      })
    );

    expect(find(diagnosis, "runtime").status).toBe("problem");
  });

  it("names the resolved sailor version", async () => {
    const diagnosis = await diagnose(healthyRoot());

    expect(find(diagnosis, "runtime").detail).toContain("sailor 0.1.0");
  });
});

describe("diagnoseSailor on git hook dispatch", () => {
  it("warns when git still runs its own hooks", async () => {
    const diagnosis = await diagnose(healthyRoot());

    expect(find(diagnosis, "hooks").status).toBe("warning");
    expect(find(diagnosis, "hooks").detail).toContain(
      "core.hooksPath` is unset"
    );
  });

  it("warns when git dispatches through another runner", async () => {
    const diagnosis = await diagnose(healthyRoot(), { hooksPath: ".husky/_" });

    expect(find(diagnosis, "hooks").status).toBe("warning");
    expect(find(diagnosis, "hooks").detail).toContain(".husky/_");
  });

  it("reports a managed hook that git could not run", async () => {
    const diagnosis = await diagnose(
      buildInstalled({ executableHooks: false }),
      { hooksPath: ".sailor/hooks" }
    );

    expect(find(diagnosis, "hooks").status).toBe("problem");
    expect(find(diagnosis, "hooks").detail).toContain(
      "pre-commit, pre-push is missing or not executable"
    );
  });

  it("reports a managed hook that is absent", async () => {
    const diagnosis = await diagnose(
      buildInstalled({ omit: [".sailor/hooks/pre-push"] }),
      { hooksPath: ".sailor/hooks" }
    );

    expect(find(diagnosis, "hooks").status).toBe("problem");
    expect(find(diagnosis, "hooks").detail).toContain("pre-push");
  });

  it("names the phase each dispatched hook runs", async () => {
    const diagnosis = await diagnose(healthyRoot(), {
      hooksPath: ".sailor/hooks",
    });

    expect(find(diagnosis, "hooks").detail).toContain(
      "pre-commit (pre-commit), pre-push (pre-push)"
    );
  });

  it("accepts a project that manages no hook", async () => {
    const diagnosis = await diagnose(
      buildInstalled({
        files: { ".sailor/config/hooks.yaml": "version: 1\n" },
      })
    );

    expect(find(diagnosis, "hooks")).toMatchObject({
      status: "ok",
      detail: "no git hook is managed",
    });
  });

  it("treats a disabled hook as unmanaged", async () => {
    const diagnosis = await diagnose(
      buildInstalled({
        omit: [".sailor/hooks/pre-commit", ".sailor/hooks/pre-push"],
        files: {
          ".sailor/config/hooks.yaml": [
            "version: 1",
            "hooks:",
            "  - hook: pre-commit",
            "    enabled: false",
            "    phase: pre-commit",
            "",
          ].join("\n"),
        },
      })
    );

    expect(find(diagnosis, "hooks").status).toBe("ok");
  });
});

describe("REQUIRED_NODE_VERSION", () => {
  it("still matches the version the package declares it needs", () => {
    // The doctor keeps its own constant so it can compare versions, and this
    // is what stops that copy drifting away from `engines.node`.
    const manifest: unknown = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8")
    );
    const engines =
      typeof manifest === "object" && manifest !== null && "engines" in manifest
        ? manifest.engines
        : null;

    expect(engines).toMatchObject({ node: `>=${REQUIRED_NODE_VERSION}` });
  });
});

describe("diagnoseSailor on project scripts", () => {
  const bundleNaming = (
    script: string,
    whenMissing = "fail",
    required = true
  ) =>
    ruleBundleYaml({
      bundleId: "sailor-base",
      ruleId: "base.tests",
      checks: projectScriptCheckYaml({
        checkId: "native-test",
        script,
        phases: ["pre-commit"],
        required,
        whenMissing: whenMissing as "fail" | "skip",
      }),
    });

  const withScripts = (
    scripts: Readonly<Record<string, string>>,
    bundle = bundleNaming("test")
  ): string =>
    buildSailorProject({
      manifest: { name: "host", scripts },
      files: { ...INSTALLED, ".sailor/rules/base.yaml": bundle },
    });

  it("reports a required check whose script the project does not define", async () => {
    const diagnosis = await diagnose(withScripts({ lint: "eslint ." }));

    expect(find(diagnosis, "scripts").status).toBe("problem");
    expect(find(diagnosis, "scripts").detail).toContain("`test`");
    expect(find(diagnosis, "scripts").detail).toContain("block every commit");
    expect(diagnosis.healthy).toBe(false);
  });

  it("accepts a project that defines every script its rules name", async () => {
    const diagnosis = await diagnose(withScripts({ test: "jest" }));

    expect(find(diagnosis, "scripts")).toMatchObject({ status: "ok" });
  });

  it("says nothing about a check that is allowed to skip", async () => {
    const diagnosis = await diagnose(
      withScripts({}, bundleNaming("test", "skip"))
    );

    expect(find(diagnosis, "scripts").status).toBe("ok");
  });

  it("warns rather than fails when the check could not block anyway", async () => {
    const diagnosis = await diagnose(
      withScripts({}, bundleNaming("test", "fail", false))
    );

    expect(find(diagnosis, "scripts")).toMatchObject({ status: "warning" });
    expect(find(diagnosis, "scripts").detail).toContain("None of them blocks");
    expect(diagnosis.healthy).toBe(true);
  });

  it("stays silent when the rules could not be resolved at all", async () => {
    const diagnosis = await diagnose(
      buildInstalled({
        files: { ".sailor/rules/base.yaml": "version: 1\nid: 9bad\n" },
      })
    );

    expect(diagnosis.diagnostics.map((entry) => entry.id)).not.toContain(
      "scripts"
    );
  });
});

describe("diagnoseSailor on chained hooks", () => {
  const manifestWithHooks = (chained: string | null): string =>
    `${JSON.stringify(
      {
        version: 1,
        sailorVersion: SAILOR_VERSION,
        installedAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
        managedFiles: [],
        hooks: [{ hook: "pre-commit", chained }],
      },
      null,
      2
    )}\n`;

  it("warns about a chained hook that lives outside the repository", async () => {
    // A dispatcher is committed with the project, so an absolute path means
    // nothing on anyone else's machine and is skipped there in silence.
    const diagnosis = await diagnose(
      buildInstalled({
        files: {
          ".sailor/version.json": manifestWithHooks("/home/x/hooks/pre-commit"),
        },
      })
    );

    expect(find(diagnosis, "chained-hooks")).toMatchObject({
      status: "warning",
    });
    expect(find(diagnosis, "chained-hooks").detail).toContain(
      "will not exist for anyone else"
    );
  });

  it("says nothing when every chained hook is inside the project", async () => {
    const diagnosis = await diagnose(
      buildInstalled({
        files: {
          ".sailor/version.json": manifestWithHooks(".git/hooks/pre-commit"),
        },
      })
    );

    expect(diagnosis.diagnostics.map((entry) => entry.id)).not.toContain(
      "chained-hooks"
    );
  });

  it("says nothing when no hook chains anything", async () => {
    const diagnosis = await diagnose(
      buildInstalled({
        files: { ".sailor/version.json": manifestWithHooks(null) },
      })
    );

    expect(diagnosis.diagnostics.map((entry) => entry.id)).not.toContain(
      "chained-hooks"
    );
  });

  it("stays quiet when the manifest cannot be read at all", async () => {
    const diagnosis = await diagnose(
      buildInstalled({ files: { ".sailor/version.json": "{" } })
    );

    expect(diagnosis.diagnostics.map((entry) => entry.id)).not.toContain(
      "chained-hooks"
    );
    expect(find(diagnosis, "installation").status).toBe("problem");
  });
});

describe("diagnoseSailor on continuous integration", () => {
  it("warns when nothing runs the gates where they cannot be skipped", async () => {
    // A git hook is bypassable with `--no-verify`, so hooks alone are a
    // convenience. This is the check that says so out loud.
    const diagnosis = await diagnose(buildInstalled(), {
      hooksPath: ".sailor/hooks",
    });

    expect(find(diagnosis, "ci")).toMatchObject({ status: "warning" });
    expect(find(diagnosis, "ci").detail).toContain("--no-verify");
    expect(find(diagnosis, "ci").detail).toContain(CI_TEMPLATE_PATH);
    expect(diagnosis.healthy).toBe(true);
  });

  it("names the workflow that runs them", async () => {
    const diagnosis = await diagnose(healthyRoot());

    expect(find(diagnosis, "ci")).toMatchObject({
      status: "ok",
      detail: "sailor.yml runs the sailor gates",
    });
  });

  it("accepts any way of reaching the CLI, not only the installed launcher", async () => {
    const diagnosis = await diagnose(
      buildInstalled({
        files: {
          ".github/workflows/gates.yml":
            "      - run: npx sailor gate pre-push\n",
        },
      })
    );

    expect(find(diagnosis, "ci").status).toBe("ok");
  });

  it("ignores a workflow that does not run them", async () => {
    const diagnosis = await diagnose(
      buildInstalled({
        files: {
          ".github/workflows/release.yml": "      - run: npm publish\n",
        },
      })
    );

    expect(find(diagnosis, "ci").status).toBe("warning");
  });

  it("steps over an entry it cannot read, such as a directory", async () => {
    const diagnosis = await diagnose(
      buildInstalled({
        files: {
          ".github/workflows/nested/notes.md": "not a workflow\n",
          ".github/workflows/sailor.yml": WORKFLOW,
        },
      })
    );

    expect(find(diagnosis, "ci")).toMatchObject({
      status: "ok",
      detail: "sailor.yml runs the sailor gates",
    });
  });

  it("looks where GitHub actually requires a workflow to be", () => {
    expect(WORKFLOW_DIRECTORY).toBe(join(".github", "workflows"));
  });
});
