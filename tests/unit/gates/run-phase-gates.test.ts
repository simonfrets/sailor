import {
  createDefaultReportId,
  createDeterministicReportId,
  runPhaseGates,
} from "../../../src/gates/run-phase-gates.js";
import type { PhaseGateReport } from "../../../src/gates/run-phase-gates.js";
import type { CommandRunner } from "../../../src/processes/command-runner.js";
import type { ProjectProfile } from "../../../src/project/project-profile-schema.js";
import { loadRuleBundle } from "../../../src/rules/load-rule-bundle.js";
import { resolveRuleSet } from "../../../src/rules/resolve-rule-set.js";
import type { ResolvedRuleSet } from "../../../src/rules/resolve-rule-set.js";
import type { Phase } from "../../../src/rules/rule-schema.js";
import {
  at,
  createFakeCommandRunner,
  exited,
  signaled,
  spawnFailed,
  timedOut,
} from "../../helpers/fake-command-runner.js";
import type { PlannedCommandResult } from "../../helpers/fake-command-runner.js";

const PROFILE: ProjectProfile = {
  root: "/workspace/example",
  packageManager: "npm",
  availableScripts: ["lint", "test"],
  typescriptConfigFiles: ["tsconfig.json"],
  eslintConfigFiles: ["eslint.config.js"],
  gitHooksPath: null,
  existingHookEntrypoints: [],
  validationMode: "native-plus-sailor",
};

const ruleSetOf = (rules: string): ResolvedRuleSet =>
  resolveRuleSet([
    {
      origin: "project",
      location: "rules.yaml",
      bundle: loadRuleBundle(
        `version: 1\nid: base\ndescription: Baseline\nrules:\n${rules}`,
        { source: "rules.yaml" }
      ),
    },
  ]);

interface RunOptions {
  readonly rules: string;
  readonly phase?: Phase;
  readonly agentId?: string | null;
  readonly profile?: ProjectProfile;
  readonly respond?: PlannedCommandResult;
  readonly runner?: CommandRunner;
}

let clock = 0;

const run = async (options: RunOptions): Promise<PhaseGateReport> => {
  clock = 0;

  const fake = createFakeCommandRunner(options.respond ?? exited(0));

  return runPhaseGates({
    ruleSet: ruleSetOf(options.rules),
    phase: options.phase ?? "pre-handoff",
    agentId: options.agentId === undefined ? "coder" : options.agentId,
    profile: options.profile ?? PROFILE,
    runner: options.runner ?? fake.run,
    now: (): Date => new Date(1_800_000_000_000 + clock++ * 1000),
    createReportId: (): string => "report-1",
  });
};

const lintRule = (
  severity: string,
  required = true,
  phases = "[pre-handoff]"
): string => `  - id: typescript.quality
    description: Quality
    severity: ${severity}
    appliesTo: [coder]
    instruction: Keep it clean.
    checks:
      - id: native-lint
        runner: project-script
        script: lint
        required: ${String(required)}
        phases: ${phases}
`;

describe("runPhaseGates", () => {
  it("passes when every required check succeeds", async () => {
    const report = await run({ rules: lintRule("error") });

    expect(report.status).toBe("passed");
    expect(report.blocked).toBe(false);
    expect(report.blockingFailureCount).toBe(0);
    expect(report.results).toHaveLength(1);
    expect(at(report.results, 0)).toMatchObject({
      checkId: "native-lint",
      ruleId: "typescript.quality",
      status: "passed",
      blocking: true,
      exitCode: 0,
    });
  });

  it("rejects the phase when a required error check fails", async () => {
    const report = await run({ rules: lintRule("error"), respond: exited(1) });

    expect(report.status).toBe("failed");
    expect(report.blocked).toBe(true);
    expect(report.blockingFailureCount).toBe(1);
    expect(at(report.results, 0).status).toBe("failed");
  });

  it("records a failing warning check without blocking the phase", async () => {
    const report = await run({
      rules: lintRule("warning"),
      respond: exited(1, { stdout: "3 warnings", stderr: "detail" }),
    });

    expect(report.status).toBe("passed-with-warnings");
    expect(report.blocked).toBe(false);
    expect(report.blockingFailureCount).toBe(0);
    expect(report.warningFailureCount).toBe(1);
    expect(at(report.results, 0)).toMatchObject({
      status: "failed",
      blocking: false,
      severity: "warning",
      stdout: "3 warnings",
      stderr: "detail",
    });
  });

  it("does not block on a failing check that is not required", async () => {
    const report = await run({
      rules: lintRule("error", false),
      respond: exited(1),
    });

    expect(report.blocked).toBe(false);
    expect(report.status).toBe("passed-with-warnings");
    expect(at(report.results, 0).blocking).toBe(false);
  });

  it("captures stdout and stderr verbatim", async () => {
    const report = await run({
      rules: lintRule("error"),
      respond: exited(0, {
        stdout: "line one\nline two",
        stderr: "warning: x",
        truncated: true,
      }),
    });

    expect(at(report.results, 0)).toMatchObject({
      stdout: "line one\nline two",
      stderr: "warning: x",
      outputTruncated: true,
    });
  });

  it("reports a timeout distinctly from a failing exit", async () => {
    const report = await run({
      rules: lintRule("error"),
      respond: timedOut(1000),
    });

    expect(at(report.results, 0)).toMatchObject({
      status: "timed-out",
      exitCode: null,
    });
    expect(at(report.results, 0).detail).toContain("timed out");
    expect(report.blocked).toBe(true);
  });

  it("reports a spawn failure distinctly and blocks", async () => {
    const report = await run({
      rules: lintRule("error"),
      respond: spawnFailed("ENOENT"),
    });

    expect(at(report.results, 0).status).toBe("spawn-failed");
    expect(at(report.results, 0).detail).toContain("ENOENT");
    expect(report.blocked).toBe(true);
  });

  it("reports a signalled command as a failure and records the signal", async () => {
    const report = await run({
      rules: lintRule("error"),
      respond: signaled("SIGKILL"),
    });

    expect(at(report.results, 0)).toMatchObject({
      status: "failed",
      signal: "SIGKILL",
      exitCode: null,
    });
  });

  it("fails a missing script without invoking the runner", async () => {
    const fake = createFakeCommandRunner(exited(0));
    const report = await run({
      rules: lintRule("error").replace("script: lint", "script: typecheck"),
      runner: fake.run,
    });

    expect(at(report.results, 0)).toMatchObject({
      status: "failed",
      command: null,
      exitCode: null,
    });
    expect(at(report.results, 0).detail).toContain("typecheck");
    expect(at(report.results, 0).detail).toContain("lint, test");
    expect(fake.requests).toHaveLength(0);
    expect(report.blocked).toBe(true);
  });

  it("skips a missing script when the rule says to, without blocking", async () => {
    const fake = createFakeCommandRunner(exited(0));
    const report = await run({
      rules: lintRule("error")
        .replace("script: lint", "script: typecheck")
        .replace(
          "        required: true",
          "        whenMissing: skip\n        required: true"
        ),
      runner: fake.run,
    });

    expect(at(report.results, 0).status).toBe("skipped");
    expect(fake.requests).toHaveLength(0);
    expect(report.blocked).toBe(false);
    expect(report.status).toBe("passed");
  });

  it("says so when the project defines no scripts at all", async () => {
    const report = await run({
      rules: lintRule("error"),
      profile: { ...PROFILE, availableScripts: [] },
    });

    expect(at(report.results, 0).detail).toContain("defines none of them");
  });

  it("runs only the checks that declare the requested phase", async () => {
    const fake = createFakeCommandRunner(exited(0));
    const report = await runPhaseGates({
      ruleSet: ruleSetOf(`  - id: a.rule
    description: A
    severity: error
    appliesTo: [coder]
    instruction: A.
    checks:
      - id: commit-only
        runner: command
        argv: ["node", "-v"]
        phases: [pre-commit]
      - id: push-only
        runner: command
        argv: ["node", "-v"]
        phases: [pre-push]
      - id: both
        runner: command
        argv: ["node", "-v"]
        phases: [pre-commit, pre-push]
`),
      phase: "pre-push",
      agentId: null,
      profile: PROFILE,
      runner: fake.run,
      now: (): Date => new Date(0),
      createReportId: (): string => "report-1",
    });

    expect(report.results.map((result) => result.checkId)).toEqual([
      "push-only",
      "both",
    ]);
    expect(report.skippedCheckIds).toEqual(["commit-only"]);
    expect(fake.requests).toHaveLength(2);
  });

  it("runs only the rules that apply to the requested agent", async () => {
    const rules = `  - id: coder.rule
    description: Coder
    severity: error
    appliesTo: [coder]
    instruction: Coder.
    checks:
      - id: coder-check
        runner: command
        argv: ["node", "-v"]
        phases: [pre-handoff]
  - id: architect.rule
    description: Architect
    severity: error
    appliesTo: [architect]
    instruction: Architect.
    checks:
      - id: architect-check
        runner: command
        argv: ["node", "-v"]
        phases: [pre-handoff]
`;

    const forArchitect = await run({ rules, agentId: "architect" });
    const forEveryone = await run({ rules, agentId: null });

    expect(forArchitect.results.map((result) => result.checkId)).toEqual([
      "architect-check",
    ]);
    expect(forArchitect.skippedCheckIds).toEqual(["coder-check"]);
    expect(forEveryone.results).toHaveLength(2);
  });

  it("passes with no results when nothing applies to the phase", async () => {
    const fake = createFakeCommandRunner(exited(0));
    const report = await run({
      rules: lintRule("error"),
      phase: "qa",
      runner: fake.run,
    });

    expect(report.results).toEqual([]);
    expect(report.status).toBe("passed");
    expect(report.blocked).toBe(false);
    expect(fake.requests).toHaveLength(0);
  });

  it("builds the package manager command from the project profile", async () => {
    const fake = createFakeCommandRunner(exited(0));

    await run({
      rules: lintRule("error"),
      profile: { ...PROFILE, packageManager: "pnpm" },
      runner: fake.run,
    });

    expect(at(fake.requests, 0)).toMatchObject({
      command: { executable: "pnpm", args: ["run", "lint"] },
      cwd: PROFILE.root,
      timeoutMs: 120000,
    });
  });

  it("passes an explicit command through as literal argv values", async () => {
    const fake = createFakeCommandRunner(exited(0));

    await run({
      rules: `  - id: a.rule
    description: A
    severity: error
    appliesTo: [coder]
    instruction: A.
    checks:
      - id: hostile
        runner: command
        argv: ["node", "-e", "process.exit(0)", "; rm -rf .", "$(touch pwned)"]
        phases: [pre-handoff]
        timeoutMs: 5000
`,
      runner: fake.run,
    });

    expect(at(fake.requests, 0)).toMatchObject({
      command: {
        executable: "node",
        args: ["-e", "process.exit(0)", "; rm -rf .", "$(touch pwned)"],
      },
      timeoutMs: 5000,
    });
  });

  it("runs checks sequentially in rule and declaration order", async () => {
    // Recording both ends proves the second check starts only after the first
    // finishes; recording starts alone would look the same if they overlapped.
    const events: string[] = [];
    const runner: CommandRunner = async (request) => {
      const name = at(request.command.args, 0);

      events.push(`start:${name}`);
      await Promise.resolve();
      events.push(`end:${name}`);

      return { ...exited(0), command: request.command };
    };

    const report = await run({
      rules: `  - id: a.rule
    description: A
    severity: error
    appliesTo: [coder]
    instruction: A.
    checks:
      - id: first
        runner: command
        argv: ["node", "one"]
        phases: [pre-handoff]
      - id: second
        runner: command
        argv: ["node", "two"]
        phases: [pre-handoff]
`,
      runner,
    });

    expect(events).toEqual(["start:one", "end:one", "start:two", "end:two"]);
    expect(report.results.map((result) => result.checkId)).toEqual([
      "first",
      "second",
    ]);
  });

  it("stamps the report with the phase, agent, rule-set hash, and clock", async () => {
    const ruleSet = ruleSetOf(lintRule("error"));
    const report = await run({ rules: lintRule("error") });

    expect(report).toMatchObject({
      reportId: "report-1",
      phase: "pre-handoff",
      agentId: "coder",
      ruleSetSha256: ruleSet.sha256,
      startedAt: "2027-01-15T08:00:00.000Z",
      finishedAt: "2027-01-15T08:00:01.000Z",
      durationMs: 1000,
    });
  });

  it("produces a report that survives a JSON round trip", async () => {
    const report = await run({ rules: lintRule("error"), respond: exited(1) });

    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

describe("report identifiers", () => {
  it("derives a stable id from the phase, agent, hash, and start time", () => {
    const input = {
      phase: "pre-commit",
      agentId: "coder",
      ruleSetSha256: "a".repeat(64),
      startedAt: "2026-08-25T00:00:00.000Z",
    } as const;

    expect(createDeterministicReportId(input)).toBe(
      createDeterministicReportId(input)
    );
    expect(createDeterministicReportId(input)).toMatch(/^[0-9a-f]{32}$/);
    expect(createDeterministicReportId({ ...input, agentId: null })).not.toBe(
      createDeterministicReportId(input)
    );
  });

  it("generates a distinct id per report by default", () => {
    expect(createDefaultReportId()).not.toBe(createDefaultReportId());
  });
});
