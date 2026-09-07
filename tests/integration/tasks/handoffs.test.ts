import { readdirSync } from "node:fs";
import { join } from "node:path";

import { BUILT_IN_AGENT_IDS } from "../../../src/agents/agent-id.js";
import type { AgentDefinition } from "../../../src/agents/agent-definition.js";
import { readAgentContext } from "../../../src/tasks/agent-context.js";
import { readTaskFile, requireTask } from "../../../src/tasks/task-file.js";
import type { Task } from "../../../src/tasks/task-schema.js";
import { removeTempDirectories } from "../../helpers/temp-directory.js";
import {
  RUN_ID,
  TASK_ID,
  buildWorkflowProject,
  driveWorkflow,
  shippedAgentDefinitions,
} from "../../helpers/workflow-driver.js";

afterEach(() => {
  removeTempDirectories();
});

const packageRoot = process.cwd();

const definitions = shippedAgentDefinitions(packageRoot);

const definitionOf = (id: string): AgentDefinition => {
  const definition = definitions.get(id);

  if (definition === undefined) {
    throw new Error(`the sailor ships no definition for ${id}`);
  }

  return definition;
};

const only = (root: string): Task => requireTask(readTaskFile(root), TASK_ID);

/** Runs the whole pipeline, one handoff and one write per stage. */
const runPipeline = async (): Promise<string> => {
  const root = buildWorkflowProject(packageRoot);

  await driveWorkflow({ packageRoot, projectRoot: root });

  return root;
};

const contextDirectory = (id: string): string =>
  `.sailor/state/runs/${RUN_ID}/agents/${id}`;

describe("agent contexts across a run", () => {
  it("gives each of the six shipped agents its own context and tool policy", async () => {
    const root = await runPipeline();
    const agentsDirectory = join(root, ".sailor/state/runs", RUN_ID, "agents");

    expect(readdirSync(agentsDirectory).sort()).toEqual([
      ...BUILT_IN_AGENT_IDS,
    ]);

    for (const id of BUILT_IN_AGENT_IDS) {
      const context = readAgentContext(root, contextDirectory(id));
      const definition = definitionOf(id);

      expect(context.agentId).toBe(id);
      expect(context.tools).toEqual(definition.tools);
      expect(context.writeScopes).toEqual(definition.writeScopes);
      expect(context.projectScripts).toEqual(definition.projectScripts);
      expect(context.policy).toContain(`# Agent policy: ${id}`);
    }
  });

  it("compiles a different set of rules into each agent's policy", async () => {
    const root = await runPipeline();

    const policyOf = (id: string): string =>
      readAgentContext(root, contextDirectory(id)).policy;

    // Asserting the six documents merely differ would pass on the heading
    // alone. `typescript.no-explicit-any` is shipped for the three agents that
    // write TypeScript and nobody else, so it is what separates the content.
    for (const id of ["coder", "cleaner", "hardener"]) {
      expect(policyOf(id)).toContain("typescript.no-explicit-any");
    }

    for (const id of ["architect", "qa", "specifier"]) {
      expect(policyOf(id)).not.toContain("typescript.no-explicit-any");
    }

    expect(new Set(BUILT_IN_AGENT_IDS.map(policyOf)).size).toBe(
      BUILT_IN_AGENT_IDS.length
    );
  });

  it("points each transition at the context the agent it handed to received", async () => {
    const root = await runPipeline();

    for (const record of only(root).history) {
      if (record.toAgent === null) {
        continue;
      }

      expect(record.contextPath).toBe(contextDirectory(record.toAgent));
      expect(readAgentContext(root, record.contextPath ?? "").agentId).toBe(
        record.toAgent
      );
      expect(
        readAgentContext(root, record.contextPath ?? "").ruleSetSha256
      ).toBe(record.ruleSetSha256);
    }
  });
});
