# Milestone D5 handoff: provider and model configuration, then the driver

## How to start

Open a new session in the worktree `<PROJECTS>/sailor-codex-milestone-d5`,
on branch `codex/milestone-d5`, cut from `main` at `5811b2b` with this
document as its only commit, and paste the prompt at the end. Read
`AGENTS.md`, `README.md`, `docs/handoff/milestone-d.md` (D1, D2, the
completion guard and the open findings) and `docs/handoff/milestone-d3.md`
(the Claude adapter, the decisions it took, the live transcripts) completely
before writing code. `docs/handoff/rule-enforcement.md` is the original
design; `docs/handoff/milestone-c.md` holds the standing trap list.

## Where things stand

- Repository: `simonfrets/sailor`. Local: `<PROJECTS>/sailor` is the plain
  clone on `main`; branch work lives in sibling worktrees named
  `<PROJECTS>/sailor-<branch>`. `<PROJECTS>/agentic-harness` is the old bare
  repository and its worktrees are legacy; nothing current lives there.
- `main` at `5811b2b` is PR #5 merged: Milestones A, B, C, D1, D2, the QA
  completion guard and D3. CI ran it on Linux at the Node floor and at
  current 22, and on macOS at the floor, all green.
- Local gate at `5811b2b`: `npm run check`, `npm run build`,
  `npm run test:coverage`, `npm pack --dry-run` all pass; 947 tests across
  82 suites at 98.64% statements; suite verified under the simulated hook
  environment. `PUBLIC_API` is 290 entries.
- **`sailor init` cannot install its runtime from `main`.** The installer
  pins the release tarball
  `https://github.com/simonfrets/sailor/releases/download/v<version>/sailor-<version>.tgz`
  (`sailorReleaseTarballUrl`, `SAILOR_PACKAGE_NAME`), and the only release,
  `v0.1.0`, carries the pre-rename asset `agentic-harness-0.1.0.tgz`. A
  fresh install resolves a URL that does not exist and fails at the
  dependency step, which the installer reports and survives, but the hooks
  are then never pointed at the sailor. The fix is a release: bump
  `package.json` and `package-lock.json` to `0.2.0`, tag `v0.2.0`, attach
  the `sailor-0.2.0.tgz` that `npm pack` produces. Cutting the release is a
  person's act; preparing the bump is the session's. Until then, the
  criteria 1 to 3 re-check in the completion gate has to point the private
  `package.json` at a locally packed tarball.
- The Claude adapter is done and verified live; the Codex adapter is not
  written because `codex` is not installed where any of this was built.

## What remains, and the order

| Step | Subject                                     | Depends on            | State   |
| ---- | ------------------------------------------- | --------------------- | ------- |
| D5   | `Validate provider and model configuration` | nothing               | next    |
| R    | `Release v0.2.0 with the renamed tarball`   | a person, after D5    |         |
| D6   | `Drive a task through its agents`           | D5                    |         |
| D4   | `Invoke an agent through the Codex CLI`     | **`codex` installed** | blocked |

### D5, the configuration

Today the adapter takes its provider-specific facts as options:
`createClaudeCliAdapter({ runner, claude, toolGate, models, maxBudgetUsd })`,
where `claude` is the `CommandSpec` that starts the CLI (default
`{ executable: "claude", args: [] }`), `models` maps the three logical
profiles to what `--model` is given (default `DEFAULT_CLAUDE_MODELS`:
`opus`, `opus`, `sonnet`, the aliases `--help` documents) and
`maxBudgetUsd` is the optional cap. The design puts these in
`.sailor/config/models.yaml` and `.sailor/config/providers.yaml`, and
`MODEL_PROFILES` is already the logical side. D5 is:

- Two seeded templates under `templates/.sailor/config/`, project-owned
  like `project.yaml`, `hooks.yaml` and `notifications.yaml`, with **every
  key defaulted** so a copy seeded by an older version keeps parsing
  (`shipped-templates.test.ts` asserts `version: 1` alone validates; keep
  that true for the new schemas). Executable commands are argument vectors,
  never shell strings.
- Loaders beside `notifications-config.ts`: a schema, a `load*Config`, a
  `readInstalled*Config` that reads the installed copy and reports an
  invalid file rather than ignoring it. Model ids are validated by the
  adapter that consumes them, as the design says; for Claude that means
  non-empty strings, since `--model` accepts aliases and full names alike
  and refuses nothing until the request is made.
- The adapter reads them: a function that builds the Claude adapter's
  options from the two configs, so the driver never assembles them by
  hand. Which provider an agent runs on is not in the agent definition;
  `providers.yaml` should name the default and, if wanted, a per-agent
  override.
- `sailor doctor` reports the provider: whether the configured command is
  on `PATH` and what `--version` prints (`2.1.263 (Claude Code)` is what the
  adapter was written against; a different version is a warning, not a
  failure, because the flags are what matter and only a live run proves
  them). The doctor test pins the diagnostic id list and a fresh install's
  warning count; both change on purpose.
- `sailor-templates.test.ts` pins the shipped file list and the seeded
  list; both change on purpose. `README.md`'s "Agent definitions and
  configuration" section is where the two files are described.

### D6, the driver

Nothing yet drives a task. What exists: `createTask`, `approveSpecification`
and `transitionTask` under `updateTaskFile`'s lock; `buildAgentContext`,
`writeAgentContext`, `readAgentContext`; `buildAgentInvocation`;
`recordAuditedAgentRun`, which snapshots, runs the adapter through
`recordAgentRun` and audits; `completeTask` for `qa -> completed`. D6 wires
them into one thing that takes a task from `awaiting_approval` to `qa`,
one agent at a time, and decides:

- Run ids. A retry mints a new run and must pass it as `newRunId` before
  writing the context under it (finding 1 in `milestone-d.md`); rework out
  of `blocked` reuses the run (finding 2). Make the driver unable to get
  this wrong, or make the library refuse it.
- What a run's outcome does to the task: `completed` with a clean audit
  moves on; a violation, a `failed`, a `timed-out` or an `aborted` run
  records a failure; a `tool-gate-failed` refusal, which arrives as a
  thrown `SailorError` rather than a `finished` event, is a failure too and
  the tree it leaves is the driver's to report. Gate reports for
  `pre-handoff` run between agents and are recorded on the transition.
- The agent's `summary` and `displayName` do not reach the prompt, because
  `AgentContext` does not carry them; adding them touches C3's schema and
  is worth doing first.
- `validationMode` is read and reported and filters nothing; `native-only`
  and `harness-only` describe an intent the runtime does not honour.
- Findings 3 to 7 from the Milestone C review are untouched.

### D4, when it is possible

Follow D3's shape exactly: run `codex --help` and the help of the
subcommand that runs non-interactively, decide how its permission or
sandbox mechanism maps onto `ToolPolicy`, find the place it lets an adapter
answer before an action or state plainly that it has none and the audit is
the whole enforcement, write the fake executable first, and demonstrate one
live run by hand. Do not start it from memory of what Codex accepts.

## Traps this branch earned

The lists in `milestone-c.md`, `milestone-d.md` and `milestone-d3.md` still
hold. New since D3:

1. **zsh does not word-split an unquoted variable.** `npx jest $tests` with
   two paths in `$tests` runs Jest on one nonexistent path, prints "No tests
   found" and exits 1 with no `Tests:` line. Use `${=tests}` or an array.
   This hid four mutation results for one round.
2. **A temporary directory is a symbolic link on macOS.** `os.tmpdir()` is
   `/var/...`, the real path is `/private/var/...`, and the Claude CLI
   reports real paths. Tests use `createTempDirectory`, which resolves the
   link; the gate resolves both sides itself. A hand-run demonstration that
   builds its own directory meets the raw form.
3. **The CLI's login needs `USER`.** It is in `ENVIRONMENT_ALLOWLIST` now.
   Do not reach for `--bare` to isolate a run: it restricts authentication
   to an API key.
4. **`--tools` drops a name it does not know silently.** `MultiEdit` is not
   in 2.1.263. Read the `tools` list in the init message of a `--print` run
   before trusting a name.
5. **A live run with `opus` costs about USD 0.40** for a two-file task.
   `--max-budget-usd` is set by the adapter when given; give it.
6. **Stage whole files.** lint-staged stashes unstaged changes around its
   tasks; a partially staged file and a failing task revert the staged set.
7. **Hashes quoted in the older handoffs predate the rebase.** Subjects
   are unchanged; search by subject.
8. **CI runs on pushes to `main` and on pull requests only.** A branch has
   never been through CI until its pull request exists.
9. **No `Co-Authored-By` or "Generated with" trailer**, in commits or pull
   request bodies. Every one in this repository's history was stripped on
   purpose.

## Completion gate

```sh
npm run check
npm run build
npm run test:coverage
npm pack --dry-run
```

Plus the suite once under the simulated hook environment
(`GIT_DIR=$PWD/.git GIT_WORK_TREE=$PWD GIT_INDEX_FILE=$PWD/.git/index npx jest`).

Then, for D5: a real `sailor init` from the built CLI against a throwaway
repository, with the private `package.json` pointed at a locally packed
tarball until the release exists, showing the two new seeded files written,
`sailor doctor` reporting the provider, and the adapter built from the
installed configuration invoking one agent live, once, by hand. Quote the
transcript in the handoff. Report any deviation directly. Do not describe
partial work as complete.

## Starting prompt

> Continue Sailor in the worktree `<PROJECTS>/sailor-codex-milestone-d5` on
> branch `codex/milestone-d5`, cut from `main` at `5811b2b`. Read
> `AGENTS.md`, `README.md`, `docs/handoff/milestone-d.md`,
> `docs/handoff/milestone-d3.md` and `docs/handoff/milestone-d5.md`
> completely before writing code. Implement **D5 only**:
> `.sailor/config/models.yaml` and `providers.yaml` as seeded, fully
> defaulted configuration; loaders beside the existing config loaders; a
> function that builds the Claude adapter's options from them; and
> `sailor doctor` reporting whether the configured provider command is on
> `PATH` and what version it prints. Test-first, with fake executables and
> never a live call from a test. `codex` is not installed, so D4 stays
> unwritten; do not start D6. Prepare the `0.2.0` version bump for the
> release the installer needs, but do not cut the release. Run the
> completion gate, demonstrate the configured adapter live once by hand, and
> report any deviation directly.
