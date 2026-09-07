import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { CLI_EXIT_CODES } from "../../../src/cli/exit-codes.js";
import { runCli } from "../../../src/cli/run-cli.js";
import type {
  CliCommandHandler,
  CliContext,
  RunCliOptions,
} from "../../../src/cli/run-cli.js";
import { SailorError } from "../../../src/sailor/sailor-error.js";
import { RuleValidationError } from "../../../src/rules/rule-error.js";
import { createRecordedStreams } from "../../helpers/cli-streams.js";
import type { RecordedStreams } from "../../helpers/cli-streams.js";
import {
  createFakeCommandRunner,
  exited,
} from "../../helpers/fake-command-runner.js";
import {
  createTempDirectory,
  removeTempDirectories,
} from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const packageRoot = (version = "9.9.9"): string => {
  const directory = createTempDirectory("sailor-package-");

  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "sailor", version })}\n`
  );

  return directory;
};

interface Invocation {
  readonly exitCode: number;
  readonly recorded: RecordedStreams;
}

const invoke = async (
  argv: readonly string[],
  overrides: Partial<RunCliOptions> = {}
): Promise<Invocation> => {
  const recorded = createRecordedStreams();
  const exitCode = await runCli({
    argv,
    commands: {},
    cwd: "/tmp/project",
    now: () => new Date("2026-08-26T00:00:00.000Z"),
    nodeVersion: "22.22.1",
    packageRootDirectory: packageRoot(),
    runner: createFakeCommandRunner(exited(0)).run,
    streams: recorded.streams,
    ...overrides,
  });

  return { exitCode, recorded };
};

/**
 * Throws synchronously rather than returning a rejected promise: `runCli`
 * awaits the handler inside its `try`, so both reach the same catch, and a
 * literal `Promise.reject` with a non-error reason is itself a lint error.
 */
const failingHandler =
  (error: unknown): CliCommandHandler =>
  () => {
    throw error;
  };

describe("runCli", () => {
  it("prints usage for no arguments", async () => {
    const { exitCode, recorded } = await invoke([]);

    expect(exitCode).toBe(CLI_EXIT_CODES.ok);
    expect(recorded.stdout()).toContain("Usage: sailor <command>");
    for (const command of ["init", "doctor", "rules validate", "gate"]) {
      expect(recorded.stdout()).toContain(command);
    }
    expect(recorded.stderr()).toBe("");
  });

  it("prints the package version", async () => {
    const { exitCode, recorded } = await invoke(["--version"], {
      packageRootDirectory: packageRoot("4.5.6"),
    });

    expect(exitCode).toBe(CLI_EXIT_CODES.ok);
    expect(recorded.stdout()).toBe("4.5.6\n");
  });

  it("reports a usage error on stderr with a stable exit code", async () => {
    const { exitCode, recorded } = await invoke(["teleport"]);

    expect(exitCode).toBe(CLI_EXIT_CODES.usage);
    expect(recorded.stderr()).toContain("unknown command `teleport`");
    expect(recorded.stdout()).toBe("");
  });

  it("reports a command that this build does not provide", async () => {
    const { exitCode, recorded } = await invoke(["doctor"]);

    expect(exitCode).toBe(CLI_EXIT_CODES.failure);
    expect(recorded.stderr()).toContain("`doctor` is not available");
  });

  it("passes an injected context to the handler and returns its code", async () => {
    const seen: CliContext[] = [];
    const { exitCode } = await invoke(["gate", "pre-commit", "--agent", "qa"], {
      commands: {
        gate: (context) => {
          seen.push(context);

          return Promise.resolve(7);
        },
      },
      cwd: "/tmp/elsewhere",
    });

    expect(exitCode).toBe(7);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cwd).toBe("/tmp/elsewhere");
    expect(seen[0]?.invocation).toEqual({
      command: "gate",
      phase: "pre-commit",
      agentId: "qa",
      update: false,
    });
    expect(seen[0]?.now()).toEqual(new Date("2026-08-26T00:00:00.000Z"));
  });

  it("maps a sailor error to its exit code", async () => {
    const { exitCode, recorded } = await invoke(["init"], {
      commands: {
        init: failingHandler(
          new SailorError("not-a-git-repository", "no repository here")
        ),
      },
    });

    expect(exitCode).toBe(CLI_EXIT_CODES.refused);
    expect(recorded.stderr()).toContain("no repository here");
  });

  it("maps a rule validation error to the invalid configuration code", async () => {
    const { exitCode, recorded } = await invoke(["rules", "validate"], {
      commands: {
        "rules validate": failingHandler(
          new RuleValidationError("base.yaml", [
            { path: "version", message: "expected 1", location: null },
          ])
        ),
      },
    });

    expect(exitCode).toBe(CLI_EXIT_CODES.invalidConfig);
    expect(recorded.stderr()).toContain("expected 1");
  });

  it("reports an unexpected failure without hiding it", async () => {
    const { exitCode, recorded } = await invoke(["init"], {
      commands: { init: failingHandler(new Error("disk on fire")) },
    });

    expect(exitCode).toBe(CLI_EXIT_CODES.failure);
    expect(recorded.stderr()).toContain("disk on fire");
  });

  it("reports a thrown non-error value", async () => {
    const { exitCode, recorded } = await invoke(["init"], {
      commands: { init: failingHandler("something odd") },
    });

    expect(exitCode).toBe(CLI_EXIT_CODES.failure);
    expect(recorded.stderr()).toContain("something odd");
  });

  it("reports an unreadable package manifest as invalid configuration", async () => {
    const { exitCode, recorded } = await invoke(["--version"], {
      packageRootDirectory: createTempDirectory("sailor-empty-"),
    });

    expect(exitCode).toBe(CLI_EXIT_CODES.invalidConfig);
    expect(recorded.stderr()).toContain("could not read the package manifest");
  });
});
