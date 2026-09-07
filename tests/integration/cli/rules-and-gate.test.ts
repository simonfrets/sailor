import { createDefaultCliCommands } from "../../../src/cli/default-commands.js";
import { CLI_EXIT_CODES } from "../../../src/cli/exit-codes.js";
import { runCli } from "../../../src/cli/run-cli.js";
import { buildSailorProject } from "../../helpers/sailor-project.js";
import { createRecordedStreams } from "../../helpers/cli-streams.js";
import {
  createFakeCommandRunner,
  exited,
} from "../../helpers/fake-command-runner.js";
import type { PlannedCommandResult } from "../../helpers/fake-command-runner.js";
import {
  projectScriptCheckYaml,
  ruleBundleYaml,
} from "../../helpers/rule-yaml.js";
import { removeTempDirectories } from "../../helpers/temp-directory.js";
import type { CommandRequest } from "../../../src/processes/command-runner.js";

afterEach(() => {
  removeTempDirectories();
});

const BASE_BUNDLE = ruleBundleYaml({
  bundleId: "sailor-base",
  ruleId: "base.tests",
  instruction: "Add or update tests with every behaviour change.",
  checks: projectScriptCheckYaml({
    checkId: "native-test",
    script: "test",
    phases: ["pre-commit", "pre-handoff"],
  }),
});

const project = (
  extra: Parameters<typeof buildSailorProject>[0] = {}
): string =>
  buildSailorProject({
    manifest: {
      name: "host",
      version: "0.0.0",
      scripts: { test: "jest", lint: "eslint ." },
    },
    rules: { "base.yaml": BASE_BUNDLE },
    files: { "package-lock.json": "{}\n" },
    ...extra,
  });

interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly requests: readonly CommandRequest[];
}

const run = async (
  root: string,
  argv: readonly string[],
  respond: (request: CommandRequest) => PlannedCommandResult = () => exited(0)
): Promise<CliRun> => {
  const recorded = createRecordedStreams();
  const runner = createFakeCommandRunner((request) =>
    request.command.args[0] === "rev-parse"
      ? exited(0, { stdout: `${root}\n` })
      : respond(request)
  );

  const exitCode = await runCli({
    argv,
    commands: createDefaultCliCommands(),
    cwd: root,
    now: () => new Date("2026-08-26T00:00:00.000Z"),
    nodeVersion: "22.22.1",
    packageRootDirectory: process.cwd(),
    runner: runner.run,
    streams: recorded.streams,
  });

  return {
    exitCode,
    stdout: recorded.stdout(),
    stderr: recorded.stderr(),
    requests: runner.requests,
  };
};

describe("sailor rules validate", () => {
  it("resolves the installed rule set", async () => {
    const result = await run(project(), ["rules", "validate"]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.ok);
    expect(result.stdout).toContain("1 rule resolved");
    expect(result.stderr).toBe("");
  });

  it("reports an invalid bundle with its file, line and column", async () => {
    const root = project({ rules: { "base.yaml": "version: 1\nid: 9bad\n" } });

    const result = await run(root, ["rules", "validate"]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.invalidConfig);
    expect(result.stderr).toContain(".sailor/rules/base.yaml:2:5");
    expect(result.stdout).toBe("");
  });

  it("reports a project that has no sailor installed", async () => {
    const root = buildSailorProject({ manifest: { name: "host" } });

    const result = await run(root, ["rules", "validate"]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.invalidConfig);
    expect(result.stderr).toContain("is not installed");
  });
});

describe("sailor rules explain", () => {
  it("lists the resolved rules with their origins", async () => {
    const result = await run(project(), ["rules", "explain"]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.ok);
    expect(result.stdout).toContain("base.tests [error] from builtin bundle");
  });

  it("compiles one agent's policy", async () => {
    const result = await run(project(), [
      "rules",
      "explain",
      "--agent",
      "coder",
    ]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.ok);
    expect(result.stdout).toContain("# Agent policy: coder");
    expect(result.stdout).toContain(
      "Add or update tests with every behaviour change."
    );
  });

  it("compiles an empty policy for an agent no rule targets", async () => {
    const result = await run(project(), ["rules", "explain", "--agent", "qa"]);

    expect(result.stdout).toContain("No mandatory rules apply to this agent.");
  });
});

describe("sailor gate", () => {
  it("runs the project script a rule names and passes", async () => {
    const result = await run(project(), ["gate", "pre-commit"]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.ok);
    expect(result.stdout).toContain("PASS base.tests / native-test");
    expect(result.stdout).toContain("Result: passed");
    expect(result.requests.map((request) => request.command)).toContainEqual({
      executable: "npm",
      args: ["run", "test"],
    });
  });

  it("blocks the phase when a required check on an error rule fails", async () => {
    const result = await run(project(), ["gate", "pre-commit"], (request) =>
      request.command.args.includes("test")
        ? exited(1, { stderr: "1 test failed\n" })
        : exited(0)
    );

    expect(result.exitCode).toBe(CLI_EXIT_CODES.gateBlocked);
    expect(result.stdout).toContain("FAIL base.tests / native-test");
    expect(result.stdout).toContain("1 test failed");
    expect(result.stdout).toContain("Result: blocked by 1 required check");
  });

  it("records a warning failure without blocking", () => {
    // This used to name `format`, a script the fixture does not define, with
    // `whenMissing: skip`. Nothing ever ran and nothing ever failed, so it
    // exercised the missing-script path and not the one in its own title.
    const root = project({
      rules: {
        "base.yaml": ruleBundleYaml({
          bundleId: "sailor-base",
          ruleId: "base.style",
          severity: "warning",
          checks: projectScriptCheckYaml({
            checkId: "native-lint",
            script: "lint",
            phases: ["pre-commit"],
            required: true,
            whenMissing: "fail",
          }),
        }),
      },
    });

    return run(root, ["gate", "pre-commit"], (request) =>
      request.command.args.includes("lint")
        ? exited(1, { stderr: "3 problems\n" })
        : exited(0)
    ).then((result) => {
      expect(result.exitCode).toBe(CLI_EXIT_CODES.ok);
      expect(result.stdout).toContain("WARN base.style / native-lint");
      expect(result.stdout).toContain("3 problems");
      expect(result.stdout).toContain("Result: passed with 1 warning failure");
    });
  });

  it("skips a check whose script the project does not define", () => {
    const root = project({
      rules: {
        "base.yaml": ruleBundleYaml({
          bundleId: "sailor-base",
          ruleId: "base.style",
          severity: "warning",
          checks: projectScriptCheckYaml({
            checkId: "native-format",
            script: "format",
            phases: ["pre-commit"],
            required: false,
            whenMissing: "skip",
          }),
        }),
      },
    });

    return run(root, ["gate", "pre-commit"]).then((result) => {
      expect(result.exitCode).toBe(CLI_EXIT_CODES.ok);
      expect(result.stdout).toContain("SKIP base.style / native-format");
      expect(result.stdout).toContain("Result: passed");
    });
  });

  it("restricts the phase to one agent", async () => {
    const result = await run(project(), [
      "gate",
      "pre-commit",
      "--agent",
      "qa",
    ]);

    expect(result.exitCode).toBe(CLI_EXIT_CODES.ok);
    expect(result.stdout).toContain("Agent: qa");
    expect(result.stdout).toContain("No checks apply to this phase.");
  });
});
