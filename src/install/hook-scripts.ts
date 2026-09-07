import { isAbsolute } from "node:path";

import { CLI_EXIT_CODES } from "../cli/exit-codes.js";
import { SAILOR_DIRECTORY, SAILOR_PATHS } from "../sailor/layout.js";
import type { Phase } from "../rules/rule-schema.js";
import { SAILOR_PACKAGE_NAME } from "./runtime-dependencies.js";

export const EXECUTABLE_MODE = 0o755;

/** Path of the launcher inside the sailor directory, with `/` separators. */
export const LAUNCHER_PATH = "bin/sailor";

/** Path of one hook dispatcher inside the sailor directory. */
export const hookScriptPath = (hook: string): string =>
  `${SAILOR_PATHS.hooks}/${hook}`;

/**
 * Escapes a path for interpolation inside a double-quoted shell string.
 *
 * A repository checked out into a directory containing `$` or a backtick would
 * otherwise turn a path into a command substitution the moment a hook ran,
 * which is a shell injection through nothing more exotic than a folder name.
 */
export const escapeForDoubleQuotes = (value: string): string =>
  value.replace(/[\\"$`]/g, "\\$&");

const SHEBANG = "#!/usr/bin/env bash";

const PREAMBLE = [
  "set -euo pipefail",
  "",
  // `dirname` on BASH_SOURCE rather than on $0: git invokes a hook by a path
  // that may be relative to the working tree root, and `cd` resolves it either
  // way, while $0 would be wrong the moment the script were sourced.
  'sailor_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"',
];

/**
 * The executable a project runs the sailor with.
 *
 * It resolves the CLI out of the private dependency tree rather than off the
 * caller's `PATH`, so a hook runs the version this project installed and not
 * whichever global one happens to be first.
 */
export const buildSailorLauncher = (): string =>
  `${[
    SHEBANG,
    `# The ${SAILOR_DIRECTORY} launcher. Managed by Sailor; do not edit.`,
    ...PREAMBLE,
    `entry="\${sailor_directory}/node_modules/${SAILOR_PACKAGE_NAME}/dist/cli/index.js"`,
    "",
    'if [ ! -f "${entry}" ]; then',
    "  printf 'sailor: the sailor runtime is not installed in %s; run `sailor init`\\n' \\",
    '    "${sailor_directory}" >&2',
    `  exit ${String(CLI_EXIT_CODES.invalidConfig)}`,
    "fi",
    "",
    'exec node "${entry}" "$@"',
  ].join("\n")}\n`;

export type HookDispatcher =
  | {
      readonly kind: "gate";
      readonly hook: string;
      readonly phase: Phase;
      /** Project-relative or absolute path of a preserved hook. */
      readonly chained: string | null;
    }
  | {
      readonly kind: "passthrough";
      readonly hook: string;
      readonly chained: string;
    };

/**
 * Renders the shell that names the preserved hook.
 *
 * A project-relative path is re-joined to the repository at run time rather
 * than baked in absolute, so the dispatcher is the same file on every machine
 * that checks the project out.
 */
const chainedAssignment = (chained: string): readonly string[] => [
  "",
  "# The hook this project already had. It runs first, unchanged.",
  isAbsolute(chained)
    ? `previous_hook="${escapeForDoubleQuotes(chained)}"`
    : `previous_hook="\${repository_root}/${escapeForDoubleQuotes(chained)}"`,
];

const REPOSITORY_ROOT = 'repository_root="$(dirname -- "${sailor_directory}")"';

/**
 * Renders the dispatcher git runs for one hook.
 *
 * Installation points `core.hooksPath` at `.sailor/hooks`, which means this
 * file becomes the only hook of its name git will run. Anything the project
 * already had is therefore invoked from here — first, with the same arguments
 * and the same standard input — because a hook that stopped running because a
 * tool was installed is a hook that was silently discarded.
 */
export const buildHookDispatcher = (dispatcher: HookDispatcher): string => {
  const header = [
    SHEBANG,
    `# The ${dispatcher.hook} dispatcher. Managed by Sailor; do not edit.`,
    ...PREAMBLE,
    REPOSITORY_ROOT,
  ];

  if (dispatcher.kind === "passthrough") {
    return `${[
      ...header,
      ...chainedAssignment(dispatcher.chained),
      "",
      "# No sailor gate runs at this hook; the project's own hook is all there is.",
      'if [ -x "${previous_hook}" ]; then',
      '  exec "${previous_hook}" "$@"',
      "fi",
    ].join("\n")}\n`;
  }

  const gate = [
    "",
    `exec "\${sailor_directory}/${LAUNCHER_PATH}" gate ${dispatcher.phase}`,
  ];

  if (dispatcher.chained === null) {
    return `${[...header, ...gate].join("\n")}\n`;
  }

  return `${[
    ...header,
    ...chainedAssignment(dispatcher.chained),
    "",
    // `set -e` stops here if it fails, so the gate never masks a hook the
    // project relies on, and the exit code a developer sees is that hook's.
    'if [ -x "${previous_hook}" ]; then',
    '  "${previous_hook}" "$@"',
    "fi",
    ...gate,
  ].join("\n")}\n`;
};
