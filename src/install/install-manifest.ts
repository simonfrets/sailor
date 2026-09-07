import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

import { writeFileAtomic } from "../sailor/atomic-write.js";
import { SailorError } from "../sailor/sailor-error.js";
import { SAILOR_PATHS, sailorPath } from "../sailor/layout.js";

export const INSTALL_MANIFEST_VERSION = 1;
const MANIFEST_MODE = 0o644;

/**
 * Who owns a file the sailor put in a project.
 *
 * A `managed` file is the sailor's: it is kept in step with the template it
 * came from, and an edit to it is a conflict. A `seeded` file is written once,
 * when it is absent, and then belongs to the project — `config/project.yaml`
 * exists to be edited, so reconciling it against the template would make
 * editing it the thing that breaks the next `sailor init`.
 */
export const MANAGED_FILE_KINDS = ["managed", "seeded"] as const;
export const managedFileKindSchema = z.enum(MANAGED_FILE_KINDS);

export const managedFileEntrySchema = z.strictObject({
  /** Path relative to the `.sailor` directory, with `/` separators. */
  path: z.string().min(1),
  /** Hash of the content on disk after the install that recorded it. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * Defaults to `managed` so a manifest written before seeding existed still
   * parses. Nothing reads it to decide an outcome: ownership is a property of
   * the shipped template, which is what migrates an older installation.
   */
  kind: managedFileKindSchema.default("managed"),
});

/** What the manifest remembers about one hook the sailor took over. */
export const hookRecordSchema = z.strictObject({
  hook: z.string().min(1),
  /**
   * The preserved hook this dispatcher runs first, or null when the project
   * had none. Relative to the project root when it lives inside it, so the
   * record means the same thing on every machine that checks the project out.
   */
  chained: z.string().min(1).nullable(),
});

/**
 * The record of what the sailor installed and what it looked like.
 *
 * Without the hashes, `--update` could not tell a file the sailor wrote from
 * one a project deliberately changed, and would have to either overwrite local
 * work or never update anything.
 */
export const installManifestSchema = z.strictObject({
  version: z.literal(INSTALL_MANIFEST_VERSION),
  sailorVersion: z.string().min(1),
  installedAt: z.string().min(1),
  updatedAt: z.string().min(1),
  managedFiles: z.array(managedFileEntrySchema),
  /**
   * Once `core.hooksPath` points at the sailor, the dispatchers are the only
   * hooks git can see. These two fields are therefore the only surviving
   * record of what the project had before, and a re-install reads them rather
   * than inspecting its own output and concluding there was never anything.
   */
  hooks: z.array(hookRecordSchema).default([]),
  previousHooksPath: z.string().min(1).nullable().default(null),
});

export type ManagedFileKind = z.output<typeof managedFileKindSchema>;
export type ManagedFileEntry = z.output<typeof managedFileEntrySchema>;
export type HookRecord = z.output<typeof hookRecordSchema>;
export type InstallManifest = z.output<typeof installManifestSchema>;

/**
 * Hashes one managed file's content.
 *
 * The hash is over the bytes as written, with no normalisation: an installed
 * file that differs from the template only by line ending was still changed by
 * something, and an installer that shrugged at that could not tell a checkout
 * setting from a deliberate edit.
 */
export const hashManagedFile = (contents: string): string =>
  createHash("sha256").update(contents, "utf8").digest("hex");

const manifestPath = (projectRoot: string): string =>
  sailorPath(projectRoot, SAILOR_PATHS.manifest);

/** Returns null when the sailor has never been installed in this project. */
export const readInstallManifest = (
  projectRoot: string
): InstallManifest | null => {
  const path = manifestPath(projectRoot);
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    throw new SailorError(
      "invalid-config",
      `${SAILOR_PATHS.manifest} is not valid JSON`,
      [String(error)]
    );
  }

  const result = installManifestSchema.safeParse(parsed);

  if (!result.success) {
    throw new SailorError(
      "invalid-config",
      `${SAILOR_PATHS.manifest} is not a valid sailor manifest`,
      result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`
      )
    );
  }

  return result.data;
};

export const writeInstallManifest = (
  projectRoot: string,
  manifest: InstallManifest
): void => {
  writeFileAtomic(
    manifestPath(projectRoot),
    `${JSON.stringify(manifest, null, 2)}\n`,
    MANIFEST_MODE
  );
};
