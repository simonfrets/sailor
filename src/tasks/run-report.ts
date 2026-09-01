import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { z } from "zod";

import {
  phaseGateReportSchema,
  reportIdSchema,
} from "../gates/gate-report-schema.js";
import type { PhaseGateReport } from "../gates/run-phase-gates.js";
import { writeFileAtomic } from "../sailor/atomic-write.js";
import { SailorError } from "../sailor/sailor-error.js";
import { SAILOR_DIRECTORY, SAILOR_PATHS } from "../sailor/layout.js";
import { runIdSchema, timestampSchema } from "./task-schema.js";

export const RUN_REPORT_VERSION = 1;

const REPORT_MODE = 0o644;

/**
 * The stored envelope. The report rides inside a version and a kind so the
 * directory can hold more than one sort of evidence - the QA procedure's
 * results land beside the gate reports - and a reader knows which schema it
 * is looking at before it looks.
 */
export const runReportSchema = z.strictObject({
  version: z.literal(RUN_REPORT_VERSION),
  kind: z.literal("phase-gates"),
  writtenAt: timestampSchema,
  report: phaseGateReportSchema,
});

export type StoredRunReport = z.output<typeof runReportSchema>;

/**
 * Reports live beside the run's agent contexts, under the ignored `state/`
 * tree: they are evidence a machine produced, not state the project reviews.
 * What `tasks.yaml` carries is the summary a transition records; the full
 * report is the detail behind it, on the machine that ran it.
 */
export const runReportsDirectory = (runId: string): string =>
  posix.join(
    SAILOR_DIRECTORY,
    ...SAILOR_PATHS.runs.split(/[\\/]/),
    runId,
    "reports"
  );

export const runReportFile = (runId: string, reportId: string): string =>
  posix.join(runReportsDirectory(runId), `${reportId}.json`);

const validatedSegment = (
  schema: z.ZodType<string>,
  value: string,
  what: string
): string => {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw new SailorError(
      "invalid-config",
      `\`${value}\` is not ${what}`,
      parsed.error.issues.map((issue) => issue.message)
    );
  }

  return parsed.data;
};

export interface WriteRunReportInput {
  readonly runId: string;
  readonly kind: "phase-gates";
  readonly report: PhaseGateReport;
  readonly writtenAt: Date;
}

/**
 * Persists one report under its run and returns the project-relative path it
 * landed at. The envelope is validated before anything touches the disk, so
 * a report that would not read back is refused rather than stored; the write
 * itself goes through the atomic rename every other sailor file uses.
 */
export const writeRunReport = (
  projectRoot: string,
  input: WriteRunReportInput
): string => {
  const runId = validatedSegment(runIdSchema, input.runId, "a run id");
  const envelope = {
    version: RUN_REPORT_VERSION,
    kind: input.kind,
    writtenAt: input.writtenAt.toISOString(),
    report: input.report,
  };
  const parsed = runReportSchema.safeParse(envelope);

  if (!parsed.success) {
    throw new SailorError(
      "invalid-config",
      `the ${input.kind} report cannot be stored as evidence`,
      parsed.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`
      )
    );
  }

  // The envelope validation above already held the report id to
  // `reportIdSchema`, so the file name is taken from the parsed data rather
  // than checked a second time here.
  const relative = runReportFile(runId, parsed.data.report.reportId);

  writeFileAtomic(
    join(projectRoot, ...relative.split(posix.sep)),
    `${JSON.stringify(parsed.data, null, 2)}\n`,
    REPORT_MODE
  );

  return relative;
};

/**
 * Reads one report back, or `null` when this machine never wrote it.
 *
 * Absence is a normal answer - reports live under the ignored `state/` tree,
 * so a fresh checkout has none - and is distinct from damage, which is
 * reported rather than papered over: evidence that cannot be read is not
 * evidence of anything.
 */
export const readRunReport = (
  projectRoot: string,
  runId: string,
  reportId: string
): StoredRunReport | null => {
  const relative = runReportFile(
    validatedSegment(runIdSchema, runId, "a run id"),
    validatedSegment(reportIdSchema, reportId, "a report id")
  );
  const path = join(projectRoot, ...relative.split(posix.sep));

  if (!existsSync(path)) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error: unknown) {
    throw new SailorError(
      "invalid-config",
      `${relative} does not hold a readable report`,
      [String(error)]
    );
  }

  const result = runReportSchema.safeParse(parsed);

  if (!result.success) {
    throw new SailorError(
      "invalid-config",
      `${relative} is not a valid run report`,
      result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`
      )
    );
  }

  return result.data;
};
