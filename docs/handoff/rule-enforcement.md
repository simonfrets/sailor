> **Archived handoff.** This document was written by the Codex session that
> produced commit `edb1793` and is preserved verbatim below as the authoritative
> design for Milestones A-D. It is kept in the repository because the only other
> copy lived in `/private/tmp`, which macOS purges.
>
> One correction applies throughout: the fifth agent is spelled **`hardener`**,
> not `hardender`. The handoff's decision 9 preserves the typo; it was corrected
> before any code referenced it.
>
> Implementation status is tracked in `README.md`, not here.

---

# Sailor: implementation handoff

## Objective

Continue building Sailor so that an installed project is governed by
project-local `.sailor/` rules at three levels:

1. resolved rules are compiled into every agent prompt;
2. executable gates block invalid workflow transitions and handoffs;
3. Git hook dispatchers enforce the same gates for ordinary local commits.

Do not treat prompt instructions as enforcement. An agent may misunderstand a
prompt; a required gate must still fail the handoff or commit.

## Current repository state

- Worktree: `<PROJECTS>/sailor-codex-basic-structure`
- Branch: `codex/basic-structure`
- HEAD: `edb1793 Add TypeScript package skeleton and pre-commit quality gates`
- Worktree was clean at handoff creation.
- `main` is still an unborn branch in the original worktree. Do not implement
  there.
- Nothing has been pushed.

Read these existing artifacts instead of reproducing their contents:

- `AGENTS.md` — mandatory repository instructions and verification commands.
- `README.md` — package purpose, supported environment, and current scope.
- `package.json` — current scripts and toolchain.
- `eslint.config.js`, `jest.config.cjs`, and `tsconfig*.json` — enforced source
  quality baseline.
- `tests/shell/check-shell-syntax.test.ts` — required pattern for testing shell
  scripts through Jest and temporary fixtures.

Already verified on the current commit:

- `npm run check`
- `npm run build`
- `npm run test:coverage` with 100% initial source coverage
- a real Husky pre-commit execution against staged files
- `npm pack --dry-run`
- npm audit reported zero vulnerabilities at installation time

## Non-negotiable design decisions

1. Everything installed into a host project belongs under `.sailor/`, except
   for the repository-local Git `core.hooksPath` setting.
2. Never overwrite a host project's ESLint, TypeScript, package, Husky, or Git
   hook configuration silently.
3. Default validation mode is `native-plus-sailor`:
   - run discovered native project scripts;
   - run sailor correctness/maintainability gates;
   - avoid competing stylistic rules unless explicitly enabled.
4. Rules are data. Runtime code validates, resolves, compiles, and executes
   them. Adding a normal custom rule must not require changing TypeScript.
5. Executable commands are argv arrays and run with `shell: false`. Do not store
   interpolated shell command strings in YAML.
6. Tool permissions must be enforced by the adapter/runtime, not merely written
   into the model prompt.
7. Every handoff records the resolved rule-set hash and gate evidence.
8. High-level workflow state is stored atomically in `.sailor/tasks.yaml`.
   Transcripts and disposable process state belong under ignored
   `.sailor/state/` directories.
9. Preserve the six required agent roles: `specifier`, `coder`, `cleaner`,
   `architect`, `hardender`, and `qa` (`QA` as its display name).
10. macOS, Linux, and WSL are the v1 shell targets. Native Windows is not.

## Target installed layout

```text
host-project/
└── .sailor/
    ├── .gitignore
    ├── package.json
    ├── package-lock.json
    ├── node_modules/                 # ignored, runtime dependencies only
    ├── bin/
    │   └── sailor
    ├── agents/
    │   ├── specifier.yaml
    │   ├── coder.yaml
    │   ├── cleaner.yaml
    │   ├── architect.yaml
    │   ├── hardender.yaml
    │   └── qa.yaml
    ├── config/
    │   ├── project.yaml
    │   ├── models.yaml
    │   ├── providers.yaml
    │   └── hooks.yaml
    ├── hooks/
    │   ├── pre-commit
    │   └── pre-push
    ├── rules/
    │   ├── base.yaml
    │   ├── typescript.yaml
    │   ├── git.yaml
    │   └── custom/
    ├── runtime/
    ├── state/                        # ignored transcripts, locks, logs
    │   └── runs/<run-id>/agents/<agent-id>/
    ├── tasks.yaml
    └── version.json
```

The initial installer may maintain a private npm environment inside
`.sailor/`. Do not add sailor dependencies to the host project's
`package.json`.

## Rule contract v1

Use Zod as the runtime schema and inferred TypeScript type source. Use `yaml`
for parsing. Add both as runtime dependencies, not dev dependencies.

The public YAML shape must support this contract:

```yaml
version: 1
id: typescript-quality
description: TypeScript correctness rules

rules:
  - id: typescript.no-explicit-any
    description: Reject new explicit any types
    severity: error
    appliesTo: [coder, cleaner, hardender]
    scopes: ["**/*.ts", "**/*.tsx"]
    instruction: >
      Do not introduce explicit any. Use a concrete type, generic,
      discriminated union, or unknown with narrowing.
    checks:
      - id: native-lint
        runner: project-script
        script: lint
        phases: [pre-handoff, pre-commit]
        required: true
        whenMissing: fail
        timeoutMs: 120000
```

Implement check runners as a discriminated union:

- `project-script`: a semantic script name resolved through the discovered
  package manager and `package.json` scripts.
- `command`: an explicit non-shell argv array, working-directory policy, and
  timeout.
- Reserve `builtin` in the schema only when the first real built-in sailor
  check exists. Do not add a fake unimplemented runner.

Required enums:

- Severity: `error | warning`
- Phase: `pre-agent | pre-handoff | pre-commit | pre-push | qa`
- Missing-script behavior: `fail | skip`
- Agent IDs: the six fixed IDs plus an extensible validated custom string

Validation failures must include the source filename and a useful YAML path.

## Rule precedence and determinism

Resolve rule sources in this order:

1. built-in base bundles;
2. project bundles;
3. agent bundles;
4. task-local overrides.

Rules with duplicate IDs are errors unless the higher-precedence rule declares
an explicit override. Preserve origin metadata for diagnostics. Sort resolved
rules deterministically by rule ID after precedence is resolved.

Hash canonical JSON containing the resolved semantic rule content, not source
paths, timestamps, comments, or YAML formatting. Use SHA-256. The same logical
rule set must produce the same hash on different machines.

## Agent policy compilation

Compile a `ResolvedRuleSet` into deterministic Markdown with:

- rule-set revision and SHA-256;
- mandatory instructions grouped by severity;
- applicable file scopes;
- verification commands/gates;
- explicit statement that required gates block handoff.

The compiler is provider-neutral. Codex- and Claude-specific adapters consume
the compiled policy later. Do not embed provider CLI flags in the compiler.

## Project discovery contract

Discovery is read-only and must not execute project scripts. Produce a validated
`ProjectProfile` containing:

- absolute project root internally, omitted from persisted portable YAML;
- detected package manager, using lockfile priority with ambiguity errors;
- `package.json` script availability for lint, typecheck, test, format, build;
- detected TypeScript and ESLint configuration filenames;
- existing `core.hooksPath` value;
- existing `.git/hooks`, Husky, Lefthook, or similar hook entrypoints;
- validation mode, initially `native-plus-sailor`.

Do not infer that an arbitrary package script is safe to run. Only resolve
script names referenced by validated rules.

## Gate execution contract

Create an injectable `CommandRunner` interface so unit tests never need real
Codex, Claude, npm registry, or user-level tools.

The production runner must:

- use `node:child_process` with `shell: false`;
- set cwd explicitly to the project root or validated relative location;
- use a minimal inherited environment with explicit overrides;
- capture stdout, stderr, exit code, signal, start time, duration, and timeout;
- terminate timed-out processes and report timeout distinctly;
- never log environment secrets;
- return structured results rather than throwing for normal nonzero exits.

`runPhaseGates` filters applicable checks by phase and agent. Required failed
checks block the phase. Warning checks are reported but do not block. Return a
serializable `GateReport`; persistence into `tasks.yaml` comes later.

## Milestone A: rule and gate kernel

This is the recommended scope of the immediate next session. Use TDD and make
the following commits in order.

### A1. Add validated contracts

Add dependencies: `zod` and `yaml`.

Create:

- `src/agents/agent-id.ts`
- `src/rules/rule-schema.ts`
- `src/rules/types.ts`
- `src/rules/load-rule-bundle.ts`
- `src/project/project-profile-schema.ts`
- corresponding tests under `tests/unit/`

Tests must cover valid bundles, every discriminated check type, malformed YAML,
unknown keys, invalid agent IDs, invalid argv arrays, and source-aware errors.

Commit: `Add validated rule and project profile contracts`

### A2. Add project discovery

Create:

- `src/project/discover-project-profile.ts`
- `src/project/package-manager.ts`
- fixture repositories under `tests/fixtures/projects/`
- `tests/unit/project/discover-project-profile.test.ts`

Test npm, pnpm, Yarn, Bun, missing package files, conflicting lockfiles,
existing ESLint/TypeScript configs, and existing hook paths. Never inspect the
developer's real repository state in tests.

Commit: `Discover external project quality configuration`

### A3. Resolve and hash rule sets

Create:

- `src/rules/resolve-rule-set.ts`
- `src/rules/hash-rule-set.ts`
- `src/rules/rule-error.ts`
- deterministic precedence/hash tests

Test source precedence, explicit overrides, accidental duplicates, stable
ordering, formatting-independent hashes, and semantic-change hash differences.

Commit: `Resolve deterministic project rule sets`

### A4. Compile agent policy prompts

Create:

- `src/prompts/compile-agent-policy.ts`
- snapshot or exact-string tests

Test severity grouping, scope rendering, gate rendering, stable output, and
escaping of rule text that contains Markdown control characters. The output
must not contain absolute machine paths.

Commit: `Compile rule sets into agent policies`

### A5. Execute phase gates

Create:

- `src/processes/command-runner.ts`
- `src/processes/node-command-runner.ts`
- `src/gates/resolve-project-script.ts`
- `src/gates/run-phase-gates.ts`
- fake-runner unit tests and temporary-project integration tests

Test success, failure, warning-only failure, missing scripts, timeout,
stdout/stderr capture, npm/pnpm/Yarn/Bun command construction, phase filtering,
and attempted shell metacharacters remaining inert argv values.

Commit: `Enforce rule checks at workflow gates`

### Milestone A completion gate

Before stopping:

```sh
npm run check
npm run build
npm run test:coverage
```

Maintain the configured global coverage thresholds. Update `README.md` only for
behavior that actually exists. Do not create installer documentation yet.

## Milestone B: `.sailor` installer and external hooks

Begin only after Milestone A is reviewed.

### B1. Add CLI foundation

- Add `src/cli/index.ts` with a Node shebang and dependency-injected command
  dispatch.
- Add the package `bin` entry.
- Commands: `init`, `doctor`, `rules validate`, `rules explain`, `gate <phase>`.
- Unknown commands and invalid config return stable nonzero exit codes.
- Test CLI behavior by spawning the built entrypoint or injecting streams.

### B2. Add `.sailor` templates

- Add `templates/.sailor/` matching the target layout.
- Provide `base.yaml`, `typescript.yaml`, and `git.yaml` with real instructions
  and checks only.
- Add a `.sailor/.gitignore` that ignores `node_modules/`, `state/`, logs, and
  temporary lock files but does not ignore `tasks.yaml`, agent definitions, or
  rules.
- Validate every shipped template in Jest.

### B3. Implement idempotent installation

- Discover the project root using `git rev-parse --show-toplevel`.
- Refuse to install outside a Git repository.
- Refuse unsafe overwrites; support `--update` only through an explicit managed
  manifest in `version.json`.
- Install runtime dependencies into `.sailor/`, never into the host package.
- Use temporary directories and atomic rename for managed-file updates.
- Add `sailor doctor` checks for Node, npm, Git, Bash, config validity, runtime
  dependencies, and hook reachability.
- Test against temporary Git repositories.

### B4. Implement hook dispatch without clobbering

Before changing hooks, record:

- existing local `core.hooksPath`;
- resolved default `.git/hooks/pre-commit` and `pre-push` paths;
- detected Husky or other hook runners.

If existing hooks are present, generate a `.sailor/hooks/` dispatcher that
runs the preserved hook and then the sailor gate. Abort installation if safe
chaining cannot be proven; do not silently discard an existing hook.

The sailor pre-commit endpoint runs `gate pre-commit`. The pre-push endpoint
runs `gate pre-push`. Add tests for no prior hook, prior relative hook path,
prior absolute hook path, failing prior hook, failing sailor gate, and Git
worktrees.

## Milestone C: tasks, contexts, and handoffs

Use `yaml` for `.sailor/tasks.yaml`. Add robust atomic writing and locking;
prefer reviewed libraries such as `proper-lockfile` and `write-file-atomic`
instead of inventing an incomplete lock protocol.

Implement states:

```text
draft -> specified -> awaiting_approval -> implementing -> cleaning
      -> architecture_review -> hardening -> qa -> completed
```

Every active state may transition to `blocked` or `failed`. Only valid recovery
transitions may leave them. The coder cannot start before explicit specification
approval.

Each transition stores:

- task revision and expected prior revision;
- source and target agent;
- resolved rule-set SHA-256;
- gate report IDs and artifact paths;
- timestamps, attempt number, and failure details;
- next-agent context path.

Reject stale-revision writes. Contexts live at
`.sailor/state/runs/<run-id>/agents/<agent-id>/` and must never be shared by
reference as one mutable global context.

## Milestone D: agents and provider adapters

Define a provider-neutral adapter:

```ts
interface ProviderAdapter {
  invoke(request: AgentInvocation): AsyncIterable<AgentEvent>;
}
```

`AgentInvocation` includes project root, isolated context path, task snapshot,
compiled policy, logical model profile, allowed tools, timeout, and abort
signal. The runtime records structured events and final status.

Implement Codex and Claude adapters by first inspecting the installed CLI
`--help`; provider flags are version-sensitive and must not be guessed. Test
with fake executable fixtures, never live API calls.

Agent tool policy defaults:

- `specifier`: read/search/spec and QA-procedure output; no source edits.
- `coder`: scoped source/test edits and test commands; no push.
- `cleaner`: scoped behavior-preserving edits, coverage and analysis commands.
- `architect`: read/search/dependency/property-test review; report output only.
- `hardender`: test and mutation edits/commands; production fixes require a new
  coder task.
- `qa`: acceptance-script generation/execution, UI verification, handoff
  consistency, notification adapter; no production source edits.

Agents reference logical profiles such as `reasoning-high`, `coding-high`, and
`verification`. Provider-specific model IDs live only in
`.sailor/config/models.yaml` and are validated by the relevant adapter.

## End-to-end acceptance criteria

The first usable release is not complete until all of the following pass:

1. A temporary TypeScript Git project can install the sailor without changing
   its root `package.json` or native ESLint config.
2. The installed footprint is confined to `.sailor/` plus local Git config.
3. Existing project hooks still execute in their original order.
4. A custom YAML rule changes both the compiled agent policy and phase gates
   without a TypeScript code change.
5. A coder handoff with a failing required lint check is rejected.
6. A warning-only rule is recorded but does not block.
7. Rule-set hashes are stable across two independent temporary directories.
8. Each of the six agents receives a distinct context and tool policy.
9. A stopped workflow resumes from `tasks.yaml` without rerunning completed
   stages.
10. QA cannot complete a task without accepted Gherkin evidence, executable QA
    procedure results, successful final gates, and a recorded notification
    result.
11. `npm run check`, `npm run build`, and `npm run test:coverage` pass in the
    framework repository.
12. No tests depend on installed Codex/Claude credentials or network access.

## Known caveats to keep explicit

- The existing source-repository Husky hook does not govern external projects.
  Milestone B creates that behavior.
- Local Git hooks can be bypassed with `--no-verify`; CI is required for
  enforcement against a human intentionally bypassing local controls.
- Running both native and sailor style rules can conflict. Sailor baseline
  rules should focus on correctness and maintainability; style overlays are
  opt-in.
- `package.json` declares MIT but no `LICENSE` file exists yet. Add it before a
  public release.
- The remote GitHub repository had not been created at the time of this handoff,
  and the saved GitHub CLI token was previously invalid. Do not assume push
  access.

## Suggested skills

- `tdd` — implement each milestone test-first.
- `engineering:system-design` — use when changing the contracts or installation
  boundary.
- `setup-pre-commit` — use only if modifying the source repository's Husky
  configuration.
- `diagnosing-bugs` — use for non-obvious hook, subprocess, timeout, or
  cross-platform failures.
- `code-review` — review each completed milestone before beginning the next.

## Fresh-session starting prompt

Use this exact prompt after attaching or referencing this handoff:

> Continue Sailor from branch `codex/basic-structure` in its existing
> worktree. Read `AGENTS.md`, `README.md`, and this handoff completely. Implement
> Milestone A only, using TDD and the listed commit boundaries. Do not build the
> `.sailor` installer or provider adapters yet. Preserve the three-layer rule
> architecture: agent policy compilation, workflow gates, and later Git hook
> enforcement. Run every Milestone A completion gate and report any deviation
> directly.
