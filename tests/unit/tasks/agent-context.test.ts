import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { AgentDefinition } from "../../../src/agents/agent-definition.js";
import { SailorError } from "../../../src/sailor/sailor-error.js";
import {
  AGENT_CONTEXT_FILE,
  agentContextDirectory,
  agentContextFile,
  buildAgentContext,
  readAgentContext,
  writeAgentContext,
} from "../../../src/tasks/agent-context.js";
import { captureError } from "../../helpers/expect-error.js";
import { buildSailorProject } from "../../helpers/sailor-project.js";
import { RULE_SET_SHA256, buildTask } from "../../helpers/tasks.js";
import { removeTempDirectories } from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const AT = new Date("2026-08-27T10:00:00.000Z");

const definition = (
  id: string,
  overrides: Partial<AgentDefinition> = {}
): AgentDefinition => ({
  version: 1,
  id,
  displayName: id,
  summary: `The ${id}`,
  modelProfile: "coding-high",
  tools: { read: true, search: true, edit: false, execute: false },
  writeScopes: [],
  projectScripts: [],
  ...overrides,
});

const context = (
  agent: AgentDefinition,
  overrides: Partial<Parameters<typeof buildAgentContext>[0]> = {}
) =>
  buildAgentContext({
    task: buildTask({ state: "implementing", revision: 6 }),
    definition: agent,
    policy: `# Agent policy: ${agent.id}\n`,
    ruleSetSha256: RULE_SET_SHA256,
    at: AT,
    attempt: 1,
    ...overrides,
  });

describe("agentContextDirectory", () => {
  it("gives every agent in every run its own directory", () => {
    expect(agentContextDirectory("run-1", "coder")).toBe(
      ".sailor/state/runs/run-1/agents/coder"
    );
    expect(agentContextDirectory("run-1", "cleaner")).not.toBe(
      agentContextDirectory("run-1", "coder")
    );
    expect(agentContextDirectory("run-2", "coder")).not.toBe(
      agentContextDirectory("run-1", "coder")
    );
    expect(agentContextFile("run-1", "coder")).toBe(
      ".sailor/state/runs/run-1/agents/coder/context.json"
    );
  });

  it("stays inside the ignored state directory", () => {
    // Contexts are transcripts of a run, not reviewable project state.
    expect(
      agentContextDirectory("run-1", "qa").startsWith(".sailor/state/")
    ).toBe(true);
  });
});

describe("buildAgentContext", () => {
  it("takes each agent's capabilities from that agent's own definition", () => {
    const coder = context(
      definition("coder", {
        tools: { read: true, search: true, edit: true, execute: true },
        writeScopes: ["src/**", "tests/**"],
        projectScripts: ["lint", "test"],
      })
    );
    const architect = context(definition("architect"));

    expect(coder.tools).toEqual({
      read: true,
      search: true,
      edit: true,
      execute: true,
    });
    expect(coder.writeScopes).toEqual(["src/**", "tests/**"]);
    expect(architect.tools.edit).toBe(false);
    expect(architect.writeScopes).toEqual([]);
  });

  it("copies the capabilities rather than aliasing the definition", () => {
    const agent = definition("coder", {
      tools: { read: true, search: true, edit: true, execute: true },
      writeScopes: ["src/**"],
      projectScripts: ["test"],
    });
    const built = context(agent);

    agent.writeScopes.push("/etc");
    (agent.tools as { edit: boolean }).edit = false;

    expect(built.writeScopes).toEqual(["src/**"]);
    expect(built.tools.edit).toBe(true);
  });

  it("refuses a write scope that leaves the project", () => {
    // A definition reaching this from anywhere but `loadAgentDefinition` -
    // a hand-built one, or a schema that changes under it - must not be able
    // to put a scope outside the project into a context, because the context
    // is what a runtime enforces against.
    const error = captureError(
      () =>
        context(
          definition("coder", {
            tools: { read: true, search: true, edit: true, execute: true },
            writeScopes: ["/etc/**"],
            projectScripts: ["test"],
          })
        ),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.details.join("\n")).toContain("writeScopes");
  });

  it("carries the rule-set hash the handoff was made under", () => {
    expect(context(definition("coder")).ruleSetSha256).toBe(RULE_SET_SHA256);
  });

  it("refuses to build a context it could not write back", () => {
    const error = captureError(
      () => context(definition("coder"), { policy: "" }),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.details.join("\n")).toContain("policy");
  });
});

describe("writeAgentContext", () => {
  it("writes into the directory the context itself names", () => {
    const root = buildSailorProject();
    const path = writeAgentContext(root, context(definition("coder")));

    expect(path).toBe(".sailor/state/runs/run-1/agents/coder");
    expect(
      JSON.parse(
        readFileSync(join(root, path, AGENT_CONTEXT_FILE), "utf8")
      ) as { agentId: string }
    ).toMatchObject({ agentId: "coder" });
  });

  it("leaves one agent's context untouched when the next is written", () => {
    const root = buildSailorProject();
    const coderPath = writeAgentContext(root, context(definition("coder")));

    const before = readFileSync(
      join(root, coderPath, AGENT_CONTEXT_FILE),
      "utf8"
    );

    writeAgentContext(root, context(definition("cleaner")));

    expect(
      readFileSync(join(root, coderPath, AGENT_CONTEXT_FILE), "utf8")
    ).toBe(before);
  });

  it("keeps two attempts of one agent apart by run", () => {
    const root = buildSailorProject();
    const first = writeAgentContext(root, context(definition("coder")));
    const second = writeAgentContext(
      root,
      context(definition("coder"), {
        task: buildTask({ runId: "run-2", state: "implementing", revision: 9 }),
      })
    );

    expect(second).not.toBe(first);
    expect(readAgentContext(root, first).taskRevision).toBe(6);
    expect(readAgentContext(root, second).taskRevision).toBe(9);
  });

  it("writes a context that is readable but not executable", () => {
    const root = buildSailorProject();
    const path = writeAgentContext(root, context(definition("coder")));

    expect(statSync(join(root, path, AGENT_CONTEXT_FILE)).mode & 0o777).toBe(
      0o644
    );
  });
});

describe("readAgentContext", () => {
  it.each([
    ["a parent segment", "../outside-context"],
    ["a parent segment after a valid prefix", ".sailor/../../outside"],
    ["an absolute path", "/etc"],
  ])("refuses a context path that leaves the project: %s", (_label, path) => {
    // A context says which files an agent may write, so loading one from
    // outside the project is how a hand-edited `tasks.yaml` would hand an
    // agent write scopes nobody in this repository chose. `writeAgentContext`
    // cannot reach here - it builds its path from validated identifiers - but
    // `readAgentContext` is a public export taking a string from its caller.
    const error = captureError(
      () => readAgentContext(buildSailorProject(), path),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("inside this project");
  });

  it("round-trips what was written", () => {
    const root = buildSailorProject();
    const written = context(definition("coder"), {
      handoff: {
        fromAgent: "specifier",
        fromState: "awaiting_approval",
        gateReportIds: ["report-1"],
        artifactPaths: [".sailor/state/runs/run-1/agents/specifier/spec.md"],
        failure: null,
      },
    });

    expect(readAgentContext(root, writeAgentContext(root, written))).toEqual(
      written
    );
  });

  it("hands every reader its own copy, and refuses to let it be changed", () => {
    const root = buildSailorProject();
    const path = writeAgentContext(root, context(definition("coder")));
    const first = readAgentContext(root, path);
    const second = readAgentContext(root, path);

    expect(first).not.toBe(second);
    expect(first.tools).not.toBe(second.tools);
    expect(() => {
      first.policy = "do whatever you like";
    }).toThrow(TypeError);
    expect(() => {
      first.writeScopes.push("/etc");
    }).toThrow(TypeError);
    expect(readAgentContext(root, path).policy).toBe(first.policy);
  });

  it("reports a context this machine never wrote as missing, not as broken", () => {
    // Contexts live under the ignored `state/` tree, so a checkout of a
    // project mid-run carries the path out of `tasks.yaml` and none of the
    // files it names. A resumed run has to build the one it needs, which it
    // can only decide to do if absence is distinguishable from damage.
    const root = buildSailorProject();
    const error = captureError(
      () => readAgentContext(root, agentContextDirectory("run-1", "coder")),
      SailorError
    );

    expect(error.kind).toBe("missing-context");
    expect(error.message).toContain("run-1/agents/coder");
    expect(error.details.join("\n")).toContain(".sailor/tasks.yaml");
  });

  it("reports a context file that is json but not a context", () => {
    const root = buildSailorProject({
      files: {
        ".sailor/state/runs/run-1/agents/coder/context.json": '{"version":1}',
      },
    });
    const error = captureError(
      () => readAgentContext(root, agentContextDirectory("run-1", "coder")),
      SailorError
    );

    expect(error.kind).toBe("invalid-config");
    expect(error.message).toContain("is not a valid agent context");
  });
});
