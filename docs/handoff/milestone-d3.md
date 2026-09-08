# Milestone D3 handoff: invoke an agent through the Claude CLI

## How to start

Open a new session in a worktree on a branch cut from `codex/milestone-d`
and paste the prompt at the end of this document. Read `AGENTS.md`,
`README.md` and this document completely before writing code.
`docs/handoff/milestone-d.md` carries the D1/D2 surfaces and the QA
completion guard in detail; `docs/handoff/rule-enforcement.md` is the
original design. Read both.

## Where things stand

- Branch: `codex/milestone-d`, pushed, HEAD `2c880e4`, 12 commits ahead of
  `origin/main`, **not merged and with no pull request**. CI triggers on
  pushes to `main` and on pull requests only, so **CI has not run this
  branch**; opening its PR is what runs it.
- Local gate at `2c880e4`: `npm run check`, `npm run build`,
  `npm run test:coverage`, `npm pack --dry-run` all pass; 870 tests across
  76 suites at 99.22% statements; `npm audit` clean; suite verified under
  the simulated hook environment.
- `v0.1.0` remains the only release. Nothing on this branch reaches an
  installed project until a release attaches a fresh `npm pack` tarball.
- D1 (adapter contract), D2 (tool-policy enforcement) and acceptance
  criterion 10 (the completion guard, notifications included) are done and
  documented in `README.md`.

## Two open pull requests to be aware of

1. **PR #4, `chore/rename-to-sailor`, opened 2026-09-04.** A whole-project
   rename touching 121 files, cut from `main` _without_ this branch's 12
   commits. Whichever of the two merges second carries a large rebase, and
   the rename moves things this branch's code states literally: the package
   name in `sailorReleaseTarballUrl`, the `SAILOR_TASK_*` environment
   variables, `.sailor/` itself. Merge order is a decision for a human,
   not for this session. Do not start D3 from the rename branch.
2. **PR #1, `worktree-sailor-v1-scaffold`.** A pre-repository scaffold,
   stale since 2026-08-25. Ignore it.

## D3 scope

Implement `ProviderAdapter` for the Claude CLI, and nothing else.

- **Read `claude --help` (and the help of relevant subcommands) before
  writing a single flag.** Flags are version-sensitive; the design forbids
  guessing them. `claude` is at `~/.local/bin/claude`. `codex` is still not
  installed; D4 stays unwritten.
- Tests use fake executable fixtures, never a live call (criterion 12). The
  one live thing is the completion-gate demonstration below, by hand.
- D5 (`config/models.yaml`, `config/providers.yaml`) only if the adapter
  cannot be honest without it; otherwise leave it to its own session.

## What the adapter builds on, and must not reimplement

- `buildAgentInvocation` hands it a frozen `AgentInvocation`: project root,
  context path, task snapshot, attempt, previous handoff, compiled policy,
  logical model profile, `toolPolicy`, timeout, abort signal.
- `recordAgentRun` drives the adapter and enforces the event protocol;
  `finishedEventOf` maps a `CommandResult` to the closing event. Build on
  `CommandRunner`; `nodeCommandRunner` already owns timeouts, output caps
  and the environment allowlist. **It has no abort support**: honouring
  `invocation.signal` mid-run needs either a runner extension or an honest
  statement that abort only prevents a start.
- `evaluateToolAction` answers pre-action questions where the CLI offers a
  hook; `toProjectRelativePath` normalises reported paths first.
- `snapshotWorkingTree` / `auditWorkingTree` wrap the run; the audit is the
  enforcement a provider cannot opt out of. Use an `indexFile` under
  `.sailor/state/audit/`, never inside the agent's own context directory.
- Map `invocation.toolPolicy` onto whatever permission mechanism
  `claude --help` actually documents. How strongly `execute` is enforced is
  exactly as strong as that mechanism's reporting, and the README says so.

## Traps beyond the standing lists

The lists in `docs/handoff/milestone-d.md` and `milestone-c.md` still hold.
New ones this branch earned:

1. `@cucumber/gherkin` is pinned to `^39.1.0` because 40+ is ESM-only and
   the CommonJS test build cannot load it. Do not "upgrade" it.
2. A failing lint-staged task mid-commit reverts the staged set; fix,
   restage, commit again - and run `prettier --check` on new files first.
3. `PUBLIC_API` in `tests/unit/index.test.ts` is 256 entries and exact.
4. The template tests pin the exact shipped file list and the seeded list
   (three config files now); the doctor test pins the diagnostic id list,
   and a fresh install reports two warnings (CI, Notifications).
5. The workflow test driver fabricates completion evidence deliberately;
   the real path lives in `tests/integration/qa/complete-task.test.ts`.
   Do not "fix" the driver.
6. A scripted edit computed in memory and never written back cost this
   branch a red run: verify every scripted rewrite landed (trap 17's
   sibling).

## Completion gate

```sh
npm run check
npm run build
npm run test:coverage
npm pack --dry-run
```

Plus the suite once under the simulated hook environment
(`GIT_DIR=$PWD/.git GIT_WORK_TREE=$PWD GIT_INDEX_FILE=$PWD/.git/index npx jest`),
and one demonstration no test may make: a real `claude` invocation of one
agent against a throwaway repository, events recorded through
`recordAgentRun`, the tree audited, and the transcript quoted in the
handoff of what worked and what the CLI refused. Report any deviation
directly. Do not describe partial work as complete.

## Starting prompt

> Continue Sailor from branch `codex/milestone-d` (HEAD `2c880e4`)
> in a worktree; cut `codex/milestone-d3` from it. Read `AGENTS.md`,
> `README.md`, `docs/handoff/rule-enforcement.md`,
> `docs/handoff/milestone-d.md` and `docs/handoff/milestone-d3.md`
> completely before writing code. Implement **D3 only**: the Claude CLI
> adapter behind the existing `ProviderAdapter` contract, test-first, with
> fake executables and never a live call from a test. Inspect the installed
> `claude --help` before writing a single provider flag; `codex` is not
> installed, so leave D4 unwritten. Run the completion gate, demonstrate
> one real invocation by hand, and report any deviation directly.

## What D3 added

Five commits on `codex/milestone-d3`, cut from `codex/milestone-d` at
`1921bea` and rebased onto `main` afterwards. The repository moved while this was built: the GitHub project is
now `simonfrets/sailor`, and the local checkout is the plain clone at
`<PROJECTS>/sailor` with this branch as the sibling worktree
`<PROJECTS>/sailor-codex-milestone-d3`. The bare repository at
`<PROJECTS>/sailor` and its two remaining worktrees
(`sailor-codex-basic-structure` on `codex/milestone-d`, and the
stale `sailor-v1-scaffold`) point at the same remote, are clean, and are
kept only until someone deletes them.

**Rebased onto the rename.** This branch and `codex/milestone-d` were cut
before PR #4 merged and were written with the old names; a dry-run merge of
`main` conflicted in nine files. Rather than resolve that by hand, the
rename commit `a169d97` was replicated as a script - the path renames, the
case-preserving substitution, the three phrases it worded by hand, a
prettier pass and the `PUBLIC_API` re-sort - and proved exact: applied to
`fed94c2` it reproduces `a169d97`'s tree byte for byte, and `main`'s tree
is that tree. Each of the seventeen commits was then re-committed on top of
`main` with the script applied to its tree, keeping author, date and
message, the message with the same substitution so it says what its diff
shows. Every rebased tree type-checks, lints and passes the suite.
`codex/milestone-d` was moved to the rebased `Record what the Claude
adapter starts from`. The hashes quoted in this document and in
`milestone-d.md` are the pre-rebase ones; the subjects are unchanged. The
pull request from this branch is the first time CI runs any of it.

`npm run check`, `npm run build`, `npm run test:coverage` and
`npm pack --dry-run` pass: 947 tests across 82 suites at 98.64% statements,
verified under the simulated hook environment. Eight mutations were applied
and each turned at least one test red: outside paths allowed, the undecided
tool use tolerated, Bash granted regardless of `execute`, the prompt-denial
flag dropped, stderr not streamed, the audit comparing a tree with itself,
the hook exiting 0 when unconfigured, and a shell command accepted as plain
words.

| Module                                       | Public surface                                                                                                                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/processes/command-runner.ts`            | `CommandRequest.signal` and `CommandRequest.onOutput`                                                                                                                                                                                                                |
| `src/providers/claude/tool-gate.ts`          | `CLAUDE_GATE_ENVIRONMENT_VARIABLE`, `CLAUDE_TOOL_NAMES`, `claudeToolsFor`, `splitPlainCommand`, `projectRelativeClaudePath`, `toolActionOfClaudeToolUse`, `decideClaudeToolUse`, `appendClaudeGateRecord`, `readClaudeGateLog`, the config, input and record schemas |
| `src/providers/claude/tool-gate-main.ts`     | the hook program; spawned, never imported                                                                                                                                                                                                                            |
| `src/providers/claude/claude-stream.ts`      | `createLineSplitter`, `readClaudeStreamLine`                                                                                                                                                                                                                         |
| `src/providers/claude/claude-cli-adapter.ts` | `createClaudeCliAdapter`, `buildClaudeCommand`, `buildClaudePrompt`, `claudeToolGateCommand`, `claudeRunFiles`, `quoteForPosixShell`, `CLAUDE_PRINT_FLAGS`, `DEFAULT_CLAUDE_MODELS`                                                                                  |
| `src/providers/audited-run.ts`               | `recordAuditedAgentRun`, `auditIndexFile`                                                                                                                                                                                                                            |

`SAILOR_ERROR_KINDS` gained `tool-gate-failed`, exit 5.
`ENVIRONMENT_ALLOWLIST` gained `USER`. `AgentInvocation` gained `agentId`.
`SAILOR_PATHS` gained `audit`. `PUBLIC_API` is 290 entries. `README.md`'s
"The Claude adapter" section is the reference.

### Decisions taken where the design was silent

1. **The gate is a `PreToolUse` hook, not `--allowedTools` patterns.** Both
   are documented. Translating write scopes and script names into the
   CLI's own pattern language would have been a second implementation of
   the policy that could drift from `evaluateToolAction`; the hook asks the
   same function, in a process the CLI starts through `sh -c`. The one
   shell string in the package is built from an argument vector by
   `quoteForPosixShell`. The policy reaches the hook through one
   environment variable, `SAILOR_CLAUDE_GATE`, which the agent cannot
   reach: the policy refuses every write under `.sailor/` outside the
   scratch directory, and `state/` is ignored, so the audit is not
   involved either.
2. **Everything is denied unless the gate allows it.** `--permission-prompts
none` makes the CLI deny whatever would have prompted; the hook's `allow`
   is what lets an edit or a command through, and its `deny` carries the
   policy's reason to the agent. `--restricted` removes the tools that run
   code unless `--tools` names them, so an agent with `execute: false`
   never has `Bash` at all. It also ignores the user's settings files while
   still applying `--settings`, which is what keeps a developer's hooks and
   permissions out of a governed run; `CLAUDE.md` files are still read.
3. **A tool use the gate did not decide fails the run.** A `tool_use` in
   the transcript with no record in the decision log is
   `tool-gate-failed`, thrown from the adapter: the session was configured
   to consult the gate for every tool, and a CLI that did not is one whose
   run the sailor cannot vouch for. The audit still happens for a run that
   finishes; it does not happen for one that is refused, and the tree is
   left for the runtime to deal with.
4. **A Bash command is an argument vector or it is `sh -c`.** The tool's
   `command` is a shell string. Words, single-quoted words and double-quoted
   words with nothing the shell expands are split into the vector the
   policy decides; anything else - a pipe, a redirection, `$`, a glob, a
   comment - is recorded as `sh -c <command>`, which is literally what the
   tool runs and which no policy grants.
5. **Paths are canonical on both sides.** The first live run refused every
   read: the throwaway root was `/var/folders/...`, the CLI reports
   `/private/var/folders/...`, and compared as strings they are different
   places. The gate now resolves symbolic links in the root and in the path
   through the nearest existing ancestor, so a file about to be created
   resolves too, and a link inside the project that points out of it is
   seen for where it points.
6. **`USER` is forwarded to every child.** The CLI keeps its login in the
   macOS keychain and looks the entry up by account name; without `USER`
   the CLI, run through `nodeCommandRunner` on a machine where it is logged
   in, says "Not logged in". Measured: `LOGNAME` alone does not restore it,
   `USER` alone does. It is the account name, not a secret.
7. **Abort is honoured by the runner.** `CommandRequest.signal` terminates
   the tree the way a timeout does and the result reports the signal, which
   `finishedEventOf` turns into `aborted`. A signal already aborted stops
   the command from starting at all. `onOutput` streams chunks as they
   arrive, so the adapter reports the run live and the transcript file is
   written as the CLI prints it.
8. **The record is made from the log, positioned by the transcript.** A
   `tool-action` is reported when the CLI prints the tool's result, which is
   after the hook answered; decisions whose results the CLI never printed,
   because it died first, are reported before `finished`. `rate_limit_event`
   lines, which the CLI prints between turns and no reference documents,
   are ignored like `system` messages.
9. **Models are aliases, overridable.** `DEFAULT_CLAUDE_MODELS` maps the
   three profiles to `opus`, `opus` and `sonnet`, the aliases `--help`
   documents. `config/models.yaml` is still D5's.
10. **`--bare` was rejected.** It would have kept `CLAUDE.md` out of the
    prompt, but it restricts authentication to an API key, which a
    developer's machine with an OAuth login does not have.

### The live invocation

Twice, by hand, from the built package against a throwaway git repository
holding the shipped `coder.yaml`, a spec at `docs/specs/greeting.md` asking
for `src/greeting.js`, a `node:test` test, a green `npm run test`, and a
README example the coder's scopes do not cover. Model `opus` through the
default mapping; `--max-budget-usd 3`.

**First run** (92 s, 14 turns, USD 0.40). The gate refused the first two
reads because the CLI reported `/private/var/...` paths against a
`/var/...` root; the agent noticed ("Path resolution issue - let me try the
non-`/private` form") and read its context and the spec with relative
paths. Then, verbatim from the event log:

```text
[tool] execute ls -la /var/folders/.../sailor-claude-demo-pHfW2K -> denied (not-a-project-script): `ls -la ...` is not a project script run through `npm` (`build`, `format`, `lint`, `test`, `typecheck`)
[tool] search {src,tests}/** -> allowed: searching the project is permitted
[tool] read package.json -> allowed: reading `package.json` is permitted
[tool] write src/greeting.js -> allowed: `src/greeting.js` is within the write scope `src/**`
[tool] write tests/greeting.test.js -> allowed: `tests/greeting.test.js` is within the write scope `tests/**`
[tool] execute npm run test -> allowed: `npm run test` runs the permitted project script `test`
[tool] write .sailor/state/runs/demo-run/agents/coder/notes.md -> allowed: `...` is in this agent's scratch directory
[finished] completed: exited with code 0 (92822ms)
```

The demo's own `test` script was broken (`node --test tests/`, trailing
slash). The agent diagnosed it, did not touch `package.json` ("outside my
write scope"), wrote the finding to its scratch directory, and closed with:
"the new test has never been executed - treat it as unverified rather than
passing. The implementation is small enough to check by eye, but I'm not
claiming a green run I didn't get." Audit: `src/greeting.js` and
`tests/greeting.test.js` changed, no violations. The CLI's own result line
counted `permission_denials: 3`, the three the gate denied.

**Second run** (55 s, USD not read, same shape), after decision 5 and with
the script fixed:

```text
[tool] read .sailor/state/runs/demo-run/agents/coder/context.json -> allowed
[tool] read docs/specs/greeting.md -> allowed
[stdout] The spec asks for a README.md change, which is outside my write scope (`src/**`, `tests/**`). I'll do everything else and flag that at the end.
[tool] execute ls -la /private/var/folders/.../sailor-claude-demo-2pBNQL -> denied (not-a-project-script)
[tool] write src/greeting.js -> allowed
[tool] write tests/greeting.test.js -> allowed
[tool] execute npm run test -> allowed
[tool] write tests/index.js -> allowed
[tool] execute npm run test -> allowed
[stdout] Tests pass (2/2), so the required `native-test` gate is green.
[finished] completed: exited with code 0 (55129ms)
```

Audit: three paths changed, all in scope, clean; the repository's own index
untouched. The README write was never attempted. The decision log and the
transcript were on disk under
`.sailor/state/runs/demo-run/claude/coder/attempt-1.*`.

What the real stream taught that the references had not: `tool_input`
shapes are `Read {file_path}`, `Glob {pattern}`, `Bash {command,
description}`, `Write {file_path, content}`; `system` messages are
numerous (39 in the first run, hook lifecycle among them);
`rate_limit_event` exists; and a denied hook decision is counted by the CLI
as a permission denial.

### Open, after D3

- **D4** stays unwritten: `codex` is still not installed.
- **D5**: `config/models.yaml` and `config/providers.yaml`. The adapter
  takes `models` and `claude` (the command) as options, which is where D5
  plugs in; `doctor` should report a missing `claude` on `PATH`.
- **D6**: the driver. `recordAuditedAgentRun` is the primitive; what
  remains is minting run ids, writing contexts, recording transitions with
  the audit's verdict, and deciding what a `tool-gate-failed` run does to
  the task.
- `AgentInvocation` carries no agent summary or display name, so the prompt
  says "the `coder` agent" and nothing of what a coder is for. The
  definition's `summary` should travel in the context; that touches C3.
- Findings 2 to 7 from the Milestone C review are untouched.
- `CLAUDE.md` files in a governed project reach the agent's prompt; the
  only flags that stop it also stop the gate or the login.

## Starting prompt for the next session

> Continue Sailor in a worktree of `<PROJECTS>/sailor`, cut from
> `codex/milestone-d3` or from `main` once its pull request has merged. Read
> `AGENTS.md`, `README.md`, `docs/handoff/milestone-d.md` and
> `docs/handoff/milestone-d3.md` completely before writing code. Implement
> **D5 only**: `.sailor/config/models.yaml` and `providers.yaml`, validated
> and seeded like the other config files, read into the Claude adapter's
> `models` and `claude` options, and reported by `sailor doctor`, including
> whether `claude` is on `PATH`. `codex` is not installed, so D4 stays
> unwritten. Test-first, with fake executables and never a live call from a
> test. Run the completion gate and report any deviation directly.
