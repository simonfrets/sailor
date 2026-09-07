import { join } from "node:path";

import { SAILOR_DIRECTORY, SAILOR_GIT_HOOKS_PATH } from "../sailor/layout.js";
import { CI_TEMPLATE_PATH } from "../install/diagnose-sailor.js";
import type { InstallSailorResult } from "../install/install-sailor.js";

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Reports what installation actually did.
 *
 * Created and replaced files are listed individually because they are the ones
 * that changed; files that were already correct are only counted, so a routine
 * re-run stays short enough to read.
 */
export const formatInstallResult = (result: InstallSailorResult): string => {
  const lines = [
    `Sailor ${result.sailorVersion} installed in ${join(
      result.projectRoot,
      SAILOR_DIRECTORY
    )}`,
    "",
    `${plural(result.created.length, "file")} created, ${String(
      result.replaced.length
    )} replaced, ${String(result.kept.length)} already up to date`,
    ...result.created.map((path) => `  + ${path}`),
    ...result.replaced.map((path) => `  ~ ${path}`),
  ];

  if (result.removed.length > 0) {
    lines.push(
      "",
      `${plural(
        result.removed.length,
        "hook dispatcher"
      )} removed, because git would otherwise still run them:`,
      ...result.removed.map((path) => `  - ${path}`)
    );
  }

  if (result.orphaned.length > 0) {
    lines.push(
      "",
      `${plural(
        result.orphaned.length,
        "managed file"
      )} this version no longer ships, left in place:`,
      ...result.orphaned.map((path) => `  ? ${path}`),
      "Delete them yourself once you are sure the project no longer needs them."
    );
  }

  if (result.hooks.length > 0) {
    lines.push(
      "",
      `${
        result.gitHooksPathChanged ? "git now dispatches" : "git dispatches"
      } ${plural(result.hooks.length, "hook")} through ${SAILOR_GIT_HOOKS_PATH}`,
      ...result.hooks.map(
        (hook) =>
          `  ${hook.hook}${
            hook.chained === null ? "" : ` runs ${hook.chained} first`
          }`
      )
    );

    // Said once, when the hooks are first taken over. A hook is skippable
    // with `--no-verify`, so leaving this to `sailor doctor` would mean the
    // one person who installed the sailor never hears it.
    if (result.gitHooksPathChanged) {
      lines.push(
        `A hook can be skipped with \`--no-verify\`. Copy ${SAILOR_DIRECTORY}/${CI_TEMPLATE_PATH} into .github/workflows/ so CI runs the same gates.`
      );
    }

    if (result.previousHooksPath !== null) {
      lines.push(
        result.previousHooksPathScope === "inherited"
          ? `\`core.hooksPath\` was \`${result.previousHooksPath}\`, set outside this repository in your global or system git config. Its hooks were chained, but they are not part of the project, so they will not exist for anyone else who checks it out.`
          : `The project's own \`core.hooksPath\` was \`${result.previousHooksPath}\`; it is recorded in ${SAILOR_DIRECTORY}/version.json.`
      );
    }
  }

  if (result.dependencyFailure === null) {
    lines.push(
      "",
      result.dependenciesInstalled
        ? `Runtime dependencies resolved in ${SAILOR_DIRECTORY}/node_modules`
        : "Runtime dependencies were not installed"
    );
  } else {
    lines.push(
      "",
      `The runtime could not be resolved, so git hooks were left alone and this project still commits normally:`,
      ...result.dependencyFailure.split("\n").map((line) => `  ${line}`),
      "Everything above is on disk; re-run `sailor init` once that is fixed."
    );
  }

  return `${lines.join("\n")}\n`;
};
