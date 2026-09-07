> **Archived handoff.** B3 and B4 are complete as of `966808b`. The current
> state, the defects found while finishing them, and the Milestone C scope are
> in `docs/handoff/milestone-c.md`.

---

# Milestone B3 handoff: idempotent installation and `sailor doctor`

## How to start

Open a new session in this worktree and paste the prompt at the end of this
document. Read `AGENTS.md`, `README.md`, `docs/handoff/rule-enforcement.md`
(the original A–D design) and `docs/handoff/milestone-b.md` before writing
code. This document supersedes `milestone-b.md` for B1 and B2 only; its B3 and
B4 scope still stands.

## Where things stand

- Worktree: `<PROJECTS>/sailor-codex-basic-structure`
- Branch: `codex/basic-structure`
- HEAD: `3c93e5b Ship agent definitions and sailor configuration`
- Nothing pushed; no remote for this branch.
- **The working tree is dirty and does not pass `npm run test:coverage`.** Five
  untracked modules under `src/install/` and two untracked test files are
  in-flight B3 work. Details below.

`npm run check` and `npm run build` pass. `npm run test:coverage` **fails** at
89.91% statements against a 90% threshold, because three of the in-flight
modules have no tests yet. This is expected, not a defect to hunt.

### Committed

| Commit    | Subject                                                          |
| --------- | ---------------------------------------------------------------- |
| `5cef0c2` | Add command line entry point (B1)                                |
| `fa05921` | Ship .sailor configuration templates (B2)                        |
| `3c93e5b` | Ship agent definitions and sailor configuration (B2, completion) |

B1 and B2 are complete. 319 tests pass across 38 suites.

### In flight, uncommitted (B3)

| File                                          | State                 |
| --------------------------------------------- | --------------------- |
| `src/install/atomic-write.ts`                 | done, tested, 100%    |
| `src/install/install-manifest.ts`             | done, tested, 100%    |
| `src/install/plan-installation.ts`            | written, **no tests** |
| `src/install/runtime-dependencies.ts`         | written, **no tests** |
| `src/install/install-sailor.ts`               | written, **no tests** |
| `tests/unit/install/atomic-write.test.ts`     | done                  |
| `tests/unit/install/install-manifest.test.ts` | done                  |

None of the five modules is exported from `src/index.ts` yet.

## What B2 turned out to require

The original `milestone-b.md` treated B2 as three rule bundles plus a
`.gitignore`. Its first bullet — "matching the target layout" — was not met:
the layout in the A–D handoff also has `agents/` and `config/` directories.

`3c93e5b` closes that. It ships six agent definitions and two config files,
each with a Zod schema and Jest validation, and adds `src/config/`:

| Module                           | Public surface                                                   |
| -------------------------------- | ---------------------------------------------------------------- |
| `src/config/load-yaml-config.ts` | `loadYamlConfig(text, schema, { source })`                       |
| `src/agents/agent-definition.ts` | `agentDefinitionSchema`, `loadAgentDefinition`, `MODEL_PROFILES` |
| `src/config/project-config.ts`   | `projectConfigSchema`, `loadProjectConfig`                       |
| `src/config/hooks-config.ts`     | `hooksConfigSchema`, `loadHooksConfig`, `EXISTING_HOOK_POLICIES` |

Scope calls made deliberately, so they are not reopened:

- `config/models.yaml` and `config/providers.yaml` are **deferred to Milestone
  D**, which validates provider flags against a real CLI `--help`. Guessing
  them now would design the adapter contract before an adapter exists.
- `tasks.yaml` belongs to Milestone C.
- `bin/sailor`, `hooks/`, `runtime/`, `node_modules/`, `version.json` are
  installer-generated, not templates.
- Nothing reads an installed copy of these files yet.
  `discoverProjectProfile` still hardcodes `validationMode:
"native-plus-sailor"` at `src/project/discover-project-profile.ts:162`.
  Wiring `config/project.yaml` into it is open work, and is a behaviour change
  rather than a template change.

## Decisions already made in the in-flight B3 code

Do not re-litigate these; change them only with a reason written down.

1. **npm always drives the private tree**, whatever the host project uses.
   Resolving `.sailor/` with the project's manager would apply that manager's
   workspace rules, which in a monorepo hoists the sailor's dependencies into
   the workspace root — the exact host contamination the boundary exists to
   prevent. npm 10 is already a stated requirement.
2. **Write order is files, then manifest, then dependencies.** An install
   interrupted by a failing `npm install` must leave a project the sailor
   still recognises as its own, so re-running repairs it instead of reporting
   every file it just wrote as an unmanaged conflict.
3. **Orphaned managed files are reported, never deleted.** Deleting a project
   file is the irreversible act B3 refuses to perform unprompted.
4. **The planner collects every conflict and throws once.** Someone untangling
   a half-adopted installation should see the whole list, not discover the next
   one on each re-run.
5. **`keep` wins when the file on disk already equals the template**, whatever
   the manifest says.
6. **`.sailor/package.json` is a managed file in the manifest** even though it
   is generated rather than copied from `templates/`.
7. **`bin/sailor` is not written yet.** It is not in B3's bullet list, and B4
   is what needs it.

The planner's decision table, in order:

| on disk | in manifest | content               | `--update` | outcome                    |
| ------- | ----------- | --------------------- | ---------- | -------------------------- |
| absent  | –           | –                     | –          | `create`                   |
| present | –           | equals shipped        | –          | `keep`                     |
| present | no entry    | differs               | –          | conflict: unmanaged file   |
| present | entry       | local ≠ manifest hash | –          | conflict: locally modified |
| present | entry       | differs               | no         | conflict: needs `--update` |
| present | entry       | differs               | yes        | `replace`                  |

## What is left in B3

1. **Tests for the three untested modules.** Temporary Git repositories, a
   fake `CommandRunner`, argument-vector assertions for `npm install`. Cover
   every row of the table above.
2. **`src/cli/commands/init.ts`**, registered in
   `src/cli/default-commands.ts`. `init` already parses, including `--update`;
   `runCli` reports an unregistered command as unavailable, which is what
   happens today.
3. **`sailor doctor`**: Node, npm, Git, Bash, config validity, runtime
   dependencies, and hook reachability. Hook reachability has to degrade
   gracefully — B4 is what installs hooks, so "no sailor hooks installed" is a
   finding, not a crash.
4. **Barrel exports** in `src/index.ts` and the matching `PUBLIC_API` entries
   in `tests/unit/index.test.ts`.
5. **README**, only for behaviour that then actually exists.

## B4, unchanged from the A–D handoff

Before changing hooks, record the existing local `core.hooksPath`, the resolved
default `.git/hooks/pre-commit` and `pre-push` paths, and any detected Husky or
other hook runner.

If hooks already exist, generate a `.sailor/hooks/` dispatcher that runs the
preserved hook **and then** the sailor gate. Abort if safe chaining cannot be
proven; never silently discard an existing hook. `config/hooks.yaml` already
encodes this as `onExistingHook: chain | abort`, with no `replace`.

The pre-commit endpoint runs `gate pre-commit`; pre-push runs `gate pre-push`.
Test: no prior hook, prior relative hook path, prior absolute hook path,
failing prior hook, failing sailor gate, and Git worktrees.

## Traps this repository will spring on you

The first four are carried forward from `milestone-b.md` and still bite. The
rest were found the hard way in this session.

1. **`import.meta.url` does not work under Jest.** `tsconfig.test.json`
   transpiles to CommonJS for ts-jest while the build emits NodeNext ESM.
   `import.meta` type-checks and builds, then crashes in a test. The package
   root is therefore injected as `packageRootDirectory: string` and resolved in
   exactly one place — `src/cli/index.ts`, which no test imports.
2. **A type-only module reports 0% coverage.** `verbatimModuleSyntax` erases it
   at every import site. Declare types beside the values they describe.
3. **`src/index.ts` barrel re-exports count as functions.**
   `tests/unit/index.test.ts` holds an explicit `PUBLIC_API` list — now 97
   entries — that must be updated whenever an export is added, or both the
   surface test and coverage fail.
4. **Never weaken a gate.** `AGENTS.md` forbids it. No lowered threshold, no
   ignore comment, no `--no-verify`.
5. **100% coverage is not achievable and is not the target.**
   `src/cli/index.ts` is 0% by design — it is the bin entry, and importing it
   under Jest would crash on `import.meta`. The realistic ceiling is ~98.75%
   overall against thresholds of 90/90/90/80. Do not chase the last 1.25%.
6. **`tests/unit/install/sailor-templates.test.ts` asserts the exact list of
   installed template paths.** Adding a template file fails it on purpose. The
   list is currently 13 entries.
7. **`buildSailorProject()` does not create `.sailor/`.** It only makes
   directories for the fixture keys you pass. Writing into `.sailor/` with a
   bare `writeFileSync` after calling it with no arguments throws `ENOENT`;
   pass `files: { ".sailor/…": … }` instead. This cost a red test already.
8. **Zod's `z.array()` output type is mutable.** A `readonly T[]` will not
   assign to `InstallManifest["managedFiles"]`. Type the local as `T[]`.
9. **`sailor` is not published to npm.** `npm install` inside
   `.sailor/` cannot resolve the dependency in a real run today. Tests assert
   the argument vector and never spawn a real install, per acceptance criterion
   12, so this does not block B3 — but do not claim a working end-to-end
   install until the package resolves.
10. **`prettier --check .` covers the whole repository**, including every
    `.yaml`, `.json` and `.md` added. Templates under `templates/` must be
    Prettier-clean.
11. **Yarn and Bun are not installed on this machine**; pnpm is. Prove their
    behaviour through argument-vector unit tests, never by spawning them.
12. **`.husky/pre-commit` runs the full gate on every commit**, against the
    working tree rather than the index. A commit that stages only part of a
    dirty tree is therefore _not_ verified by the hook. To verify a commit on
    its own, move the unrelated files aside first — this is how `3c93e5b` was
    made green while B3 work sat uncommitted.
13. **This is a Git worktree and the stash stack is shared.** Never use bare
    `git stash` / `git stash pop`. Prefer a temporary WIP commit, or move files
    to a scratch directory.

## Commit boundaries

| Step | Subject                                               | State |
| ---- | ----------------------------------------------------- | ----- |
| B1   | `Add command line entry point`                        | done  |
| B2   | `Ship .sailor configuration templates`                | done  |
| B2   | `Ship agent definitions and sailor configuration`     | done  |
| B3   | `Install the sailor into a project idempotently`      | open  |
| B4   | `Dispatch Git hooks without discarding existing ones` | open  |

## Completion gate

```sh
npm run check
npm run build
npm run test:coverage
npm pack --dry-run
```

Then demonstrate, against a throwaway Git repository, acceptance criteria 1–4
from the A–D handoff: a TypeScript project installs the sailor without its
root `package.json` or ESLint config changing; the footprint is confined to
`.sailor/` plus local Git config; existing hooks still run in their original
order; and a custom YAML rule changes both the compiled policy and the phase
gates with no TypeScript change.

Report any deviation directly. Do not describe partial work as complete.

## Starting prompt

> Continue Sailor on branch `codex/basic-structure` in the worktree
> `<PROJECTS>/sailor-codex-basic-structure`. Read
> `AGENTS.md`, `README.md`, `docs/handoff/rule-enforcement.md`, and
> `docs/handoff/milestone-b3.md` completely before writing code. Milestones A,
> B1 and B2 are committed. The working tree carries uncommitted B3 work:
> `atomic-write.ts` and `install-manifest.ts` are done and tested;
> `plan-installation.ts`, `runtime-dependencies.ts` and `install-sailor.ts`
> are written but have no tests, so `npm run test:coverage` currently fails at
> 89.91%. Finish B3 — tests for those three modules, the `init` and `doctor`
> commands, barrel exports and `PUBLIC_API` — then B4. Do not build task state
> or provider adapters. Run the completion gate and report any deviation
> directly.
