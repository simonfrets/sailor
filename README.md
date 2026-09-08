# Sailor

Sailor is a TypeScript-based, project-local workflow engine for
coordinating coding agents through CLI adapters such as Codex and Claude.

The framework is being built around one hard boundary: installing it into a
project places its configuration, agents, rules, task state, contexts, hooks,
and runtime under that project's `.sailor/` directory.

## Current status

This branch implements the rule and gate kernel, the command line entry point,
and the `.sailor/` installer: rule bundles are validated, layered, hashed,
compiled into agent policies, executed as phase gates, and installed into a
host project by `sailor init`, which `sailor doctor` then checks.

`sailor init` also takes over the repository's Git hooks without discarding
the ones the project already had, so a gate runs on an ordinary local commit
rather than only when someone remembers to invoke it. The configuration files
it installs belong to the project and can be edited freely.

Task state, the workflow state machine and per-agent handoff contexts are
implemented: a transition is recorded into `.sailor/tasks.yaml` through
`updateTaskFile`, which holds an exclusive lock across the whole
read-change-write, and a context is written per run and per agent. Pairing the
two - writing the next agent's context and recording the transition that points
at it - is the runtime's job, and there is no runtime.

The contract a provider adapter implements exists, and an agent's tool policy
is enforced around an invocation rather than described in its prompt. The
Claude adapter is implemented against the installed CLI: it runs
`claude --print` under the agent's policy, decides every tool call through a
hook before the call runs, and the working tree is audited afterwards. The
Codex adapter is **not**: `codex` is not installed where this was built, and
a guessed adapter would ship behind a passing suite. Nothing yet drives a
task through its agents, so the workflow is still driven through the library.

## Requirements

- Node.js 22.22.1 or newer
- npm 10 or newer
- Git
- Bash on macOS, Linux, or WSL

## Setup

```sh
npm install
npm run check
npm run build
```

`npm install` activates the repository's Husky hooks through the `prepare`
script.

## Quality commands

| Command                 | Purpose                                                 |
| ----------------------- | ------------------------------------------------------- |
| `npm run format:check`  | Verify formatting without modifying files               |
| `npm run lint`          | Run type-aware ESLint with zero warnings allowed        |
| `npm run typecheck`     | Run strict TypeScript checking                          |
| `npm run lint:shell`    | Parse every `*.sh` file with Bash, and report the count |
| `npm test`              | Run Jest unit and shell-script tests                    |
| `npm run test:coverage` | Run Jest with enforced coverage thresholds              |
| `npm run check`         | Run the complete local quality gate                     |
| `npm run build`         | Produce ESM JavaScript and declarations in `dist/`      |

The pre-commit hook runs staged formatting and ESLint fixes, followed by the
full lint, type-check, shell syntax, and Jest gates.

## Command line

```sh
sailor <command> [options]
```

| Command                              | Behaviour                                     |
| ------------------------------------ | --------------------------------------------- |
| `sailor rules validate`              | Load and resolve every bundle; print the hash |
| `sailor rules explain`               | List the resolved rules with their origins    |
| `sailor rules explain --agent coder` | Print that agent's compiled policy            |
| `sailor gate <phase>`                | Run the checks that apply to a workflow phase |
| `sailor init [--update]`             | Install or update `.sailor/` in this project  |
| `sailor doctor`                      | Check that the installed sailor can run       |

Rules are read from the project the command is run in. The working tree root
is resolved with `git rev-parse --show-toplevel`, so a command works from any
subdirectory. `.sailor/rules/*.yaml` is the `builtin` precedence layer and
`.sailor/rules/custom/*.yaml` is the `project` layer, so a project replaces a
shipped rule by declaring the same rule id with `overrides: true`.

Exit codes are part of the contract, because a hook or a CI step branches on
them:

| Code | Meaning                                       |
| ---- | --------------------------------------------- |
| 0    | Success                                       |
| 1    | Unexpected failure                            |
| 2    | The command line could not be understood      |
| 3    | Invalid or missing sailor configuration       |
| 4    | A required check failed and blocked the phase |
| 5    | The action was unsafe and was not taken       |

## Installation

`sailor init` resolves the working tree with `git rev-parse --show-toplevel`
and refuses to install outside a Git repository. Everything it writes lands
under `.sailor/`; the host project's `package.json`, ESLint configuration and
lockfile are never read for writing and never modified.

Each installed file is written through a temporary sibling and an atomic
rename, so an interrupted install leaves the previous version intact rather
than a truncated one.

Installed files come in two kinds, and `.sailor/version.json` — the manifest —
records which is which:

- **managed** files are the sailor's. `rules/`, `agents/`, the hook
  dispatchers, the launcher and `package.json` are kept in step with the
  version that installed them, and an edit to one is a conflict.
- **seeded** files are the project's. Everything under `config/` carries a
  decision discovery cannot make, so each is written once, when absent, and
  never reconciled again. They exist to be edited; a sailor that refused to
  run afterwards would be refusing to run because it had been configured.

Ownership is a property of the shipped file, not of the manifest entry, so a
project installed by an earlier version is reclassified on its next install
rather than needing a migration.

What happens to a **managed** file that is already there is decided before
anything is written, from the manifest's record of the SHA-256 it wrote:

| On disk | In the manifest | Content               | `--update` | Outcome                   |
| ------- | --------------- | --------------------- | ---------- | ------------------------- |
| absent  | –               | –                     | –          | created                   |
| present | –               | equals shipped        | –          | kept                      |
| present | no entry        | differs               | –          | refused: unmanaged file   |
| present | entry           | local ≠ manifest hash | –          | refused: locally modified |
| present | entry           | differs               | no         | refused: needs `--update` |
| present | entry           | differs               | yes        | replaced                  |

A **seeded** file that already exists is kept, whatever it now contains and
whether or not `--update` was given, so it can never appear in that table.

Every conflict in a project is collected and reported once, so a half-adopted
installation is untangled in one pass instead of one file per re-run. Nothing
is written until the plan is conflict-free.

A managed file that a newer sailor no longer ships is **reported and left in
place**. Deleting a file from someone's project is the irreversible act the
installer will not perform on its own.

Runtime dependencies are resolved into `.sailor/node_modules/` by npm running
with `.sailor/` as its working directory — npm regardless of what the host
project uses, because resolving this tree with the project's package manager
would apply that manager's workspace rules and, in a monorepo, hoist the
sailor's dependencies into the workspace root.

The sailor is **not published to npm**. The generated `.sailor/package.json`
pins one exact GitHub release asset — the tarball `npm pack` produces, attached
to the release for that version:

```json
"dependencies": {
  "sailor": "https://github.com/<owner>/<repo>/releases/download/v0.2.0/sailor-0.2.0.tgz"
}
```

npm installs a remote tarball without cloning or building anything, which a
`github:owner/repo` dependency would have to do — and `dist/` is not committed,
so there would be nothing there to install. The owner and name come from this
package's own `repository` field, so a fork installs from the fork.

Files and the manifest are written before dependencies, so an install
interrupted by a failing download leaves a project the sailor still recognises
as its own and a re-run repairs it. Git hooks are pointed at the sailor
**last**, only once the runtime they invoke is actually present: activating them
first left a repository that could not commit at all, because every hook ran a
launcher with nothing behind it. A failed install reports everything it did
write, leaves hooks alone, and exits `5`.

`sailor doctor` checks Node, npm, Git, Bash, the installation manifest, the
configuration files, the configured provider's CLI, the rule set, the private
dependency tree, Git hook reachability, whether every check can resolve the
project script it names, and whether anything runs the gates in CI.

The provider check covers every provider `config/providers.yaml` could route
an agent to - the default and each per-agent override, because an override to
a provider that is not there breaks exactly the agent it names while the
default one reports perfectly.

A provider this sailor has no adapter for is a **problem**, decided before
anything is spawned: that is a fact about the package rather than about the
machine, and probing first would make installing the CLI look like the fix.
Otherwise the command is run with `--version`. A command that is not there is
a **problem** too: the project named it, and nothing can invoke an agent
without it. A version other than the one the adapter was written against is a
**warning**, because the flags are what matter, an adapter is written by
reading one `--help`, and only a live run proves those flags are still there -
which is not a claim a diagnosis is in a position to make.

A project that installs a bundle naming a script it does not have is the case
worth calling out: `whenMissing: fail` means the rule considers the absence to
_be_ the defect, which is right for the project the rule was written for and
wrong for one that never had that script. Left alone it blocks every commit,
so `doctor` reports it as a problem and names the rule, the check and the
script, along with where to override it. It writes nothing, runs every check even after one fails, and
exits `3` if any check is a problem. Warnings — an installation made by a
different sailor version, or hooks that are not dispatched through the sailor
— are reported without failing.

## Git hooks

`sailor init` points the repository's local `core.hooksPath` at
`.sailor/hooks` and writes one dispatcher per hook. That setting is the single
thing the sailor changes outside `.sailor/`, because Git cannot be told to
look inside a directory from within that directory.

Redirecting `core.hooksPath` stops **every** hook in the previous directory
from running, not only the ones the sailor has a gate for. So the installer
first records what was active — `core.hooksPath` if it was set, otherwise the
hooks directory of the common Git directory, which is where a linked worktree's
hooks actually live — and generates a dispatcher for each of them:

- a managed hook (`pre-commit` and `pre-push` by default) runs the preserved
  hook first, unchanged, with the same arguments and the same standard input,
  and then `sailor gate <phase>`;
- any other executable hook that was there gets a pass-through that runs the
  original and nothing else.

`set -e` means a failing preserved hook stops the dispatcher there. The gate
never masks a hook the project relies on, and the exit code a developer sees is
that hook's own.

`config/hooks.yaml` sets the policy. `onExistingHook: chain` is the default and
`abort` refuses the installation instead. There is no `replace`. It is a seeded
file, so the installed copy is what installation reads: disabling a hook or
switching to `abort` takes effect on the next `sailor init`.

A preserved hook inside the repository is recorded relative to the project root
and re-joined at run time, so a dispatcher is the same file on every machine
that checks the project out. Once Git dispatches through the sailor,
`.sailor/version.json` is the only surviving record of what was there before,
and a re-install reads it rather than inspecting its own dispatchers and
chaining the sailor to itself.

`.sailor/bin/sailor` is the executable the dispatchers call. It runs the CLI
from `.sailor/node_modules/`, so a hook runs the version this project
installed rather than whichever global one is first on `PATH`, and exits `3`
with a clear message when the runtime has not been installed.

### Worktrees

`core.hooksPath` is repository-local configuration, which Git shares across
every linked worktree. The sailor therefore writes a **relative** value, so
each worktree resolves its own `.sailor/hooks`. The consequence is worth
stating plainly: installing from one worktree redirects hooks for the whole
repository, and a worktree with no `.sailor/hooks` of its own then runs no
hooks at all. Install from the main checkout, or install in every worktree.

## Continuous integration

There are two separate questions here, and they have different answers.

### This repository

`.github/workflows/ci.yml` runs `npm run check`, `npm run build`,
`npm run test:coverage` and `npm pack --dry-run` on Linux and macOS — WSL runs
the Linux build, so those two cover every shell target v1 claims.

The Node version is pinned rather than read from `engines.node`. That field is
a _range_, and `setup-node` resolves a range to the newest version satisfying
it, so reading it would have meant never once running the minimum the project
promises. Linux runs both that minimum and current `22`; macOS runs the minimum
only, because it bills at ten times Linux and the difference it exists to catch
is the shell, not the Node version.
`tests/integration/ci/workflow.test.ts` asserts the pinned literal still equals
the floor in `engines.node`, which is what stops the two drifting.

`.husky/pre-commit` runs the same gate locally, but a local hook is skippable
with `git commit --no-verify`. The hook is the convenience; the workflow is the
enforcement. `tests/integration/ci/workflow.test.ts` asserts the exact command
list, so a step cannot be quietly dropped from the one place that cannot be
skipped.

### A project the sailor is installed into

The same reasoning applies, and the sailor cannot act on it alone. A GitHub
Actions workflow has to live in `.github/workflows/` to run at all, which is
outside the `.sailor/` boundary — the one thing installation is not allowed to
cross. So `sailor init` ships a ready workflow at `.sailor/ci/github-actions.yml`
and leaves placing it to the project:

```sh
mkdir -p .github/workflows
cp .sailor/ci/github-actions.yml .github/workflows/sailor.yml
```

It resolves the private tree from `.sailor/package-lock.json` and then runs
`sailor gate pre-commit` and `sailor gate pre-push`; both, because the two
phases check different things — lint and type checking on one, the build on the
other.

Installing the _project's_ own dependencies is the one manager-specific step,
and the template says so in place: replace `npm ci` if the project is on pnpm,
Yarn or Bun. Caching is pointed at `.sailor/package-lock.json` rather than the
project root, because the private tree is always npm by design while the
project may not be, and `cache: npm` against a `package-lock.json` that does not
exist fails the step outright.

Leaving it there as documentation would make it advice, which this project does
not treat as enforcement, so `sailor doctor` reports it: a project whose
`.github/workflows/` contains nothing invoking `sailor gate` gets a **warning**
naming the file to copy. A warning rather than a failure, because a project may
enforce the same gates on GitLab, Jenkins or a server-side hook, and "no GitHub
workflow runs them" is the only claim this check is in a position to make.

One caveat the template states in place: a check that inspects staged content,
such as the shipped `git diff --check --cached`, has nothing to look at in CI,
because CI has no index. Those rules are enforced by the hook alone.

## Testing shell scripts

Shell behavior is tested from Jest rather than asserted by ad hoc manual steps.
Tests spawn scripts using Bash and isolate filesystem behavior in temporary
fixture directories.

## Rules

A rule bundle is YAML. Rules carry an instruction for agents and, optionally,
executable checks that run at workflow phases.

```yaml
version: 1
id: typescript-quality
description: TypeScript correctness rules

rules:
  - id: typescript.no-explicit-any
    description: Reject new explicit any types
    severity: error
    appliesTo: [coder, cleaner, hardener]
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

- Severity is `error` or `warning`.
- Phases are `pre-agent`, `pre-handoff`, `pre-commit`, `pre-push`, and `qa`.
- A `project-script` check names one of `build`, `format`, `lint`, `test`, or
  `typecheck`. An arbitrary package script is never assumed safe to run.
- A `command` check carries an explicit argument vector. Commands are never
  stored as shell strings.
- Validation errors report the source file, the YAML path, and a line and
  column.

Bundles are layered in `builtin`, `project`, `agent`, `task` order. A duplicate
rule id is an error unless the higher-precedence rule sets `overrides: true`.

The resolved rule set has a SHA-256 over its effective content alone: bundle
ids, file paths, key order, comments, quoting style, and line endings do not
affect it, so the same logical rules hash identically on any machine.

## Agent definitions and configuration

`templates/.sailor/agents/` ships one definition per built-in agent, and
`templates/.sailor/config/` ships the settings files the installer will place
alongside them. Both are validated by the test suite, so a shipped template
that stops matching its schema fails the build.

```yaml
version: 1
id: hardener
displayName: Hardener
summary: >
  Attacks the test suite: finds the cases the tests do not cover and adds them,
  without repairing the production code they expose.
modelProfile: coding-high

tools:
  read: true
  search: true
  edit: true
  execute: true

writeScopes:
  - "tests/**"

projectScripts:
  - test
  - typecheck
```

`modelProfile` is a logical name — `coding-high`, `reasoning-high`, or
`verification`. Provider-specific model identifiers are deliberately absent, so
a definition is portable across adapters.

`tools` and `writeScopes` have to agree: an agent that declares `edit: true`
must name a write scope, and one that declares `edit: false` must not.
Otherwise the runtime has two answers about what an agent may change, and
whichever it happens to read becomes the real policy by accident. The same
applies to `execute` and `projectScripts`.

A write scope stays inside the project. `/etc/**` and `../**` are refused, and
so are `{..,src}/**`, `@(..|src)/**` and `[.][.]/**`, which name a path outside
the project without containing a `..` segment of their own - `minimatch` matches
`../outside.txt` against all three, and `!(src)/**` reaches `/etc/passwd`. The
wildcards left are `*`, `**` and `?`: checking where an alternation could expand
to means expanding it, and two scopes say what one alternation was trying to.
This is the same boundary the `artifactPaths` and `contextPath` recorded in
`tasks.yaml` are held to, and it matters more here, because a recorded path is a
diagnostic and a write scope is what the runtime will read to decide which files
an agent may change.

`config/project.yaml` carries only the two decisions discovery cannot make: the
validation mode, and a pinned package manager for a repository that carries two
lockfiles. `discoverProjectProfile` reads the installed copy, and a pin there
wins over the host `package.json`'s own `packageManager` field — it exists to
settle exactly the ambiguity that field had already failed to settle. A config
file that is present but invalid is reported rather than ignored, so a mistyped
setting cannot silently deliver the opposite of what was asked for. `config/hooks.yaml` says which Git hooks are managed and what to do
when the project already has one — `chain` runs the existing hook and then the
sailor gate, `abort` stops. There is no `replace`.

`config/models.yaml` is where a logical profile becomes something a provider's
`--model` will accept, per provider. A profile the file leaves out runs on the
model its adapter defaults to, so overriding one model does not mean restating
the other two, and a profile a later sailor adds keeps working in a file
written before it existed. A model id is held to being a non-empty string and
nothing more, because that is all this side can honestly check: `claude
--model` takes aliases and full names alike and refuses neither until the
request is made, so validating an id is the consuming adapter's job.

`config/providers.yaml` says which provider CLI runs an agent and how that CLI
is started. The provider is deliberately not part of an agent definition,
which names a logical profile and stays portable; `default` names the provider
every agent runs on and `agents` overrides it for one. Each provider's
`command` is an argument vector, never a shell string, whose first word is
looked up on `PATH`, and Claude's block also carries the `maxBudgetUsd` passed
as `--max-budget-usd` - `null`, no cap, by default, because a cap that stops a
run half way through leaves the tree the agent was in the middle of changing.
`codex` is named because the adapter contract admits it and nothing can run on
it: the CLI was not installed where its adapter would have been written, and
its flags are not guessed.

`sailor init` installs these files and `sailor doctor` validates the
installed copies. What the runtime does with the policy is described under
[Tool policy enforcement](#tool-policy-enforcement).

## Phase gates

`runPhaseGates` runs the checks that apply to a phase and returns a serialisable
report.

- A failing **required** check on an **error** rule blocks the phase.
- A failing **warning** check is recorded in full but never blocks.
- A missing project script either fails or is skipped, per the rule, and is
  never attempted.
- Timeouts, signals, and spawn failures are reported distinctly from a non-zero
  exit. Nothing is hidden behind a generic failure.

Commands run through an injectable `CommandRunner`. The production runner uses
`node:child_process` with `shell: false` and an argument vector, so shell
metacharacters in a rule stay inert as literal argument values. It forwards only
an allowlisted environment, points stdin at `/dev/null`, caps captured output,
and terminates a timed-out process.

Command construction is supported for npm, pnpm, Yarn, and Bun. Only npm is
exercised against a real binary in the test suite; the other three are covered
by argument-vector unit tests, because Yarn and Bun are not assumed to be
installed.

## Task state and handoffs

A task moves through nine states, in this order:

```text
draft -> specified -> awaiting_approval -> implementing -> cleaning
      -> architecture_review -> hardening -> qa -> completed
```

Every state but `completed` may fall to `blocked` or `failed`, and both demand
a recorded reason. Recovery out of either may target the stage the task stopped
in or any stage before it, and never one after: that is what lets QA send work
back to the coder without letting anything skip a stage it has not run. A
blocked task may still be given up on; a failed one is already there.

Every state names the agent that owns it, and a transition recording any other
is refused. `specified` is the specifier's, and `implementing`, `cleaning`,
`architecture_review`, `hardening` and `qa` belong to the agents they are named
after. `draft`, `awaiting_approval`, `completed`, `blocked` and `failed` belong
to nobody: a task in one of them is written down, waiting on a person, finished
or stopped, and in none of them is an agent running. The recorded agent is what
a runtime builds the next context from and enforces tools and write scopes
against, so recording another would run the stage under the wrong policy - the
coder under QA's `edit: false` and no write scope, or QA with the coder's - and
both records would otherwise validate. A project-defined agent id is accepted
everywhere a rule may target one, but it cannot own a pipeline state: the nine
states are fixed, so there is none spare for a seventh agent.

The stage a task stopped in is recorded as one of the eight active stages, and
never as `completed`, `blocked` or `failed`. Recovery is the stages up to and
including that one, and `tasks.yaml` is committed and hand-editable, so a file
naming `completed` there would bound recovery by the end of the pipeline and
let a task be walked to done without entering `implementing` or `qa`.

The coder cannot start before the specification is approved. Approval is a
separate act taking a revision of its own, so it can never be granted by the
same call that starts the work, and a move to `implementing` is refused until
one is recorded. What is not enforced is who granted it: `approvedBy` is a free
string, recorded and never checked, and nothing compares it with whoever asks
for the transition that starts the coder. The separation the sailor holds is
between the two acts, not between two identities. Sending a task back to
`draft` or `specified` withdraws the approval, because an approval of a
specification that has since been rewritten approves nothing.

### `.sailor/tasks.yaml`

Task state lives in `.sailor/tasks.yaml`, which is deliberately **not**
ignored: a workflow nobody can review in a pull request is not governed by
anything. It is neither a managed nor a seeded file, so `sailor init` never
writes it and never reconciles it; the first transition creates it.

The transition creates the file, not the directory holding it. Taking the task
lock against a project with no `.sailor` reports `not-installed` and creates
nothing, because that directory is what `sailor init` installs: creating it
here would leave a `.sailor` holding task state and no agents, rules or hooks
behind any task call made against any path.

Every transition records the revision it produced and the revision its writer
expected, the source and target agent, the resolved rule-set SHA-256, gate
report ids and artifact paths, the timestamp, the attempt number, any failure,
and where the next agent's context was written. A write whose expected revision
no longer matches is refused, so two agents handed the same snapshot cannot
both compute the next revision and have the second erase the first.

One call takes the lock: `updateTaskFile` holds it across the whole
read-change-write, so the file is read, the next revision decided and written
back without another process getting in between. The lock is
`proper-lockfile`'s; the file itself is replaced through a temporary sibling,
an `fsync` and an atomic rename. Its `.lock` sibling is covered by the shipped
`.gitignore`.

A sailor killed while holding that lock leaves it behind, and the only thing
that says nobody holds it is its age. The window it stays honoured for is two
seconds - the shortest `proper-lockfile` implements, and far longer than the
read-change-write it covers - and acquiring waits out roughly 2.8 seconds, so
an abandoned lock is normally taken over rather than reported as contention.
Waiting less would leave `sailor gate pre-commit` failing, and a failing gate
blocks commits, for as long as the window lasts.

Normally, not always. `proper-lockfile` measures the filesystem's mtime
precision on its first acquisition in a process, and does it by stamping the
lock up to about a second into the future. A lock abandoned by a process that
was killed within that first heartbeat can therefore read as up to three
seconds old rather than two, which outlasts the 2.8 seconds of waiting. The
loser is told another process holds a lock that nobody holds. Retrying once
clears it; the honest statement is that the budget covers the ordinary case and
not the worst one.

Contention is reported as contention, and nothing else is. `proper-lockfile`
raises `ELOCKED` for a lock another process is genuinely holding; anything else
that stops the lock being taken - a `.sailor` the process cannot write, a full
filesystem, a `.sailor` that is not a directory - is reported as a lock that
could not be taken, with the cause beneath it. Waiting is the answer to exactly
one of those.

`readTaskFile` and `writeTaskFile` are the unlocked primitives it is built
from, and both are exported. A read on its own is whole, because a write lands
by rename and nothing observes half a file, but it is a snapshot and it takes
no lock. Pairing the two by hand takes neither the lock nor the
expected-revision check, so a transition another sailor process recorded in
between is erased with no error to show for it: the guarantee is a property of
`updateTaskFile`, not of the file. Anything that changes a task goes through
it.

### Agent contexts

Each handoff writes the next agent a context of its own at

```text
.sailor/state/runs/<run-id>/agents/<agent-id>/context.json
```

carrying that agent's own tool policy and write scopes, its display name and
the summary of what it is for, the compiled policy for the rule set in force,
the rule-set hash, and what the previous agent left behind. There is no shared,
mutable context object: the run and the agent are both in the path, each read
parses the file again, and what comes back is frozen.

The name and summary are the definition's own words, and they travel here
rather than being looked up when a prompt is built: a definition edited after
the handoff describes the next run, not this one. A context written by an
earlier sailor, which carries neither, is refused by its version rather than
read with the fields missing - a context is machine-local scratch derived
entirely from tracked things, so refusing one costs a rebuild and nothing else.

Writing that context and recording the transition that points at it are two
calls, `writeAgentContext` and `transitionTask`, and the sailor does not
couple them: `contextPath` is optional on a transition and defaults to none,
which is what a move into a stage no agent owns records. Ordering them belongs
to whatever drives the workflow, and that is Milestone D. Today the only driver
is the library's own test driver.

Context first and then the transition naming it works for every move that stays
in the same run. A move that **discards** an attempt starts a new one, because
a context path is a function of the run and the agent: writing the replacement
under the run it replaces would put it on top of the record of what failed.
Two moves discard, and `runIdForTransition` is the whole of the rule:

- a recovery out of `failed`, always - the attempt failed and the next one
  replaces it, whichever stage it restarts at;
- a recovery out of `blocked` that targets a stage **before** the one the task
  stopped in, which is rework: QA sending a change back to the coder throws
  away everything from that stage on.

Everything else keeps the run. A blocked task resuming where it stopped
discarded nothing, and `blocked -> failed` restarts nothing at all.

The driver has to know which of those it is doing before it writes anything,
so `runIdForTransition` is exported and is the same function `transitionTask`
asks: the driver decides the id, writes the context under it, and passes it
back as `newRunId`. It cannot get that pair wrong and be believed. A task's
recorded `contextPath` is held by `taskSchema` to the path its own `runId` and
`agentId` name, so a context written under the run a retry replaced is refused
by the transition that would have recorded it, rather than found later by
whatever tried to build an invocation from the task.

Everything under `state/` is ignored, so a context is machine-local. That is
deliberate, and it settles what the `contextPath` recorded in `tasks.yaml`
means: it is a name, derived from the run id and the agent id the committed
file already carries, and not a promise that the file behind it exists on the
machine reading it. A clone made while a task is mid-run gets every one of
those names and none of those files.

Nothing is lost with them. A context holds the agent's own capabilities and
write scopes, the compiled policy and the rule-set hash, all derived from
things that are tracked - the task, the agent definition and the rules - so a
resumed run writes the context it needs at the path already recorded for it
rather than needing the copy the machine that made the handoff wrote. Reading
one that was never written here reports `missing-context`, which is a different
condition from a context that is damaged and calls for a different answer.

Stopping a run and resuming it - in another process, on another machine, or
from a fresh clone - therefore needs only `tasks.yaml`: it names the stage the
task stands at, and the stages already behind it are not run again.

### Completing a task

`qa -> completed` is guarded; acceptance criterion 10 stops being aspirational
here. Approval already pins what it accepted - at least one Gherkin feature
file and one executable QA procedure, each recorded on the task as a SHA-256
digest - and the transition into `completed` now demands `completion`
evidence with four parts, refused as `incomplete-evidence` (exit `5`) when
any is missing or inconsistent:

1. **Final gate reports** for both `pre-handoff` and `qa`, run over every
   check in the rule set rather than QA's slice of it, neither blocked.
2. **The accepted procedure's results.** The procedure is YAML: steps of the
   same two runners a rule check has, each declaring which scenarios it
   `covers`. Every step must have passed.
3. **Accepted Gherkin evidence.** The evidence's feature digests must equal
   the approved ones - QA may write `features/**`, so an edited feature file
   blocks completion by content - and at approval every scenario must be
   covered by at least one step, so scenario evidence is derived entirely
   from step results the sailor produced itself.
4. **A recorded notification result.** `config/notifications.yaml` (seeded)
   names the channel: `command` runs a configured argument vector with the
   task in `SAILOR_TASK_*` variables; `log`, the default, appends to a
   machine-local file under `state/` and makes `sailor doctor` warn that
   nobody is told. `onFailure: block` (default) refuses completion when
   delivery fails, as `notification-failed`; `onFailure: record` records the
   failure and completes.

The evidence's shape can express success and nothing else - a blocked gate or
an empty procedure is unrepresentable - and the full reports are persisted
under `.sailor/state/runs/<run-id>/reports/`, with the summary in the
committed transition record, so a pull request reviews what was demonstrated
without needing the machine that demonstrated it.

`completeTask` produces all four honestly: it re-hashes the accepted files
first, runs the gates and the procedure through the injectable
`CommandRunner`, persists every report whether or not it passed, notifies,
and only then takes the task lock to record the transition - the lock's
stale window is two seconds and gates take as long as the project's scripts
take, so nothing slow runs under it; a concurrent write surfaces as a stale
revision. What the guard does not check is provenance: like `approvedBy`,
the evidence's structure and consistency are enforced and the identity of
whoever assembled it is not, and `completeTask` is the caller that assembles
it from real files and real runs.

## Provider adapters

An agent is invoked through a provider's command line, and the contract every
provider implements is one method:

```ts
interface ProviderAdapter {
  readonly provider: "claude" | "codex";
  invoke(invocation: AgentInvocation): AsyncIterable<AgentEvent>;
}
```

`AgentInvocation` is what the adapter is handed: the absolute project root,
the agent's id, display name and summary, the project-relative context path, a
snapshot of the task, the attempt and what the previous agent left behind, the
compiled policy, the logical model profile, the tool policy, a timeout and an
abort signal. It is built by
`buildAgentInvocation` from the task and the context the handoff wrote, and
from nothing else: the capabilities, scopes and scripts are the context's, so
the adapter and the working-tree audit read one policy. What comes back is
frozen and copied.

The builder refuses a context that does not belong to the task: one written
for another task, run or agent, one built from a revision that is neither the
one this handoff was decided at nor the one it produced - a handoff writes the
context from the snapshot before the transition, so an earlier attempt left at
the same path is what that rules out - and a task whose recorded `contextPath`
is not the path its own `runId` and `agentId` name. The last check is now the
second guard on that pair rather than the only one - `taskSchema` refuses to
record it - and it stays because a `Task` reaches this builder from a caller
that may have assembled it rather than read it. Every disagreement is listed
at once.

An adapter reports `AgentEvent`s: `started` once, any number of `output`
chunks and `tool-action`s - each action with the verdict `evaluateToolAction`
gave it - and `finished` once, last, carrying the run's status: `completed`,
`failed`, `timed-out` or `aborted`. `recordAgentRun` drives an adapter,
validates every event against the schema, holds them to that order, and
returns the events with the closing one; an adapter that breaks the protocol
is reported as a `ProviderProtocolError`, which is a defect rather than a
condition an exit code should describe. `finishedEventOf` turns a
`CommandResult` into the closing event, so an adapter built on
`nodeCommandRunner` gets its timeouts, output caps and environment allowlist
from there and its final status from here.

An adapter is written against the installed CLI's `--help`, because provider
flags are version-sensitive and a guessed flag would ship behind a passing
test suite: no test may make a live call, so no test could catch it. `claude`
is installed on the machine this was built on and `codex` is not, so the
Claude adapter exists and the Codex adapter waits for its CLI. The contract
carries no provider flag.

### The Claude adapter

`createClaudeCliAdapter` runs one `claude` process per invocation through the
injected `CommandRunner`, with the flags `claude --help` (2.1.263) documents
for a governed, non-interactive session, and nothing it does not:

- `--print --output-format stream-json --verbose`: one turn, reported as one
  JSON line per message, read as it arrives. `--no-session-persistence`: the
  transcript the sailor keeps is the record, not the user's session store.
- `--restricted --strict-mcp-config --disable-slash-commands`: the file tools
  are confined to the project, the tools that run code exist only if `--tools`
  names them, no MCP server and no skill is loaded, and the user's, the
  project's and the local settings files are ignored while `--settings` still
  applies. `CLAUDE.md` files are still read; the only flags that stop that
  also stop the gate or the login.
- `--tools`: `Read,Glob,Grep,Edit,Write,NotebookEdit`, plus `Bash` only for an
  agent with `execute: true`. Every agent keeps the file tools because every
  agent may write to its own scratch directory; which paths is the gate's
  decision.
- `--permission-prompts none`: nobody answers a prompt, so whatever would
  have prompted is denied unless the gate allowed it first.
- `--model`: the logical profile mapped through `DEFAULT_CLAUDE_MODELS`
  (`opus`, `opus`, `sonnet`, the aliases `--help` documents) or the mapping
  the adapter was given. `--max-budget-usd` when a cap is configured.
- `--settings`: a `PreToolUse` hook on every tool. The hook is the gate.

`claudeAdapterOptions` is what turns `config/models.yaml` and
`config/providers.yaml` into those options: the command that starts the CLI,
the model each profile runs on - the project's where it named one and the
adapter's where it did not - and the spending cap, passed as no cap at all
rather than as a `null` that would reach `--max-budget-usd` as a string. It
is the one place the two files become adapter options, so whatever drives a
task cannot arrive at a second reading of them.

The gate is `tool-gate-main.js`, shipped in `dist/` and run by the CLI
through `sh -c` before each tool call with the call as JSON on stdin. It
reads its configuration - project root, the invocation's `ToolPolicy`, and
where to log - from one environment variable the adapter sets on the CLI's
process, maps the call to a `ToolAction`, asks `evaluateToolAction`, appends
the decision to a log and answers the CLI in the shape the hooks reference
documents. It fails closed: anything that stops a decision being made exits
`2`, which blocks the call. A `Read`, `Edit`, `Write` or `NotebookEdit` is
the path it names, made canonical on both sides - the CLI reports real paths,
and a project root reached through a symbolic link is the same place - and
re-expressed from the project root; a path that leaves the project is refused
as `outside-project` before the policy is consulted. `Glob` and `Grep` are
searches. A `Bash` command that is plainly words is the argument vector the
policy decides; one that needs a shell - a pipe, a redirection, `$`, a glob -
is recorded as `sh -c <command>`, which is what the tool runs and which no
policy grants. A tool the gate does not know is refused loudly, because the
session was given exactly the tools it knows.

The adapter reports the run as the contract's events: the CLI's text as
`output`, each decision as a `tool-action` when the CLI prints the tool's
result, the CLI's stderr as `output`, and `finishedEventOf` the runner's
result. The invocation's abort signal terminates the process and the run is
`aborted`. A `tool_use` in the transcript with no decision in the log is
`tool-gate-failed`, exit `5`, thrown from the adapter: a CLI that ran a tool
without consulting the gate is one whose run the sailor cannot vouch for.
The decision log and the verbatim transcript land under
`.sailor/state/runs/<run-id>/claude/<agent-id>/attempt-<n>.*`, beside the
agent's directory rather than inside it, so the record of what the agent did
is not something the agent may write.

`recordAuditedAgentRun` is the provider-neutral wrapper that makes the audit
mechanical: it snapshots the tree, drives the adapter through
`recordAgentRun`, snapshots again and puts every changed path to the
invocation's policy, with the private index under `.sailor/state/audit/`.

What the mechanism enforces is exactly as strong as the CLI's reporting of
its own tool calls, and the audit covers writes whatever the CLI reported.
`nodeCommandRunner` forwards `USER` for this adapter's sake: the CLI keeps
its login in the macOS keychain and finds it by account name.

## Tool policy enforcement

Design decision 6 says an agent's tool permissions are enforced by the runtime
and not merely written into its prompt. The definitions and contexts have
carried `tools`, `writeScopes` and `projectScripts` since Milestone C; this is
what reads them.

An action is one of four things - a `read`, a `search`, a `write` of one path,
or an `execute` of one argument vector - and `evaluateToolAction` decides each
against a `ToolPolicy` built from the agent's context by `toolPolicyFromContext`.
The decision is a value, allowed or denied, and a denial names its cause from a
closed list rather than in prose, so a record of a run can be read by kind.

A write is held to four things, in order:

1. It has to be inside the project. `../x`, `/etc/passwd` and a path with a
   backslash in it are outside, whatever the scopes say: `**` grants the
   project, not the machine.
2. The agent's own context directory is scratch. Every agent may write there,
   whether or not it may edit, so a reviewer with `edit: false` can still
   leave its findings - except for `context.json`, which is what the agent was
   handed and is never rewritten by the agent holding it.
3. The rest of `.sailor/` belongs to the sailor. Rules, definitions,
   configuration, hooks and `tasks.yaml` are what govern the agents, and a
   scope that could reach them would let an agent widen its own scope for the
   next run. No scope reaches them.
4. Only then do `tools.edit` and the write scopes apply. A scope's wildcards
   are `*`, `**` and `?` - the schema admits nothing else - and the matcher
   implements exactly those. Dotfiles match: a scope names a subtree.

An execute is a project script or it is refused. The definition grants scripts
by their semantic name, and a command is recognised as one in the form the
sailor would build for it - `npm run test`, `pnpm run lint`, arguments after
the name permitted - plus the bare `test` each manager documents (`npm test`,
`npm t`, `pnpm test`, `yarn test`; not `bun test`, which is Bun's own runner).
`npx jest` runs the same tests and is still refused: it is not a script the
definition named, and there is no arbitrary command an agent is permitted.

Two things enforce this, because a CLI-driven agent is a separate process and
the sailor cannot see inside it:

- A provider that can ask before the agent acts asks `evaluateToolAction`
  through its adapter, and reports the action with the verdict it received.
  How strongly `execute` is enforced is exactly as strong as that: a command
  the provider does not report before running it cannot be refused.
- Whether or not it can, the working tree is compared afterwards.
  `snapshotWorkingTree` stages everything git would track into a **private
  index** named through `GIT_INDEX_FILE` and writes it as a tree object, once
  before the run and once after; `auditWorkingTree` has git list the paths
  that differ and puts every one of them to the write policy. A change outside
  the scopes is a violation whatever the provider reported, and a deletion is
  a change. The repository's own index is never read or written.

The audit is a report, not an exception: a violation is a finding about the
run, and refusing the handoff is the runtime's decision. Git failing is an
exception, `working-tree-audit-failed`, exit `5` - the sailor cannot say
whether the agent stayed in scope, so accepting the work would be the unsafe
act. A path list git could not print in full is refused for the same reason.

Two limits are worth stating. The audit sees what git sees, so a write to an
ignored path is outside it - which is what makes `.sailor/state/` scratch -
and a write through a symlink that leaves the project is a write git records
against the link. And it is after the fact: it can refuse the handoff and
record why, but the file has been written, and undoing it is not something the
sailor does on its own.

## Planned modules

- The Codex adapter behind the contract, written against its installed CLI
- A runtime that drives a task through its agents, recording each audited
  run on the task
- Specifier, coder, cleaner, architect, hardener, and QA agents
