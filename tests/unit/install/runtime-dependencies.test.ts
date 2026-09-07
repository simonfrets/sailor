import { join } from "node:path";

import { SailorError } from "../../../src/sailor/sailor-error.js";
import {
  SAILOR_PACKAGE_NAME,
  RUNTIME_INSTALL_ARGV,
  RUNTIME_INSTALL_TIMEOUT_MS,
  RUNTIME_PACKAGE_NAME,
  buildRuntimePackageManifest,
  sailorReleaseTarballUrl,
  installRuntimeDependencies,
} from "../../../src/install/runtime-dependencies.js";
import { captureRejection } from "../../helpers/expect-error.js";
import {
  at,
  createFakeCommandRunner,
  exited,
  signaled,
  spawnFailed,
  timedOut,
} from "../../helpers/fake-command-runner.js";
import type { PlannedCommandResult } from "../../helpers/fake-command-runner.js";

const PROJECT_ROOT = join("/tmp", "host-project");

describe("buildRuntimePackageManifest", () => {
  const build = (sailorVersion = "1.2.3"): string =>
    buildRuntimePackageManifest({
      sailorVersion,
      repository: "an-owner/a-repo",
    });

  it("pins one exact GitHub release asset as the only dependency", () => {
    // The sailor is not published to npm, so the dependency is the tarball
    // `npm pack` produces, attached to the release for its version.
    const manifest: unknown = JSON.parse(build());

    expect(manifest).toEqual({
      name: RUNTIME_PACKAGE_NAME,
      version: "0.0.0",
      private: true,
      description:
        "Private dependency tree for the sailor installed in this project.",
      dependencies: {
        [SAILOR_PACKAGE_NAME]:
          "https://github.com/an-owner/a-repo/releases/download/v1.2.3/sailor-1.2.3.tgz",
      },
    });
  });

  it("names a tarball, not a git ref", () => {
    // A `github:owner/repo` dependency would make npm clone and build, and
    // this package does not commit its `dist/`, so there would be nothing to
    // install.
    expect(build()).toContain(".tgz");
    expect(build()).not.toContain("github:");
  });

  it("marks the tree private so it can never be published by accident", () => {
    expect(build()).toContain('"private": true');
  });

  it("writes formatted json with a trailing newline", () => {
    const text = build();

    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "name":');
  });
});

describe("sailorReleaseTarballUrl", () => {
  it("points at the asset name `npm pack` produces", () => {
    expect(sailorReleaseTarballUrl("owner/repo", "0.1.0")).toBe(
      "https://github.com/owner/repo/releases/download/v0.1.0/sailor-0.1.0.tgz"
    );
  });
});

describe("installRuntimeDependencies", () => {
  const install = async (
    respond: PlannedCommandResult,
    timeoutMs?: number
  ): Promise<ReturnType<typeof createFakeCommandRunner>> => {
    const runner = createFakeCommandRunner(respond);

    await installRuntimeDependencies({
      projectRoot: PROJECT_ROOT,
      runner: runner.run,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });

    return runner;
  };

  const refuse = async (respond: PlannedCommandResult): Promise<SailorError> =>
    captureRejection(
      () =>
        installRuntimeDependencies({
          projectRoot: PROJECT_ROOT,
          runner: createFakeCommandRunner(respond).run,
        }),
      SailorError
    );

  it("resolves the private tree with npm whatever the host project uses", async () => {
    const runner = await install(exited(0));

    expect(at(runner.requests, 0).command).toEqual({
      executable: "npm",
      args: ["install", "--no-audit", "--no-fund", "--omit=dev"],
    });
    expect([...RUNTIME_INSTALL_ARGV]).toEqual(
      at(runner.requests, 0).command.args
    );
  });

  it("runs inside .sailor so npm never reads the host manifest", async () => {
    const runner = await install(exited(0));

    expect(at(runner.requests, 0).cwd).toBe(join(PROJECT_ROOT, ".sailor"));
  });

  it("passes no environment overrides and the documented timeout", async () => {
    const runner = await install(exited(0));

    expect(at(runner.requests, 0).env).toBeNull();
    expect(at(runner.requests, 0).timeoutMs).toBe(RUNTIME_INSTALL_TIMEOUT_MS);
  });

  it("honours a caller-supplied timeout", async () => {
    const runner = await install(exited(0), 1_234);

    expect(at(runner.requests, 0).timeoutMs).toBe(1_234);
  });

  it("reports a failing install with the command and npm's own output", async () => {
    const error = await refuse(
      exited(1, { stderr: "npm error code E404\nnot found\n" })
    );

    expect(error.kind).toBe("dependency-install-failed");
    expect(error.message).toContain(
      "npm install --no-audit --no-fund --omit=dev"
    );
    expect(error.message).toContain("exited with code 1");
    expect(error.details).toEqual(["npm error code E404", "not found"]);
  });

  it("reports a failing install that said nothing without inventing detail", async () => {
    const error = await refuse(exited(7));

    expect(error.details).toEqual([]);
  });

  it("reports a timeout as a timeout rather than a non-zero exit", async () => {
    const error = await refuse(timedOut(600_000));

    expect(error.message).toContain("timed out after 600000ms");
  });

  it("reports a signalled install", async () => {
    const error = await refuse(signaled("SIGKILL"));

    expect(error.message).toContain("terminated by SIGKILL");
  });

  it("reports npm being absent as a dependency failure, not a crash", async () => {
    const error = await refuse(spawnFailed("ENOENT"));

    expect(error.kind).toBe("dependency-install-failed");
    expect(error.message).toContain("could not be started");
  });
});
