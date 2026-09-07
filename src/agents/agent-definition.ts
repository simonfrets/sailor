import { z } from "zod";

import { loadYamlConfig } from "../config/load-yaml-config.js";
import { projectRelativeGlobSchema } from "../sailor/project-path.js";
import { projectScriptNameSchema } from "../rules/rule-schema.js";
import { agentIdSchema } from "./agent-id.js";

/**
 * Logical model profiles. Provider-specific model identifiers are deliberately
 * absent: they live in `.sailor/config/models.yaml` and are validated by the
 * adapter that consumes them, so a definition stays portable across providers.
 */
export const MODEL_PROFILES = [
  "coding-high",
  "reasoning-high",
  "verification",
] as const;
export const modelProfileSchema = z.enum(MODEL_PROFILES);

/**
 * The capability surface an adapter must enforce.
 *
 * These are booleans rather than a list because the set is closed and total:
 * an adapter that reads `tools.edit` gets `boolean`, never `undefined`, so it
 * cannot fail open on a definition that simply omitted the capability.
 */
export const agentToolsSchema = z.strictObject({
  read: z.boolean(),
  search: z.boolean(),
  edit: z.boolean(),
  execute: z.boolean(),
});

const agentDefinitionShape = z.strictObject({
  version: z.literal(1),
  id: agentIdSchema,
  /** Rendered to humans. `qa` is displayed as `QA`, not `Qa`. */
  displayName: z.string().min(1),
  summary: z.string().min(1),
  modelProfile: modelProfileSchema,
  tools: agentToolsSchema,
  /**
   * Globs the agent may write, relative to the project root. An empty list
   * means the agent writes no project file at all.
   *
   * Held to the project boundary rather than to `min(1)`: this is what the
   * runtime reads to decide which files the agent may change, so a scope that
   * leaves the project grants what it names.
   */
  writeScopes: z.array(projectRelativeGlobSchema).default([]),
  /** Semantic project scripts the agent may run. Never an arbitrary command. */
  projectScripts: z.array(projectScriptNameSchema).default([]),
});

/**
 * The write scope and the capability flag have to agree.
 *
 * Design decision 6 says tool permissions are enforced by the runtime rather
 * than by prompt text. A definition that says `edit: false` while listing write
 * scopes, or the reverse, gives the runtime two answers, and whichever one it
 * happens to read becomes the real policy by accident. Rejecting the file is
 * the only reading that cannot silently grant an agent more than was intended.
 *
 * `execute` and `projectScripts` are held to the same rule in both directions.
 * Only one of the two was checked before, so `execute: true` with no scripts
 * validated happily - an agent permitted to run commands with nothing it is
 * permitted to run, which is the same contradiction the edit invariant exists
 * to reject.
 */
export const agentDefinitionSchema = agentDefinitionShape.superRefine(
  (definition, ctx) => {
    if (definition.tools.edit && definition.writeScopes.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["writeScopes"],
        message:
          "an agent with `tools.edit: true` must declare at least one write scope",
      });
    }

    if (!definition.tools.edit && definition.writeScopes.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["writeScopes"],
        message:
          "an agent with `tools.edit: false` must not declare a write scope",
      });
    }

    if (definition.tools.execute && definition.projectScripts.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["projectScripts"],
        message:
          "an agent with `tools.execute: true` must declare at least one project script",
      });
    }

    if (!definition.tools.execute && definition.projectScripts.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["projectScripts"],
        message:
          "an agent with `tools.execute: false` must not declare a project script",
      });
    }
  }
);

export type ModelProfile = z.output<typeof modelProfileSchema>;
export type AgentTools = z.output<typeof agentToolsSchema>;
export type AgentDefinition = z.output<typeof agentDefinitionSchema>;

export const loadAgentDefinition = (
  text: string,
  options: { readonly source: string }
): AgentDefinition => loadYamlConfig(text, agentDefinitionSchema, options);
