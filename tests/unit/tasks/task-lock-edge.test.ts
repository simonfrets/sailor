import { lock } from "proper-lockfile";

import { SailorError } from "../../../src/sailor/sailor-error.js";
import { withTaskLock } from "../../../src/tasks/task-lock.js";
import { captureRejection } from "../../helpers/expect-error.js";
import { buildSailorProject } from "../../helpers/sailor-project.js";
import { removeTempDirectories } from "../../helpers/temp-directory.js";

jest.mock("proper-lockfile", () => ({ lock: jest.fn() }));

const lockMock = jest.mocked(lock);

afterEach(() => {
  removeTempDirectories();
});

/**
 * Every failure `proper-lockfile` produces itself carries a `code`: `ELOCKED`
 * for contention, and the filesystem's own code for anything else. A rejection
 * with no code at all is what would reach the sailor from something the
 * library does not control - a broken installation of it, or a caller handing
 * it options its own retry layer throws on - so this is the defensive branch of
 * the headline choice rather than a state a real lock can be driven into.
 *
 * It defaults away from contention on purpose. Contention is the one failure
 * that tells an operator to wait, and telling them to wait for a cause nothing
 * identified is worse than saying the lock could not be taken.
 */
describe("withTaskLock", () => {
  it("does not claim contention for a failure that carries no code", async () => {
    const root = buildSailorProject();
    let ran = false;

    lockMock.mockRejectedValue(new Error("the lock module went wrong"));

    const error = await captureRejection(
      () =>
        withTaskLock(root, () => {
          ran = true;

          return "ran";
        }),
      SailorError
    );

    expect(error.kind).toBe("task-lock-failed");
    expect(error.message).not.toContain("another process is holding");
    expect(error.message).toContain("could not be taken");
    expect(error.message).toContain("the lock module went wrong");
    expect(ran).toBe(false);
  });
});
