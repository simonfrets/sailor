import { z } from "zod";

import { HOOK_NAMES } from "../project/project-profile-schema.js";
import { phaseSchema } from "../rules/rule-schema.js";
import { loadYamlConfig } from "./load-yaml-config.js";

/**
 * What installation does when the project already has a hook.
 *
 * There is no `replace`. Design decision 2 forbids silently discarding a host
 * project's hook configuration, so the only two honest outcomes are to run the
 * existing hook and then the sailor gate, or to stop and let a human decide.
 */
export const EXISTING_HOOK_POLICIES = ["abort", "chain"] as const;
export const existingHookPolicySchema = z.enum(EXISTING_HOOK_POLICIES);

export const managedHookSchema = z.strictObject({
  hook: z.enum(HOOK_NAMES),
  enabled: z.boolean().default(true),
  /** The gate phase the endpoint runs. `sailor gate <phase>`. */
  phase: phaseSchema,
});

const hooksConfigShape = z.strictObject({
  version: z.literal(1),
  onExistingHook: existingHookPolicySchema.default("chain"),
  hooks: z.array(managedHookSchema).default([]),
});

/**
 * A hook name may appear once.
 *
 * Two entries for `pre-commit` would make the installed endpoint depend on
 * which one the installer read last, which is exactly the kind of silent,
 * order-dependent policy the manifest exists to prevent.
 */
export const hooksConfigSchema = hooksConfigShape.superRefine((config, ctx) => {
  const seen = new Set<string>();

  for (const [index, entry] of config.hooks.entries()) {
    if (seen.has(entry.hook)) {
      ctx.addIssue({
        code: "custom",
        path: ["hooks", index, "hook"],
        message: `hook \`${entry.hook}\` is configured more than once`,
      });
    }

    seen.add(entry.hook);
  }
});

export type ExistingHookPolicy = z.output<typeof existingHookPolicySchema>;
export type ManagedHook = z.output<typeof managedHookSchema>;
export type HooksConfig = z.output<typeof hooksConfigSchema>;

export const loadHooksConfig = (
  text: string,
  options: { readonly source: string }
): HooksConfig => loadYamlConfig(text, hooksConfigSchema, options);
