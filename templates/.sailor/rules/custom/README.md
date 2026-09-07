# Custom rules

Rule bundles in this directory are the `project` precedence layer. They are
loaded after the bundles in `.sailor/rules/`, which are the `builtin` layer
that `sailor init --update` manages.

Adding a bundle here changes both the compiled agent policies and the phase
gates. No TypeScript change is involved.

```yaml
version: 1
id: team-conventions
description: Rules specific to this repository

rules:
  - id: team.no-console-logging
    description: Use the project logger instead of console
    severity: error
    appliesTo: [cleaner, coder, hardener]
    scopes: ["src/**/*.ts"]
    instruction: >
      Use the project logger. console output bypasses log levels and
      redaction, so it is invisible in production and unsafe in a request
      path.
```

To replace a shipped rule rather than add one, declare the same rule id and
set `overrides: true` on it. Without that flag a duplicate rule id is an
error, so a rule is never silently replaced by one nobody meant to write.

Files here are never overwritten by `sailor init --update`.
