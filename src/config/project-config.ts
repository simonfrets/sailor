import { z } from "zod";

import {
  packageManagerSchema,
  validationModeSchema,
} from "../project/project-profile-schema.js";
import { loadYamlConfig } from "./load-yaml-config.js";

/**
 * The host project's sailor settings.
 *
 * It is deliberately small. Anything the sailor can discover from the project
 * itself — available scripts, TypeScript and ESLint configs, existing hooks —
 * is discovered rather than declared, because a second copy of a fact is a
 * second thing to keep true. Only the two decisions discovery cannot make are
 * settable here.
 */
export const projectConfigSchema = z.strictObject({
  version: z.literal(1),
  /**
   * Which side of the validation runs. `native-plus-sailor` is the documented
   * default; the other modes let a project opt out of one side without editing
   * any rule.
   */
  validationMode: validationModeSchema.default("native-plus-sailor"),
  /**
   * Pinned package manager. `null` means detect it, which is correct for
   * almost every project; it is set only to resolve the ambiguity a repository
   * with two lockfiles would otherwise raise.
   */
  packageManager: packageManagerSchema.nullable().default(null),
});

export type ProjectConfig = z.output<typeof projectConfigSchema>;

export const loadProjectConfig = (
  text: string,
  options: { readonly source: string }
): ProjectConfig => loadYamlConfig(text, projectConfigSchema, options);
