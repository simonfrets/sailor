import { SailorError } from "../../../src/sailor/sailor-error.js";
import { resolveProjectRoot } from "../../../src/sailor/resolve-project-root.js";
import { captureRejection } from "../../helpers/expect-error.js";
import {
  at,
  createFakeCommandRunner,
  exited,
  spawnFailed,
} from "../../helpers/fake-command-runner.js";

describe("resolveProjectRoot", () => {
  it("asks git for the working tree root", async () => {
    const runner = createFakeCommandRunner(
      exited(0, { stdout: "/tmp/project\n" })
    );

    await expect(
      resolveProjectRoot({ cwd: "/tmp/project/src", runner: runner.run })
    ).resolves.toBe("/tmp/project");

    const request = at(runner.requests, 0);

    expect(request.command).toEqual({
      executable: "git",
      args: ["rev-parse", "--show-toplevel"],
    });
    expect(request.cwd).toBe("/tmp/project/src");
  });

  it("refuses a directory that is not inside a git repository", async () => {
    const runner = createFakeCommandRunner(
      exited(128, { stderr: "fatal: not a git repository\n" })
    );

    const error = await captureRejection(
      () => resolveProjectRoot({ cwd: "/tmp/loose", runner: runner.run }),
      SailorError
    );

    expect(error.kind).toBe("not-a-git-repository");
    expect(error.message).toContain("fatal: not a git repository");
  });

  it("refuses when git reports success but names no directory", async () => {
    const runner = createFakeCommandRunner(exited(0, { stdout: "  \n" }));

    await expect(
      resolveProjectRoot({ cwd: "/tmp/loose", runner: runner.run })
    ).rejects.toThrow(/named no working tree root/);
  });

  it("reports a git binary that cannot be started", async () => {
    const runner = createFakeCommandRunner(spawnFailed("ENOENT"));

    await expect(
      resolveProjectRoot({ cwd: "/tmp/loose", runner: runner.run })
    ).rejects.toThrow(/could not be started/);
  });
});
