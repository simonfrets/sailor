import { z } from "zod";

import { modelProfileSchema } from "../agents/agent-definition.js";
import type { ModelProfile } from "../agents/agent-definition.js";
import { providerIdSchema } from "../providers/provider-adapter.js";
import type { ProviderId } from "../providers/provider-adapter.js";
import {
  SAILOR_DIRECTORY,
  SAILOR_PATHS,
  sailorPath,
} from "../sailor/layout.js";
import { readTextFileIfPresent } from "../sailor/read-text-file.js";
import { loadYamlConfig } from "./load-yaml-config.js";

/**
 * The model each logical profile runs on, for one provider.
 *
 * Partial on purpose: a profile the file leaves out runs on the model its
 * adapter defaults to, so overriding one model does not mean restating the
 * other two - and a profile added by a later sailor keeps working in a file
 * written before it existed.
 *
 * A model id is only held to being a non-empty string, because that is all
 * this side can honestly check. `--model` takes aliases and full names alike
 * and refuses neither until the request is made, so the adapter that consumes
 * the id is where the design puts its validation.
 */
export const providerModelsSchema = z.partialRecord(
  modelProfileSchema,
  z.string().min(1)
);

/**
 * Every key has a default, deliberately: this is a seeded file, written once
 * and never reconciled, so a copy written by an older sailor must keep
 * parsing when a newer one adds a key. `version: 1` alone is a valid file.
 */
export const modelsConfigSchema = z.strictObject({
  version: z.literal(1),
  models: z.partialRecord(providerIdSchema, providerModelsSchema).default({}),
});

export type ProviderModels = z.output<typeof providerModelsSchema>;
export type ModelsConfig = z.output<typeof modelsConfigSchema>;

/** What one provider's adapter is told, which may be nothing. */
export const modelsForProvider = (
  config: ModelsConfig,
  provider: ProviderId
): Readonly<Partial<Record<ModelProfile, string>>> =>
  config.models[provider] ?? {};

export const loadModelsConfig = (
  text: string,
  options: { readonly source: string }
): ModelsConfig => loadYamlConfig(text, modelsConfigSchema, options);

/**
 * The installed copy, or the defaults where none was ever installed.
 *
 * A missing file is normal - an installation made before this file shipped
 * has no copy, and its defaults are every adapter's own. An invalid one is
 * not: a project that named a model and mistyped the profile would otherwise
 * run its agents on models it did not choose, and the bill would be the first
 * thing to say so.
 */
export const readInstalledModelsConfig = (
  projectRoot: string
): ModelsConfig => {
  const source = `${SAILOR_DIRECTORY}/${SAILOR_PATHS.modelsConfig}`;
  const text = readTextFileIfPresent(
    sailorPath(projectRoot, SAILOR_PATHS.modelsConfig)
  );

  return text === null
    ? modelsConfigSchema.parse({ version: 1 })
    : loadModelsConfig(text, { source });
};
