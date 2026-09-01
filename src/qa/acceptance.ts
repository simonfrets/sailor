import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { SailorError } from "../sailor/sailor-error.js";
import { projectRelativePathSchema } from "../sailor/project-path.js";
import type { Acceptance } from "../tasks/task-schema.js";
import { listScenarios } from "./gherkin.js";
import { loadQaProcedure } from "./procedure.js";
import type { QaProcedure } from "./procedure.js";

export interface PrepareAcceptanceOptions {
  readonly projectRoot: string;
  /** The feature files the approval accepts, relative to the project root. */
  readonly featurePaths: readonly string[];
  /** The executable QA procedure, relative to the project root. */
  readonly procedurePath: string;
}

/** What an approval is about to accept, read from the actual files. */
export interface PreparedAcceptance {
  readonly acceptance: Acceptance;
  /** Every scenario across the accepted features, in declaration order. */
  readonly scenarios: readonly string[];
  readonly procedure: QaProcedure;
}

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

interface ReadFile {
  readonly path: string;
  readonly text: string;
}

/**
 * Reads the files an acceptance names and holds the set to what completion
 * will need: real files inside the project, features that parse and declare
 * uniquely named scenarios, a procedure that parses, and coverage that is
 * total in both directions - every scenario has a step demonstrating it, and
 * every step covers only scenarios that exist. A dangling `covers` entry is
 * refused because it is always a typo, and a typo here silently exempts the
 * scenario it was aimed at.
 *
 * Called at approval, so a specification that cannot be demonstrated is
 * refused before anyone approves it; and again at completion, where the
 * digests are compared with the approved ones, so a file rewritten in
 * between is caught by content rather than by trust.
 *
 * Every issue is collected and reported once.
 */
export const prepareAcceptance = (
  options: PrepareAcceptanceOptions
): PreparedAcceptance => {
  const issues: string[] = [];

  const readProjectFile = (path: string): ReadFile | null => {
    if (!projectRelativePathSchema.safeParse(path).success) {
      issues.push(`\`${path}\` is not a path inside the project`);

      return null;
    }

    const absolute = join(options.projectRoot, ...path.split(posix.sep));

    if (!existsSync(absolute)) {
      issues.push(`${path} does not exist`);

      return null;
    }

    return { path, text: readFileSync(absolute, "utf8") };
  };

  const seenPaths = new Set<string>();
  const scenarios: string[] = [];
  const declaredBy = new Map<string, string>();
  const features: { path: string; sha256: string }[] = [];

  for (const path of options.featurePaths) {
    if (seenPaths.has(path)) {
      issues.push(`${path} is accepted more than once`);
      continue;
    }

    seenPaths.add(path);

    const file = readProjectFile(path);

    if (file === null) {
      continue;
    }

    try {
      const names = listScenarios(file.text, { source: path });

      if (names.length === 0) {
        issues.push(`${path} declares no scenario, so it accepts nothing`);
      }

      for (const name of names) {
        const declared = declaredBy.get(name);

        if (declared === undefined) {
          declaredBy.set(name, path);
          scenarios.push(name);
        } else {
          issues.push(
            `\`${name}\` is declared by more than one accepted feature (${declared} and ${path})`
          );
        }
      }

      features.push({ path, sha256: sha256(file.text) });
    } catch (error: unknown) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (features.length === 0 && issues.length === 0) {
    issues.push("an acceptance must name at least one feature file");
  }

  let procedure: QaProcedure | null = null;
  let procedureDigest: string | null = null;
  const procedureFile = readProjectFile(options.procedurePath);

  if (procedureFile !== null) {
    try {
      procedure = loadQaProcedure(procedureFile.text, {
        source: procedureFile.path,
      });
      procedureDigest = sha256(procedureFile.text);
    } catch (error: unknown) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (procedure !== null) {
    const covered = new Set<string>();

    for (const step of procedure.steps) {
      for (const name of step.covers) {
        covered.add(name);

        if (!declaredBy.has(name)) {
          issues.push(
            `step \`${step.id}\` covers \`${name}\`, which no accepted feature declares`
          );
        }
      }
    }

    for (const name of scenarios) {
      if (!covered.has(name)) {
        issues.push(
          `no step covers \`${name}\`; a scenario nothing demonstrates cannot be completed`
        );
      }
    }
  }

  if (issues.length > 0 || procedure === null || procedureDigest === null) {
    throw new SailorError(
      "invalid-config",
      "the acceptance cannot be prepared from these files",
      issues
    );
  }

  return {
    acceptance: {
      features,
      procedure: { path: options.procedurePath, sha256: procedureDigest },
    },
    scenarios,
    procedure,
  };
};
