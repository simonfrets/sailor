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
rather than only when someone remembers to invoke it. The two configuration
files it installs belong to the project and can be edited freely.

Task state, the workflow state machine and per-agent handoff contexts are
implemented: a transition is recorded into `.sailor/tasks.yaml` through
`updateTaskFile`, which holds an exclusive lock across the whole
read-change-write, and a context is written per run and per agent. Pairing the
two - writing the next agent's context and recording the transition that points
at it - is the runtime's job, and there is no runtime: the Codex and Claude
adapters are **not** implemented yet, so nothing invokes an agent and the
workflow is driven through the library.

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
- **seeded** files are the project's. `config/project.yaml` and
  `config/hooks.yaml` carry the only decisions discovery cannot make, so they
  are written once, when absent, and never reconciled again. They exist to be
  edited; a sailor that refused to run afterwards would be refusing to run
  because it had been configured.

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
  "sailor": "https://github.com/<owner>/<repo>/releases/download/v0.1.0/sailor-0.1.0.tgz"
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
configuration files, the rule set, the private dependency tree, Git hook
reachability, whether every check can resolve the project script it names, and
whether anything runs the gates in CI.

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
`templates/.sailor/config/` ships the two settings files the installer will
place alongside them. Both are validated by the test suite, so a shipped
template that stops matching its schema fails the build.

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

`sailor init` installs these files and `sailor doctor` validates the
installed copies. Hook dispatch is the next milestone, and enforcing the tool
policy at run time belongs to the provider adapters.

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

carrying that agent's own tool policy and write scopes, the compiled policy for
the rule set in force, the rule-set hash, and what the previous agent left
behind. There is no shared, mutable context object: the run and the agent are
both in the path, each read parses the file again, and what comes back is
frozen.

Writing that context and recording the transition that points at it are two
calls, `writeAgentContext` and `transitionTask`, and the sailor does not
couple them: `contextPath` is optional on a transition and defaults to none,
which is what a move into a stage no agent owns records. Ordering them belongs
to whatever drives the workflow, and that is Milestone D. Today the only driver
is the library's own test driver.

Context first and then the transition naming it works for every move that stays
in the same run. It does **not** work for a retry out of `failed`, and a driver
that assumes it will overwrite the attempt it is replacing. A retry starts a new
run, and `transitionTask` mints that id inside the call, so a driver writing the
context first has only the old run id to write it under - and a context path is
a function of the run and the agent, so the file lands on top of the failed
attempt's. The task then carries a `runId` and a `contextPath` that disagree,
and nothing validates that pair.

A driver retrying a task must therefore mint the run id itself, pass it as
`newRunId`, and write the context under that. `newRunId` exists for this and
takes precedence over the default. Nothing enforces it, which is why it is
written here: the guarantee that an attempt cannot overwrite the record of the
one it replaces is the caller's to keep, not the library's to give.

Resuming a `blocked` task keeps its run, because nothing was discarded - except
that recovery may target any stage at or before the interrupted one, so sending
a task back for rework does discard, and reuses the run it discarded under.
Rework carries the same overwrite, without even a new run id to reach for.

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

## Planned modules

- Typed Codex and Claude CLI adapter contract
- Runtime enforcement of the shipped agent tool policies
- Specifier, coder, cleaner, architect, hardener, and QA agents
