import { isAbsolute, posix, relative, resolve, sep } from "node:path";

import { projectRelativePathSchema } from "../sailor/project-path.js";

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g;

/**
 * One path segment of a scope as a regular expression.
 *
 * `*` and `?` never cross a `/`, and a run of stars that is not a segment on
 * its own is a plain `*`, which is how `minimatch` reads `src/**.ts` as well.
 * Everything else is literal: a scope is written by hand into an agent
 * definition, and a dot or a plus in it names a dot or a plus.
 */
const segmentPattern = (segment: string): RegExp =>
  new RegExp(
    `^${segment
      .split(/(\*+|\?)/)
      .map((part) => {
        if (part === "?") {
          return "[^/]";
        }

        if (/^\*+$/.test(part)) {
          return "[^/]*";
        }

        return part.replace(REGEX_SPECIAL, "\\$&");
      })
      .join("")}$`
  );

const matchSegments = (
  pattern: readonly string[],
  path: readonly string[]
): boolean => {
  const [head, ...rest] = pattern;

  if (head === undefined) {
    return path.length === 0;
  }

  if (head === "**") {
    // `**` spans any number of directories, including none: `**/*.ts` names
    // `a.ts`. At the end of a scope it must span at least one segment, so that
    // `src/**` names the files under `src` and not a file called `src`.
    const minimum = rest.length === 0 ? 1 : 0;

    for (let skip = minimum; skip <= path.length; skip += 1) {
      if (matchSegments(rest, path.slice(skip))) {
        return true;
      }
    }

    return false;
  }

  const [first, ...remaining] = path;

  if (first === undefined) {
    return false;
  }

  return segmentPattern(head).test(first) && matchSegments(rest, remaining);
};

/**
 * Whether a project-relative path falls under a write scope.
 *
 * The matcher is written here rather than taken from a glob library because
 * `projectRelativeGlobSchema` has already reduced a scope to `*`, `**` and `?`:
 * the constructs a library exists to implement are the ones a scope may not
 * contain, and a dependency whose behaviour has to be fenced off is a worse
 * statement of the rule than forty lines that implement exactly it.
 *
 * Dotfiles match. A scope names a subtree, and a file under it is under it
 * whatever its name starts with; an agent that may write `src/**` may write
 * `src/.eslintrc`, and a matcher that said otherwise would be quietly narrower
 * than the definition it enforces.
 */
export const globMatches = (pattern: string, path: string): boolean =>
  matchSegments(pattern.split("/"), path.split("/"));

/**
 * The first scope a path falls under, or `null` when it falls under none.
 *
 * A path that is not inside the project is under no scope at all, whatever
 * the scopes say - `**` grants the whole project, not the machine. That is
 * checked here rather than left to the matcher because the matcher compares
 * strings, and `../outside.txt` is a string `**` happily matches.
 */
export const matchingWriteScope = (
  scopes: readonly string[],
  path: string
): string | null => {
  if (!projectRelativePathSchema.safeParse(path).success) {
    return null;
  }

  return scopes.find((scope) => globMatches(scope, path)) ?? null;
};

/**
 * Turns a path an agent named into the project-relative form the policy is
 * written in, or `null` when the path is not inside the project.
 *
 * A provider reports the path the agent used, which may be absolute or
 * relative to the project root, may contain `.` and `..` segments, and may
 * point anywhere. It is resolved and then re-expressed from the root, which
 * is the one operation that cannot be fooled by a sibling directory sharing
 * the root's name as a prefix. The root itself is not a file inside the
 * project, so it resolves to `null` too.
 */
export const toProjectRelativePath = (
  projectRoot: string,
  path: string
): string | null => {
  const root = resolve(projectRoot);
  const relativePath = relative(root, resolve(root, path));

  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }

  return relativePath.split(sep).join(posix.sep);
};
