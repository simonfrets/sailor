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
| D5   | `Validate provider and model configuration` | nothing               | done    |
| R    | `Release v0.2.0 with the renamed tarball`   | a person, after D5    | ready   |
| D6   | `Drive a task through its agents`           | D5                    | next    |
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

New in D5:

10. **A fake runner keyed by the executable alone cannot see arguments.**
    `createFakeCommandRunner` answers per executable, so a test that only
    reads the diagnostic's wording passes however the arguments were
    mangled. Assert the `CommandRequest` that was made.
11. **`z.strictObject(...).default(value)` takes the output type**, so the
    value has to spell out every key the shape fills in. Typing a default
    command as `readonly [string, ...string[]]` is what keeps that literal
    free of a cast.
12. **Installing the packed tarball runs `prepare`, which runs `husky`, which
    fails outside a git repository.** Use `npm install --ignore-scripts` when
    resolving an extracted copy of this package for a demonstration.
13. **A hand-run demonstration is worth more than its transcript.** The
    provider check's ordering defect was invisible to 61 unit tests and
    obvious the first time a real `default: codex` was diagnosed.

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

## What D5 added

Five commits on `codex/milestone-d5`, on top of the handoff commit:

| Commit    | Subject                                                   |
| --------- | --------------------------------------------------------- |
| `fef5e1b` | Configure providers and models as the project's own files |
| `9010485` | Build the Claude adapter from the installed configuration |
| `71e5877` | Report the configured provider in `sailor doctor`         |
| `ddd9c79` | Prepare the 0.2.0 release the installer needs             |
| `9d4cf66` | Decide a provider with no adapter before probing its CLI  |

`npm run check`, `npm run build`, `npm run test:coverage` and
`npm pack --dry-run` pass: 999 tests across 85 suites at 98.69% statements,
verified under the simulated hook environment. `PUBLIC_API` is 306 entries.
`README.md`'s "Agent definitions and configuration", "The Claude adapter"
and installer sections are the reference.

| Module                                  | Public surface                                                                                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/models-config.ts`           | `modelsConfigSchema`, `providerModelsSchema`, `modelsForProvider`, `loadModelsConfig`, `readInstalledModelsConfig`                                                                                                                     |
| `src/config/providers-config.ts`        | `DEFAULT_PROVIDER_COMMANDS`, `providerCommandSchema`, `claudeProviderConfigSchema`, `codexProviderConfigSchema`, `providersConfigSchema`, `providerForAgent`, `providerCommand`, `loadProvidersConfig`, `readInstalledProvidersConfig` |
| `src/providers/claude/claude-config.ts` | `claudeAdapterOptions`                                                                                                                                                                                                                 |
| `src/providers/provider-adapter.ts`     | `PROVIDER_CLI_VERSIONS`                                                                                                                                                                                                                |

`SAILOR_PATHS` gained `modelsConfig` and `providersConfig`;
`SEEDED_TEMPLATE_PATHS` gained the two files, and is now five. No error kind
was added: everything here is `invalid-config`, which already existed.

### The two files

```yaml
# config/models.yaml
version: 1
models:
  claude:
    coding-high: opus
    reasoning-high: opus
    verification: sonnet
```

```yaml
# config/providers.yaml
version: 1
default: claude
agents: {}
claude:
  command: [claude]
  maxBudgetUsd: null
codex:
  command: [codex]
```

### Decisions taken where the design was silent

1. **A profile the project leaves out keeps the adapter's model.**
   `claudeAdapterOptions` merges `models.yaml` over `DEFAULT_CLAUDE_MODELS`
   rather than replacing it, so overriding one model does not mean restating
   and then maintaining the other two, and a copy seeded before a profile
   existed keeps working. The shipped template writes the three defaults out
   anyway, so they can be seen and edited, and a test pins that block against
   `DEFAULT_CLAUDE_MODELS` - the one place the fact lives - so the two cannot
   be changed apart.
2. **A model id is a non-empty string and nothing more.** That is all this
   side can honestly check: `claude --model` takes aliases and full names
   alike and refuses neither until the request is made. The design already
   said the consuming adapter validates ids; for Claude, that validation is
   the request.
3. **The provider is the project's decision, not the agent definition's.** A
   definition names a logical profile and stays portable, so `providers.yaml`
   carries `default` plus a per-agent override map. `providerForAgent` is the
   whole of the lookup.
4. **A command is a tuple, not a length-checked array.**
   `z.tuple([z.string().min(1)], z.string().min(1))` types the executable as
   `string`, so nothing that destructures a configured command needs a
   fallback branch for an executable that the schema has already refused.
5. **`codex` is admitted and carries a command and nothing else.** The
   contract admits the provider, so the configuration must; its CLI was never
   read here, so anything shaped for its flags would be the guess the design
   forbids. `maxBudgetUsd` lives under `claude` alone for the same reason.
6. **No spending cap by default.** A cap that stops a run half way through
   leaves the tree the agent was in the middle of changing, and what a run is
   worth is the project's judgement. The template says so in place, with the
   measured USD 0.40 of a two-file `opus` run beside it.
7. **A provider with no adapter is a problem, decided before anything is
   spawned.** It is a fact about the package rather than about the machine,
   so probing first would have made installing the CLI look like the fix. It
   is a problem and not a warning because an installation whose agents are
   routed to a provider it cannot drive can run none of them. The live
   demonstration is what found this: `default: codex` first reported
   `codex --version could not be started`, which reads as a missing program.
8. **The provider check covers every provider the configuration could route
   an agent to**, the default and each per-agent override. An override to a
   provider that is not there breaks exactly the agent it names while the
   default one reports perfectly, so a default-only check would have called
   that installation healthy.
9. **`models.yaml` and `providers.yaml` are validated by the `config`
   check, not the `provider` one.** Absent is the defaults, invalid is a
   problem, and the provider check then says it cannot run rather than
   guessing - the same shape `hooks` already had against `hooks.yaml`.
10. **`PROVIDER_CLI_VERSIONS` lives beside the contract**, mapping each
    provider to the CLI version its adapter was written against and `null`
    where no adapter exists. It is what the doctor compares against, so which
    `--help` an adapter was read from is recorded as data rather than as
    prose in a comment.

### Two tests that could not fail, found and fixed

Both were found by mutation, and both had been written to guard exactly what
they missed.

- `SEEDED_TEMPLATE_PATHS` was only ever asserted against itself, so removing
  `config/models.yaml` from it kept the suite green. A config template added
  and never seeded would have been installed as **managed**: reconciled on
  the next `sailor init`, and a conflict the first time the project edited
  the file it had been given to edit. A test now asserts that everything
  shipped under `config/` is seeded.
- The doctor test that says the configured command is the one that runs
  asserted the sentence describing the command. The fake runner is keyed by
  executable alone, so dropping the configured arguments changed nothing it
  looked at. It now asserts the request that was spawned.

Six further mutations each turned a test red: the project's models losing to
the adapter's, the cap dropped, a command's arguments dropped, an empty word
accepted as an executable, a cap of zero accepted, an unknown model profile
accepted, and the shipped template drifting from `DEFAULT_CLAUDE_MODELS`.

### The live demonstration

By hand, against a throwaway git repository, from the packed `sailor-0.2.0`
tarball rather than the development tree.

**One deviation, and it is the one the handoff anticipated.** v0.2.0 is not
released, so `sailorReleaseTarballUrl` in the _extracted copy_ of the tarball
was pointed at the locally packed `sailor-0.2.0.tgz`. One function, in a
throwaway extraction, and nothing in the repository. With that,
`sailor init` completed for real: 21 files created, hooks dispatched,
`Runtime dependencies resolved in .sailor/node_modules`, exit 0. Both new
files were written:

```text
$ ls .sailor/config
hooks.yaml  models.yaml  notifications.yaml  project.yaml  providers.yaml
```

`sailor doctor`, against the real `claude` at `~/.local/bin/claude`:

```text
OK   Configuration — .sailor/config/project.yaml, .sailor/config/hooks.yaml, .sailor/config/models.yaml, .sailor/config/providers.yaml are valid
OK   Provider — claude 2.1.263 (Claude Code), from `claude --version`
Result: 0 problems, 2 warnings
```

and the two refusing branches, each with the file edited and put back:

```text
# agents: { qa: codex }
FAIL Provider — claude 2.1.263 (Claude Code), from `claude --version`
       this sailor has no adapter for codex, so no agent can be run on it whether or not its CLI is installed
exit 3

# claude: { command: [claude-not-here] }
FAIL Provider — `claude-not-here --version` could not be started: spawn claude-not-here ENOENT, so no agent can be run on claude
```

Then one live invocation of the coder, through the sailor **installed in the
project** rather than the development tree, with the adapter built by
`claudeAdapterOptions` from the installed files. `models.yaml` was edited to
`coding-high: sonnet` and `providers.yaml` to `maxBudgetUsd: 3` first, so the
run proves the configuration was read: the adapter's own default for that
profile is `opus`.

```text
models.yaml: {"claude":{"coding-high":"sonnet","reasoning-high":"opus","verification":"sonnet"}}
providers.yaml: {"command":["claude"],"maxBudgetUsd":3}
model for coding-high: sonnet
[started] --model sonnet
[tool] read .sailor/state/runs/run-demo/agents/coder/context.json -> allowed
[tool] read docs/specs/greeting.md -> allowed
[tool] execute sh -c ls -la ... && cat .../package.json -> denied (not-a-project-script)
[stdout] I can't run arbitrary Bash commands - only the four npm scripts are permitted. I'll use Glob/Read instead.
[tool] search src/** -> allowed
[tool] read package.json -> allowed
[tool] write src/greeting.js -> allowed: within the write scope `src/**`
[tool] write tests/greeting.test.js -> allowed: within the write scope `tests/**`
[stdout] The write scope for this stage is limited to `src/**` and `tests/**`, so I can't edit `README.md` even though the spec asks for a README example - I'll flag that as a gap.
[tool] execute npm run test -> allowed
[tool] execute npm run lint -> allowed
[tool] execute npm run typecheck -> allowed
[tool] execute sh -c npm run test 2>&1 | head -3 -> denied (not-a-project-script)
[tool] execute npm run build -> allowed
[finished] completed: exited with code 0 (138883ms)
```

Audit: `src/greeting.js` and `tests/greeting.test.js` changed, no violations,
the repository's own index untouched. The decision log and the transcript
were on disk at
`.sailor/state/runs/run-demo/claude/coder/attempt-1.{decisions,transcript}.jsonl`.

The demo's own `test` script (`node --test tests`) is broken in this Node
build - it resolves `tests` as a module and throws `MODULE_NOT_FOUND` - which
is the same shape of fixture defect D3 hit. The agent diagnosed it, refused
to touch `package.json` because it was outside its write scope, and closed by
saying the required gate fails for an environment reason rather than claiming
a green run. That is the demonstration working, not failing.

### Open, after D5

- **The release is not cut.** `package.json` and `package-lock.json` say
  `0.2.0`; tagging `v0.2.0` and attaching the `sailor-0.2.0.tgz` that
  `npm pack` produces is a person's act. Until it exists, `sailor init` from
  `main` still fails at the dependency step, and any re-check has to point
  the URL at a local tarball as above.
- **D4** stays unwritten: `codex` is still not installed.
- **D6**, the driver, is next and is described above. `claudeAdapterOptions`
  is where its adapter comes from; `providerForAgent` is how it chooses one;
  a provider with no adapter is a condition it has to refuse rather than
  discover.
- `validationMode` still filters nothing, and findings 2 to 7 from the
  Milestone C review are still untouched.
- `AgentContext` still carries no `summary` or `displayName`, so the prompt
  says "the `coder` agent" and nothing of what a coder is for.
- Nothing checks that a model id names a model that exists. Nothing can,
  before the request; a run that names a model the provider rejects fails at
  the provider, and the failure is the adapter's to report.

## Starting prompt for the next session

> Continue Sailor from `codex/milestone-d5` in a worktree cut from it. Read
> `AGENTS.md`, `README.md`, `docs/handoff/milestone-d.md`,
> `docs/handoff/milestone-d3.md` and `docs/handoff/milestone-d5.md`
> completely before writing code. D1, D2, D3, D5 and the QA completion guard
> are done; `codex` is still not installed, so D4 stays unwritten.
> Implement **D6 only**: the driver that takes a task from
> `awaiting_approval` to `qa`, one agent at a time, on top of
> `transitionTask`, `writeAgentContext`, `buildAgentInvocation`,
> `recordAuditedAgentRun` and `claudeAdapterOptions`. Make the run-id
> mistakes in findings 1 and 2 of `milestone-d.md` unmakeable rather than
> merely documented. Test-first, with fake executables and never a live call
> from a test. Run the completion gate, demonstrate one task driven through
> at least two agents live by hand, and report any deviation directly. The
> `v0.2.0` release is prepared but not cut; until it is, point the private
> `package.json` at a locally packed tarball for any installer re-check.
