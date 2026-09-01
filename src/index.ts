import { SAILOR_DIRECTORY } from "./sailor/layout.js";

export interface SailorPackageMetadata {
  readonly directory: typeof SAILOR_DIRECTORY;
  readonly name: "sailor";
}

export const sailorPackageMetadata = {
  directory: SAILOR_DIRECTORY,
  name: "sailor",
} as const satisfies SailorPackageMetadata;

export {
  SAILOR_DIRECTORY,
  SAILOR_GIT_HOOKS_PATH,
  SAILOR_PATHS,
  sailorPath,
} from "./sailor/layout.js";
export {
  SAILOR_ERROR_KINDS,
  SailorError,
  describeFailure,
} from "./sailor/sailor-error.js";
export type { SailorErrorKind } from "./sailor/sailor-error.js";
export {
  readPackageRepository,
  readPackageVersion,
} from "./sailor/package-version.js";
export { readTextFileIfPresent } from "./sailor/read-text-file.js";
export { writeFileAtomic } from "./sailor/atomic-write.js";
export { resolveProjectRoot } from "./sailor/resolve-project-root.js";
export type { ResolveProjectRootOptions } from "./sailor/resolve-project-root.js";
export { loadSailorRuleSet } from "./sailor/load-sailor-rule-set.js";
export type { LoadSailorRuleSetOptions } from "./sailor/load-sailor-rule-set.js";
export {
  projectRelativeGlobSchema,
  projectRelativePathSchema,
} from "./sailor/project-path.js";

export {
  BUILT_IN_AGENT_IDS,
  agentIdSchema,
  isBuiltInAgentId,
  mapBuiltInAgents,
} from "./agents/agent-id.js";
export type { AgentId, BuiltInAgentId } from "./agents/agent-id.js";
export {
  MODEL_PROFILES,
  agentDefinitionSchema,
  agentToolsSchema,
  loadAgentDefinition,
  modelProfileSchema,
} from "./agents/agent-definition.js";
export type {
  AgentDefinition,
  AgentTools,
  ModelProfile,
} from "./agents/agent-definition.js";

export { loadYamlConfig } from "./config/load-yaml-config.js";
export type { LoadYamlConfigOptions } from "./config/load-yaml-config.js";
export {
  loadProjectConfig,
  projectConfigSchema,
} from "./config/project-config.js";
export type { ProjectConfig } from "./config/project-config.js";
export {
  EXISTING_HOOK_POLICIES,
  existingHookPolicySchema,
  hooksConfigSchema,
  loadHooksConfig,
  managedHookSchema,
} from "./config/hooks-config.js";
export type {
  ExistingHookPolicy,
  HooksConfig,
  ManagedHook,
} from "./config/hooks-config.js";

export { loadRuleBundle } from "./rules/load-rule-bundle.js";
export { loadRuleDirectory } from "./rules/load-rule-directory.js";
export type { LoadRuleDirectoryOptions } from "./rules/load-rule-directory.js";
export type { LoadRuleBundleOptions } from "./rules/load-rule-bundle.js";
export {
  RuleResolutionError,
  RuleValidationError,
  formatRuleIssue,
  formatRuleIssues,
} from "./rules/rule-error.js";
export {
  RULE_SET_HASH_VERSION,
  canonicalRule,
  canonicalRuleSet,
  canonicalStringify,
  compareCodeUnits,
  hashRuleSet,
  normalizeText,
} from "./rules/hash-rule-set.js";
export type { CanonicalObject, CanonicalValue } from "./rules/hash-rule-set.js";
export {
  RULE_ORIGIN_PRECEDENCE,
  resolveRuleSet,
} from "./rules/resolve-rule-set.js";
export type {
  ResolvedRule,
  ResolvedRuleSet,
  RuleOrigin,
  RuleSource,
} from "./rules/resolve-rule-set.js";
export type { RuleIssue, RuleSourceLocation } from "./rules/rule-error.js";
export {
  DEFAULT_CHECK_TIMEOUT_MS,
  MAX_CHECK_TIMEOUT_MS,
  MIN_CHECK_TIMEOUT_MS,
  MISSING_SCRIPT_BEHAVIOURS,
  PHASES,
  PROJECT_SCRIPT_NAMES,
  SEVERITIES,
  checkSchema,
  ruleBundleSchema,
  ruleSchema,
} from "./rules/rule-schema.js";
export type {
  CommandCheck,
  MissingScriptBehaviour,
  Phase,
  ProjectScriptCheck,
  ProjectScriptName,
  Rule,
  RuleBundle,
  RuleCheck,
  Severity,
} from "./rules/rule-schema.js";

export {
  HOOK_NAMES,
  HOOK_RUNNERS,
  PACKAGE_MANAGERS,
  VALIDATION_MODES,
  packageManagerSchema,
  portableProjectProfileSchema,
  projectProfileSchema,
  toPortableProjectProfile,
} from "./project/project-profile-schema.js";
export { discoverProjectProfile } from "./project/discover-project-profile.js";
export type { DiscoverProjectProfileOptions } from "./project/discover-project-profile.js";
export {
  LOCKFILE_PACKAGE_MANAGERS,
  PackageManagerAmbiguityError,
  detectLockfilePackageManagers,
  parseDeclaredPackageManager,
  resolvePackageManager,
} from "./project/package-manager.js";
export type {
  HookEntrypoint,
  PackageManager,
  PortableProjectProfile,
  ProjectProfile,
  ValidationMode,
} from "./project/project-profile-schema.js";

export {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_KILL_SIGNAL,
  DEFAULT_MAX_OUTPUT_BYTES,
  EMPTY_COMMAND_OUTPUT,
  commandSucceeded,
  describeCommand,
  describeCommandResult,
  toSpawnFailure,
} from "./processes/command-runner.js";
export {
  ENVIRONMENT_ALLOWLIST,
  NODE_COMMAND_RUNNER_DEFAULTS,
  buildChildEnvironment,
  createNodeCommandRunner,
  killProcessTree,
  nodeCommandRunner,
} from "./processes/node-command-runner.js";
export type { NodeCommandRunnerOptions } from "./processes/node-command-runner.js";
export type {
  CommandOutput,
  CommandRequest,
  CommandResult,
  CommandRunner,
  CommandSpec,
  ExitedCommandResult,
  SignaledCommandResult,
  SpawnFailedCommandResult,
  TimedOutCommandResult,
} from "./processes/command-runner.js";

export {
  globMatches,
  matchingWriteScope,
  toProjectRelativePath,
} from "./enforcement/write-scope.js";
export {
  TOOL_ACTION_KINDS,
  TOOL_DENIALS,
  commandSpecSchema,
  evaluateToolAction,
  matchProjectScript,
  toolActionSchema,
  toolDecisionSchema,
  toolDenialSchema,
  toolPolicyFromContext,
} from "./enforcement/tool-policy.js";
export type {
  DeniedToolDecision,
  ToolAction,
  ToolDecision,
  ToolDenial,
  ToolPolicy,
} from "./enforcement/tool-policy.js";
export {
  WORKING_TREE_AUDIT_TIMEOUT_MS,
  auditWorkingTree,
  snapshotWorkingTree,
} from "./enforcement/working-tree-audit.js";
export type {
  AuditWorkingTreeOptions,
  SnapshotWorkingTreeOptions,
  WorkingTreeAudit,
  WorkingTreeSnapshot,
  WorkingTreeViolation,
} from "./enforcement/working-tree-audit.js";

export {
  AGENT_EVENT_KINDS,
  AGENT_STATUSES,
  OUTPUT_STREAMS,
  agentEventSchema,
  agentStatusOfCommandResult,
  agentStatusSchema,
  finishedEventOf,
} from "./providers/agent-event.js";
export type {
  AgentEvent,
  AgentEventKind,
  AgentStatus,
  FinishedEvent,
  OutputStream,
} from "./providers/agent-event.js";
export {
  PROVIDER_IDS,
  ProviderProtocolError,
  buildAgentInvocation,
  providerIdSchema,
  recordAgentRun,
} from "./providers/provider-adapter.js";
export type {
  AgentInvocation,
  AgentRunRecord,
  BuildAgentInvocationInput,
  ProviderAdapter,
  ProviderId,
  RecordAgentRunOptions,
} from "./providers/provider-adapter.js";

export { listScenarios } from "./qa/gherkin.js";
export type { ListScenariosOptions } from "./qa/gherkin.js";

export { compileAgentPolicy } from "./prompts/compile-agent-policy.js";
export type { CompileAgentPolicyInput } from "./prompts/compile-agent-policy.js";

export {
  buildPackageManagerCommand,
  resolveProjectScript,
} from "./gates/resolve-project-script.js";
export type {
  ProjectScriptResolution,
  ResolveProjectScriptInput,
} from "./gates/resolve-project-script.js";
export {
  GATE_STATUSES,
  PHASE_GATE_STATUSES,
  gateResultSchema,
  gateStatusSchema,
  phaseGateReportSchema,
  reportIdSchema,
} from "./gates/gate-report-schema.js";
export type {
  StoredGateResult,
  StoredPhaseGateReport,
} from "./gates/gate-report-schema.js";
export {
  createDefaultReportId,
  createDeterministicReportId,
  runPhaseGates,
} from "./gates/run-phase-gates.js";
export type {
  GateResult,
  GateStatus,
  PhaseGateReport,
  PhaseGateStatus,
  RunPhaseGatesOptions,
} from "./gates/run-phase-gates.js";

export {
  SEEDED_TEMPLATE_PATHS,
  sailorTemplateRoot,
  isSeededTemplate,
  listSailorTemplateFiles,
  readSailorTemplateFile,
} from "./install/sailor-templates.js";
export type { SailorTemplateFile } from "./install/sailor-templates.js";
export {
  INSTALL_MANIFEST_VERSION,
  MANAGED_FILE_KINDS,
  hashManagedFile,
  hookRecordSchema,
  installManifestSchema,
  managedFileEntrySchema,
  managedFileKindSchema,
  readInstallManifest,
  writeInstallManifest,
} from "./install/install-manifest.js";
export type {
  HookRecord,
  InstallManifest,
  ManagedFileEntry,
  ManagedFileKind,
} from "./install/install-manifest.js";
export {
  INSTALL_ACTIONS,
  planInstallation,
  toPlannedFileSource,
} from "./install/plan-installation.js";
export type {
  InstallAction,
  InstallationPlan,
  PlanInstallationInput,
  PlannedFile,
  PlannedFileSource,
} from "./install/plan-installation.js";
export {
  SAILOR_PACKAGE_NAME,
  RUNTIME_INSTALL_ARGV,
  RUNTIME_INSTALL_TIMEOUT_MS,
  RUNTIME_PACKAGE_NAME,
  buildRuntimePackageManifest,
  sailorReleaseTarballUrl,
  installRuntimeDependencies,
} from "./install/runtime-dependencies.js";
export type {
  InstallRuntimeDependenciesOptions,
  RuntimePackageManifestInput,
} from "./install/runtime-dependencies.js";
export { installSailor } from "./install/install-sailor.js";
export type {
  InstallSailorOptions,
  InstallSailorResult,
} from "./install/install-sailor.js";
export {
  HOOKS_PATH_SCOPES,
  discoverHookEnvironment,
  toProjectPath,
} from "./install/discover-hooks.js";
export type {
  DiscoverHookEnvironmentOptions,
  HookEnvironment,
  HooksPathScope,
  PriorHook,
} from "./install/discover-hooks.js";
export {
  EXECUTABLE_MODE,
  LAUNCHER_PATH,
  buildSailorLauncher,
  buildHookDispatcher,
  escapeForDoubleQuotes,
  hookScriptPath,
} from "./install/hook-scripts.js";
export type { HookDispatcher } from "./install/hook-scripts.js";
export { planHooks } from "./install/plan-hooks.js";
export type { PlanHooksInput } from "./install/plan-hooks.js";
export {
  CI_TEMPLATE_PATH,
  DIAGNOSTIC_STATUSES,
  REQUIRED_NODE_VERSION,
  REQUIRED_TOOLS,
  WORKFLOW_DIRECTORY,
  diagnoseSailor,
  versionOrder,
} from "./install/diagnose-sailor.js";
export type {
  DiagnoseSailorOptions,
  Diagnostic,
  DiagnosticStatus,
  SailorDiagnosis,
} from "./install/diagnose-sailor.js";

export {
  INTERRUPTED_STATES,
  TASK_FILE_VERSION,
  acceptanceSchema,
  fileDigestSchema,
  TASK_STATES,
  WORKFLOW_STATES,
  runIdSchema,
  taskFailureSchema,
  taskFileSchema,
  taskIdSchema,
  taskSchema,
  taskStateSchema,
  transitionRecordSchema,
} from "./tasks/task-schema.js";
export type {
  Acceptance,
  ActiveState,
  FileDigest,
  InterruptedState,
  Task,
  TaskFailure,
  TaskFile,
  TaskState,
  TransitionRecord,
  WorkflowState,
} from "./tasks/task-schema.js";
export {
  TASK_FILE_SOURCE,
  emptyTaskFile,
  findTask,
  readTaskFile,
  requireTask,
  taskFilePath,
  writeTaskFile,
} from "./tasks/task-file.js";
export {
  TASK_LOCK_DEFAULTS,
  taskLockRetryBudgetMs,
  taskLockStaleMs,
  withTaskLock,
} from "./tasks/task-lock.js";
export type { TaskLockOptions } from "./tasks/task-lock.js";
export { updateTaskFile } from "./tasks/update-task-file.js";
export {
  ACTIVE_STATES,
  STATE_AGENTS,
  TERMINAL_STATE,
  allowedTransitions,
  completedStages,
  currentStage,
  isActiveState,
  isInterruptedState,
  isWorkflowState,
  nextWorkflowState,
  pendingStages,
} from "./tasks/workflow.js";
export {
  approveSpecification,
  createDefaultRunId,
  createTask,
  transitionTask,
} from "./tasks/transition-task.js";
export type {
  ApproveSpecificationRequest,
  CreateTaskRequest,
  TransitionRequest,
} from "./tasks/transition-task.js";
export {
  RUN_REPORT_VERSION,
  readRunReport,
  runReportFile,
  runReportsDirectory,
  runReportSchema,
  writeRunReport,
} from "./tasks/run-report.js";
export type {
  StoredRunReport,
  WriteRunReportInput,
} from "./tasks/run-report.js";
export {
  AGENT_CONTEXT_FILE,
  AGENT_CONTEXT_VERSION,
  agentContextDirectory,
  agentContextFile,
  agentContextSchema,
  buildAgentContext,
  contextHandoffSchema,
  readAgentContext,
  writeAgentContext,
} from "./tasks/agent-context.js";
export type {
  AgentContext,
  BuildAgentContextInput,
  ContextHandoff,
} from "./tasks/agent-context.js";

export { CLI_COMMANDS, parseCliArguments } from "./cli/parse-cli-arguments.js";
export type {
  CliCommand,
  CliInvocation,
  CliParseResult,
} from "./cli/parse-cli-arguments.js";
export { CLI_EXIT_CODES, exitCodeForSailorError } from "./cli/exit-codes.js";
export { runCli } from "./cli/run-cli.js";
export type {
  CliCommandHandler,
  CliCommandRegistry,
  CliContext,
  CliStream,
  CliStreams,
  RunCliOptions,
} from "./cli/run-cli.js";
export { createDefaultCliCommands } from "./cli/default-commands.js";
export { formatDiagnosis } from "./cli/format-diagnosis.js";
export { formatInstallResult } from "./cli/format-install-result.js";
export { formatPhaseGateReport } from "./cli/format-gate-report.js";
export {
  formatRuleSetExplanation,
  formatRuleSetSummary,
} from "./cli/format-rule-set.js";
