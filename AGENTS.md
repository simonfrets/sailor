# Agent instructions

Do not sugar code anything. Report defects, skipped checks, and architectural
compromises directly.

## Working rules

- Keep the installed sailor isolated under the target project's `.sailor/`
  directory.
- Treat agent definitions, task state, context, rules, and provider adapters as
  separate modules with explicit contracts.
- Add or update tests with every behavior change.
- Test shell scripts by spawning them from Jest against temporary fixture
  directories. Do not make tests depend on the developer's machine state.
- Keep shell scripts compatible with Bash on macOS, Linux, and WSL.
- Never hide a failed tool invocation or silently weaken a quality gate.
- Do not bypass Git hooks with `--no-verify`.

## Required verification

Run the following before handing work off:

```sh
npm run check
npm run build
```
