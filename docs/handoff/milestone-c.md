# Milestone C handoff: tasks, contexts, and handoffs

## How to start

Open a new session in this worktree and paste the prompt at the end of this
document. Read `AGENTS.md`, `README.md` and `docs/handoff/rule-enforcement.md`
(the original A–D design) before writing code. `docs/handoff/milestone-b.md`
and `docs/handoff/milestone-b3.md` are archived: their B1–B4 scope is now
complete and this document supersedes them.

## Where things stand

- Worktree: `<PROJECTS>/sailor-codex-basic-structure`
- Branch: `codex/milestone-c`, cut from `main`. Do **not** reuse
  `codex/basic-structure`, which is merged and kept only for its history.
- HEAD of `main`: `bf9b4f9 Merge the rule kernel, installer and hook dispatch`
- The repository is **public**, at `simonfrets/sailor`.

`npm run check`, `npm run build`, `npm run test:coverage` and
`npm pack --dry-run` all pass: 665 tests across 60 suites at 99.3% statements
against thresholds of 90/90/90/80.

GitHub Actions runs the same gate on every push and pull request, on Linux and
macOS, against Node 22.22.1 — the floor `engines.node` declares — and current 22. That is the enforcement; `.husky/pre-commit` is the convenience, and is
skippable with `--no-verify`. CI is green on `main`.

**`v0.1.0` is released.** The sailor is deliberately not on npm: an installed
project's `.sailor/package.json` pins the tarball attached to the GitHub
release, and the owner and name come from this package's own `repository`
field. Cutting a new release means tagging `vX.Y.Z` and attaching the exact
`npm pack` output as `sailor-X.Y.Z.tgz`, or every `sailor init` will
fail at the runtime step.

### Proven end to end

`sailor init` was run against a real TypeScript project — real `tsc` build and
typecheck, a real `node --test` suite, and a pre-existing `.git/hooks/pre-commit`.
It completed, `doctor` reported ten checks OK and one warning, the project's own
hook still ran first, a clean commit passed, a type error blocked, and a partial
commit carrying conflict markers was refused. Do not regress any of that.

### What B3 and B4 added

| Module                                | Public surface                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/sailor/atomic-write.ts`          | `writeFileAtomic` (moved out of `src/install/` in C1)                                   |
| `src/install/install-manifest.ts`     | `readInstallManifest`, `writeInstallManifest`, `hashManagedFile`, `hookRecordSchema`    |
| `src/install/plan-installation.ts`    | `planInstallation`, `toPlannedFileSource`, `INSTALL_ACTIONS`                            |
| `src/install/runtime-dependencies.ts` | `installRuntimeDependencies`, `buildRuntimePackageManifest`, `RUNTIME_INSTALL_ARGV`     |
| `src/install/discover-hooks.ts`       | `discoverHookEnvironment`, `toProjectPath`                                              |
| `src/install/plan-hooks.ts`           | `planHooks`                                                                             |
| `src/install/hook-scripts.ts`         | `buildSailorLauncher`, `buildHookDispatcher`, `escapeForDoubleQuotes`, `hookScriptPath` |
| `src/install/install-sailor.ts`       | `installSailor`                                                                         |
| `src/install/diagnose-sailor.ts`      | `diagnoseSailor`, `REQUIRED_NODE_VERSION`, `REQUIRED_TOOLS`, `versionOrder`             |
| `src/cli/commands/init.ts`            | registered as `init`                                                                    |
| `src/cli/commands/doctor.ts`          | registered as `doctor`                                                                  |
| `src/cli/format-install-result.ts`    | `formatInstallResult`                                                                   |
| `src/cli/format-diagnosis.ts`         | `formatDiagnosis`                                                                       |

`CliContext` gained `nodeVersion`, supplied by the bin entry as
`process.versions.node`, so `doctor` can compare against
`REQUIRED_NODE_VERSION` without any module but `src/cli/index.ts` touching
`process`. `SAILOR_ERROR_KINDS` gained `git-config-failed`, mapped to exit 5.

## Verified against a throwaway repository

Acceptance criteria 1–6 from the A–D handoff were demonstrated by hand against
a temporary Git project, not only by tests:

1. `sailor init` left the host `package.json` and `eslint.config.js`
   byte-identical.
2. The footprint was `.sailor/` plus one local Git setting,
   `core.hooksPath=.sailor/hooks`.
3. A real `git commit` printed the project's own `pre-commit` hook first, then
   the sailor gate, then the project's `commit-msg` hook — which the sailor
   has no gate for and preserved with a pass-through.
4. A `rules/custom/team.yaml` bundle appeared in `rules explain --agent coder`
   and ran as a fifth check at `gate pre-commit`, with no TypeScript change.
5. Making that rule's required check fail blocked a real commit (exit 4).
6. The same failure as a `warning`, `required: false` rule was reported in full
   and the commit landed.

Criterion 7 (hash stability across independent directories) is covered by
`tests/integration/rules/hash-stability.test.ts`.

**All six were re-checked after C1-C3**, against a fresh throwaway TypeScript
project with a real `eslint`, `tsc` and `node --test`, a pre-existing
`.git/hooks/pre-commit` and `commit-msg`, and the C3 build swapped into
`.sailor/node_modules` so the gate ran this code and not the released one.
Same results: host config byte-identical, footprint `.sailor/` plus
`core.hooksPath`, project hook then gate then `commit-msg`, the custom rule as
a fifth check, exit 4 on a real blocked commit, and the warning variant
reported in full while the commit landed. `.sailor/tasks.yaml` is absent after
`init`, as intended.

**Criterion 8** is covered by `tests/integration/tasks/handoffs.test.ts` and was
demonstrated on that project: six agents, six context directories under one
run, each carrying its own `tools`, `writeScopes` and compiled policy.

**Criterion 9** was demonstrated with two separate Node processes driving the
installed runtime. The first created the task, ran the specifier and the coder,
and exited at `implementing`. The second shared nothing with it, read only
`.sailor/tasks.yaml`, reported `draft, specified, awaiting_approval` as done
and the rest as pending, resumed at `implementing`, ran the remaining four
agents, and reached `completed` - with `specified` and `implementing` each
entered exactly once across both processes.

The cross-process lock was demonstrated the same way and then disproved: two
processes racing the same transition from revision 1 produced one write and one
`stale-task-revision` refusal; with `proper-lockfile`'s mutual exclusion patched
out of the installed runtime, both wrote and one was silently lost.

**Criterion 10** is not implemented. See defect 9 below.

## Deviations and known defects

Read these before planning Milestone C. None is hidden by a passing test.

1. ~~`sailor` is unpublished, so a real `sailor init` cannot
   finish.~~ **Fixed.** The private manifest pins a GitHub release tarball
   rather than a registry version, and `v0.1.0` is published. Verified: npm
   resolves the URL, and `sailor init` completes with exit 0 on a real
   project. The failure path was fixed with it — dependencies resolve _before_
   `core.hooksPath` is redirected, so a failed install leaves hooks alone and
   the repository still commits, and the summary prints either way.

2. ~~A project cannot edit `config/project.yaml` or `config/hooks.yaml` and
   then re-run `sailor init`.~~ **Fixed in C0.** Installed files now carry a
   kind. A `seeded` file is written once and never reconciled; ownership is a
   property of the shipped file rather than of the manifest entry, so an
   installation made by an earlier version is reclassified rather than
   migrated. `installSailor` reads the _installed_ `config/hooks.yaml` rather
   than the template, because accepting an edit and then ignoring it would be
   worse than refusing it.

3. **Installing from one linked worktree redirects hooks for the whole
   repository.** `core.hooksPath` is repository-local configuration that Git
   shares across worktrees. The written value is relative so each worktree
   resolves its own `.sailor/hooks`, but a worktree without one then runs no
   hooks at all. Documented in `README.md`; the alternative,
   `extensions.worktreeConfig`, changes repository configuration semantics
   globally and was judged too invasive to enable on a project's behalf.

4. ~~`discoverProjectProfile` still hardcodes `validationMode`.~~ **Fixed in
   C0**, together with defect 2, since both are about reading a file the
   project owns. The profile now reports the installed `validationMode`, and a
   `packageManager` pin there wins over the host manifest's field. **Still
   open: nothing acts on `validationMode`.** It is carried on the profile and
   reported, but no gate filters on it, so `native-only` and `sailor-only`
   currently describe an intent the runtime does not honour. Deciding what they
   filter — rule origin is the obvious axis — is open work, and is a change to
   gate behaviour rather than to discovery.

5. **`config/models.yaml` and `config/providers.yaml` remain deferred to
   Milestone D**, which validates provider flags against a real CLI `--help`.

6. ~~There is no CI.~~ **Fixed, and now actually executing.** Both workflows
   are real: `.github/workflows/ci.yml` for this repository, and
   `.sailor/ci/github-actions.yml` shipped for installed projects to copy into
   `.github/workflows/` themselves — the sailor cannot place it, because
   `.github/` is outside the `.sailor/` boundary decision 1 forbids crossing.
   `sailor doctor` reports its absence as a warning. The Node version is
   pinned rather than read from `engines.node`, because that field is a range
   and `setup-node` resolves a range to the newest match, so the declared floor
   would never have run; a test asserts the pin still equals the floor.

   The shipped workflow is the **one thing still unexercised against a real
   project** — it needs a GitHub remote to run.

7. ~~`package.json` declares MIT with no `LICENSE` file.~~ **Fixed.** MIT
   `LICENSE`, `author`, and `LICENSE` in the published `files`.

8. **Nothing drives the workflow from the command line.** C1-C3 are a library:
   `createTask`, `approveSpecification`, `transitionTask`, `writeAgentContext`
   and `updateTaskFile` are exported and tested, but no `sailor task` command
   exists and no agent is ever invoked. That is deliberate - the B1 command set
   is `init`, `doctor`, `rules validate`, `rules explain` and `gate <phase>`,
   and the thing that would call these is the Milestone D runtime - but it does
   mean acceptance criterion 9 was demonstrated by driving the installed
   runtime from two Node processes rather than through a shipped command.

9. **Acceptance criterion 10 is not implemented.** QA can reach `completed`
   with no Gherkin evidence, no executable QA-procedure result and no recorded
   notification, because none of those three things exists yet: the
   notification adapter is Milestone D, and there is no artifact contract to
   check the other two against. `transitionTask` records `gateReportIds` and
   `artifactPaths` on every transition, which is the hook a later completion
   guard will read, but it does not require them.

10. **`validationMode` is still inert**, unchanged from defect 4 above. C1-C3
    did not touch gate behaviour.

11. **`proper-lockfile@4.1.2` pins a transitive major that has moved on, and
    there is nothing to do about it.** It depends on `signal-exit@^3.0.2` while
    `signal-exit` is at `4.1.0`, and on `retry@^0.12.0` while `retry` is at
    `0.13.1`, so the production tree carries `signal-exit@3.0.7` and
    `retry@0.12.0`. `4.1.2` is the latest published `proper-lockfile`, so there
    is no upgrade to take, and the pins are its own.

    Recorded so it is not rediscovered as a finding. Nothing here is a
    vulnerability or a deprecation: `npm audit --omit=dev` reports zero
    vulnerabilities, and `npm ci --dry-run --ignore-scripts` over the whole
    423-package tree prints no deprecation warning at all. The registry carries
    no `deprecated` field on `signal-exit@3.0.7`, on `signal-exit@4.1.0`, or on
    any version of the four other production packages except `graceful-fs`,
    whose deprecated versions are its 1.x-3.x line and `4.2.7` - none of them
    the `4.2.11` installed here. A review that reads "deprecated" from a stale
    major is reading something that is not there.

    Do not churn the dependency tree over it. Overriding `signal-exit` to `4.x`
    would replace a version `proper-lockfile` is tested against with one it is
    not, to fix a warning nothing emits. `proper-lockfile` uses it to remove a
    held lock when the process exits, which is the part of the lock protocol
    the sailor picked a reviewed library for in the first place. The condition
    that would change this is `proper-lockfile` publishing a release that moves
    the pin, or one of these acquiring a real advisory.

## Traps this repository will spring on you

The first five are carried forward and still bite. Trap 6 cost one session a
corrupted branch, and traps 15 to 17 are the working habits that caught the
rest.

1. **`import.meta.url` does not work under Jest.** `tsconfig.test.json`
   transpiles to CommonJS for ts-jest while the build emits NodeNext ESM. The
   package root is injected as `packageRootDirectory: string` and resolved in
   exactly one place — `src/cli/index.ts`, which no test imports. `nodeVersion`
   now travels the same way.
2. **A type-only module reports 0% coverage.** Declare types beside the values
   they describe.
3. **`src/index.ts` barrel re-exports count as functions.**
   `tests/unit/index.test.ts` holds an explicit `PUBLIC_API` list — now 144
   entries — that must be updated whenever an export is added.
4. **Never weaken a gate.** `AGENTS.md` forbids it. No lowered threshold, no
   ignore comment, no `--no-verify`.
5. **`exactOptionalPropertyTypes` is on.** `{ timeoutMs }` where `timeoutMs` is
   `number | undefined` will not satisfy `timeoutMs?: number`. Spread
   conditionally: `...(x === undefined ? {} : { x })`.
6. **A test that spawns `git` must scrub `GIT_*` from the environment first.**
   Git exports `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` to the hooks it
   runs, and `.husky/pre-commit` runs the whole suite. The first attempt at
   `966808b` therefore ran its fixtures against _this_ repository: it rewrote
   the branch HEAD to a one-file commit, created a stray `feature` branch and
   registered a worktree pointing into `/tmp`. Recovery was
   `git reset --mixed`, `git worktree prune`, `git branch -D`. Use
   `tests/helpers/git.ts` — `runGit`, `initRepository` and `cleanEnvironment` —
   which strips those variables and asserts that Git resolves a fixture to the
   fixture.

   **This changed, and the old note was wrong to treat it as a safety
   property.** `nodeCommandRunner` now forwards `GIT_INDEX_FILE`, and only that
   one. Stripping it made the shipped `git diff --check --cached` read the
   stale on-disk index during `git commit -- <path>`, so it passed while
   conflict markers went into the commit. `GIT_DIR`, `GIT_WORK_TREE` and
   `GIT_PREFIX` are deliberately **not** forwarded: every command runs with an
   explicit absolute cwd, and forwarding them broke thirteen tests the moment
   the suite ran under this repository's own hook, because fixtures inherited
   _this_ repository. A test driving the runner against a fixture must build it
   with `baseEnv: cleanEnvironment()`.

7. **`tests/unit/install/sailor-templates.test.ts` asserts the exact list of
   shipped template paths**, currently 14, _and_ the exact list of seeded ones.
   Adding a template fails both on purpose: the second is what forces a
   decision about who owns the new file. `bin/sailor` and `hooks/*` are
   generated, not templates, and are in neither list.
8. **Seeding is only safe because every key in both config schemas has a
   default.** A seeded file written by an older sailor must still parse when a
   later one adds a key. `shipped-templates.test.ts` asserts that
   `version: 1` alone validates; do not add a required key to either schema.
9. **`buildSailorProject()` creates `.sailor/` and nothing inside it.** Pass
   `files: { ".sailor/…": … }` for content. The directory itself is what says
   a project is installed - `withTaskLock` reports `not-installed` without it -
   so a fixture standing in for an uninstalled project is a bare
   `createTempDirectory`, not this.
10. **`prettier --check .` covers the whole repository**, templates included.
11. **Yarn and Bun are not installed on this machine**; pnpm is. Prove their
    behaviour through argument-vector unit tests.
12. **`.husky/pre-commit` runs the full gate against the working tree**, not
    the index. To verify a commit on its own, move unrelated files aside first.
    It is also skippable with `--no-verify`; `.github/workflows/ci.yml` is what
    actually enforces the gate, and
    `tests/integration/ci/workflow.test.ts` asserts its exact command list so a
    step cannot be dropped from it quietly.
13. **A test that spawns git must never write an identity with `git config`.**
    `tests/helpers/git.ts` passes `-c user.name` / `-c user.email` per
    invocation instead. A fixture that wrote them with `git config` put them in
    _this_ repository's `.git/config`, where they went on to author four real
    commits as "Sailor Test" before anyone noticed.
14. **This is a Git worktree and the stash stack is shared.** Never use bare
    `git stash` / `git stash pop`. Prefer a temporary WIP commit.
15. **Run the suite under a simulated hook environment before committing.**
    `GIT_DIR=$PWD/.git GIT_WORK_TREE=$PWD GIT_INDEX_FILE=$PWD/.git/index npx jest`.
    The suite passing under a bare `npx jest` proves less than it looks:
    `.husky/pre-commit` runs it with those set, and a change can be green one
    way and red the other. This is how the over-wide allowlist was caught.
16. **Prove a test can fail before trusting it.** A review found eighteen tests
    whose names promised more than their bodies checked, several of which could
    not fail at all. When adding or changing one, apply the mutation it is
    meant to catch and watch it go red. Several existing tests were green
    against the very regression they existed to prevent.
17. **A scripted `str.replace` that does not match fails silently.** Two edits
    this session did nothing because Prettier had reflowed the text being
    matched, and one of them left a handoff claiming a defect was fixed when
    the document still described it as open. Verify the rewrite landed.

## Milestone C scope

Verbatim from `docs/handoff/rule-enforcement.md`, plus defect 2 above.

Use `yaml` for `.sailor/tasks.yaml`. Add robust atomic writing and locking;
prefer reviewed libraries such as `proper-lockfile` and `write-file-atomic`
rather than inventing an incomplete lock protocol. `writeFileAtomic` already
handles the atomic rename for single managed files, but it takes no lock.

Implement these states:

```text
draft -> specified -> awaiting_approval -> implementing -> cleaning
      -> architecture_review -> hardening -> qa -> completed
```

Every active state may transition to `blocked` or `failed`, and only valid
recovery transitions may leave them. The coder cannot start before explicit
specification approval.

Each transition stores the task revision and the expected prior revision, the
source and target agent, the resolved rule-set SHA-256, gate report IDs and
artifact paths, timestamps, attempt number, failure details, and the
next-agent context path. Reject stale-revision writes.

Contexts live at `.sailor/state/runs/<run-id>/agents/<agent-id>/` and must
never be shared by reference as one mutable global context.

`tasks.yaml` is deliberately **not** ignored by the shipped `.gitignore`, so
task state is reviewable in a pull request. `state/` is ignored.

C0 already answered the question C1 has to answer again: `tasks.yaml` is
neither managed nor seeded — the sailor writes it continuously and the project
never hand-edits it. It should not go through `planInstallation` at all.

## What C1-C3 added

| Module                          | Public surface                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sailor/project-path.ts`    | `projectRelativePathSchema`, `projectRelativeGlobSchema`                                                                                                                  |
| `src/tasks/task-schema.ts`      | `TASK_STATES`, `WORKFLOW_STATES`, `INTERRUPTED_STATES`, `taskSchema`, `taskFileSchema`, `transitionRecordSchema`, `taskFailureSchema`, `runIdSchema`, `taskIdSchema`      |
| `src/tasks/task-file.ts`        | `readTaskFile`, `writeTaskFile`, `taskFilePath`, `emptyTaskFile`, `findTask`, `requireTask`, `TASK_FILE_SOURCE`                                                           |
| `src/tasks/task-lock.ts`        | `withTaskLock`, `TASK_LOCK_DEFAULTS`                                                                                                                                      |
| `src/tasks/update-task-file.ts` | `updateTaskFile`                                                                                                                                                          |
| `src/tasks/workflow.ts`         | `allowedTransitions`, `completedStages`, `pendingStages`, `currentStage`, `nextWorkflowState`, `ACTIVE_STATES`, `TERMINAL_STATE`, `isWorkflowState`, `isInterruptedState` |
| `src/tasks/transition-task.ts`  | `createTask`, `approveSpecification`, `transitionTask`, `createDefaultRunId`                                                                                              |
| `src/tasks/agent-context.ts`    | `buildAgentContext`, `writeAgentContext`, `readAgentContext`, `agentContextDirectory`, `agentContextFile`, `agentContextSchema`, `contextHandoffSchema`                   |

`SAILOR_ERROR_KINDS` gained `invalid-transition`, `stale-task-revision`,
`task-lock-failed` (all exit 5) and `unknown-task` (exit 3). `SAILOR_PATHS`
gained `tasks` and `runs`. `proper-lockfile` is a new runtime dependency;
`@types/proper-lockfile` is a new dev dependency. `npm audit` reports zero
vulnerabilities.

## Decisions C1-C3 took where the specification was silent

Each of these is a reading the specification does not fix. They are recorded
here rather than left to be re-derived from the code.

1. **Recovery targets.** "Only valid recovery transitions may leave them" is
   read as: the stage the task was interrupted in, or **any stage before it**,
   and never one after. The narrower reading - back only to where it stopped -
   cannot express rework, so a failed QA could re-run QA but could never reach
   the coder, and the pipeline would have no way to fix what it found. The
   invariants that matter survive: nothing skips a stage it has not run, and
   recovery can never reach `completed`, because an interrupted task always
   stopped at an active state.

2. **A retry mints a new run id.** The context layout
   `.sailor/state/runs/<run-id>/agents/<agent-id>/` is fixed by the design and
   has no room for an attempt, so reusing the run would have a second attempt
   overwrite the record of the first. A transition out of `failed` therefore
   starts a new run; resuming out of `blocked` keeps the old one, because
   nothing was discarded. The id is injected (`newRunId`), like `now` and
   `createReportId` elsewhere.

3. **Approval is its own revision.** "The coder cannot start before explicit
   specification approval" is enforced by `approveSpecification`, a separate
   call that bumps the revision and records `approvedAt` and `approvedBy`.
   Accepting the approval as an argument to the transition that starts the
   coder would mean it was granted by whoever wanted the work started. It
   appears in `history` as the one record where `from` equals `to`, which keeps
   the history total over revisions. Re-entering `draft` or `specified`
   withdraws it.

4. **`blocked` and `failed` must both record a reason**, and a transition back
   into the pipeline must not carry one. `blocked -> failed` is an edge;
   `failed -> blocked` is not.

5. **Every state has one owning agent, or none.** The specification fixes nine
   states and six agents and never maps one to the other, and nothing checked
   the pairing, so a transition to `implementing` recording `qa` was accepted
   and the coder's stage would have run under QA's tool policy. `STATE_AGENTS`
   is now that mapping, total over every state and enforced on the transition
   that records it and on the task the file carries. `specified` is the
   specifier's; `draft`, `awaiting_approval`, `completed`, `blocked` and
   `failed` own nobody. A project-defined agent id still validates, because a
   rule may target one, but cannot own a state. History is deliberately not
   validated against the mapping: it records what was believed at the time.

6. **Locking, and what was not adopted.** `proper-lockfile` is used, as the
   design suggests. `write-file-atomic` is **not**: the repository already has
   `writeFileAtomic`, and a second atomic-write implementation would give the
   installer and the task store different semantics for one operation. What
   that library had and this did not was the flush, so `writeFileAtomic` now
   `fsync`s the temporary before the rename - which is exactly what
   `write-file-atomic` does - and moved to `src/sailor/`, since task state has
   no business importing from `src/install/`. `proper-lockfile`'s default
   `onCompromised` throws from a timer callback, which is an uncaught exception
   that takes the process down; it is replaced with one that records the loss
   and reports it as an error the caller can act on.

## Commit boundaries

| Step | Subject                                               | State |
| ---- | ----------------------------------------------------- | ----- |
| B3   | `Install the sailor into a project idempotently`      | done  |
| B4   | `Dispatch Git hooks without discarding existing ones` | done  |
| C0   | `Separate seeded configuration from managed files`    | done  |
| C1   | `Store task state atomically`                         | done  |
| C2   | `Enforce workflow transitions`                        | done  |
| C3   | `Isolate agent contexts across handoffs`              | done  |

## Completion gate

```sh
npm run check
npm run build
npm run test:coverage
npm pack --dry-run
```

Then demonstrate acceptance criterion 9 — a stopped workflow resumes from
`tasks.yaml` without rerunning completed stages — against a throwaway Git
repository, and re-check criteria 1–6, which the installer must not regress.

Report any deviation directly. Do not describe partial work as complete.

## What Milestone D starts from

C1-C3 are library only. What does not exist yet, in the order a runtime needs
it:

- a `ProviderAdapter` and the Codex and Claude implementations behind it,
  written against a real CLI `--help` rather than guessed flags;
- runtime enforcement of `context.tools`, `writeScopes` and `projectScripts` -
  they are written into every context and nothing reads them;
- a completion guard for acceptance criterion 10;
- `config/models.yaml` and `config/providers.yaml`;
- whatever drives all of it: a `sailor task` command set, or a runtime the
  adapters are called from. Two Node scripts were enough to demonstrate
  criterion 9; they are not a product.

## Starting prompt

> Continue Sailor in the worktree
> `<PROJECTS>/sailor-codex-basic-structure`. Start from `main` and cut
> a new branch for this work. Read `AGENTS.md`, `README.md`,
> `docs/handoff/rule-enforcement.md` and `docs/handoff/milestone-c.md`
> completely before writing code. Milestones A, B and C are committed and
> verified against a real project; `v0.1.0` is the released installer, and C
> has not been released. Implement Milestone D, test-first. Inspect the
> installed Codex and Claude CLI `--help` before writing a single provider
> flag; never call a live API from a test. Run the completion gate and report
> any deviation directly.
