# Milestone D6 handoff: the driver, and the command that runs it

## How to start

Open a new session in a worktree cut from this branch and paste the prompt at
the end. Read `AGENTS.md`, `README.md`, `docs/handoff/rule-enforcement.md`
(the original A-D design), `docs/handoff/milestone-d.md` (D1, D2, the QA
completion guard and the Milestone C findings), `docs/handoff/milestone-d3.md`
(the Claude adapter) and `docs/handoff/milestone-d5.md` (provider and model
configuration) completely before writing code. `docs/handoff/milestone-c.md`
holds the standing trap list.

## Where things stand

- Branch: `milestone-d6`, cut from `main` at `678edc1` (PR #6 merged).
  Milestone branches no longer carry a vendor name; `codex/*` was the old
  convention and the branches that still use it are merged history.
- Local gate at `c287280`: `npm run check`, `npm run build`,
  `npm run test:coverage` and `npm pack --dry-run` all pass; **1046 tests
  across 90 suites at 98.78% statements**, verified under the simulated hook
  environment. `PUBLIC_API` is 318 entries.
- Milestones A, B, C, D1, D2, D3, D5, the QA completion guard and now **D6**
  are done. **D4 is still unwritten**: `codex` is not installed on this
  machine, and the design forbids guessing provider flags.
- **The `v0.2.0` release is still not cut.** `package.json` and
  `package-lock.json` say `0.2.0`; tagging and attaching the tarball `npm
pack` produces is a person's act. Until it exists, any `sailor init` has to
  point `sailorReleaseTarballUrl` at a locally packed tarball, as the live
  demonstration below did.

## What D6 added

Six commits on top of the handoff commit:

| Commit    | Subject                                                  |
| --------- | -------------------------------------------------------- |
| `086a5a4` | Carry an agent's name and purpose into its context       |
| `d46fe43` | Refuse a context path its run and agent do not name      |
| `24c6b3a` | Drive a task through its agents                          |
| `686491d` | Run a task through its agents from the command line      |
| `c9d1466` | Let a search look in the project root                    |
| `c287280` | Ignore the tarball `npm pack` writes into the repository |

| Module                             | Public surface                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/runtime/drive-task.ts`        | `DEFAULT_AGENT_TIMEOUT_MS`, `DRIVE_DESTINATION`, `DRIVEN_STAGE_STATUSES`, `HANDOFF_GATE_PHASE`, `driveTask`, and the `DriveTaskOptions`/`DriveTaskResult`/`DrivenStage` types |
| `src/runtime/provider-adapters.ts` | `hasProviderAdapter`, `requireProviderAdapters`, `createProviderAdapter`                                                                                                      |
| `src/runtime/installed-agents.ts`  | `installedAgentPath`, `readInstalledAgentDefinition`                                                                                                                          |
| `src/tasks/context-path.ts`        | `AGENT_CONTEXT_FILE`, `agentContextDirectory`, `agentContextFile`, moved out of `agent-context.ts` and re-exported from it                                                    |
| `src/cli/format-drive-result.ts`   | `formatDriveResult`                                                                                                                                                           |
| `src/cli/commands/run-task.ts`     | the `run` handler; registered, never imported elsewhere                                                                                                                       |
| `src/tasks/transition-task.ts`     | `runIdForTransition`                                                                                                                                                          |

`AGENT_CONTEXT_VERSION` is 2. `AgentContext` and `AgentInvocation` gained
`displayName` and `summary`. `CliContext` gained `nodeExecutable`.
`CliInvocation` gained `taskId`. `CLI_COMMANDS` gained `run`. No error kind
and no exit code was added. `README.md`'s "Driving a task" section is the
reference; what follows is what it does not say.

### Decisions taken where the design was silent

1. **The driver runs the agent that owns the stage the task stands in, and
   enters the next stage by a handoff.** So one turn is: enter, run, audit,
   gate, and the next turn's entry carries the gate's report. The stage the
   run starts in is not entered again - being in a stage is not having
   finished it, which is what `pendingStages` already said - and
   `awaiting_approval`, the only stage in range that no agent owns, hands off
   with neither a run nor a gate. The work before it was gated by the handoff
   that put the task there, and that handoff is not the driver's.
2. **It records the transition first and writes the context second, both
   under one task lock.** `runIdForTransition` is asked once and its answer
   handed straight back as `newRunId`, so the run is decided before the
   context path is derived from it and there is no second id for the two to
   disagree about. Writing second also means the context is built from the
   task the transition produced, which `buildAgentInvocation` accepts as one
   of the two ends of a handoff; and if the write throws, the mutator throws,
   so a task never names a context nobody wrote.
3. **A blocked gate is `blocked` and everything else is `failed`.** The two
   interrupted states differ in exactly one mechanical way - what
   `runIdForTransition` does on the way out - so the split had to be about
   whether the attempt is discarded. A gate that blocked leaves the work on
   disk and names what failed, and a person who fixes it resumes the stage the
   task stopped in, keeping the run. A run that did not finish, a tree outside
   the write scopes, and a tool that skipped the gate all produced no handoff:
   the next attempt replaces this one and starts a run of its own.
4. **The driver holds a working-tree snapshot of its own.** A
   `tool-gate-failed` refusal is thrown rather than finished, so
   `recordAuditedAgentRun` never reaches its second snapshot; the D1 comment
   says plainly that the tree such a run left is the runtime's to deal with.
   This is that runtime, so it snapshots before calling the wrapper and audits
   against that when there is no record to audit with. The recorded failure
   names the changed paths and says that nothing has been undone.
5. **It starts only from `awaiting_approval` or a stage an agent owns.**
   `draft` and `specified` sit before an approval, which is a person's act;
   `completed` is over; and which stage a `blocked` or `failed` task recovers
   into is exactly the judgement that stopping it was for. Refusing is
   `invalid-transition`, which already exits 5.
6. **A provider with no adapter is refused for every agent the run would
   reach, not the one about to start.** An installation that routes the
   hardener to `codex` would otherwise run the coder and the cleaner for real
   and stop three stages in on a fact that was in the file all along. It is a
   fact about the package rather than the machine, so nothing is probed;
   `hasProviderAdapter` reads `PROVIDER_CLI_VERSIONS`, which is where D5 put
   it, and a test holds it and `createProviderAdapter` to the same answer.
7. **The context is rebuilt when this machine does not have it.** A run
   resumed from a fresh checkout finds the path in `tasks.yaml` and no file
   behind it, and everything in a context is derived from things that are
   tracked. `readAgentContext` already distinguished absence from damage,
   which is what makes rebuilding safe; a damaged context is still an error.
8. **The agent's summary and display name travel in the context, and the
   version went to 2.** They could have been defaulted, but a defaulted
   summary leaves a prompt silently saying nothing about the role, and a
   context is machine-local scratch that the run rewrites - so refusing an
   older one costs a rebuild and no recorded fact.
9. **`sailor run` adds no exit code.** Reaching `qa` is `0`; a `pre-handoff`
   gate blocking a handoff is the same `4` that `sailor gate` exits with for
   the same failing check on the same phase; every other stop is `5`, an
   action the sailor understood, would not take, and recorded a reason for.
   Stages are printed to stderr as they settle, because an agent run is
   minutes long and a command printing nothing until the end looks hung.
10. **`createProviderAdapter` takes an optional `toolGate`.** Where a
    provider's gate program lives is a fact about the installation - `dist/`
    inside the installed package - and a suite running against this source
    tree has none. It defaults to the built path; the tests pass the source.
    A gate that could not start would let every tool call through unexamined,
    so this is not a detail a test could skip.

### Findings 1 and 2, made unmakeable

`taskSchema` now holds a task's `contextPath` to the path its own `runId` and
`agentId` name, and `transitionTask` validates the task it produces, so a
context written under the run a retry replaced is refused where it is
introduced rather than found later by whatever tried to build an invocation.
`buildAgentInvocation`'s own check on that pair stays: a `Task` reaches it
from a caller that may have assembled one rather than read it.

`runIdForTransition` is now the whole of the rule about which move starts a
new run, and it closed finding 2 as well: a recovery out of `blocked` that
targets a stage **before** the one the task stopped in is rework, it discards,
and it mints a run of its own. `blocked -> failed` and a blocked task resuming
where it stopped both keep the run, because neither restarts anything.

The function is exported because the driver has to know the answer before it
writes the context, and it is the same function the transition asks.

### Two defects the demonstration found

1. **A search could not look in the project root** (`c9d1466`, fixed). The
   CLI globs `*` with `path` set to the project root; re-expressing the root
   from the root gives the empty string, which `toProjectRelativePath` reports
   as outside - right for a write, since there is no file called "the
   project", and wrong for a directory to search. It was denied as
   `outside-project` on the first live run. This is D3's code and the fix is
   in the search branch alone.
2. **Re-running a stage overwrites the record of the previous run of it**
   (open, see below). Running `sailor run greeting` a second time on a task
   already standing in `qa` ran the QA agent again - correctly, by the
   driver's own rule that being in a stage is not having finished it - but no
   transition happened, so the attempt stayed 1, and the adapter starts each
   attempt's decision log and transcript empty. The first QA run's transcript
   is gone. It cost USD 0.13 nobody asked for, too.

## The live demonstration

By hand, against a throwaway git repository, through the sailor **installed
in the project** rather than the development tree.

**One deviation, the one the D5 handoff anticipated.** `v0.2.0` is not
released, so `sailorReleaseTarballUrl` was pointed at the locally packed
`sailor-0.2.0.tgz` in an _extracted copy_ of that tarball - one function, in a
throwaway extraction, nothing in the repository. With that, `sailor init`
completed for real: 21 files created, hooks dispatched, runtime dependencies
resolved, exit 0.

The project is a small TypeScript one with real `build`, `lint`, `test` and
`typecheck` scripts (`tsc`, `eslint`, `node --test` over
`--experimental-strip-types`), a spec at `docs/specs/greeting.md`, an accepted
feature file and an accepted QA procedure. `models.yaml` was edited to
`sonnet` for both high profiles and `providers.yaml` to `maxBudgetUsd: 4`, so
the run proves the configuration was read. `sailor doctor`: 0 problems, 2
warnings (notifications, CI), `Provider — claude 2.1.263 (Claude Code)`.

The task was created and approved through the installed library, because
**there is no command for either yet** - see the open items.

```text
$ .sailor/bin/sailor run greeting
[handed-off] implementing — coder
[handed-off] cleaning — cleaner
[handed-off] architecture_review — architect
[handed-off] hardening — hardener
[reached] qa — qa

Task: greeting — Add a greeting helper
Run: run-1
State: qa (revision 9)

  DONE implementing — coder on claude, attempt 1: exited with code 0
       changed: src/greeting.ts, tests/greeting.test.ts
       pre-handoff gates passed: ff05c1ff-e7ca-4397-b358-45d1b9eb9f47
  DONE cleaning — cleaner on claude, attempt 1: exited with code 0
       pre-handoff gates passed: 8539e9ad-4e12-48fa-877b-2ca0ffcc75c6
  DONE architecture_review — architect on claude, attempt 1: exited with code 0
       pre-handoff gates passed: 98823d79-68b1-4a6b-9053-db20d43a7d84
  DONE hardening — hardener on claude, attempt 1: exited with code 0
       changed: tests/greeting.test.ts
       pre-handoff gates passed: 403c83e5-ff6a-42af-b92b-59339f66009f
  QA   qa — qa on claude, attempt 1: exited with code 0

Result: reached `qa` after 5 agents
exit=0
```

Five agents, 4m 12s of model time, **USD 0.63** in total on `sonnet` (coder
0.096, cleaner 0.070, architect 0.133, hardener 0.177, qa 0.157), 73 gate
decisions, 8 of them denials.

### What the gate decided

Every tool call of every agent, verbatim from the decision logs. The
denials are the interesting part: seven `not-a-project-script` and, before it
was fixed, one `outside-project`.

```text
=== coder (17 decisions) ===
[read] .sailor/state/runs/run-1/agents/coder/context.json -> allowed
[execute] cat .../.sailor/tasks.yaml -> denied (not-a-project-script)
[execute] sh -c ls -la ... && ls -la .../src .../tests 2>/dev/null -> denied (not-a-project-script)
[read] .sailor/tasks.yaml -> allowed
[search] **/* -> allowed
[read] docs/specs/greeting.md -> allowed
[read] features/greeting.feature -> allowed
[read] docs/qa/greeting.yaml -> allowed
[read] src/placeholder.ts -> allowed
[search] * -> denied (outside-project)          # the defect, now fixed
[read] tests/placeholder.test.ts -> allowed
[write] src/greeting.ts -> allowed
[write] tests/greeting.test.ts -> allowed
[execute] npm run test -> allowed
[execute] npm run lint -> allowed
[execute] npm run typecheck -> allowed

=== cleaner (8 decisions) ===
[read] .sailor/state/runs/run-1/agents/cleaner/context.json -> allowed
[read] src/greeting.ts -> allowed
[read] tests/greeting.test.ts -> allowed
[read] .sailor/state/runs/run-1/reports/ff05c1ff-....json -> allowed
[execute] sh -c npm run test && npm run lint && npm run typecheck -> denied (not-a-project-script)
[execute] npm run test -> allowed
[execute] npm run lint -> allowed
[execute] npm run typecheck -> allowed

=== architect (17 decisions) ===
[read] .sailor/state/runs/run-1/agents/architect/context.json -> allowed
[read] .sailor/state/runs/run-1/reports/8539e9ad-....json -> allowed
[read] tests/greeting.test.ts -> allowed
[read] src/greeting.ts -> allowed
[search] **/* -> allowed
[read] package.json -> allowed
[read] .sailor/tasks.yaml -> allowed
[read] src/placeholder.ts -> allowed
[search] features/greeting.feature -> allowed
[read] tests/placeholder.test.ts -> allowed
[search] docs/qa/greeting.yaml -> allowed
[search] docs/specs/greeting.md -> allowed
[read] features/greeting.feature -> allowed
[read] docs/qa/greeting.yaml -> allowed
[read] docs/specs/greeting.md -> allowed
[write] .sailor/state/runs/run-1/agents/architect/notes.md -> allowed

=== hardener (16 decisions) ===
[execute] cat .sailor/state/runs/run-1/agents/hardener/context.json -> denied (not-a-project-script)
[read] src/greeting.ts -> allowed
[read] tests/greeting.test.ts -> allowed
[read] .sailor/state/runs/run-1/agents/hardener/context.json -> allowed
[read] .sailor/tasks.yaml -> allowed
[read] .sailor/state/runs/run-1/reports/98823d79-....json -> allowed
[execute] sh -c find features docs/qa docs/specs -type f 2>/dev/null | xargs -I{} echo {} -> denied (not-a-project-script)
[search] docs/** -> allowed
[search] features/** -> allowed
[read] features/greeting.feature -> allowed
[read] docs/specs/greeting.md -> allowed
[read] docs/qa/greeting.yaml -> allowed
[read] package.json -> allowed
[write] tests/greeting.test.ts -> allowed
[execute] npm run test -> allowed
[execute] npm run typecheck -> allowed

=== qa (15 decisions) ===
[read] .sailor/state/runs/run-1/agents/qa/context.json -> allowed
[read] .sailor/state/runs/run-1/reports/403c83e5-....json -> allowed
[read] src/greeting.ts -> allowed
[read] tests/greeting.test.ts -> allowed
[execute] sh -c git status && git diff --stat HEAD -> denied (not-a-project-script)
[read] .sailor/tasks.yaml -> allowed
[execute] npm run test -> allowed
[execute] sh -c find features docs/qa -type f 2>/dev/null -> denied (not-a-project-script)
[search] features/** -> allowed
[search] docs/qa/** -> allowed
[read] features/greeting.feature -> allowed
[read] docs/qa/greeting.yaml -> allowed
[search] tests/** -> allowed
[execute] npm run build -> allowed
[write] .sailor/state/runs/run-1/agents/qa/notes.md -> allowed
```

The architect has `edit: false` and no write scope, and wrote its findings to
its own scratch directory - which is decision 2 of D1/D2 doing exactly what it
was written for. QA did the same. No agent wrote a project file outside its
scopes, and every audit came back clean.

### The transitions the driver recorded

`.sailor/tasks.yaml`, revisions 5 to 9, abridged to the fields that make the
point:

```yaml
- revision: 5
  from: awaiting_approval
  to: implementing
  fromAgent: null
  toAgent: coder
  gateReportIds: [] # nobody handed off into this one
  contextPath: .sailor/state/runs/run-1/agents/coder
- revision: 6
  from: implementing
  to: cleaning
  fromAgent: coder
  toAgent: cleaner
  gateReportIds: [ff05c1ff-e7ca-4397-b358-45d1b9eb9f47]
  artifactPaths:
    [.sailor/state/runs/run-1/reports/ff05c1ff-e7ca-4397-b358-45d1b9eb9f47.json]
  contextPath: .sailor/state/runs/run-1/agents/cleaner
- revision: 7
  from: cleaning
  to: architecture_review
  toAgent: architect
  gateReportIds: [8539e9ad-4e12-48fa-877b-2ca0ffcc75c6]
  contextPath: .sailor/state/runs/run-1/agents/architect
- revision: 8
  from: architecture_review
  to: hardening
  toAgent: hardener
  gateReportIds: [98823d79-68b1-4a6b-9053-db20d43a7d84]
  contextPath: .sailor/state/runs/run-1/agents/hardener
- revision: 9
  from: hardening
  to: qa
  toAgent: qa
  gateReportIds: [403c83e5-ff6a-42af-b92b-59339f66009f]
  contextPath: .sailor/state/runs/run-1/agents/qa
```

Every `contextPath` is the one its own `runId` and `agentId` name, which the
schema now requires. Every handoff after the first carries the report of the
gates that let it happen, and each report is on disk under the run.

### What came out of it

`src/greeting.ts` and `tests/greeting.test.ts`, nothing else in the project
tree, and `npm run test`, `lint`, `typecheck` and `build` all green afterwards

- 9 tests, up from the coder's 3, because the hardener added six edge cases
  without touching the production code, which is exactly its definition.

### The two refusals, also live

```text
$ .sailor/bin/sailor run second        # a task in `draft`
sailor: task `second` is `draft`, which the driver does not start from
  nothing has specified it yet
  the driver takes a task from `awaiting_approval` to `qa`
exit=5

$ .sailor/bin/sailor run greeting      # with `default: codex`
sailor: this run cannot be driven with the providers it is configured to use
  this sailor has no adapter for codex, so no agent can be run on it whether or not its CLI is installed: `qa`
exit=3
```

Nothing was spawned for either. `sailor doctor` reports the second the same
way, which is the wording being shared on purpose.

One thing the refusals taught: with the task already at `qa`, routing
**`hardener`** to `codex` did not refuse anything, because the hardener is
behind the task and `remainingAgents` is only what the run would still reach.
That is decision 6 working, and it is worth knowing before someone reads it as
a hole.

## Open, after D6

1. **Re-running a task that already stands in a stage re-runs it, and
   overwrites the previous run's record.** The driver's rule is right - a run
   killed half way through `implementing` has to resume there - but nothing on
   the task says whether that stage's agent has finished, so `sailor run` on a
   task already in `qa` runs QA again, at cost, and the adapter starts
   `attempt-1.transcript.jsonl` empty because no transition bumped the
   attempt. Two candidate answers, and the choice is a design decision:
   record on the task that a stage's run completed (a new field, and the
   thing `pendingStages` is missing), or number the adapter's files per
   invocation rather than per attempt. Doing neither is not an option: the
   second run silently destroyed the first's transcript.
2. **Nothing creates or approves a task from the command line.** `sailor run`
   is the only task command, so the demonstration had to reach for the
   installed library to get to `awaiting_approval`. `task create`,
   `task approve` and `task show` are the obvious shape, and approval takes an
   acceptance, which is more than a flag.
3. **`sailor run` cannot complete a task.** `completeTask` exists and is
   tested; `qa -> completed` has no command. That is the natural companion to
   2 and probably the same session.
4. **D4** stays unwritten: `codex` is still not installed.
5. **The `v0.2.0` release is still not cut**, so `sailor init` from `main`
   fails at the dependency step and any re-check needs the local-tarball
   trick.
6. `validationMode` still filters nothing, and findings 3 to 7 from the
   Milestone C review are untouched.
7. The driver has no `--from`/`--until`: it always runs to `qa`. Stopping
   after one agent would help a person watching a new project's first task,
   and it is a flag rather than a design.
8. A run cannot be aborted from the terminal. `driveTask` takes a signal and
   `nodeCommandRunner` honours it, but `sailor run` wires no `SIGINT` to it,
   so Ctrl-C kills the sailor and leaves the provider's process to the shell.

## Traps

The lists in `milestone-c.md`, `milestone-d.md`, `milestone-d3.md` and
`milestone-d5.md` still hold. New here:

1. **A test cannot use the built tool gate.** `claudeToolGateCommand` points
   at `dist/`, and `npm run check` runs the suite before the build. Pass
   `toolGate` from `CLAUDE_TOOL_GATE_SOURCE` through
   `tests/helpers/register-typescript-sources.mjs`, as
   `tests/integration/runtime/drive-task.test.ts` does. A scenario with no
   tool steps needs no gate at all, which is what lets the CLI tests drive the
   whole pipeline.
2. **`node --test <dir>` is still the fixture trap D3 and D5 both hit.** In
   Node 22.23 `node --test tests/` resolves `tests` as a module and throws
   `MODULE_NOT_FOUND`. Use a glob: `node --test tests/*.test.ts`.
3. **TypeScript 6 refuses `import ... from "node:test"`** in a project shaped
   like the demonstration's, reporting `TS2591 Cannot find name 'node:test'`
   even with `@types/node` installed. Pinning `typescript@5` cleared it. Not
   this repository's problem - it is on TypeScript 5 - but it will bite the
   next hand-built demo project.
4. **`fake-claude.ts` now reads a scenario per agent**, chosen by the agent id
   in `--append-system-prompt`, and has a `writes` field for files a provider
   changes without reporting a `tool_use`. That last one is the only way to
   exercise the audit finding a violation the gate could not have seen, since
   the gate and the audit ask the same function.
5. **The driver's snapshot is doubled on purpose.** It takes one before
   calling `recordAuditedAgentRun`, which takes its own. Removing the driver's
   would leave a `tool-gate-failed` refusal with nothing to audit against.
6. **A stage settles after its handoff is recorded, not before.** `onStage`
   fires for a `handed-off` stage on the next turn of the loop, once the
   transition is in `tasks.yaml`. Reporting it earlier would announce a
   handoff that a lock failure could still prevent.

## Completion gate

```sh
npm run check
npm run build
npm run test:coverage
npm pack --dry-run
```

Plus the suite once under the simulated hook environment
(`GIT_DIR=$PWD/.git GIT_WORK_TREE=$PWD GIT_INDEX_FILE=$PWD/.git/index npx jest`).
All five passed at `c287280`.

Then one demonstration no test may make: a real task driven through at least
two agents, live, against a throwaway repository, with the transcript and the
recorded transitions quoted. Done above, through five agents.

## Starting prompt for the next session

> Continue Sailor from `milestone-d6` in a worktree cut from it. Read
> `AGENTS.md`, `README.md`, `docs/handoff/rule-enforcement.md`,
> `docs/handoff/milestone-d.md`, `docs/handoff/milestone-d3.md`,
> `docs/handoff/milestone-d5.md` and `docs/handoff/milestone-d6.md` completely
> before writing code. D1, D2, D3, D5, D6 and the QA completion guard are
> done; `codex` is still not installed, so D4 stays unwritten and must not be
> guessed. Do not use a vendor name in the branch name.
>
> Implement, test-first, in this order: **(a)** close open finding 1 - a
> re-run of the stage a task already stands in overwrites the previous run's
> transcript and decision log, and costs a live run nobody asked for. Decide
> between recording on the task that a stage's run finished and numbering the
> adapter's files per invocation, and say why in the handoff. **(b)** the
> missing task commands: `sailor task create`, `sailor task approve` (which
> takes an acceptance, not a flag) and `sailor task show`, so a task can reach
> `awaiting_approval` without the library. **(c)** `sailor complete <task>`
> over the existing `completeTask`.
>
> Tests use fake executable fixtures and never make a live provider call.
> Never weaken a gate, no `--no-verify`, no lowered thresholds. No
> `Co-Authored-By` or "Generated with" trailer in commits or the pull request
> body. Prove every new test can fail by mutating the code it guards. Run the
> completion gate, demonstrate the new commands live by hand against a
> throwaway repository, and report any deviation directly. The `v0.2.0`
> release is prepared but not cut; until it is, point the private
> `package.json` at a locally packed tarball for any installer re-check.
