import { z } from "zod";

import { agentIdSchema } from "../agents/agent-id.js";

export const SEVERITIES = ["error", "warning"] as const;
export const severitySchema = z.enum(SEVERITIES);

export const PHASES = [
  "pre-agent",
  "pre-handoff",
  "pre-commit",
  "pre-push",
  "qa",
] as const;
export const phaseSchema = z.enum(PHASES);

export const MISSING_SCRIPT_BEHAVIOURS = ["fail", "skip"] as const;
export const whenMissingSchema = z.enum(MISSING_SCRIPT_BEHAVIOURS);

/**
 * Only these semantic script names may be resolved against a host project.
 * An arbitrary package script is never assumed safe to execute.
 */
export const PROJECT_SCRIPT_NAMES = [
  "build",
  "format",
  "lint",
  "test",
  "typecheck",
] as const;
export const projectScriptNameSchema = z.enum(PROJECT_SCRIPT_NAMES);

export const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
export const MIN_CHECK_TIMEOUT_MS = 1_000;
export const MAX_CHECK_TIMEOUT_MS = 3_600_000;

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export const identifierSchema = z
  .string()
  .regex(
    IDENTIFIER_PATTERN,
    "ids must be lower-case, dot- or dash-separated, for example `typescript.no-explicit-any`"
  );

const checkBaseShape = {
  id: identifierSchema,
  phases: z
    .array(phaseSchema)
    .min(1, "a check must declare at least one phase"),
  required: z.boolean().default(true),
  timeoutMs: z
    .int()
    .min(MIN_CHECK_TIMEOUT_MS)
    .max(MAX_CHECK_TIMEOUT_MS)
    .default(DEFAULT_CHECK_TIMEOUT_MS),
};

export const projectScriptCheckSchema = z.strictObject({
  ...checkBaseShape,
  runner: z.literal("project-script"),
  script: projectScriptNameSchema,
  args: z.array(z.string()).default([]),
  whenMissing: whenMissingSchema.default("fail"),
});

/**
 * `argv` is a non-empty tuple rather than a plain array so the executable is
 * typed `string` under `noUncheckedIndexedAccess`. Commands are never stored as
 * interpolated shell strings; that is what keeps metacharacters inert.
 */
export const commandCheckSchema = z.strictObject({
  ...checkBaseShape,
  runner: z.literal("command"),
  argv: z.tuple([z.string().min(1)], z.string()),
  cwd: z.enum(["project-root"]).default("project-root"),
});

export const checkSchema = z.discriminatedUnion("runner", [
  projectScriptCheckSchema,
  commandCheckSchema,
]);

export const ruleSchema = z.strictObject({
  id: identifierSchema,
  description: z.string().min(1),
  severity: severitySchema,
  appliesTo: z
    .array(agentIdSchema)
    .min(1, "a rule must apply to at least one agent"),
  scopes: z.array(z.string().min(1)).default([]),
  instruction: z.string().min(1),
  checks: z.array(checkSchema).default([]),
  /** Set on a higher-precedence rule to intentionally replace a lower one. */
  overrides: z.boolean().default(false),
});

export const ruleBundleSchema = z.strictObject({
  version: z.literal(1),
  id: identifierSchema,
  description: z.string().min(1),
  rules: z.array(ruleSchema).min(1, "a bundle must declare at least one rule"),
});

/**
 * Types are the schema *output*, not its input: `.default()` makes the two
 * differ, and downstream code must see the model with defaults already applied
 * so it never needs a `?? fallback` branch.
 *
 * They live beside their schemas rather than in a separate `types.ts` because a
 * type-only module emits no runtime code under `verbatimModuleSyntax` and is
 * therefore reported as zero-percent covered.
 */
export type Severity = z.output<typeof severitySchema>;
export type Phase = z.output<typeof phaseSchema>;
export type MissingScriptBehaviour = z.output<typeof whenMissingSchema>;
export type ProjectScriptName = z.output<typeof projectScriptNameSchema>;
export type ProjectScriptCheck = z.output<typeof projectScriptCheckSchema>;
export type CommandCheck = z.output<typeof commandCheckSchema>;
export type RuleCheck = z.output<typeof checkSchema>;
export type Rule = z.output<typeof ruleSchema>;
export type RuleBundle = z.output<typeof ruleBundleSchema>;
