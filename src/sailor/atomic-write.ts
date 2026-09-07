import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * Writes a file by creating a temporary sibling and renaming it into place.
 *
 * `rename` within one filesystem is atomic, so a reader never sees a partially
 * written managed file, and an interrupted install leaves the previous version
 * intact rather than a truncated one. The temporary lives in the destination
 * directory because a rename across filesystems is a copy, which is not atomic.
 *
 * The content is flushed with `fsync` before the rename, which is what
 * `write-file-atomic` does and for the same reason: the rename publishes the
 * new content, and a file renamed into place while its blocks are still only
 * in the page cache can come back empty after a crash. `tasks.yaml` is written
 * continuously by a running workflow, so that is the difference between losing
 * an install and losing the record of what has already been done.
 *
 * The mode is applied with `chmod` rather than left to `writeFileSync`, whose
 * `mode` is masked by the process umask — an executable hook that came out
 * non-executable would fail only later, from git.
 */
export const writeFileAtomic = (
  path: string,
  contents: string,
  mode: number
): void => {
  const directory = dirname(path);

  mkdirSync(directory, { recursive: true });

  const temporary = join(directory, `.sailor-${randomUUID()}.tmp`);

  try {
    const handle = openSync(temporary, "w");

    try {
      writeFileSync(handle, contents);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }

    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error: unknown) {
    rmSync(temporary, { force: true });

    throw error;
  }
};
