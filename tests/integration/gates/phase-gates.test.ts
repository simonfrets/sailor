import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { runPhaseGates } from "../../../src/gates/run-phase-gates.js";
import type { PhaseGateReport } from "../../../src/gates/run-phase-gates.js";
import {
  NODE_COMMAND_RUNNER_DEFAULTS,
  createNodeCommandRunner,
} from "../../../src/processes/node-command-runner.js";
import { discoverProjectProfile } from "../../../src/project/discover-project-profile.js";
import type { ProjectProfile } from "../../../src/project/project-profile-schema.js";
import { loadRuleBundle } from "../../../src/rules/load-rule-bundle.js";
import { resolveRuleSet } from "../../../src/rules/resolve-rule-set.js";
import { buildProject } from "../../fixtures/projects/build-project.js";
import { removeTempDirectories } from "../../helpers/temp-directory.js";

const runner = createNodeCommandRunner({
  ...NODE_COMMAND_RUNNER_DEFAULTS,
  killGraceMs: 200,
});

const NODE = JSON.stringify(process.execPath);

const runGates = async (
  rules: string,
  profile: ProjectProfile
): Promise<PhaseGateReport> =>
  runPhaseGates({
    ruleSet: resolveRuleSet([
      {
        origin: "project",
        location: "rules.yaml",
        bundle: loadRuleBundle(
          `version: 1\nid: base\ndescription: Baseline\nrules:\n${rules}`,
          { source: "rules.yaml" }
        ),
      },
    ]),
    phase: "pre-commit",
    agentId: "coder",
    profile,
    runner,
    now: (): Date => new Date(),
    createReportId: (): string => "integration",
  });

const profileFor = async (root: string): Promise<ProjectProfile> =>
  discoverProjectProfile({
    root,
    runner: () =>
      Promise.resolve({
        outcome: "exited",
        exitCode: 1,
        command: { executable: "git", args: [] },
        output: { stdout: "", stderr: "", truncated: false },
        startedAt: new Date(0).toISOString(),
        durationMs: 0,
      }),
  });

afterEach(() => {
  removeTempDirectories();
});

describe("phase gates against a real project", () => {
  it("reports passing, blocking, warning, and timing-out checks in one run", async () => {
    const root = buildProject({ manifest: { name: "example" } });
    const profile = await profileFor(root);

    const report = await runGates(
      `  - id: gate.required
    description: Required
    severity: error
    appliesTo: [coder]
    instruction: Must pass.
    checks:
      - id: ok
        runner: command
        argv: [${NODE}, "-e", "process.stdout.write('fine')"]
        phases: [pre-commit]
        timeoutMs: 10000
      - id: broken
        runner: command
        argv: [${NODE}, "-e", "process.stderr.write('boom');process.exit(3)"]
        phases: [pre-commit]
        timeoutMs: 10000
      - id: slow
        runner: command
        argv: [${NODE}, "-e", "setTimeout(() => {}, 5000)"]
        phases: [pre-commit]
        timeoutMs: 1000
  - id: gate.advisory
    description: Advisory
    severity: warning
    appliesTo: [coder]
    instruction: Should pass.
    checks:
      - id: nagging
        runner: command
        argv: [${NODE}, "-e", "process.exit(1)"]
        phases: [pre-commit]
        timeoutMs: 10000
`,
      profile
    );

    expect(report.status).toBe("failed");
    expect(report.blocked).toBe(true);
    expect(report.blockingFailureCount).toBe(2);
    expect(report.warningFailureCount).toBe(1);

    const byId = new Map(
      report.results.map((result) => [result.checkId, result])
    );

    expect(byId.get("ok")).toMatchObject({ status: "passed", stdout: "fine" });
    expect(byId.get("broken")).toMatchObject({
      status: "failed",
      exitCode: 3,
      stderr: "boom",
    });
    expect(byId.get("slow")?.status).toBe("timed-out");
    expect(byId.get("nagging")).toMatchObject({
      status: "failed",
      blocking: false,
    });
  });

  it("reports a missing executable rather than crashing the phase", async () => {
    const root = buildProject({ manifest: { name: "example" } });
    const profile = await profileFor(root);

    const report = await runGates(
      `  - id: gate.missing
    description: Missing binary
    severity: error
    appliesTo: [coder]
    instruction: Must pass.
    checks:
      - id: absent
        runner: command
        argv: ["sailor-no-such-binary"]
        phases: [pre-commit]
        timeoutMs: 10000
`,
      profile
    );

    expect(report.results[0]).toMatchObject({ status: "spawn-failed" });
    expect(report.blocked).toBe(true);
  });

  it("keeps shell metacharacters inert when a real gate runs", async () => {
    const root = buildProject({ manifest: { name: "example" } });
    const profile = await profileFor(root);

    const report = await runGates(
      `  - id: gate.hostile
    description: Hostile arguments
    severity: error
    appliesTo: [coder]
    instruction: Must pass.
    checks:
      - id: hostile
        runner: command
        argv:
          [
            ${NODE},
            "-e",
            "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
            "; rm -rf .",
            "$(touch pwned)",
            "&& echo pwned",
            "| tee pwned",
            "> pwned",
          ]
        phases: [pre-commit]
        timeoutMs: 10000
`,
      profile
    );

    expect(report.results[0]?.status).toBe("passed");
    expect(JSON.parse(report.results[0]?.stdout ?? "[]")).toEqual([
      "; rm -rf .",
      "$(touch pwned)",
      "&& echo pwned",
      "| tee pwned",
      "> pwned",
    ]);
    expect(existsSync(join(root, "pwned"))).toBe(false);
    expect(readdirSync(root)).toEqual(["package.json"]);
  });

  it("runs a real package script discovered from the project", async () => {
    const root = buildProject({
      manifest: {
        name: "tmp-sailor-fixture",
        private: true,
        scripts: { lint: "node -e \"process.stdout.write('linted')\"" },
      },
    });
    const profile = await profileFor(root);

    expect(profile.packageManager).toBe("npm");
    expect(profile.availableScripts).toEqual(["lint"]);

    const report = await runGates(
      `  - id: gate.lint
    description: Lint
    severity: error
    appliesTo: [coder]
    instruction: Must pass.
    checks:
      - id: native-lint
        runner: project-script
        script: lint
        phases: [pre-commit]
        timeoutMs: 120000
`,
      profile
    );

    expect(report.results[0]).toMatchObject({
      status: "passed",
      command: { executable: "npm", args: ["run", "lint"] },
    });
    expect(report.results[0]?.stdout).toContain("linted");
    expect(report.blocked).toBe(false);
  }, 120_000);

  it("blocks on a script the project does not define, without spawning", async () => {
    const root = buildProject({ manifest: { name: "example" } });
    const profile = await profileFor(root);

    const report = await runGates(
      `  - id: gate.typecheck
    description: Typecheck
    severity: error
    appliesTo: [coder]
    instruction: Must pass.
    checks:
      - id: native-typecheck
        runner: project-script
        script: typecheck
        phases: [pre-commit]
        timeoutMs: 120000
`,
      profile
    );

    expect(report.results[0]).toMatchObject({
      status: "failed",
      command: null,
    });
    expect(report.blocked).toBe(true);
  });
});
