> **Archived handoff.** Milestone B is complete as of `966808b`. See
> `docs/handoff/milestone-c.md` for the current state.

---

# Milestone B handoff: `.sailor` installer and external hooks

## How to start

Open a new session in this worktree and paste the prompt at the end of this
document. Read `AGENTS.md`, `README.md`, and
`docs/handoff/rule-enforcement.md` (the original A–D design) before writing
code.

## Where things stand

- Worktree: `<PROJECTS>/sailor-codex-basic-structure`
- Branch: `codex/basic-structure`
- HEAD: `599c1ac Enforce rule checks at workflow gates`
- Working tree clean. Nothing pushed; no remote exists.
- `main` (`edc7e00`) is an unrelated root commit in the other worktree. Do not
  implement there.

Milestone A is complete and verified: `npm run check`, `npm run build`, and
`npm run test:coverage` all pass, with 171 tests at 100% statements, branches,
functions, and lines against thresholds of 90/90/90/80.

### What Milestone A already gives you

Import these from the package root; do not reimplement them.

| Module                                    | Public surface                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/agents/agent-id.ts`                  | `BUILT_IN_AGENT_IDS`, `agentIdSchema`, `isBuiltInAgentId`, `mapBuiltInAgents`                            |
| `src/rules/rule-schema.ts`                | `ruleBundleSchema`, `PHASES`, `SEVERITIES`, `PROJECT_SCRIPT_NAMES`, and the inferred types               |
| `src/rules/load-rule-bundle.ts`           | `loadRuleBundle(text, { source })`, throwing `RuleValidationError` with file, YAML path, line and column |
| `src/rules/resolve-rule-set.ts`           | `resolveRuleSet(sources)` → `ResolvedRuleSet` with `sha256`                                              |
| `src/rules/hash-rule-set.ts`              | `hashRuleSet`, `canonicalStringify`, `compareCodeUnits`, `normalizeText`                                 |
| `src/prompts/compile-agent-policy.ts`     | `compileAgentPolicy({ agentId, ruleSet })` → Markdown                                                    |
| `src/project/discover-project-profile.ts` | `discoverProjectProfile({ root, runner })` → `ProjectProfile`                                            |
| `src/project/package-manager.ts`          | `resolvePackageManager`, `PackageManagerAmbiguityError`                                                  |
| `src/processes/command-runner.ts`         | `CommandRunner` type, `CommandResult` union, `describeCommandResult`                                     |
| `src/processes/node-command-runner.ts`    | `createNodeCommandRunner`, `nodeCommandRunner`, `buildChildEnvironment`                                  |
| `src/gates/run-phase-gates.ts`            | `runPhaseGates(options)` → `PhaseGateReport`                                                             |
| `src/gates/resolve-project-script.ts`     | `buildPackageManagerCommand`, `resolveProjectScript`                                                     |

Not yet present: `package.json` has **no `bin` entry**, and there is **no
`templates/` directory** (though `files` already lists it). Runtime
dependencies are `yaml` and `zod`.

## Scope

Verbatim from `docs/handoff/rule-enforcement.md`, sections B1–B4.

### B1. CLI foundation

- `src/cli/index.ts` with a Node shebang and dependency-injected command
  dispatch.
- Add the package `bin` entry.
- Commands: `init`, `doctor`, `rules validate`, `rules explain`,
  `gate <phase>`.
- Unknown commands and invalid config return stable nonzero exit codes.
- Test by spawning the built entrypoint or by injecting streams.

### B2. `.sailor` templates

- `templates/.sailor/` matching the target layout in the A–D handoff.
- `base.yaml`, `typescript.yaml`, `git.yaml` with real instructions and checks
  only — no placeholders.
- A `.sailor/.gitignore` ignoring `node_modules/`, `state/`, logs and
  temporary lock files, but **not** `tasks.yaml`, agent definitions, or rules.
- Validate every shipped template in Jest.

### B3. Idempotent installation

- Discover the project root with `git rev-parse --show-toplevel`.
- Refuse to install outside a Git repository.
- Refuse unsafe overwrites; support `--update` only through an explicit managed
  manifest in `version.json`.
- Install runtime dependencies into `.sailor/`, never into the host package.
- Use temporary directories and atomic rename for managed-file updates.
- `sailor doctor` checks Node, npm, Git, Bash, config validity, runtime
  dependencies, and hook reachability.
- Test against temporary Git repositories.

### B4. Hook dispatch without clobbering

Before changing hooks, record the existing local `core.hooksPath`, the resolved
default `.git/hooks/pre-commit` and `pre-push` paths, and any detected Husky or
other hook runner.

If hooks already exist, generate a `.sailor/hooks/` dispatcher that runs the
preserved hook **and then** the sailor gate. Abort installation if safe
chaining cannot be proven; never silently discard an existing hook.

The pre-commit endpoint runs `gate pre-commit`; the pre-push endpoint runs
`gate pre-push`. Test: no prior hook, prior relative hook path, prior absolute
hook path, failing prior hook, failing sailor gate, and Git worktrees.

## Traps this repository will spring on you

These cost real time in Milestone A. They are not hypothetical.

1. **`import.meta.url` does not work.** `tsconfig.test.json` transpiles `src/`
   _and_ `tests/` to CommonJS for ts-jest, while `tsc -p tsconfig.build.json`
   emits NodeNext ESM. `import.meta.url`, `import.meta.dirname` and top-level
   `await` typecheck and build fine but **crash under Jest**.

   This is the central design problem of B2 and B3, because the installer must
   locate `templates/`. Do not solve it with a conditional. Take
   `packageRootDirectory: string` as an injected option on the installer, and
   resolve it in exactly one place — the `bin` entry, which no test imports.
   Tests pass the repository root directly.

2. **A type-only module reports 0% coverage.** `verbatimModuleSyntax` erases it
   at every import site. Declare types beside the values they describe; do not
   create a `types.ts`.

3. **Barrel re-exports are counted as functions.** Under the CommonJS transpile
   each `export … from` becomes a getter. `tests/unit/index.test.ts` holds an
   explicit `PUBLIC_API` list that touches every export — **add new exports to
   it** or coverage drops and the surface test fails.

4. **Coverage is at 100%.** Thresholds are 90/90/90/80. Never lower a threshold
   or add an ignore comment to make a step pass; `AGENTS.md` forbids weakening a
   gate. Prefer code shapes with no unreachable branch: exhaustive switches with
   no `default`, and no defensive check on an already-non-nullable value
   (`no-unnecessary-condition` is an error).

5. **Tests must not need the network.** Acceptance criterion 12. B3 installs
   dependencies into `.sailor/`, which means running a package manager — inject
   a `CommandRunner` and assert the argument vector, exactly as
   `discoverProjectProfile` does for `git config`. Do not run a real install in
   a test.

6. **`prettier --check .` covers the whole repository**, including any `.yaml`,
   `.json` or `.md` you add. Shipped templates under `templates/` must be
   Prettier-clean, or add a considered `.prettierignore` entry and say why.

7. **Yarn and Bun are not installed on this machine**; pnpm is. Prove their
   behaviour through argument-vector unit tests, never by spawning them.

8. **`.husky/pre-commit` in this repo runs on every commit** (`lint`,
   `typecheck`, `lint:shell`, `test`) and `--no-verify` is forbidden. Each
   commit must be green when made, so red-green-refactor happens _inside_ a
   step, not across steps.

9. This repository's own Husky hook does **not** govern external projects.
   Milestone B is what creates that behaviour. Local hooks are also bypassable
   with `--no-verify`; CI is required against a human who intends to bypass.

## Commit boundaries

One commit per step, in order, each green:

| Step | Subject                                               |
| ---- | ----------------------------------------------------- |
| B1   | `Add command line entry point`                        |
| B2   | `Ship .sailor configuration templates`                |
| B3   | `Install the sailor into a project idempotently`      |
| B4   | `Dispatch Git hooks without discarding existing ones` |

## Completion gate

```sh
npm run check
npm run build
npm run test:coverage
npm pack --dry-run
```

Then demonstrate, against a throwaway Git repository, acceptance criteria 1–3
and 4 from the A–D handoff: a TypeScript project installs the sailor without
its root `package.json` or ESLint config changing; the footprint is confined to
`.sailor/` plus local Git config; existing hooks still run in their original
order; and a custom YAML rule changes both the compiled policy and the phase
gates with no TypeScript change.

Update `README.md` only for behaviour that actually exists.

## Starting prompt

> Continue Sailor on branch `codex/basic-structure` in the worktree
> `<PROJECTS>/sailor-codex-basic-structure`. Read
> `AGENTS.md`, `README.md`, `docs/handoff/rule-enforcement.md`, and
> `docs/handoff/milestone-b.md` completely before writing code. Milestone A is
> done and committed at 100% coverage. Implement Milestone B only — B1 through
> B4 — test-first, with the listed commit boundaries. Do not build task state or
> provider adapters. Run the completion gate and report any deviation directly.
