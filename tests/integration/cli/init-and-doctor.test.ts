import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { createDefaultCliCommands } from "../../../src/cli/default-commands.js";
import { CLI_EXIT_CODES } from "../../../src/cli/exit-codes.js";
import { runCli } from "../../../src/cli/run-cli.js";
import { listSailorTemplateFiles } from "../../../src/install/sailor-templates.js";
import { readPackageVersion } from "../../../src/sailor/package-version.js";
import { createRecordedStreams } from "../../helpers/cli-streams.js";
import {
  createFakeCommandRunner,
  exited,
} from "../../helpers/fake-command-runner.js";
import type { PlannedCommandResult } from "../../helpers/fake-command-runner.js";
import {
  createTempDirectory,
  removeTempDirectories,
} from "../../helpers/temp-directory.js";
import type { CommandRequest } from "../../../src/processes/command-runner.js";

/**
 * A stand-in for the repository-local git config, so `sailor doctor` reads
 * back the `core.hooksPath` that `sailor init` set in the same test.
 */
const gitConfig = new Map<string, string>();

afterEach(() => {
  gitConfig.clear();
  removeTempDirectories();
});

const packageRoot = process.cwd();

interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const buildProject = (): string => {
  const root = createTempDirectory("sailor-cli-install-");

  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "host",
        version: "1.0.0",
        // The shipped bundles name these, and a check that cannot resolve its
        // script is a check that blocks every commit.
        scripts: {
          build: "tsc",
          lint: "eslint .",
          test: "jest",
          typecheck: "tsc --noEmit",
        },
      },
      null,
      2
    )}\n`
  );

  return root;
};

const run = async (
  root: string,
  argv: readonly string[],
  override: (request: CommandRequest) => PlannedCommandResult | null = () =>
    null
): Promise<CliRun> => {
  const recorded = createRecordedStreams();
  const runner = createFakeCommandRunner((request) => {
    const forced = override(request);

    if (forced !== null) {
      return forced;
    }

    const { executable, args } = request.command;

    if (executable === "git" && args[1] === "--show-toplevel") {
      return exited(0, { stdout: `${root}\n` });
    }

    if (executable === "git" && args[1] === "--git-common-dir") {
      return exited(0, { stdout: ".git\n" });
    }

    if (executable === "git" && args[0] === "config") {
      // Three shapes reach this fake: `config --get <key>` (effective),
      // `config --local --get <key>` (repository only), and
      // `config --local <key> <value>` (write).
      const rest = args[1] === "--local" ? args.slice(2) : args.slice(1);
      const [head, tail] = rest;

      if (head === "--get") {
        const stored = gitConfig.get(`${root}:${String(tail)}`);

        // git exits non-zero for an unset key, which is not an error.
        return stored === undefined
          ? exited(1)
          : exited(0, { stdout: `${stored}\n` });
      }

      gitConfig.set(`${root}:${String(head)}`, String(tail));

      return exited(0);
    }

    return exited(0, { stdout: "1.2.3\n" });
  });

  const exitCode = await runCli({
    argv,
    commands: createDefaultCliCommands(),
    cwd: root,
    now: () => new Date("2026-08-26T00:00:00.000Z"),
    nodeVersion: "22.22.1",
    packageRootDirectory: packageRoot,
    runner: runner.run,
    streams: recorded.streams,
  });

  return { exitCode, stdout: recorded.stdout(), stderr: recorded.stderr() };
};

/** Fakes the private tree `npm install` would have resolved. */
const resolveRuntime = (root: string): void => {
  const directory = join(root, ".sailor", "node_modules", "sailor");

  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify({
      name: "sailor",
      version: readPackageVersion(packageRoot),
    })}\n`
  );
};

describe("sailor init", () => {
  it("installs the shipped sailor into a project", async () => {
    const root = buildProject();
    const result = await run(root, ["init"]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.ok);
    expect(result.stdout).toContain("+ rules/base.yaml");
    expect(result.stdout).toContain(
      "Runtime dependencies resolved in .sailor/node_modules"
    );
    expect(readdirSync(join(root, ".sailor")).sort()).toEqual([
      ".gitignore",
      "agents",
      "bin",
      "ci",
      "config",
      "hooks",
      "package.json",
      "rules",
      "version.json",
    ]);
  });

  it("changes nothing outside .sailor", async () => {
    const root = buildProject();
    const manifest = readFileSync(join(root, "package.json"), "utf8");

    await run(root, ["init"]);

    expect(readdirSync(root).sort()).toEqual([".sailor", "package.json"]);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(manifest);
  });

  it("refuses a directory that is not inside a git repository", async () => {
    const root = buildProject();
    const result = await run(root, ["init"], (request) =>
      request.command.args[0] === "rev-parse"
        ? exited(128, { stderr: "fatal: not a git repository\n" })
        : null
    );

    expect(result.exitCode).toBe(CLI_EXIT_CODES.refused);
    expect(result.stderr).toContain("is not inside a git repository");
    expect(existsSync(join(root, ".sailor"))).toBe(false);
  });

  it("is safe to run twice", async () => {
    const root = buildProject();

    await run(root, ["init"]);
    const result = await run(root, ["init"]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.ok);
    expect(result.stdout).toContain(
      `0 files created, 0 replaced, ${String(
        listSailorTemplateFiles(packageRoot).length + 4
      )} already up to date`
    );
  });

  it("refuses to overwrite a file the project put there itself", async () => {
    const root = buildProject();

    mkdirSync(join(root, ".sailor", "rules"), { recursive: true });
    writeFileSync(join(root, ".sailor", "rules", "base.yaml"), "mine\n");

    const result = await run(root, ["init"]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.refused);
    expect(result.stderr).toContain("was not installed by the sailor");
    expect(
      readFileSync(join(root, ".sailor", "rules", "base.yaml"), "utf8")
    ).toBe("mine\n");
  });

  it("accepts --update", async () => {
    const root = buildProject();

    await run(root, ["init"]);
    const result = await run(root, ["init", "--update"]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.ok);
  });
});

describe("sailor doctor", () => {
  it("passes on a complete installation", async () => {
    const root = buildProject();

    await run(root, ["init"]);
    resolveRuntime(root);

    const result = await run(root, ["doctor"]);

    expect(result.stdout).toContain("Sailor diagnosis for");
    expect(result.stdout).toContain("OK   Rules —");
    expect(result.stdout).toContain(
      "OK   Git hooks — git dispatches pre-commit (pre-commit), pre-push (pre-push)"
    );
    // No workflow was placed, so CI is a warning: hooks alone are skippable.
    expect(result.stdout).toContain("WARN Continuous integration —");
    expect(result.stdout).toContain("Result: 0 problems, 1 warning");
    expect(result.exitCode).toBe(CLI_EXIT_CODES.ok);
  });

  it("reports a shipped check that this project cannot run", async () => {
    // Installing the TypeScript bundle into a project with no `lint` script
    // blocked every commit from then on, while doctor reported no problems.
    const root = buildProject();

    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "host", version: "1.0.0" }, null, 2)}\n`
    );
    await run(root, ["init"]);
    resolveRuntime(root);

    const result = await run(root, ["doctor"]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.invalidConfig);
    expect(result.stdout).toContain("FAIL Project scripts —");
    expect(result.stdout).toContain("which package.json does not define");
    expect(result.stdout).toContain("will block every commit");
  });

  it("reports an install whose dependencies never resolved", async () => {
    const root = buildProject();

    await run(root, ["init"]);

    const result = await run(root, ["doctor"]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.invalidConfig);
    expect(result.stdout).toContain(
      "FAIL Runtime dependencies — sailor is not resolved"
    );
  });

  it("reports a project the sailor was never installed into", async () => {
    const result = await run(buildProject(), ["doctor"]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.invalidConfig);
    expect(result.stdout).toContain("FAIL Installation —");
    expect(result.stdout).toContain("FAIL Configuration —");
    expect(result.stdout).toContain("FAIL Rules —");
  });

  it("reports a missing external tool without stopping the other checks", async () => {
    const root = buildProject();

    await run(root, ["init"]);
    resolveRuntime(root);

    const result = await run(root, ["doctor"], (request) =>
      request.command.executable === "bash" ? exited(127) : null
    );

    expect(result.exitCode).toBe(CLI_EXIT_CODES.invalidConfig);
    expect(result.stdout).toContain("FAIL Bash —");
    expect(result.stdout).toContain("OK   Rules —");
  });
});
