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
