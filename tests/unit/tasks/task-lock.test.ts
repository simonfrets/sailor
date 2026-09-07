import {
  existsSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { lock } from "proper-lockfile";

import { SailorError } from "../../../src/sailor/sailor-error.js";
import { readTaskFile, taskFilePath } from "../../../src/tasks/task-file.js";
import {
  TASK_LOCK_DEFAULTS,
  taskLockRetryBudgetMs,
  taskLockStaleMs,
  withTaskLock,
} from "../../../src/tasks/task-lock.js";
import { updateTaskFile } from "../../../src/tasks/update-task-file.js";
import { captureRejection } from "../../helpers/expect-error.js";
import { buildSailorProject } from "../../helpers/sailor-project.js";
import { buildTask } from "../../helpers/tasks.js";
import {
  createTempDirectory,
  removeTempDirectories,
} from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const lockPath = (root: string): string =>
  join(root, ".sailor", "tasks.yaml.lock");

/** Takes the same filesystem lock a second sailor process would take. */
const holdTaskLock = (root: string): Promise<() => Promise<void>> =>
  lock(taskFilePath(root), { realpath: false, stale: 10_000 });

/**
 * Leaves behind the lock a sailor process killed mid-transition leaves.
 *
 * The directory is what `proper-lockfile` creates, and the mtime is what its
 * heartbeat would have been refreshing. Backdating it is how a holder that
 * died `ageMs` ago is expressed without waiting `ageMs` for it to happen.
 */
const abandonTaskLock = (root: string, ageMs: number): void => {
  mkdirSync(lockPath(root), { recursive: true });

  const when = (Date.now() - ageMs) / 1_000;

  utimesSync(lockPath(root), when, when);
};

describe("withTaskLock", () => {
  it("takes the lock before the task file it names exists", async () => {
    const root = buildSailorProject();

    expect(existsSync(taskFilePath(root))).toBe(false);

    await expect(withTaskLock(root, () => "ran")).resolves.toBe("ran");
    expect(existsSync(lockPath(root))).toBe(false);
  });

  it("refuses a project with no sailor rather than installing half of one", async () => {
    // `sailor init` creates `.sailor`; nothing else may. Creating it here to
    // give the lock somewhere to live would leave a directory holding task
    // state and no agents, rules or hooks behind every task call, against any
    // path the caller happened to pass.
    const root = createTempDirectory("sailor-uninstalled-");
    let ran = false;

    const error = await captureRejection(
      () =>
        withTaskLock(root, () => {
          ran = true;

          return "ran";
        }),
      SailorError
    );

    expect(error.kind).toBe("not-installed");
    expect(ran).toBe(false);
    expect(existsSync(join(root, ".sailor"))).toBe(false);
  });

  it("waits for a lock another process is holding", async () => {
    const root = buildSailorProject();
    const releaseOther = await holdTaskLock(root);
    const order: string[] = [];
    const pending = withTaskLock(root, () => {
      order.push("sailor ran");

      return "done";
    });

    await delay(150);
    order.push("other released");
    await releaseOther();

    await expect(pending).resolves.toBe("done");
    // Without mutual exclusion the sailor would have run first, immediately.
    expect(order).toEqual(["other released", "sailor ran"]);
  });

  it("reports a lock it cannot get rather than writing anyway", async () => {
    const root = buildSailorProject();
    const releaseOther = await holdTaskLock(root);
    let ran = false;
    const error = await captureRejection(
      () =>
        withTaskLock(
          root,
          () => {
            ran = true;

            return "done";
          },
          { staleMs: 10_000, retries: 0 }
        ),
      SailorError
    );

    expect(error.kind).toBe("task-lock-failed");
    expect(error.message).toContain("another process is holding the lock");
    expect(ran).toBe(false);
    await releaseOther();
  });

  it("names a failure that is not contention instead of blaming a process", async () => {
    // `.sailor` as a regular file makes the lock's own `mkdir` fail with
    // `ENOTDIR`. That stands for every cause that is not contention - `EACCES`
    // on a directory the process cannot write, `ENOSPC`, a parent that is not
    // a directory - and none of them is answered by waiting for anyone to let
    // go, which is what the one headline this reported used to tell an
    // operator to do.
    const root = createTempDirectory("sailor-unlockable-");
    let ran = false;

    writeFileSync(join(root, ".sailor"), "");

    const error = await captureRejection(
      () =>
        withTaskLock(
          root,
          () => {
            ran = true;

            return "ran";
          },
          { staleMs: 10_000, retries: 0 }
        ),
      SailorError
    );

    expect(error.kind).toBe("task-lock-failed");
    expect(error.message).not.toContain("another process is holding");
    expect(error.message).toContain("could not be taken");
    // The cause reaches the operator, and it is the real one.
    expect(error.message).toContain("ENOTDIR");
    expect(ran).toBe(false);
  });

  it("takes over a lock left behind by a process that died", async () => {
    // A killed sailor leaves the lock directory with nothing behind it: no
    // holder, no heartbeat, and only its age to say so. This is the case
    // `staleMs` exists for, and no test reached it before.
    //
    // The age is a fixed 1.5s rather than one derived from the window, which
    // is the point: derived, it would rescale with the window and pass at any
    // setting, including the shipped one it exists to reject.
    const root = buildSailorProject();

    abandonTaskLock(root, 1_500);

    const started = Date.now();

    await expect(withTaskLock(root, () => "ran")).resolves.toBe("ran");

    // It cannot have been taken over on the first attempt: the lock was 500ms
    // short of stale. So this is the retry loop outlasting the window rather
    // than the lock having been stale on arrival. With the window ten seconds
    // wide, as it was, the retries ran out seven seconds before the lock went
    // stale and this reported contention that nothing was causing.
    expect(Date.now() - started).toBeGreaterThan(400);
    expect(existsSync(lockPath(root))).toBe(false);
  });

  it("keeps retrying for longer than a lock stays honoured", () => {
    // The takeover above starts 500ms in. This is what makes it reachable
    // from any age at all, the worst case being a process killed the instant
    // before: an abandoned lock is only taken over by an attempt made after it
    // goes stale, so a budget that expires first reports `ELOCKED` for the
    // rest of the window - and `sailor gate pre-commit` exits non-zero on
    // that, blocking commits on a lock nobody is holding.
    expect(taskLockRetryBudgetMs(TASK_LOCK_DEFAULTS)).toBeGreaterThan(
      taskLockStaleMs(TASK_LOCK_DEFAULTS)
    );
  });

  it("releases the lock when the work throws", async () => {
    const root = buildSailorProject();

    await expect(
      withTaskLock(root, () => {
        throw new Error("the transition was rejected");
      })
    ).rejects.toThrow("the transition was rejected");

    expect(existsSync(lockPath(root))).toBe(false);
    await expect(withTaskLock(root, () => "ran again")).resolves.toBe(
      "ran again"
    );
  });

  it("reports a lock lost while it was held instead of crashing the process", async () => {
    // The library's default `onCompromised` throws from a timer callback,
    // which is an uncaught exception. The heartbeat is driven from `stale`,
    // so the shortest honest version of this test waits for one interval.
    const root = buildSailorProject();
    const error = await captureRejection(
      () =>
        withTaskLock(
          root,
          async () => {
            rmSync(lockPath(root), { force: true, recursive: true });
            await delay(1_800);

            return "done";
          },
          { staleMs: 2_000, retries: 0 }
        ),
      SailorError
    );

    expect(error.kind).toBe("task-lock-failed");
    expect(error.message).toContain("was lost while the sailor held it");
  });
});

describe("updateTaskFile", () => {
  it("writes what the mutator returned", async () => {
    const root = buildSailorProject();

    await updateTaskFile(root, (file) => ({
      ...file,
      tasks: [...file.tasks, buildTask()],
    }));

    expect(readTaskFile(root).tasks).toHaveLength(1);
  });

  it("serialises overlapping updates instead of losing one", async () => {
    const root = buildSailorProject();
    // The mutator yields between the read and the write, which is exactly what
    // a real one does when it writes the next agent's context. Without the
    // lock both would read an empty file and the second would overwrite the
    // first, leaving one task instead of two.
    const append = (id: string): Promise<unknown> =>
      updateTaskFile(root, async (file) => {
        await delay(20);

        return { ...file, tasks: [...file.tasks, buildTask({ id })] };
      });

    await Promise.all([append("first"), append("second")]);

    expect(
      readTaskFile(root)
        .tasks.map((task) => task.id)
        .sort()
    ).toEqual(["first", "second"]);
  });

  it("leaves the file untouched when the mutator rejects the change", async () => {
    const root = buildSailorProject();

    await expect(
      updateTaskFile(root, () => {
        throw new SailorError("stale-task-revision", "expected revision 4");
      })
    ).rejects.toThrow("expected revision 4");

    expect(existsSync(taskFilePath(root))).toBe(false);
  });
});
