import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stringify } from "yaml";

import { SailorError } from "../../../src/sailor/sailor-error.js";
import {
  TASK_FILE_SOURCE,
  emptyTaskFile,
  findTask,
  readTaskFile,
  requireTask,
  taskFilePath,
  writeTaskFile,
} from "../../../src/tasks/task-file.js";
import { captureError } from "../../helpers/expect-error.js";
import { buildSailorProject } from "../../helpers/sailor-project.js";
import { buildTask, buildTaskFile } from "../../helpers/tasks.js";
import {
  createTempDirectory,
  removeTempDirectories,
} from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

describe("taskFilePath", () => {
  it("puts task state inside the sailor directory, not under state/", () => {
    // `state/` is gitignored. Task state is deliberately reviewable, so it
    // lives beside the rules rather than with the transcripts.
    expect(taskFilePath("/tmp/project")).toBe(
      join("/tmp/project", ".sailor", "tasks.yaml")
    );
    expect(TASK_FILE_SOURCE).toBe(".sailor/tasks.yaml");
  });
});

describe("readTaskFile", () => {
  it("reads a project that has never run a task as having none", () => {
    expect(readTaskFile(buildSailorProject())).toEqual({
      version: 1,
      tasks: [],
    });
  });

  it("never hands two callers the same tasks array", () => {
    const root = buildSailorProject();
    const first = readTaskFile(root);

    first.tasks.push(buildTask());

    expect(readTaskFile(root).tasks).toEqual([]);
  });

  it("round-trips a task file through the filesystem", () => {
    const root = buildSailorProject();
    const file = buildTaskFile(
      buildTask({
        state: "implementing",
        revision: 4,
        agentId: "coder",
        approvedAt: "2026-08-27T00:02:00.000Z",
        approvedBy: "a-reviewer",
        contextPath: ".sailor/state/runs/run-1/agents/coder",
      })
    );

    writeTaskFile(root, file);

    expect(readTaskFile(root)).toEqual(file);
  });

  it("reports the file and the line when the yaml is broken", () => {
    const root = buildSailorProject({
      files: { ".sailor/tasks.yaml": "version: 1\ntasks:\n  - id: [\n" },
    });
    const error = captureError(() => readTaskFile(root), SailorError);

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain(".sailor/tasks.yaml");
  });

  it("refuses a task interrupted in a state no work happens in", () => {
    // `tasks.yaml` is committed on purpose, so a hand edit or a merge conflict
    // is all it takes to write this. Recovery is computed as the stages up to
    // and including the one named here, so `completed` would open the entire
    // pipeline and let a task reach done without entering `implementing` or
    // `qa`.
    const root = buildSailorProject({
      files: {
        ".sailor/tasks.yaml": stringify({
          version: 1,
          tasks: [
            buildTask({
              state: "blocked",
              interruptedFrom: "completed" as "qa",
            }),
          ],
        }),
      },
    });
    const error = captureError(() => readTaskFile(root), SailorError);

    expect(error.kind).toBe("invalid-config");
    expect(error.details.join("\n")).toContain("interruptedFrom");
  });

  it("refuses task state that does not validate", () => {
    const root = buildSailorProject({
      files: {
        ".sailor/tasks.yaml": "version: 1\ntasks:\n  - id: add-login\n",
      },
    });
    const error = captureError(() => readTaskFile(root), SailorError);

    expect(error.kind).toBe("invalid-config");
    expect(error.details.join("\n")).toContain("title");
  });
});

describe("writeTaskFile", () => {
  it("writes yaml a person can read in a pull request", () => {
    const root = buildSailorProject();

    writeTaskFile(root, buildTaskFile(buildTask()));

    const text = readFileSync(join(root, ".sailor", "tasks.yaml"), "utf8");

    expect(text).toContain("# Managed by Sailor");
    expect(text).toContain("version: 1");
    expect(text).toContain("  - id: add-login");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("writes an empty file into a project that has the sailor installed", () => {
    // The name this carried claimed it covered an uninstalled project, while
    // `buildSailorProject()` creates `.sailor/` before it runs. The case it
    // claimed is below, and it is not the behaviour the name implied.
    const root = buildSailorProject();

    writeTaskFile(root, emptyTaskFile());

    expect(readFileSync(join(root, ".sailor", "tasks.yaml"), "utf8")).toContain(
      "tasks: []"
    );
  });

  it("creates `.sailor/` in a project that has none, unlike the lock", () => {
    // Documenting a real asymmetry rather than asserting it is correct.
    // `withTaskLock` refuses a project with no sailor installed, on the
    // reasoning that a directory holding task state and no agents, rules or
    // hooks is not one anybody asked for. This primitive sits a layer below
    // that guard and still creates it, so reaching for `writeTaskFile`
    // directly bypasses the refusal. Anything that changes here should change
    // deliberately, and the two layers should agree.
    const root = createTempDirectory("sailor-uninstalled-");

    expect(existsSync(join(root, ".sailor"))).toBe(false);

    writeTaskFile(root, emptyTaskFile());

    expect(existsSync(join(root, ".sailor", "tasks.yaml"))).toBe(true);
  });

  it("refuses to write state that could not be read back", () => {
    const root = buildSailorProject();
    const error = captureError(() => {
      writeTaskFile(root, buildTaskFile(buildTask(), buildTask()));
    }, SailorError);

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain(".sailor/tasks.yaml");
    expect(error.details.join("\n")).toContain("more than once");
  });

  it("does not fold a long title into a shape the diff cannot show", () => {
    const root = buildSailorProject();
    const title = `Rework ${"the authentication flow ".repeat(6)}end to end`;

    writeTaskFile(root, buildTaskFile(buildTask({ title })));

    const text = readFileSync(join(root, ".sailor", "tasks.yaml"), "utf8");

    expect(text).toContain(`title: ${title}`);
    expect(readTaskFile(root).tasks[0]?.title).toBe(title);
  });
});

describe("findTask", () => {
  it("returns null for a task the file does not carry", () => {
    expect(findTask(buildTaskFile(buildTask()), "other")).toBeNull();
  });

  it("returns the task with the requested id", () => {
    const task = buildTask({ id: "other" });

    expect(findTask(buildTaskFile(buildTask(), task), "other")).toEqual(task);
  });
});

describe("requireTask", () => {
  it("names the task and what the file does hold", () => {
    const error = captureError(
      () => requireTask(buildTaskFile(buildTask()), "other"),
      SailorError
    );

    expect(error.kind).toBe("unknown-task");
    expect(error.message).toContain("other");
    expect(error.details.join("\n")).toContain("add-login");
  });
});
