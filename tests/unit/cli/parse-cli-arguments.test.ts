import { parseCliArguments } from "../../../src/cli/parse-cli-arguments.js";
import type { CliParseResult } from "../../../src/cli/parse-cli-arguments.js";

const parse = (...argv: readonly string[]): CliParseResult =>
  parseCliArguments(argv);

const usageMessage = (result: CliParseResult): string => {
  if (result.kind !== "usage-error") {
    throw new Error(`expected a usage error, received ${result.kind}`);
  }

  return result.message;
};

describe("parseCliArguments", () => {
  it("treats no arguments as a request for help", () => {
    expect(parse()).toEqual({ kind: "help" });
  });

  it.each([["--help"], ["-h"]])("treats %s as a request for help", (flag) => {
    expect(parse(flag)).toEqual({ kind: "help" });
    expect(parse("gate", "pre-commit", flag)).toEqual({ kind: "help" });
  });

  it.each([["--version"], ["-v"]])("treats %s as a version query", (flag) => {
    expect(parse(flag)).toEqual({ kind: "version" });
  });

  it("prefers help over version when both are given", () => {
    expect(parse("--version", "--help")).toEqual({ kind: "help" });
  });

  it("parses init with and without --update", () => {
    expect(parse("init")).toEqual({
      kind: "invocation",
      invocation: {
        command: "init",
        phase: null,
        agentId: null,
        update: false,
        taskId: null,
      },
    });
    expect(parse("init", "--update")).toEqual({
      kind: "invocation",
      invocation: {
        command: "init",
        phase: null,
        agentId: null,
        update: true,
        taskId: null,
      },
    });
  });

  it("parses doctor", () => {
    expect(parse("doctor")).toEqual({
      kind: "invocation",
      invocation: {
        command: "doctor",
        phase: null,
        agentId: null,
        update: false,
        taskId: null,
      },
    });
  });

  it("parses both rules subcommands", () => {
    expect(parse("rules", "validate")).toEqual({
      kind: "invocation",
      invocation: {
        command: "rules validate",
        phase: null,
        agentId: null,
        update: false,
        taskId: null,
      },
    });
    expect(parse("rules", "explain", "--agent", "coder")).toEqual({
      kind: "invocation",
      invocation: {
        command: "rules explain",
        phase: null,
        agentId: "coder",
        update: false,
        taskId: null,
      },
    });
  });

  it("parses a gate phase and an optional agent", () => {
    expect(parse("gate", "pre-push")).toEqual({
      kind: "invocation",
      invocation: {
        command: "gate",
        phase: "pre-push",
        agentId: null,
        update: false,
        taskId: null,
      },
    });
    expect(parse("gate", "qa", "--agent", "qa")).toEqual({
      kind: "invocation",
      invocation: {
        command: "gate",
        phase: "qa",
        agentId: "qa",
        update: false,
        taskId: null,
      },
    });
  });

  it("parses run with the task it names", () => {
    expect(parse("run", "add-login")).toEqual({
      kind: "invocation",
      invocation: {
        command: "run",
        phase: null,
        agentId: null,
        update: false,
        taskId: "add-login",
      },
    });
  });

  it("rejects a run with no task, or with one that is not a task id", () => {
    // The id names a directory under `.sailor/state/runs/` by way of the run
    // it belongs to, and it is what `tasks.yaml` is looked up by.
    expect(usageMessage(parse("run"))).toContain("requires a task id");
    expect(usageMessage(parse("run", "Add Login"))).toContain("kebab-case");
  });

  it("rejects an unknown command", () => {
    expect(usageMessage(parse("teleport"))).toContain(
      "unknown command `teleport`"
    );
  });

  it("rejects flags with no command", () => {
    expect(usageMessage(parse("--update"))).toContain("missing command");
  });

  it("rejects an unknown option", () => {
    expect(usageMessage(parse("doctor", "--force"))).toContain(
      "unknown option `--force`"
    );
  });

  it("rejects an option with no value", () => {
    expect(usageMessage(parse("gate", "qa", "--agent"))).toContain(
      "`--agent` requires a value"
    );
  });

  it("rejects an invalid agent id", () => {
    expect(usageMessage(parse("gate", "qa", "--agent", "Coder"))).toContain(
      "kebab-case"
    );
  });

  it("rejects an unknown rules subcommand", () => {
    expect(usageMessage(parse("rules", "rewrite"))).toContain(
      "unknown `rules` subcommand `rewrite`"
    );
    expect(usageMessage(parse("rules"))).toContain("requires a subcommand");
  });

  it("rejects a missing or unknown gate phase", () => {
    expect(usageMessage(parse("gate"))).toContain("requires a phase");
    expect(usageMessage(parse("gate", "pre-merge"))).toContain(
      "unknown phase `pre-merge`"
    );
  });

  it("rejects surplus positional arguments", () => {
    expect(usageMessage(parse("doctor", "now"))).toContain(
      "unexpected argument `now`"
    );
    expect(usageMessage(parse("gate", "qa", "now"))).toContain(
      "unexpected argument `now`"
    );
    expect(usageMessage(parse("rules", "validate", "now"))).toContain(
      "unexpected argument `now`"
    );
    expect(usageMessage(parse("run", "add-login", "now"))).toContain(
      "unexpected argument `now`"
    );
  });

  it("rejects an option the command does not accept", () => {
    expect(usageMessage(parse("doctor", "--update"))).toContain(
      "`doctor` does not accept `--update`"
    );
    expect(usageMessage(parse("init", "--agent", "coder"))).toContain(
      "`init` does not accept `--agent`"
    );
    expect(
      usageMessage(parse("rules", "validate", "--agent", "coder"))
    ).toContain("`rules validate` does not accept `--agent`");
  });
});
