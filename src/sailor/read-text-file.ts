import { readFileSync } from "node:fs";

/**
 * Reads a file, or reports that it is not there.
 *
 * "Absent" and "unreadable" are deliberately the same answer. Every caller here
 * is asking whether a project has a file at all, and a caller that distinguished
 * the two would have to decide what to do about a permission error in the
 * middle of a plan, which is not a decision any of them is placed to make.
 */
export const readTextFileIfPresent = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};
