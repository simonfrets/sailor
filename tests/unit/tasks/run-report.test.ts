import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { PhaseGateReport } from "../../../src/gates/run-phase-gates.js";
import { SailorError } from "../../../src/sailor/sailor-error.js";
import {
  readRunReport,
  runReportFile,
  runReportsDirectory,
  writeRunReport,
} from "../../../src/tasks/run-report.js";
import { captureError } from "../../helpers/expect-error.js";
import { buildSailorProject } from "../../helpers/sailor-project.js";
import { removeTempDirectories } from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const WRITTEN_AT = new Date("2026-08-31T12:00:00.000Z");

const gateReport = (reportId: string): PhaseGateReport => ({
  reportId,
  phase: "qa",
  agentId: "qa",
  ruleSetSha256: "b".repeat(64),
  status: "passed",
  blocked: false,
  startedAt: "2026-08-31T11:59:00.000Z",
  finishedAt: "2026-08-31T11:59:30.000Z",
  durationMs: 30_000,
  results: [
    {
      ruleId: "base.tests-accompany-behaviour",
      checkId: "native-test",
      severity: "error",
      required: true,
      blocking: true,
      status: "passed",
      command: { executable: "npm", args: ["run", "test"] },
      exitCode: 0,
      signal: null,
      stdout: "ok\n",
      stderr: "",
      outputTruncated: false,
      durationMs: 29_000,
      detail: "exited with code 0",
    },
  ],
  skippedCheckIds: ["native-build"],
  blockingFailureCount: 0,
  warningFailureCount: 0,
});

describe("run report paths", () => {
  it("puts a run's reports beside its agent contexts", () => {
    expect(runReportsDirectory("run-1")).toBe(
      ".sailor/state/runs/run-1/reports"
    );
    expect(runReportFile("run-1", "abc-123")).toBe(
      ".sailor/state/runs/run-1/reports/abc-123.json"
    );
  });
});

describe("writeRunReport and readRunReport", () => {
  it("round-trips a phase gate report through the run directory", () => {
    const root = buildSailorProject();
    const report = gateReport("a".repeat(32));

    const relative = writeRunReport(root, {
      runId: "run-1",
      kind: "phase-gates",
      report,
      writtenAt: WRITTEN_AT,
    });

    expect(relative).toBe(
      `.sailor/state/runs/run-1/reports/${"a".repeat(32)}.json`
    );
    expect(existsSync(join(root, relative))).toBe(true);

    const stored = readRunReport(root, "run-1", "a".repeat(32));

    expect(stored).toEqual({
      version: 1,
      kind: "phase-gates",
      writtenAt: "2026-08-31T12:00:00.000Z",
      report,
    });
  });

  it("round-trips a QA procedure report through the same directory", () => {
    const root = buildSailorProject();
    const report = {
      reportId: "b".repeat(32),
      startedAt: "2026-08-31T11:58:00.000Z",
      finishedAt: "2026-08-31T11:59:00.000Z",
      durationMs: 60_000,
      steps: [
        {
          stepId: "acceptance",
          covers: ["Happy path"],
          status: "passed" as const,
          command: { executable: "node", args: ["--test"] },
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          outputTruncated: false,
          durationMs: 59_000,
          detail: "exited with code 0",
        },
      ],
      passed: true,
      failedStepIds: [],
    };

    writeRunReport(root, {
      runId: "run-1",
      kind: "qa-procedure",
      report,
      writtenAt: WRITTEN_AT,
    });

    expect(readRunReport(root, "run-1", "b".repeat(32))).toEqual({
      version: 1,
      kind: "qa-procedure",
      writtenAt: "2026-08-31T12:00:00.000Z",
      report,
    });
  });

  it("reports a run this machine has no reports for as absent, not broken", () => {
    const root = buildSailorProject();

    expect(readRunReport(root, "run-1", "a".repeat(32))).toBeNull();
  });

  it("refuses to write a report that would not read back", () => {
    const root = buildSailorProject();
    const error = captureError(
      () =>
        writeRunReport(root, {
          runId: "run-1",
          kind: "phase-gates",
          report: { ...gateReport("a".repeat(32)), ruleSetSha256: "nope" },
          writtenAt: WRITTEN_AT,
        }),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(existsSync(join(root, ".sailor/state/runs/run-1"))).toBe(false);
  });

  it("refuses an id that is not a file name in the run's report directory", () => {
    const root = buildSailorProject();

    for (const reportId of ["../escape", "a/b", "", ".hidden"]) {
      const error = captureError(
        () =>
          writeRunReport(root, {
            runId: "run-1",
            kind: "phase-gates",
            report: gateReport(reportId),
            writtenAt: WRITTEN_AT,
          }),
        SailorError
      );

      expect(error.kind).toBe("invalid-config");
    }
  });

  it("refuses a run id that would leave the runs directory", () => {
    const root = buildSailorProject();
    const error = captureError(
      () => readRunReport(root, "../outside", "a".repeat(32)),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
  });

  it("reports a damaged file rather than papering over it", () => {
    const root = buildSailorProject();
    const path = join(root, runReportFile("run-1", "a".repeat(32)));

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not json");

    const error = captureError(
      () => readRunReport(root, "run-1", "a".repeat(32)),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("readable");
  });

  it("reports a file that is JSON but not a report", () => {
    const root = buildSailorProject();
    const path = join(root, runReportFile("run-1", "a".repeat(32)));

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, kind: "phase-gates" }));

    const error = captureError(
      () => readRunReport(root, "run-1", "a".repeat(32)),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("not a valid run report");
  });

  it("writes through a sibling and a rename, leaving no partial report behind", () => {
    const root = buildSailorProject();

    writeRunReport(root, {
      runId: "run-1",
      kind: "phase-gates",
      report: gateReport("a".repeat(32)),
      writtenAt: WRITTEN_AT,
    });

    const directory = join(root, runReportsDirectory("run-1"));
    const entries = readFileSync(
      join(directory, `${"a".repeat(32)}.json`),
      "utf8"
    );

    expect(entries.endsWith("\n")).toBe(true);
    expect(JSON.parse(entries)).toHaveProperty("kind", "phase-gates");
  });
});
