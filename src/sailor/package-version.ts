import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SailorError } from "./sailor-error.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readManifest = (packageDirectory: string): unknown => {
  const path = join(packageDirectory, "package.json");

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error: unknown) {
    throw new SailorError(
      "invalid-config",
      `could not read the package manifest at ${path}`,
      // `String` rather than a narrowing branch: `readFileSync` and
      // `JSON.parse` only ever throw errors, so a branch for anything else
      // could never be reached, let alone tested.
      [String(error)]
    );
  }
};

/**
 * Reads the `version` of a package manifest.
 *
 * The sailor records its own version in an installed project's manifest, so
 * the value has to come from the real package rather than from a constant that
 * would drift out of step with `package.json` on the next release.
 */
const GITHUB_SLUG_PATTERN = /github\.com[/:]([^/]+)\/([^/.]+)/;

/**
 * Reads the `owner/name` a package is published from.
 *
 * An installed project resolves the sailor from a GitHub release asset rather
 * than from the npm registry, so the slug has to come from the package itself:
 * a constant here would name the wrong repository the moment anyone forked it.
 */
export const readPackageRepository = (packageDirectory: string): string => {
  const manifest = readManifest(packageDirectory);
  const repository = isRecord(manifest) ? manifest.repository : undefined;
  const url = isRecord(repository) ? repository.url : repository;
  const match = typeof url === "string" ? GITHUB_SLUG_PATTERN.exec(url) : null;

  if (match === null) {
    throw new SailorError(
      "invalid-config",
      `${join(packageDirectory, "package.json")} does not declare a GitHub \`repository\` url, so the release to install from cannot be named`
    );
  }

  return `${String(match[1])}/${String(match[2])}`;
};

export const readPackageVersion = (packageDirectory: string): string => {
  const path = join(packageDirectory, "package.json");
  const parsed = readManifest(packageDirectory);
  const version = isRecord(parsed) ? parsed.version : undefined;

  if (typeof version !== "string") {
    throw new SailorError(
      "invalid-config",
      `${path} does not declare a string \`version\``
    );
  }

  return version;
};
