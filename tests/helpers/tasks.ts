import type {
  Acceptance,
  Task,
  TaskFile,
  TransitionRecord,
} from "../../src/tasks/task-schema.js";

export const RULE_SET_SHA256 = "b".repeat(64);

/** A task as `createTask` would have written it, for tests that start later. */
export const buildTask = (overrides: Partial<Task> = {}): Task => ({
  id: "add-login",
  title: "Add login",
  state: "draft",
  revision: 1,
  runId: "run-1",
  agentId: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
  approvedAt: null,
  approvedBy: null,
  acceptance: null,
  interruptedFrom: null,
  contextPath: null,
  history: [],
  ...overrides,
});

/** What an approval accepted, for tests that do not read the files behind it. */
export const buildAcceptance = (
  overrides: Partial<Acceptance> = {}
): Acceptance => ({
  features: [{ path: "features/add-login.feature", sha256: "c".repeat(64) }],
  procedure: { path: "docs/qa/add-login.yaml", sha256: "d".repeat(64) },
  ...overrides,
});

export const buildTaskFile = (...tasks: readonly Task[]): TaskFile => ({
  version: 1,
  tasks: [...tasks],
});

export const buildTransition = (
  overrides: Partial<TransitionRecord> = {}
): TransitionRecord => ({
  revision: 2,
  expectedRevision: 1,
  from: "draft",
  to: "specified",
  fromAgent: null,
  toAgent: "specifier",
  ruleSetSha256: RULE_SET_SHA256,
  gateReportIds: [],
  artifactPaths: [],
  at: "2026-08-27T00:01:00.000Z",
  attempt: 1,
  failure: null,
  contextPath: null,
  ...overrides,
});
