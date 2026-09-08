# Milestone D handoff: agents and provider adapters

## How to start

Open a new session in this worktree and paste the prompt at the end of this
document. Read `AGENTS.md`, `README.md`, `docs/handoff/rule-enforcement.md`
(the original A–D design) and this document completely before writing code.

`docs/handoff/milestone-c.md` records how Milestone C was built and is worth
reading for the traps, but its scope is closed.

## Where things stand

- Worktree: `<PROJECTS>/sailor-codex-basic-structure`
- Branch to start from: `main`. Cut a new branch; the milestone branches are
  merged and kept only for their history.
- HEAD of `main`: `fed94c2 Merge Milestone C: atomic task state, enforced
transitions, isolated contexts`
- The repository is public, at `simonfrets/sailor`, released as
  `v0.1.0`.

`npm run check`, `npm run build`, `npm run test:coverage` and
`npm pack --dry-run` all pass: 690 tests across 63 suites at 99.28% statements
against thresholds of 90/90/90/80. GitHub Actions runs the same gate on every
push and pull request, on Linux and macOS, against Node 22.22.1 — the floor
`engines.node` declares — and current 22.

Milestones A, B and C are merged. The sailor installs itself into a project,
resolves rules, compiles agent policies, runs phase gates, dispatches Git hooks
without discarding existing ones, and stores workflow state atomically.

**Nothing invokes an agent.** That is the whole of Milestone D.

## What D inherits

### The library C1–C3 built, which nothing calls

`src/tasks/` exports `createTask`, `approveSpecification`, `transitionTask`,
`updateTaskFile`, `writeAgentContext`, `readAgentContext` and the workflow
predicates. Nothing in `src/cli`, `src/gates` or `src/install` imports any of
it. `sailor task` does not exist. The state machine, the lock, the revision
check and the per-agent contexts are all real and tested; the thing that would
drive them is D.

### The six agent definitions, whose policy nothing enforces

`templates/.sailor/agents/*.yaml` ship with a validated tool surface:

| agent     | edit  | execute | write scopes |
| --------- | ----- | ------- | ------------ |
| architect | false | false   | 0            |
| specifier | true  | false   | 2            |
| coder     | true  | true    | 2            |
| cleaner   | true  | true    | 2            |
| hardener  | true  | true    | 1            |
| qa        | true  | true    | 2            |

Design decision 6 says tool permissions are enforced by the adapter or runtime,
**not merely written into the prompt**. Today they are written into the prompt
and nothing else. An agent that ignored its policy would not be stopped.

### Seven open findings from the Milestone C review

None is reachable through a shipped command today, because nothing calls
`src/tasks`. Every one of them lands on the runtime D builds. The first is the
one that will bite silently.

1. **A retry's run id is minted inside `transitionTask`.** `README.md` now
   documents the consequence: a driver that writes the agent context first has
   only the old run id to write it under, and a context path is a function of
   run and agent, so the retry's context lands on top of the failed attempt's.
   The driver must mint the id itself and pass `newRunId`. Nothing enforces
   this, and nothing validates that a task's `runId` and `contextPath` agree.
   **Write the driver so this cannot happen, or make the library refuse it.**
2. **Rework out of `blocked` reuses the run it discards under.** A new run is
   minted for `failed` but not for `blocked`, and sending a task back from `qa`
   to `implementing` does discard. Same overwrite as 1, without even a new run
   id to reach for.
3. **The lock's retry budget still falls short of the worst case** by the
   mtime-probe skew `proper-lockfile` introduces on its first acquisition in a
   process — measured between 13ms and 830ms. The budget-outlasts-window
   invariant is also asserted only for the default options, while
   `withTaskLock` accepts arbitrary ones.
4. **`writeTaskFile` creates `.sailor/` in a project that has none**, one
   layer below the `withTaskLock` guard that refuses to. Recorded by a test.
5. A comment in `src/tasks/task-schema.ts` miscounts the states owning no agent
   as four; there are five. The code is right.
6. One untested invariant in the attempt counter: deleting the
   `record.from !== record.to` filter in `entriesInto` leaves the whole suite
   green.
7. Two stale statements in `docs/handoff/milestone-c.md`: a test count that has
   moved and an incomplete list of new error kinds.

### Acceptance criteria still unmet

Three of the twelve, and all three are D's:

- **8.** Each of the six agents receives a distinct context and tool policy _in
  practice_. The contexts exist and are isolated; nothing hands them to
  anything.
- **10.** ~~QA cannot complete a task without accepted Gherkin evidence,
  executable QA-procedure results, successful final gates and a recorded
  notification result. None of those four things exists.~~ **Done**, after
  D1 and D2; see "The QA completion guard" below.
- **9** is met and directly tested; **1–7, 11, 12** are met.

`validationMode` is read from the installed config and reported on the profile,
but no gate filters on it, so `native-only` and `sailor-only` describe an
intent the runtime does not honour. Deciding what they filter — rule origin is
the obvious axis — is open.

## The blocker, before anyone plans around it

**`codex` is not installed on this machine.** `claude` is, at
`~/.local/bin/claude`.

The design is explicit that provider flags are version-sensitive and **must not
be guessed**: adapters are written by first inspecting the installed CLI's
`--help`. Criterion 12 then says tests use fake executable fixtures and never
live API calls — which means a guessed adapter would have a _passing test
suite_ and be wrong. The tests cannot catch this; only the real `--help` can.

So: build the Claude adapter against the real CLI, and do not write the Codex
adapter until `codex` is installed. Leaving it unwritten is the honest outcome;
writing it from memory is the one thing this milestone must not do.

## Scope, and why it is more than one session

Milestone C was three commits against a written specification. D is not that
shape. Suggested boundaries, each independently reviewable:

| Step | Subject                                      | Depends on                | State |
| ---- | -------------------------------------------- | ------------------------- | ----- |
| D1   | `Define the provider adapter contract`       | nothing                   | done  |
| D2   | `Enforce an agent's tool policy at run time` | nothing                   | done  |
| D3   | `Invoke an agent through the Claude CLI`     | D1, `claude` installed    |       |
| D4   | `Invoke an agent through the Codex CLI`      | D1, **`codex` installed** |       |
| D5   | `Validate provider and model configuration`  | D3 or D4                  |       |
| D6   | `Drive a task through its agents`            | D1-D3, D5                 |       |

**D1 and D2 are the natural first session.** Neither needs a provider CLI, both
are self-contained, and D2 is where design decision 6 stops being aspirational.

### D1 — the adapter contract

```ts
interface ProviderAdapter {
  invoke(request: AgentInvocation): AsyncIterable<AgentEvent>;
}
```

`AgentInvocation` carries the project root, the isolated context path, a task
snapshot, the compiled policy, the logical model profile, the allowed tools, a
timeout and an abort signal. The runtime records structured events and a final
status. Note what is already built and must not be reimplemented:
`compileAgentPolicy` produces the policy, `readAgentContext` produces the
context, `CommandRunner` is the process seam, and `nodeCommandRunner` already
handles timeouts, signals, output caps and an environment allowlist.

The adapter is provider-neutral: no provider flag belongs in it.

### D2 — enforcing the tool policy

`AgentTools` and `writeScopes` are validated on every agent definition and
carried into every context. Decide what enforcement means for a CLI-driven
agent — a write outside a scope, an execute for an agent with
`execute: false`, a project script not in `projectScripts` — and make it
mechanical. `src/sailor/project-path.ts` already holds the glob and path
schemas this needs.

## What D1 and D2 added

Three commits on `codex/milestone-d`, on top of the handoff commit:
`f2e5f07` (D2), `7d49731` (D1) and `a685dc6`, a fix the end-to-end
demonstration forced. D2 landed before D1 because D1's `tool-action` event
carries D2's action and decision; the handoff lists both as depending on
nothing, and that is the only dependency between them.

`npm run check`, `npm run build`, `npm run test:coverage` and
`npm pack --dry-run` pass: 795 tests across 69 suites at 99.4% statements. The
suite was run under the simulated hook environment before every commit.

| Module                                  | Public surface                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/enforcement/write-scope.ts`        | `globMatches`, `matchingWriteScope`, `toProjectRelativePath`                                                                                                                                |
| `src/enforcement/tool-policy.ts`        | `TOOL_ACTION_KINDS`, `TOOL_DENIALS`, `toolActionSchema`, `toolDecisionSchema`, `toolDenialSchema`, `commandSpecSchema`, `evaluateToolAction`, `matchProjectScript`, `toolPolicyFromContext` |
| `src/enforcement/working-tree-audit.ts` | `snapshotWorkingTree`, `auditWorkingTree`, `WORKING_TREE_AUDIT_TIMEOUT_MS`                                                                                                                  |
| `src/providers/agent-event.ts`          | `AGENT_EVENT_KINDS`, `AGENT_STATUSES`, `OUTPUT_STREAMS`, `agentEventSchema`, `agentStatusSchema`, `agentStatusOfCommandResult`, `finishedEventOf`                                           |
| `src/providers/provider-adapter.ts`     | `PROVIDER_IDS`, `providerIdSchema`, `buildAgentInvocation`, `recordAgentRun`, `ProviderProtocolError`, the `ProviderAdapter` and `AgentInvocation` types                                    |
| `src/sailor/deep-freeze.ts`             | `deepFreeze`, moved out of `agent-context.ts`; not re-exported                                                                                                                              |

`SAILOR_ERROR_KINDS` gained `invalid-invocation` and
`working-tree-audit-failed`, both exit 5. `PUBLIC_API` is now 220 entries.
`README.md` has two new sections, "Provider adapters" and "Tool policy
enforcement", and they are the reference; what follows is what they do not
say.

### Decisions taken where the design was silent

1. **Enforcement is two layers, because the agent is another process.**
   `evaluateToolAction` is a pure decision an adapter asks before the agent
   acts, for a provider that can be asked. `snapshotWorkingTree` and
   `auditWorkingTree` compare the tree afterwards through a private git index
   and put every changed path to the same write policy, for every provider.
   The audit is a report; git failing is an exception. How strongly `execute`
   is enforced is exactly as strong as the provider's reporting of commands
   before it runs them, and nothing post hoc can improve on that.
2. **The agent's own context directory is scratch, and the rest of
   `.sailor/` is untouchable.** The shipped `architect.yaml` says findings go
   to the run context, with `edit: false` and no scope; a policy under which it
   could not write there would contradict the definition it enforces.
   `context.json` is the exception. Everything else under `.sailor/` is
   refused whatever the scopes say, because a scope reaching
   `.sailor/agents/` would let an agent widen its own scope for the next run.
3. **An execute is a project script or nothing.** A command is recognised in
   the form `buildPackageManagerCommand` builds, so the gate runner and the
   policy share one definition of running a script, plus the bare `test` each
   manager documents (`npm test`, `npm t`, `npm tst`, `pnpm test`, `pnpm t`,
   `yarn test`; not `bun test`). `npx jest` is refused. Loosening this is a
   policy change, not a bug.
4. **The adapter reports the verdict, the runtime does not decide it.** An
   `AsyncIterable` is one-way, so a provider that can block before an action
   has to be given the policy and ask; the `tool-action` event records what it
   was told. `AgentInvocation` therefore carries a `ToolPolicy`, and D1
   depends on D2.
5. **A context is accepted from either end of the handoff.** The handoff
   writes the context from the snapshot the transition was decided against,
   one revision behind the task; a driver recording first would build it from
   the one produced. `buildAgentInvocation` accepts both, paired, and refuses
   an earlier attempt's context at the same path. See `a685dc6` for how this
   was found.
6. **`ProviderProtocolError` is not a `SailorError`.** An adapter that emits
   `finished` twice is a defect in the adapter, not an operational condition an
   exit code should describe to an operator.

### Open findings, after D1 and D2

Finding 1 is half closed. `buildAgentInvocation` refuses a task whose
`contextPath` is not what its `runId` and `agentId` name, so a retry whose
context landed under the old run cannot be invoked. `tasks.yaml` can still
carry the pair; a `taskSchema` refinement would close it and touches C1, so it
was left for the session that writes the driver. Findings 2 to 7 are untouched.
Criterion 8 now has an invocation per agent and still nothing that invokes it;
criterion 10 is unchanged.

### Verified against a throwaway repository

Criterion 8, with the built package driving the six shipped agents through a
fresh git repository holding the shipped rules and definitions: six contexts,
six `AgentInvocation`s, six distinct tool policies, every invocation frozen,
each policy heading naming its agent. Then, at `implementing`: a task recorded
under another run's path and an earlier attempt's context at the right path
were both refused as `invalid-invocation`. Then the coder's run was audited:
`src/login.ts` and `tests/login.test.ts` written in scope, `docs/readme.md`
deleted and `docs/other.md` added outside it, `.sailor/agents/coder.yaml`
rewritten, scratch written under the context directory. The audit listed the
four project changes and the definition, flagged the three that were not the
coder's to make - two `outside-write-scope`, one `sailor-owned` - ignored the
scratch, and left the repository's own index empty. Ten decisions an adapter
would ask for came back as the README describes them.

Criteria 1 to 3 were re-checked with a real `sailor init` from the built
CLI against a throwaway repository with a pre-existing `.git/hooks/pre-commit`:
the `v0.1.0` tarball resolved, hooks chained with the project's first,
`package.json` byte-identical, footprint `.sailor/` plus `core.hooksPath`.
`doctor` named the `typecheck` script the fixture lacked, and a real commit
ran the project hook, then the gate, and was blocked by that rule at exit 4,
as documented. Criteria 4 to 7 and 9 are covered by the integration suites
that already existed, all green.

### The QA completion guard, after D1 and D2

Acceptance criterion 10 is implemented, in seven commits following the two
above: Gherkin parsing (`f83cd5b`, with `@cucumber/gherkin` pinned to the
last CommonJS major, `39.1.0` - moving past it is an ESM test-sailor
migration, not a parser need), acceptance digests recorded by approval
(`ad3efda`), persisted run reports (`ae1713b`), the QA procedure as data
(`fc781c7`), notifications (`416c8cf`), acceptance preparation (`15e01a2`)
and the guard itself. `README.md`'s "Completing a task" section is the
reference.

The decisions that were open in the plan, as taken:

- **Approval is strict.** `approveSpecification` now requires an acceptance:
  at least one feature and one procedure, digested. A task that cannot be
  demonstrated cannot be approved; a non-functional change gets a trivial
  feature. A `tasks.yaml` approved by an earlier sailor still parses and is
  refused at completion, where the absence is acted on.
- **QA keeps `features/**` and the digests do the guarding.** An edit to an
  accepted feature blocks completion by content; new step definitions and
  scenarios for the next task stay writable.
- **The default channel is `log` and `doctor` warns.** A project completes
  before it is wired to a webhook; the warning is what says "nobody is told
  yet", the same shape as the CI warning.
- **Scenario evidence is derived, not asserted.** Steps declare `covers` at
  specification time, approval freezes the pairing and checks it total in
  both directions, and completion derives per-scenario evidence from step
  results the sailor ran. No agent-authored assertion is in the chain.
- **Final gates run for every agent's checks** (`agentId: null`), because a
  coder-only lint rule left unrun at completion would complete a task the
  next commit cannot make.
- **Provenance is not checked**, exactly as with `approvedBy`: the guard
  holds structure and consistency, `completeTask` is the honest producer,
  and the workflow tests fabricate consistent evidence on purpose.

The integration suite drives a real task over real accepted files to `qa`
and completes it with a fake process runner: evidence recorded on the
transition, three reports persisted under the run, a notification line in
the machine-local log; then each leg is broken in turn - a rewritten
feature, a blocked gate, a failing step, a dead channel under both
policies, a stale revision - and completion refuses with the kind and the
words asserted. `SAILOR_ERROR_KINDS` gained `incomplete-evidence` and
`notification-failed`, both exit 5.

### What D3 starts from

- Run `claude --help` and read it before writing a flag. `claude` is at
  `~/.local/bin/claude`; `codex` is still not installed, so D4 stays open.
- An adapter implements `ProviderAdapter`, yields `started`, `output`,
  `tool-action` and `finished`, and is driven by `recordAgentRun`. Build the
  closing event with `finishedEventOf` from a `CommandResult`, so
  `nodeCommandRunner` keeps the timeout, output cap and environment allowlist.
  `nodeCommandRunner` has no abort support; the invocation's `signal` will
  need it or the adapter reports `aborted` only for a run that had not started.
- Map `invocation.toolPolicy` to whatever permission mechanism the CLI's
  `--help` actually documents, and ask `evaluateToolAction` wherever the CLI
  lets an adapter answer before an action. Relativise reported paths with
  `toProjectRelativePath` first.
- Snapshot before and audit after, with `indexFile` somewhere under
  `.sailor/state/` that is not the agent's own context directory - the agent
  may write there. `.sailor/state/audit/<run>-<agent>.index` is what the
  demonstration used.
- The `.sailor/config/models.yaml` and `providers.yaml` the design names do
  not exist; `MODEL_PROFILES` is the logical side, and the provider side is D5.

## Traps

Carried forward and still true. `docs/handoff/milestone-c.md` has the full
list; these are the ones D will meet first.

1. **`import.meta.url` does not work under Jest.** The package root is injected
   as `packageRootDirectory` and resolved only in `src/cli/index.ts`.
2. **`src/index.ts` barrel re-exports count as functions.**
   `tests/unit/index.test.ts` holds an explicit `PUBLIC_API` list — now 193
   entries — that must be updated whenever an export is added.
3. **Never weaken a gate.** No lowered threshold, no ignore comment, no
   `--no-verify`. `AGENTS.md` forbids it outright.
4. **`exactOptionalPropertyTypes` is on.** Spread conditionally:
   `...(x === undefined ? {} : { x })`.
5. **A test that spawns git must use `tests/helpers/git.ts`.** A fixture that
   did not once rewrote a branch's HEAD and re-authored four commits.
6. **`nodeCommandRunner` forwards `GIT_INDEX_FILE` and only that.** Stripping
   it made the shipped staged-content gate pass while conflict markers went
   into the commit. A test driving the runner against a fixture must build it
   with `baseEnv: cleanEnvironment()`.
7. **Run the suite under a simulated hook environment before committing**:
   `GIT_DIR=$PWD/.git GIT_WORK_TREE=$PWD GIT_INDEX_FILE=$PWD/.git/index npx jest`.
   A bare `npx jest` has been misleading here more than once.
8. **Prove a test can fail before trusting it.** Three reviews of this
   repository have found tests that could not fail, several guarding the exact
   regression they existed to prevent. Apply the mutation, watch it go red,
   revert.
9. **A scripted `str.replace` that does not match fails silently.** Verify the
   rewrite landed.
10. **This is a Git worktree and the stash stack is shared.** Never use bare
    `git stash` / `git stash pop`.
11. **Do not add a `Co-Authored-By` trailer.** Every one was deliberately
    stripped from this repository's history; adding one back would undo that.

## Completion gate

```sh
npm run check
npm run build
npm run test:coverage
npm pack --dry-run
```

Plus the suite once under the simulated hook environment above.

Then demonstrate acceptance criterion 8 — each of the six agents receiving a
distinct context and tool policy — against a throwaway Git repository, and
re-check criteria 1–7 and 9, which the installer and the task store must not
regress.

Report any deviation directly. Do not describe partial work as complete.

## Starting prompt

> Continue Sailor in the worktree
> `<PROJECTS>/sailor-codex-basic-structure`. Start from `main` and cut
> a new branch. Read `AGENTS.md`, `README.md`,
> `docs/handoff/rule-enforcement.md` and `docs/handoff/milestone-d.md`
> completely before writing code. Milestones A, B and C are merged, released as
> `v0.1.0` and verified against a real project. Implement **D1 and D2 only** —
> the provider adapter contract, and run-time enforcement of an agent's tool
> policy — test-first, with the commit boundaries in the handoff. Do not write
> a provider adapter: `codex` is not installed, and the design forbids guessing
> provider flags. Run the completion gate and report any deviation directly.
