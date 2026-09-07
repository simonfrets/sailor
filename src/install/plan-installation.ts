import { SailorError } from "../sailor/sailor-error.js";
import { SAILOR_DIRECTORY, sailorPath } from "../sailor/layout.js";
import { readTextFileIfPresent } from "../sailor/read-text-file.js";
import { compareCodeUnits } from "../rules/hash-rule-set.js";
import type { SailorTemplateFile } from "./sailor-templates.js";
import { hashManagedFile } from "./install-manifest.js";
import type { InstallManifest, ManagedFileKind } from "./install-manifest.js";

export const INSTALL_ACTIONS = ["create", "keep", "replace"] as const;
export type InstallAction = (typeof INSTALL_ACTIONS)[number];

export interface PlannedFile {
  /** Path relative to the `.sailor` directory, with `/` separators. */
  readonly path: string;
  readonly action: InstallAction;
  /** What will be on disk afterwards: the project's copy of a kept file. */
  readonly contents: string;
  readonly sha256: string;
  readonly kind: ManagedFileKind;
}

export interface InstallationPlan {
  readonly files: readonly PlannedFile[];
  /**
   * Files the previous install managed that this version no longer ships.
   *
   * They are reported rather than deleted. Removing a file from a project is
   * exactly the irreversible act this installer refuses to perform on its own,
   * and a stale managed file is harmless where a wrongly deleted one is not.
   */
  readonly orphaned: readonly string[];
}

export interface PlanInstallationInput {
  readonly projectRoot: string;
  /** Managed content keyed by path relative to `.sailor`, already rendered. */
  readonly desired: readonly PlannedFileSource[];
  readonly manifest: InstallManifest | null;
  readonly update: boolean;
}

export interface PlannedFileSource {
  readonly path: string;
  readonly contents: string;
  readonly kind: ManagedFileKind;
}

/** Renders a template file into the content the installer intends to write. */
export const toPlannedFileSource = (
  file: SailorTemplateFile,
  contents: string
): PlannedFileSource => ({
  path: file.installedPath,
  contents,
  kind: file.seeded ? "seeded" : "managed",
});

/**
 * Decides what installing would do to each managed file, without touching disk.
 *
 * Every conflict in the project is collected before any is raised, so a person
 * resolving a half-adopted installation sees the whole list once instead of
 * discovering the next one on every re-run. Nothing is written until the plan
 * is conflict-free, which is what makes `sailor init` safe to attempt.
 */
export const planInstallation = (
  input: PlanInstallationInput
): InstallationPlan => {
  const managed = new Map(
    (input.manifest?.managedFiles ?? []).map((entry) => [
      entry.path,
      entry.sha256,
    ])
  );
  const files: PlannedFile[] = [];
  const conflicts: string[] = [];

  for (const source of input.desired) {
    const absolute = sailorPath(input.projectRoot, ...source.path.split("/"));
    const existing = readTextFileIfPresent(absolute);
    const where = `${SAILOR_DIRECTORY}/${source.path}`;
    // The hash recorded is always of what will be on disk once the install
    // finishes, which for a kept file is the copy already there.
    const plan = (action: InstallAction, contents: string): void => {
      files.push({
        path: source.path,
        action,
        contents,
        sha256: hashManagedFile(contents),
        kind: source.kind,
      });
    };

    if (existing === null) {
      plan("create", source.contents);
      continue;
    }

    // A seeded file belongs to the project from the moment it exists, so it is
    // never compared against the template and can never raise a conflict.
    if (source.kind === "seeded") {
      plan("keep", existing);
      continue;
    }

    if (existing === source.contents) {
      plan("keep", existing);
      continue;
    }

    const recorded = managed.get(source.path);

    if (recorded === undefined) {
      conflicts.push(
        `${where} already exists and was not installed by the sailor`
      );
      continue;
    }

    if (hashManagedFile(existing) !== recorded) {
      conflicts.push(
        `${where} was changed after it was installed; move your version aside to accept the shipped one`
      );
      continue;
    }

    if (!input.update) {
      conflicts.push(`${where} is out of date; re-run with \`--update\``);
      continue;
    }

    plan("replace", source.contents);
  }

  if (conflicts.length > 0) {
    throw new SailorError(
      "unsafe-overwrite",
      `installing would overwrite ${String(conflicts.length)} file(s) the sailor does not own`,
      conflicts
    );
  }

  const desired = new Set(input.desired.map((source) => source.path));

  return {
    files,
    orphaned: [...managed.keys()]
      .filter((path) => !desired.has(path))
      .sort(compareCodeUnits),
  };
};
