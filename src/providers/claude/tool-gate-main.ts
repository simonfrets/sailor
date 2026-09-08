#!/usr/bin/env node
import { describeFailure } from "../../sailor/sailor-error.js";
import {
  CLAUDE_GATE_ENVIRONMENT_VARIABLE,
  appendClaudeGateRecord,
  decideClaudeToolUse,
  parseClaudeGateConfig,
  parseClaudeHookInput,
} from "./tool-gate.js";

/**
 * The program the Claude CLI runs as its `PreToolUse` hook.
 *
 * It fails closed. Anything that stops a decision being made - no
 * configuration, a configuration or a call that does not parse, a tool the
 * gate does not map, a log that cannot be appended to - exits `2`, which the
 * hooks reference documents as blocking the tool call, with the reason on
 * stderr. Nothing is written to stdout in that case, so the CLI cannot read a
 * half-formed answer as one. A decided call, allowed or denied, exits `0`
 * with the decision as JSON, and is appended to the log before it is
 * answered, so no answer the CLI acted on is missing from the record.
 *
 * Like `src/cli/index.ts`, this is an entry point: it touches `process` and
 * nothing imports it. It is exercised by spawning it.
 */
const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer | string));
  }

  return Buffer.concat(chunks).toString("utf8");
};

try {
  const raw = process.env[CLAUDE_GATE_ENVIRONMENT_VARIABLE];

  if (raw === undefined) {
    throw new Error(
      `${CLAUDE_GATE_ENVIRONMENT_VARIABLE} is not set; the gate has no policy to decide against`
    );
  }

  const config = parseClaudeGateConfig(raw);
  let call: unknown;

  try {
    call = JSON.parse(await readStdin());
  } catch (error: unknown) {
    throw new Error(`the hook's input is not JSON: ${describeFailure(error)}`, {
      cause: error,
    });
  }

  const decided = decideClaudeToolUse({
    input: parseClaudeHookInput(call),
    config,
    at: new Date().toISOString(),
  });

  appendClaudeGateRecord(config.log, decided.record);
  process.stdout.write(`${JSON.stringify(decided.response)}\n`);
} catch (error: unknown) {
  process.stderr.write(`sailor claude tool gate: ${describeFailure(error)}\n`);
  process.exitCode = 2;
}
