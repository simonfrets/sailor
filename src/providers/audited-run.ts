import { join } from "node:path";

import {
  auditWorkingTree,
  snapshotWorkingTree,
} from "../enforcement/working-tree-audit.js";
import type { WorkingTreeAudit } from "../enforcement/working-tree-audit.js";
import { SAILOR_DIRECTORY, SAILOR_PATHS } from "../sailor/layout.js";
import type { CommandRunner } from "../processes/command-runner.js";
import { recordAgentRun } from "./provider-adapter.js";
import type {
  AgentInvocation,
  AgentRunRecord,
  ProviderAdapter,
  RecordAgentRunOptions,
} from "./provider-adapter.js";

/**
 * The private index one agent's audit stages into. It lives under the
 * sailor's own `state/audit/`, never inside the agent's context directory:
 * the agent may write there, and an index the agent could rewrite would be
 * an audit the agent could edit.
 */
export const auditIndexFile = (
  projectRoot: string,
  runId: string,
  agentId: string
): string =>
  join(
    projectRoot,
    SAILOR_DIRECTORY,
    SAILOR_PATHS.audit,
    `${runId}-${agentId}.index`
  );

export interface RecordAuditedAgentRunOptions extends RecordAgentRunOptions {
  /** Runs git for the snapshots. Never the adapter's business. */
  readonly runner: CommandRunner;
  readonly auditTimeoutMs?: number;
}

export interface AuditedAgentRunRecord extends AgentRunRecord {
  readonly audit: WorkingTreeAudit;
}

/**
 * Runs an agent and audits what it did to the working tree.
 *
 * This is the enforcement a provider cannot opt out of, made mechanical: the
 * tree is hashed before the adapter is invoked and after it finishes, and
 * every path that differs is put to the invocation's own tool policy. An
 * adapter that asks the gate before every action and one that cannot ask at
 * all are audited the same way, by the same code, against the same policy.
 *
 * An adapter's failure is let through as it is, unaudited: a run that has no
 * record has nothing an audit could be attached to, and the runtime that
 * catches the failure is the one that decides what to do with the tree.
 */
export const recordAuditedAgentRun = async (
  adapter: ProviderAdapter,
  invocation: AgentInvocation,
  options: RecordAuditedAgentRunOptions
): Promise<AuditedAgentRunRecord> => {
  const snapshotOptions = {
    projectRoot: invocation.projectRoot,
    runner: options.runner,
    indexFile: auditIndexFile(
      invocation.projectRoot,
      invocation.task.runId,
      invocation.agentId
    ),
    ...(options.auditTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.auditTimeoutMs }),
  };
  const before = await snapshotWorkingTree(snapshotOptions);
  const record = await recordAgentRun(adapter, invocation, {
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });
  const after = await snapshotWorkingTree(snapshotOptions);
  const audit = await auditWorkingTree({
    projectRoot: invocation.projectRoot,
    runner: options.runner,
    before,
    after,
    policy: invocation.toolPolicy,
    ...(options.auditTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.auditTimeoutMs }),
  });

  return { ...record, audit };
};
