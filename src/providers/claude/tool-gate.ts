import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import {
  evaluateToolAction,
  toolActionSchema,
  toolDecisionSchema,
  toolPolicySchema,
} from "../../enforcement/tool-policy.js";
import type { ToolAction, ToolPolicy } from "../../enforcement/tool-policy.js";
import { toProjectRelativePath } from "../../enforcement/write-scope.js";
import { SailorError } from "../../sailor/sailor-error.js";
import { timestampSchema } from "../../tasks/task-schema.js";

/**
 * The gate the Claude CLI consults before every tool call.
 *
 * `claude --help` documents `--settings <file-or-json>`, and the hooks
 * reference documents a `PreToolUse` hook: a command the CLI runs before a
 * tool, handing it the call as JSON on stdin and reading a permission
 * decision back from stdout. That is the one place the CLI lets an adapter
 * answer before an action, so this is where `evaluateToolAction` is asked.
 *
 * The hook is a process of its own, started by the CLI through `sh -c`, so it
 * gets the policy through the environment rather than from the adapter's
 * memory: one variable holding the configuration below, set on the CLI's
 * environment by the adapter and inherited by every hook it runs. An agent
 * cannot reach that variable, and cannot reach the file the decisions are
 * appended to, because the policy itself refuses every write under
 * `.sailor/` outside the agent's scratch directory.
 */
export const CLAUDE_GATE_ENVIRONMENT_VARIABLE = "SAILOR_CLAUDE_GATE";

export const CLAUDE_GATE_VERSION = 1;

export const CLAUDE_GATE_RECORD_VERSION = 1;

/** The hook program, as the built package ships it. Relative to the package root. */
export const CLAUDE_TOOL_GATE_BUILT = "dist/providers/claude/tool-gate-main.js";

/** The same program as source, for a test that runs it without a build. */
export const CLAUDE_TOOL_GATE_SOURCE = "src/providers/claude/tool-gate-main.ts";

/**
 * The Claude tools the gate knows how to read, by the action each one is.
 *
 * These are the names `claude --help` and the init message of a `--print`
 * session report, and the session is given exactly these through `--tools`,
 * so a call the gate cannot map is a call that should not have been possible.
 * `MultiEdit` is absent because the installed CLI drops it from `--tools`
 * silently; a tool that does not exist has no calls to decide.
 */
export const CLAUDE_TOOL_NAMES = {
  read: ["Read"],
  search: ["Glob", "Grep"],
  write: ["Edit", "Write", "NotebookEdit"],
  execute: ["Bash"],
} as const;

/**
 * The tools a session under a policy is given.
 *
 * Every agent keeps the file tools whatever `tools.edit` says, because an
 * agent that may not edit the project may still write to its own scratch
 * directory, and the gate decides that per path. `Bash` is withheld outright
 * from an agent that may not execute: there is no path under which it would
 * be allowed, so there is nothing for the gate to decide.
 */
export const claudeToolsFor = (policy: ToolPolicy): readonly string[] => [
  ...CLAUDE_TOOL_NAMES.read,
  ...CLAUDE_TOOL_NAMES.search,
  ...CLAUDE_TOOL_NAMES.write,
  ...(policy.tools.execute ? CLAUDE_TOOL_NAMES.execute : []),
];

const absolutePathSchema = z
  .string()
  .min(1)
  .refine(isAbsolute, "must be an absolute path");

/** What the adapter hands the hook, through `SAILOR_CLAUDE_GATE`. */
export const claudeGateConfigSchema = z.strictObject({
  version: z.literal(CLAUDE_GATE_VERSION),
  projectRoot: absolutePathSchema,
  policy: toolPolicySchema,
  /** Where each decision is appended, one JSON line per tool call. */
  log: absolutePathSchema,
});

export type ClaudeGateConfig = z.output<typeof claudeGateConfigSchema>;

/**
 * What the CLI writes to the hook's stdin, as the hooks reference documents
 * it. Fields the reference lists beside these - the session id, the working
 * directory, the transcript path - are kept but not relied on: the project
 * root the gate resolves paths against is the adapter's, not the CLI's
 * current directory.
 */
export const claudeHookInputSchema = z.looseObject({
  hook_event_name: z.literal("PreToolUse"),
  tool_name: z.string().min(1),
  tool_input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string().min(1),
});

export type ClaudeHookInput = z.output<typeof claudeHookInputSchema>;

/** One decision, as the log records it and the adapter reads it back. */
export const claudeGateRecordSchema = z.strictObject({
  version: z.literal(CLAUDE_GATE_RECORD_VERSION),
  at: timestampSchema,
  toolUseId: z.string().min(1),
  toolName: z.string().min(1),
  action: toolActionSchema,
  decision: toolDecisionSchema,
});

export type ClaudeGateRecord = z.output<typeof claudeGateRecordSchema>;

/** The answer the hooks reference documents for a `PreToolUse` hook. */
export interface ClaudeHookResponse {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision: "allow" | "deny";
    readonly permissionDecisionReason: string;
  };
}

const code = (text: string): string => `\`${text}\``;

const gateFailure = (
  message: string,
  details: readonly string[] = []
): SailorError => new SailorError("tool-gate-failed", message, details);

const issueLines = (error: z.ZodError): string[] =>
  error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);

export const parseClaudeGateConfig = (raw: string): ClaudeGateConfig => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw gateFailure(
      `${CLAUDE_GATE_ENVIRONMENT_VARIABLE} does not hold JSON`,
      [String(error)]
    );
  }

  const result = claudeGateConfigSchema.safeParse(parsed);

  if (!result.success) {
    throw gateFailure(
      `${CLAUDE_GATE_ENVIRONMENT_VARIABLE} does not hold a gate configuration`,
      issueLines(result.error)
    );
  }

  return result.data;
};

export const parseClaudeHookInput = (input: unknown): ClaudeHookInput => {
  const result = claudeHookInputSchema.safeParse(input);

  if (!result.success) {
    throw gateFailure(
      "the hook was not given a PreToolUse call for one tool use",
      issueLines(result.error)
    );
  }

  return result.data;
};

/** A character the shell would pass through untouched. */
const PLAIN = /[A-Za-z0-9_./:@=+,%-]/;

/**
 * Splits a command into words, or refuses it.
 *
 * The Bash tool's `command` is a string the CLI hands to a shell, and the
 * policy decides argument vectors. The two meet only where the string *is*
 * an argument vector: words, single-quoted words and double-quoted words
 * containing nothing the shell expands. A pipe, a redirection, a variable, a
 * glob, a comment, a newline or an unterminated quote means the string does
 * something the vector could not say, and the answer is `null` rather than
 * a guess about what the shell would have done with it.
 */
export const splitPlainCommand = (
  command: string
): readonly string[] | null => {
  if (/[\r\n]/.test(command)) {
    return null;
  }

  const words: string[] = [];
  // A word is open once any character has joined it, so `''` is a word and
  // two spaces are not.
  let word = "";
  let open = false;
  let index = 0;

  const push = (text: string): void => {
    word += text;
    open = true;
  };

  const close = (): void => {
    if (open) {
      words.push(word);
      word = "";
      open = false;
    }
  };

  while (index < command.length) {
    const char = command.charAt(index);

    if (char === " " || char === "\t") {
      close();
      index += 1;
    } else if (char === "'" || char === '"') {
      const end = command.indexOf(char, index + 1);

      if (end === -1) {
        return null;
      }

      const quoted = command.slice(index + 1, end);

      if (char === '"' && /[$`\\]/.test(quoted)) {
        return null;
      }

      push(quoted);
      index = end + 1;
    } else if (PLAIN.test(char)) {
      push(char);
      index += 1;
    } else {
      return null;
    }
  }

  close();

  return words.length === 0 ? null : words;
};

export interface MappedClaudeToolUse {
  readonly action: ToolAction;
  /**
   * The path the call named, when that path is not inside the project. The
   * action still carries it as given, so the record shows what was tried.
   */
  readonly outside: string | null;
}

const readString = (
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
  field: string
): string => {
  const value = toolInput[field];

  if (typeof value !== "string" || value === "") {
    throw gateFailure(
      `the tool call ${code(toolName)} named no ${code(field)}, so the gate cannot decide it`
    );
  }

  return value;
};

/**
 * The path with every symbolic link in it resolved, for a path that need
 * not exist yet.
 *
 * The CLI reports the real path of what it touches, and the project root the
 * sailor holds may well be a link to it: on macOS the temporary directory
 * is `/var/...`, and the CLI says `/private/var/...`. Compared as strings
 * the two are different places, and the first live run refused every read.
 * A file the agent is about to create has no real path of its own, so the
 * longest ancestor that exists is resolved and the rest is joined back on.
 */
const canonicalPath = (path: string): string => {
  const missing: string[] = [];
  let current = path;

  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);

      if (parent === current) {
        return path;
      }

      missing.push(basename(current));
      current = parent;
    }
  }
};

/**
 * Re-expresses a path the CLI named from the project root, or `null` when
 * it is not inside the project. Both sides are made canonical first, so a
 * root reached through a link and a path reported through its target agree,
 * and a link inside the project that points out of it is seen for where it
 * points.
 */
export const projectRelativeClaudePath = (
  projectRoot: string,
  path: string
): string | null =>
  toProjectRelativePath(
    canonicalPath(resolve(projectRoot)),
    canonicalPath(resolve(projectRoot, path))
  );

const located = (
  projectRoot: string,
  path: string,
  action: (path: string) => ToolAction
): MappedClaudeToolUse => {
  const relative = projectRelativeClaudePath(projectRoot, path);

  return relative === null
    ? { action: action(path), outside: path }
    : { action: action(relative), outside: null };
};

const isIn = (names: readonly string[], toolName: string): boolean =>
  names.includes(toolName);

/**
 * Reads a Claude tool call as the action it is.
 *
 * A file tool names its file in `file_path` - `NotebookEdit` in
 * `notebook_path` - and the path is re-expressed from the project root, so
 * the absolute form the CLI usually sends and the relative form it sometimes
 * sends decide the same way. A search is its pattern; its optional `path`
 * only matters when it leaves the project. A Bash command that is plainly an
 * argument vector is that vector; one that needs a shell is recorded as the
 * shell the tool would run it through, `sh -c <command>`, which is what it
 * is and which no policy grants.
 *
 * A tool the gate does not know, or a call missing the field it maps, is
 * refused loudly rather than denied quietly: the session was given exactly
 * the tools this maps, so either is the adapter's model of the CLI being
 * wrong, and a wrong model should stop the run rather than be papered over
 * one call at a time.
 */
export const toolActionOfClaudeToolUse = (
  projectRoot: string,
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>
): MappedClaudeToolUse => {
  if (isIn(CLAUDE_TOOL_NAMES.read, toolName)) {
    return located(
      projectRoot,
      readString(toolName, toolInput, "file_path"),
      (path) => ({ kind: "read", path })
    );
  }

  if (isIn(CLAUDE_TOOL_NAMES.search, toolName)) {
    const query = readString(toolName, toolInput, "pattern");
    const path = toolInput.path;
    const outside =
      typeof path === "string" &&
      path !== "" &&
      projectRelativeClaudePath(projectRoot, path) === null
        ? path
        : null;

    return { action: { kind: "search", query }, outside };
  }

  if (isIn(CLAUDE_TOOL_NAMES.write, toolName)) {
    const field = toolName === "NotebookEdit" ? "notebook_path" : "file_path";

    return located(
      projectRoot,
      readString(toolName, toolInput, field),
      (path) => ({ kind: "write", path })
    );
  }

  if (isIn(CLAUDE_TOOL_NAMES.execute, toolName)) {
    const command = readString(toolName, toolInput, "command");
    const words = splitPlainCommand(command) ?? ["sh", "-c", command];
    const [executable = "sh", ...args] = words;

    return {
      action: { kind: "execute", command: { executable, args } },
      outside: null,
    };
  }

  throw gateFailure(
    `${code(toolName)} is not a tool the Claude gate maps to an action`,
    [
      `the session is given only: ${Object.values(CLAUDE_TOOL_NAMES)
        .flat()
        .map(code)
        .join(", ")}`,
    ]
  );
};

export interface DecideClaudeToolUseInput {
  readonly input: ClaudeHookInput;
  readonly config: ClaudeGateConfig;
  readonly at: string;
}

export interface DecidedClaudeToolUse {
  readonly record: ClaudeGateRecord;
  readonly response: ClaudeHookResponse;
}

/**
 * Decides one tool call, and says so in both vocabularies.
 *
 * The decision is `evaluateToolAction`'s, with one thing settled before it
 * is asked: a path that leaves the project is refused as `outside-project`
 * whatever the action. The policy already says that for a write, and a read
 * or a search of `/etc` has no better claim. The record is what the adapter
 * reports as the run's `tool-action` event; the response is what the CLI
 * reads, in the shape the hooks reference documents.
 */
export const decideClaudeToolUse = (
  input: DecideClaudeToolUseInput
): DecidedClaudeToolUse => {
  const { tool_name: toolName, tool_input: toolInput } = input.input;
  const mapped = toolActionOfClaudeToolUse(
    input.config.projectRoot,
    toolName,
    toolInput
  );
  const decision =
    mapped.outside === null
      ? evaluateToolAction(mapped.action, input.config.policy)
      : {
          verdict: "denied" as const,
          denial: "outside-project" as const,
          reason: `${code(mapped.outside)} is not a path inside the project`,
        };

  return {
    record: {
      version: CLAUDE_GATE_RECORD_VERSION,
      at: input.at,
      toolUseId: input.input.tool_use_id,
      toolName,
      action: mapped.action,
      decision,
    },
    response: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision.verdict === "allowed" ? "allow" : "deny",
        permissionDecisionReason: decision.reason,
      },
    },
  };
};

/** Appends one decision. The log's directory is created if the run has not. */
export const appendClaudeGateRecord = (
  log: string,
  record: ClaudeGateRecord
): void => {
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, `${JSON.stringify(record)}\n`);
};

/**
 * Reads the decisions back, in the order they were made.
 *
 * A missing log is a run in which no tool was called, which is a normal
 * outcome. A line that does not parse or validate is not skipped: a record of
 * the run with a decision missing from it is the one thing the log must not
 * quietly become.
 */
export const readClaudeGateLog = (log: string): readonly ClaudeGateRecord[] => {
  if (!existsSync(log)) {
    return [];
  }

  return readFileSync(log, "utf8")
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.trim() !== "")
    .map(({ line, number }) => {
      let parsed: unknown;

      try {
        parsed = JSON.parse(line);
      } catch (error: unknown) {
        throw gateFailure(`${log} line ${String(number)} is not JSON`, [
          String(error),
        ]);
      }

      const result = claudeGateRecordSchema.safeParse(parsed);

      if (!result.success) {
        throw gateFailure(
          `${log} line ${String(number)} is not a gate record`,
          issueLines(result.error)
        );
      }

      return result.data;
    });
};
