import { z } from "zod";

import { projectScriptNameSchema } from "../rules/rule-schema.js";

export const PACKAGE_MANAGERS = ["bun", "npm", "pnpm", "yarn"] as const;
export const packageManagerSchema = z.enum(PACKAGE_MANAGERS);

/**
 * `native-plus-sailor` runs the host project's own scripts alongside the
 * sailor correctness gates. The other modes exist so a project can opt out of
 * one side without editing rules.
 */
export const VALIDATION_MODES = [
  "sailor-only",
  "native-only",
  "native-plus-sailor",
] as const;
export const validationModeSchema = z.enum(VALIDATION_MODES);

export const HOOK_RUNNERS = ["git", "husky", "lefthook", "unknown"] as const;
export const HOOK_NAMES = ["pre-commit", "pre-push"] as const;

export const hookEntrypointSchema = z.strictObject({
  runner: z.enum(HOOK_RUNNERS),
  hook: z.enum(HOOK_NAMES),
  /** Always relative to the project root, so the profile stays portable. */
  path: z.string().min(1),
});

const portableProfileShape = {
  packageManager: packageManagerSchema,
  availableScripts: z.array(projectScriptNameSchema),
  typescriptConfigFiles: z.array(z.string().min(1)),
  eslintConfigFiles: z.array(z.string().min(1)),
  gitHooksPath: z.string().nullable(),
  existingHookEntrypoints: z.array(hookEntrypointSchema),
  validationMode: validationModeSchema,
};

/** Persisted form: carries no absolute path, so it is machine-independent. */
export const portableProjectProfileSchema =
  z.strictObject(portableProfileShape);

/** In-memory form: adds the absolute root, which is never persisted. */
export const projectProfileSchema = z.strictObject({
  ...portableProfileShape,
  root: z.string().min(1),
});

/**
 * Drops the absolute root. The fields are listed explicitly rather than
 * rest-destructured so that adding a field to the profile without deciding
 * whether it is portable is a compile error, not a silent omission.
 */
export const toPortableProjectProfile = (
  profile: z.output<typeof projectProfileSchema>
): z.output<typeof portableProjectProfileSchema> => ({
  packageManager: profile.packageManager,
  availableScripts: profile.availableScripts,
  typescriptConfigFiles: profile.typescriptConfigFiles,
  eslintConfigFiles: profile.eslintConfigFiles,
  gitHooksPath: profile.gitHooksPath,
  existingHookEntrypoints: profile.existingHookEntrypoints,
  validationMode: profile.validationMode,
});

export type PackageManager = z.output<typeof packageManagerSchema>;
export type ValidationMode = z.output<typeof validationModeSchema>;
export type HookEntrypoint = z.output<typeof hookEntrypointSchema>;
export type ProjectProfile = z.output<typeof projectProfileSchema>;
export type PortableProjectProfile = z.output<
  typeof portableProjectProfileSchema
>;
