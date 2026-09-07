import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  LAUNCHER_PATH,
  buildSailorLauncher,
  buildHookDispatcher,
  escapeForDoubleQuotes,
  hookScriptPath,
} from "../../../src/install/hook-scripts.js";
import type { HookDispatcher } from "../../../src/install/hook-scripts.js";
import {
  createTempDirectory,
  removeTempDirectories,
} from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

/** Parses a script the way `npm run lint:shell` parses the tracked ones. */
const parses = (script: string): boolean => {
  const directory = createTempDirectory("sailor-hook-script-");
  const path = join(directory, "script");

  writeFileSync(path, script);

  return spawnSync("bash", ["-n", path], { encoding: "utf8" }).status === 0;
};

describe("buildSailorLauncher", () => {
  it("runs the CLI out of the project's own dependency tree", () => {
    expect(buildSailorLauncher()).toContain('exec node "${entry}" "$@"');
    expect(buildSailorLauncher()).toContain(
      "node_modules/sailor/dist/cli/index.js"
    );
  });

  it("reports a missing runtime with the configuration exit code", () => {
    const script = buildSailorLauncher();

    expect(script).toContain('if [ ! -f "${entry}" ]; then');
    expect(script).toContain("exit 3");
  });

  it("stops on the first failure rather than continuing", () => {
    expect(buildSailorLauncher()).toContain("set -euo pipefail");
  });

  it("parses as bash", () => {
    expect(parses(buildSailorLauncher())).toBe(true);
  });
});

describe("buildHookDispatcher", () => {
  const gate = (
    overrides: Partial<Extract<HookDispatcher, { kind: "gate" }>> = {}
  ): string =>
    buildHookDispatcher({
      kind: "gate",
      hook: "pre-commit",
      phase: "pre-commit",
      chained: null,
      ...overrides,
    });

  it("runs the gate for its phase through the project launcher", () => {
    expect(gate()).toContain(
      `exec "\${sailor_directory}/${LAUNCHER_PATH}" gate pre-commit`
    );
  });

  it("names the hook it dispatches so the file explains itself", () => {
    expect(gate({ hook: "pre-push", phase: "pre-push" })).toContain(
      "# The pre-push dispatcher. Managed by Sailor"
    );
  });

  it("runs no previous hook when the project had none", () => {
    expect(gate()).not.toContain("previous_hook");
  });

  it("re-joins a project-relative previous hook at run time", () => {
    // Baked in absolute, the dispatcher would be a file that only worked on
    // the machine it was generated on, yet it is committed with the project.
    expect(gate({ chained: ".git/hooks/pre-commit" })).toContain(
      'previous_hook="${repository_root}/.git/hooks/pre-commit"'
    );
  });

  it("keeps an absolute previous hook absolute", () => {
    expect(gate({ chained: "/opt/hooks/pre-commit" })).toContain(
      'previous_hook="/opt/hooks/pre-commit"'
    );
  });

  it("runs the previous hook before the gate, with the same arguments", () => {
    const script = gate({ chained: ".husky/pre-commit" });
    const previous = script.indexOf('"${previous_hook}" "$@"');
    const sailorGate = script.indexOf("gate pre-commit");

    expect(previous).toBeGreaterThan(-1);
    expect(sailorGate).toBeGreaterThan(previous);
  });

  it("does not exec the previous hook, so the gate still runs after it", () => {
    expect(gate({ chained: ".husky/pre-commit" })).toContain(
      '\n  "${previous_hook}" "$@"\n'
    );
  });

  it("hands a hook it has no gate for straight to the original", () => {
    const script = buildHookDispatcher({
      kind: "passthrough",
      hook: "commit-msg",
      chained: ".git/hooks/commit-msg",
    });

    expect(script).toContain('exec "${previous_hook}" "$@"');
    expect(script).not.toContain(LAUNCHER_PATH);
  });

  it("parses as bash in every shape", () => {
    expect(parses(gate())).toBe(true);
    expect(parses(gate({ chained: ".git/hooks/pre-commit" }))).toBe(true);
    expect(parses(gate({ chained: "/opt/hooks/pre-commit" }))).toBe(true);
    expect(
      parses(
        buildHookDispatcher({
          kind: "passthrough",
          hook: "commit-msg",
          chained: ".git/hooks/commit-msg",
        })
      )
    ).toBe(true);
  });

  it("keeps a hostile directory name inert", () => {
    const script = gate({ chained: '.git/hooks/$(touch pwned)`x`"' });

    expect(script).toContain(
      'previous_hook="${repository_root}/.git/hooks/\\$(touch pwned)\\`x\\`\\""'
    );
    expect(parses(script)).toBe(true);
  });
});

describe("escapeForDoubleQuotes", () => {
  it("escapes every character a double-quoted shell string still expands", () => {
    expect(escapeForDoubleQuotes('a\\b"c$d`e')).toBe('a\\\\b\\"c\\$d\\`e');
  });

  it("leaves an ordinary path alone", () => {
    expect(escapeForDoubleQuotes(".git/hooks/pre-commit")).toBe(
      ".git/hooks/pre-commit"
    );
  });
});

describe("hookScriptPath", () => {
  it("places a dispatcher in the managed hooks directory", () => {
    expect(hookScriptPath("pre-commit")).toBe("hooks/pre-commit");
  });
});
