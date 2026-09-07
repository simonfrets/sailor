import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { parse } from "yaml";

import { loadAgentDefinition } from "../../../src/agents/agent-definition.js";
import type { AgentDefinition } from "../../../src/agents/agent-definition.js";
import { BUILT_IN_AGENT_IDS } from "../../../src/agents/agent-id.js";
import { loadHooksConfig } from "../../../src/config/hooks-config.js";
import { loadProjectConfig } from "../../../src/config/project-config.js";
import {
  listSailorTemplateFiles,
  readSailorTemplateFile,
} from "../../../src/install/sailor-templates.js";
import { HOOK_NAMES } from "../../../src/project/project-profile-schema.js";
import { compileAgentPolicy } from "../../../src/prompts/compile-agent-policy.js";
import { loadRuleBundle } from "../../../src/rules/load-rule-bundle.js";
import { resolveRuleSet } from "../../../src/rules/resolve-rule-set.js";
import type { RuleSource } from "../../../src/rules/resolve-rule-set.js";
import type { Rule } from "../../../src/rules/rule-schema.js";
import { initRepository, runGit } from "../../helpers/git.js";
import {
  createTempDirectory,
  removeTempDirectories,
} from "../../helpers/temp-directory.js";

afterEach(() => {
  removeTempDirectories();
});

const packageRoot = process.cwd();

const ruleBundleFiles = listSailorTemplateFiles(packageRoot).filter((file) =>
  /^rules\/[^/]+\.yaml$/.test(file.installedPath)
);

const sources: readonly RuleSource[] = ruleBundleFiles.map((file) => ({
  origin: "builtin" as const,
  location: file.installedPath,
  bundle: loadRuleBundle(
    readSailorTemplateFile(packageRoot, file.templatePath),
    {
      source: file.installedPath,
    }
  ),
}));

const allRules: readonly Rule[] = sources.flatMap(
  (source) => source.bundle.rules
);

describe("shipped rule bundles", () => {
  it("ships the three documented bundles", () => {
    expect(ruleBundleFiles.map((file) => file.installedPath)).toEqual([
      "rules/base.yaml",
      "rules/git.yaml",
      "rules/typescript.yaml",
    ]);
  });

  it("resolves into one rule set with no duplicate ids", () => {
    const ruleSet = resolveRuleSet(sources);

    expect(ruleSet.rules).toHaveLength(allRules.length);
    expect(ruleSet.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("targets only the six built-in agents", () => {
    // Membership alone let a seventh id be added without failing, and an empty
    // rule list made the whole loop vacuous.
    expect(BUILT_IN_AGENT_IDS).toHaveLength(6);
    expect(allRules.length).toBeGreaterThan(0);

    for (const rule of allRules) {
      expect(rule.appliesTo.length).toBeGreaterThan(0);
      for (const agent of rule.appliesTo) {
        expect(BUILT_IN_AGENT_IDS).toContain(agent);
      }
    }
  });

  it("gives every rule an instruction an agent can act on", () => {
    for (const rule of allRules) {
      expect(rule.instruction.trim().length).toBeGreaterThan(80);
      expect(rule.instruction).not.toMatch(/TODO|TBD|placeholder|FIXME/i);
    }
  });

  it("never runs a project script that rewrites the working tree", () => {
    // `format` is `--write` in most projects, and a gate that edits files
    // while a commit is being prepared would change what is committed.
    const scripts = allRules.flatMap((rule) =>
      rule.checks.flatMap((check) =>
        check.runner === "project-script" ? [check.script] : []
      )
    );

    expect(scripts).not.toContain("format");
    expect(scripts).toEqual(
      expect.arrayContaining(["test", "build", "lint", "typecheck"])
    );
  });

  it("runs only git as an explicit command check", () => {
    const argvs = allRules.flatMap((rule) =>
      rule.checks.flatMap((check) =>
        check.runner === "command" ? [check.argv] : []
      )
    );

    expect(argvs).toHaveLength(1);
    for (const argv of argvs) {
      expect(argv[0]).toBe("git");
      expect(argv.join(" ")).not.toMatch(/[|;&$`><]/);
    }
  });

  it("compiles into a policy for every built-in agent", () => {
    const ruleSet = resolveRuleSet(sources);

    for (const agentId of BUILT_IN_AGENT_IDS) {
      const policy = compileAgentPolicy({ agentId, ruleSet });

      expect(policy).toContain(`# Agent policy: ${agentId}`);
      expect(policy).toContain(ruleSet.sha256);
      expect(policy).not.toContain(packageRoot);
    }
  });

  it("gives the coder every blocking gate", () => {
    const policy = compileAgentPolicy({
      agentId: "coder",
      ruleSet: resolveRuleSet(sources),
    });

    for (const checkId of [
      "native-test",
      "native-build",
      "native-lint",
      "native-typecheck",
      "git-diff-check",
    ]) {
      expect(policy).toContain(checkId);
    }
  });
});

describe("the shipped .gitignore", () => {
  const git = runGit;

  const buildRepository = (): string => {
    const root = createTempDirectory("sailor-gitignore-");
    const contents = readSailorTemplateFile(packageRoot, "gitignore");
    const target = join(root, ".sailor", ".gitignore");

    initRepository(root);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);

    return root;
  };

  const isIgnored = (root: string, path: string): boolean =>
    git(root, ["check-ignore", "--quiet", path]).status === 0;

  it("ignores the private dependency tree, run state and logs", () => {
    const root = buildRepository();

    for (const path of [
      ".sailor/node_modules/sailor/package.json",
      ".sailor/state/runs/run-1/agents/coder/transcript.json",
      // An agent context is derived from the task, the agent definition and
      // the rule set, all three of which are tracked, so it is rebuilt on the
      // machine that needs it rather than committed with the task.
      ".sailor/state/runs/run-1/agents/coder/context.json",
      ".sailor/debug.log",
      ".sailor/install.tmp",
      ".sailor/sailor.lock",
      // `proper-lockfile` puts the task lock beside the file it guards, so the
      // one thing that must stay tracked has an untracked sibling.
      ".sailor/tasks.yaml.lock",
    ]) {
      expect(isIgnored(root, path)).toBe(true);
    }
  });

  it("keeps rules, agent definitions and task state under review", () => {
    const root = buildRepository();

    for (const path of [
      ".sailor/tasks.yaml",
      ".sailor/version.json",
      ".sailor/rules/base.yaml",
      ".sailor/rules/custom/team.yaml",
      ".sailor/agents/coder.yaml",
      ".sailor/hooks/pre-commit",
      ".sailor/bin/sailor",
    ]) {
      expect(isIgnored(root, path)).toBe(false);
    }
  });
});

const agentFiles = listSailorTemplateFiles(packageRoot).filter((file) =>
  /^agents\/[^/]+\.yaml$/.test(file.installedPath)
);

const definitions: readonly AgentDefinition[] = agentFiles.map((file) =>
  loadAgentDefinition(readSailorTemplateFile(packageRoot, file.templatePath), {
    source: file.installedPath,
  })
);

const definitionOf = (id: string): AgentDefinition => {
  const found = definitions.find((definition) => definition.id === id);

  if (found === undefined) {
    throw new Error(`no shipped definition for ${id}`);
  }

  return found;
};

describe("the shipped agent definitions", () => {
  it("ships one definition per built-in agent", () => {
    expect(definitions.map((definition) => definition.id)).toEqual([
      ...BUILT_IN_AGENT_IDS,
    ]);
  });

  it("names each file after the agent it defines", () => {
    for (const [index, definition] of definitions.entries()) {
      expect(agentFiles[index]?.installedPath).toBe(
        `agents/${definition.id}.yaml`
      );
    }
  });

  it("displays qa as QA rather than a capitalised identifier", () => {
    expect(definitionOf("qa").displayName).toBe("QA");
  });

  it("gives every agent a summary a human can act on", () => {
    for (const definition of definitions) {
      expect(definition.summary.trim().length).toBeGreaterThan(40);
      expect(definition.summary).not.toMatch(/TODO|TBD|placeholder|FIXME/i);
    }
  });

  it("names no provider or model id", () => {
    for (const file of agentFiles) {
      const text = readSailorTemplateFile(packageRoot, file.templatePath);

      expect(text).not.toMatch(/claude|codex|gpt|anthropic|openai/i);
    }
  });

  it("keeps the reviewing agents out of production source", () => {
    // An architect that can edit what it reviews is not a second opinion, and
    // a hardener that can repair production code can make its own failing test
    // pass instead of reporting the defect it found.
    expect(definitionOf("architect").tools.edit).toBe(false);
    expect(definitionOf("architect").writeScopes).toEqual([]);
    expect(definitionOf("hardener").writeScopes).toEqual(["tests/**"]);
  });

  it("lets no agent edit production source except the coder and the cleaner", () => {
    const writesSource = definitions
      .filter((definition) =>
        definition.writeScopes.some((scope) => scope.startsWith("src/"))
      )
      .map((definition) => definition.id);

    expect(writesSource).toEqual(["cleaner", "coder"]);
  });

  it("never lets an agent run a script that rewrites the working tree", () => {
    for (const definition of definitions) {
      expect(definition.projectScripts).not.toContain("format");
    }
  });

  it("grants no script allowance without the capability to execute", () => {
    for (const definition of definitions) {
      expect(
        definition.projectScripts.length === 0 || definition.tools.execute
      ).toBe(true);
    }
  });
});

describe("the shipped CI workflow", () => {
  const workflow = readSailorTemplateFile(packageRoot, "ci/github-actions.yml");

  it("runs both gate phases, which check different things", () => {
    expect(workflow).toContain("sailor gate pre-commit");
    expect(workflow).toContain("sailor gate pre-push");
  });

  it("resolves the private tree, which is git-ignored and absent in CI", () => {
    expect(workflow).toContain("working-directory: .sailor");
  });

  it("caches against the sailor lockfile, which is the one always present", () => {
    // `cache: npm` alone makes setup-node look for a lockfile at the project
    // root and fail the step outright when the project is on pnpm, yarn or
    // bun. The private tree is npm by design, so its lockfile always exists.
    expect(workflow).toContain(
      "cache-dependency-path: .sailor/package-lock.json"
    );
  });

  it("tells a project that is not on npm what to change", () => {
    // The sailor detects pnpm, yarn and bun, so a workflow that silently
    // assumed npm would break for exactly the projects it detects.
    for (const manager of ["pnpm", "yarn", "bun"]) {
      expect(workflow).toContain(manager);
    }
  });

  it("says why it exists and what to do with it", () => {
    // It does nothing where it is installed, so a reader who does not act on
    // it has gained nothing.
    expect(workflow).toContain(".github/workflows");
    expect(workflow).toContain("--no-verify");
  });

  it("is valid YAML with the triggers a gate needs", () => {
    const parsed: unknown = parse(workflow);

    expect(parsed).toMatchObject({
      name: "Sailor gates",
      on: { pull_request: null },
    });
  });
});

describe("the shipped config files", () => {
  const readConfig = (installedPath: string): string =>
    readSailorTemplateFile(packageRoot, installedPath);

  it("defaults the project to native-plus-sailor validation", () => {
    const config = loadProjectConfig(readConfig("config/project.yaml"), {
      source: "config/project.yaml",
    });

    expect(config).toEqual({
      version: 1,
      validationMode: "native-plus-sailor",
      packageManager: null,
    });
  });

  it("manages both git hooks and chains onto whatever is already there", () => {
    const config = loadHooksConfig(readConfig("config/hooks.yaml"), {
      source: "config/hooks.yaml",
    });

    expect(config.onExistingHook).toBe("chain");
    expect(config.hooks.map((entry) => entry.hook)).toEqual([...HOOK_NAMES]);
  });

  it("stays valid when only its version key survives", () => {
    // Both files are seeded: written once and then owned by the project. A
    // later sailor that adds a key must not invalidate a copy written before
    // that key existed, which holds only while every key has a default.
    // `not.toThrow()` alone would pass on defaults that had drifted away from
    // what the shipped files say, which is the thing seeding depends on.
    expect(
      loadProjectConfig("version: 1\n", { source: "config/project.yaml" })
    ).toEqual(
      loadProjectConfig(readConfig("config/project.yaml"), {
        source: "config/project.yaml",
      })
    );
    expect(
      loadHooksConfig("version: 1\n", { source: "config/hooks.yaml" })
    ).toMatchObject({ version: 1, onExistingHook: "chain", hooks: [] });
  });

  it("runs each hook endpoint at its own phase", () => {
    const config = loadHooksConfig(readConfig("config/hooks.yaml"), {
      source: "config/hooks.yaml",
    });

    for (const entry of config.hooks) {
      expect(entry.enabled).toBe(true);
      expect(entry.phase).toBe(entry.hook);
    }
  });
});
