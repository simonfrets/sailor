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
- **10.** QA cannot complete a task without accepted Gherkin evidence,
  executable QA-procedure results, successful final gates and a recorded
  notification result. None of those four things exists.
  `transitionTask` records `gateReportIds` and `artifactPaths` on every
  transition, which is the hook a completion guard will read, but requires
  neither.
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

| Step | Subject                                      | Depends on                |
| ---- | -------------------------------------------- | ------------------------- |
| D1   | `Define the provider adapter contract`       | nothing                   |
| D2   | `Enforce an agent's tool policy at run time` | nothing                   |
| D3   | `Invoke an agent through the Claude CLI`     | D1, `claude` installed    |
| D4   | `Invoke an agent through the Codex CLI`      | D1, **`codex` installed** |
| D5   | `Validate provider and model configuration`  | D3 or D4                  |
| D6   | `Drive a task through its agents`            | D1–D3, D5                 |

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
