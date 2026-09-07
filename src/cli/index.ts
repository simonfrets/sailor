#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { nodeCommandRunner } from "../processes/node-command-runner.js";
import { createDefaultCliCommands } from "./default-commands.js";
import { CLI_EXIT_CODES } from "./exit-codes.js";
import { runCli } from "./run-cli.js";

/**
 * The executable entry point, and the only module in this package that touches
 * `process` or `import.meta`.
 *
 * `tsconfig.test.json` transpiles `src/` to CommonJS for ts-jest, where
 * `import.meta` is a run-time syntax error even though it type-checks and
 * builds. Resolving the package root here, and passing it onwards as an
 * ordinary string, keeps every other module importable from a test.
 */
const packageRootDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

runCli({
  argv: process.argv.slice(2),
  commands: createDefaultCliCommands(),
  cwd: process.cwd(),
  now: () => new Date(),
  nodeVersion: process.versions.node,
  packageRootDirectory,
  runner: nodeCommandRunner,
  streams: { stdout: process.stdout, stderr: process.stderr },
}).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    process.stderr.write(
      `sailor: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = CLI_EXIT_CODES.failure;
  }
);
