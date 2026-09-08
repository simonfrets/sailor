import { z } from "zod";

import { loadYamlConfig } from "../config/load-yaml-config.js";
import { reportIdSchema } from "../gates/gate-report-schema.js";
import { resolveProjectScript } from "../gates/resolve-project-script.js";
import { commandSpecSchema } from "../enforcement/tool-policy.js";
import { describeCommandResult } from "../processes/command-runner.js";
import type {
  CommandResult,
  CommandRunner,
  CommandSpec,
} from "../processes/command-runner.js";
import type { ProjectProfile } from "../project/project-profile-schema.js";
import {
  DEFAULT_CHECK_TIMEOUT_MS,
  MAX_CHECK_TIMEOUT_MS,
  MIN_CHECK_TIMEOUT_MS,
  identifierSchema,
  projectScriptNameSchema,
} from "../rules/rule-schema.js";
import { timestampSchema } from "../tasks/task-schema.js";

const stepBase = {
  id: identifierSchema,
  /**
   * Scenario names this step demonstrates. Completion derives its Gherkin
   * evidence from these: a scenario passes when every step covering it
   * passed. A step may cover none - setup is a step too.
   */
  covers: z.array(z.string().min(1)).default([]),
  timeoutMs: z
    .int()
    .min(MIN_CHECK_TIMEOUT_MS)
    .max(MAX_CHECK_TIMEOUT_MS)
    .default(DEFAULT_CHECK_TIMEOUT_MS),
};

/**
 * One step of the accepted QA procedure. The same two runners a rule check
 * has, and the same reasons: a semantic script name resolved through the
 * project's package manager, or an explicit argument vector. Never a shell
 * string, and never an arbitrary package script.
 */
export const qaStepSchema = z.discriminatedUnion("runner", [
  z.strictObject({
    ...stepBase,
    runner: z.literal("project-script"),
    script: projectScriptNameSchema,
    args: z.array(z.string()).default([]),
  }),
  z.strictObject({
    ...stepBase,
    runner: z.literal("command"),
    argv: z.tuple([z.string().min(1)], z.string()),
  }),
]);

/**
 * The executable QA procedure, as data. The specifier writes it beside the
 * specification, approval pins its digest, and completion runs it - so what
 * it may contain is fixed by schema rather than by whoever runs it last.
 */
export const qaProcedureSchema = z
  .strictObject({
    version: z.literal(1),
    steps: z
      .array(qaStepSchema)
      .min(1, "a QA procedure must declare at least one step"),
  })
  .superRefine((procedure, ctx) => {
    const seen = new Set<string>();

    for (const [index, step] of procedure.steps.entries()) {
      if (seen.has(step.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, "id"],
          message: `step \`${step.id}\` is declared more than once`,
        });
      }

      seen.add(step.id);
    }
  });

export type QaStep = z.output<typeof qaStepSchema>;
export type QaProcedure = z.output<typeof qaProcedureSchema>;

export const loadQaProcedure = (
  text: string,
  options: { readonly source: string }
): QaProcedure => loadYamlConfig(text, qaProcedureSchema, options);

/**
 * How one step can end. No `skipped`: a gate check may be configured to skip
 * a script the project lacks, but the QA procedure was approved for this
 * project, so a script it names and the project lacks is a failure.
 */
export const QA_STEP_STATUSES = [
  "passed",
  "failed",
  "timed-out",
  "spawn-failed",
] as const;

export const qaStepStatusSchema = z.enum(QA_STEP_STATUSES);

export const qaStepResultSchema = z.strictObject({
  stepId: identifierSchema,
  covers: z.array(z.string().min(1)),
  status: qaStepStatusSchema,
  /** Null when the step never resolved to something runnable. */
  command: commandSpecSchema.nullable(),
  exitCode: z.int().nullable(),
  signal: z.string().min(1).nullable(),
  stdout: z.string(),
  stderr: z.string(),
  outputTruncated: z.boolean(),
  durationMs: z.number().min(0),
  /** One printable line stating what happened. Always populated. */
  detail: z.string().min(1),
});

export const qaProcedureReportSchema = z.strictObject({
  reportId: reportIdSchema,
  startedAt: timestampSchema,
  finishedAt: timestampSchema,
  durationMs: z.number().min(0),
  steps: z.array(qaStepResultSchema).min(1),
  passed: z.boolean(),
  failedStepIds: z.array(identifierSchema),
});

export type QaStepResult = z.output<typeof qaStepResultSchema>;
export type QaProcedureReport = z.output<typeof qaProcedureReportSchema>;

export interface RunQaProcedureOptions {
  readonly procedure: QaProcedure;
  readonly profile: ProjectProfile;
  readonly runner: CommandRunner;
  readonly now: () => Date;
  readonly createReportId: () => string;
}

const statusOf = (result: CommandResult): QaStepResult["status"] => {
  switch (result.outcome) {
    case "exited":
      return result.exitCode === 0 ? "passed" : "failed";
    case "signaled":
      return "failed";
    case "timed-out":
      return "timed-out";
    case "spawn-failed":
      return "spawn-failed";
  }
};

const toStepResult = (
  step: QaStep,
  command: CommandSpec,
  result: CommandResult
): QaStepResult => ({
  stepId: step.id,
  covers: step.covers,
  status: statusOf(result),
  command,
  exitCode: result.outcome === "exited" ? result.exitCode : null,
  signal: result.outcome === "signaled" ? result.signal : null,
  stdout: result.output.stdout,
  stderr: result.output.stderr,
  outputTruncated: result.output.truncated,
  durationMs: result.durationMs,
  detail: describeCommandResult(result),
});

const missingScriptResult = (
  step: QaStep & { readonly script: string },
  profile: ProjectProfile
): QaStepResult => ({
  stepId: step.id,
  covers: step.covers,
  status: "failed",
  command: null,
  exitCode: null,
  signal: null,
  stdout: "",
  stderr: "",
  outputTruncated: false,
  durationMs: 0,
  detail: `project script "${step.script}" is not defined (${
    profile.availableScripts.length === 0
      ? "the project defines none of them"
      : `available: ${profile.availableScripts.join(", ")}`
  })`,
});

/**
 * Runs the accepted procedure and reports every step.
 *
 * Steps run sequentially, in declaration order, and a failure does not stop
 * the run: the report is evidence, and evidence that stops at the first
 * failure says nothing about the steps behind it. Timeouts, signals and
 * spawn failures are reported as themselves, exactly as gates report them,
 * because "it failed" and "it never ran" call for different mornings.
 */
export const runQaProcedure = async (
  options: RunQaProcedureOptions
): Promise<QaProcedureReport> => {
  const startedAtDate = options.now();
  const steps: QaStepResult[] = [];

  for (const step of options.procedure.steps) {
    let command: CommandSpec;

    if (step.runner === "command") {
      const [executable, ...args] = step.argv;

      command = { executable, args };
    } else {
      const resolution = resolveProjectScript({
        packageManager: options.profile.packageManager,
        script: step.script,
        args: step.args,
        availableScripts: options.profile.availableScripts,
        whenMissing: "fail",
      });

      if (resolution.kind === "missing") {
        steps.push(missingScriptResult(step, options.profile));
        continue;
      }

      command = resolution.command;
    }

    steps.push(
      toStepResult(
        step,
        command,
        await options.runner({
          command,
          cwd: options.profile.root,
          env: null,
          timeoutMs: step.timeoutMs,
        })
      )
    );
  }

  const failedStepIds = steps
    .filter((step) => step.status !== "passed")
    .map((step) => step.stepId);
  const finishedAtDate = options.now();

  return {
    reportId: options.createReportId(),
    startedAt: startedAtDate.toISOString(),
    finishedAt: finishedAtDate.toISOString(),
    durationMs: finishedAtDate.getTime() - startedAtDate.getTime(),
    steps,
    passed: failedStepIds.length === 0,
    failedStepIds,
  };
};
