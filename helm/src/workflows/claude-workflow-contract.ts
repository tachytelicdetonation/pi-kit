export const CLAUDE_WORKFLOW_ORACLE_VERSION = "2.1.212" as const;

export type ClaudeWorkflowInvocationSource = "scriptPath" | "script" | "name";
export type ClaudeWorkflowInputOrigin = "human" | "print" | "rpc" | "extension" | "scheduled" | "webhook";
export type ClaudeWorkflowPermissionMode = "default" | "acceptEdits" | "auto" | "bypassPermissions" | "headless";
export type ClaudeWorkflowLifecycleState = "pending" | "running" | "paused" | "completed" | "failed" | "stopped";

export type ClaudeWorkflowErrorCategory =
  | "INVALID_INVOCATION"
  | "INVALID_SCRIPT_PATH"
  | "PROJECT_NOT_TRUSTED"
  | "APPROVAL_DENIED"
  | "PERMISSION_DENIED"
  | "TOOL_NOT_ALLOWED"
  | "IMPORT_DISABLED"
  | "CODE_GENERATION_DISABLED"
  | "SANDBOX_VIOLATION"
  | "ORCHESTRATION_TIMEOUT"
  | "CONCURRENCY_LIMIT"
  | "AGENT_LIMIT"
  | "RESUME_SCOPE_MISMATCH"
  | "INVALID_LIFECYCLE_TRANSITION"
  | "INVALID_SAVED_WORKFLOW";

const lifecycleStates = (...states: ClaudeWorkflowLifecycleState[]): readonly ClaudeWorkflowLifecycleState[] =>
  Object.freeze(states);

const lifecycleTransitions: Readonly<Record<ClaudeWorkflowLifecycleState, readonly ClaudeWorkflowLifecycleState[]>> =
  Object.freeze({
    pending: lifecycleStates("running", "stopped"),
    running: lifecycleStates("paused", "completed", "failed", "stopped"),
    paused: lifecycleStates("running", "stopped"),
    completed: lifecycleStates(),
    failed: lifecycleStates(),
    stopped: lifecycleStates(),
  });

const approvalByMode = Object.freeze({
  default: "every-untrusted-launch",
  acceptEdits: "every-untrusted-launch",
  auto: "first-launch",
  bypassPermissions: "never",
  headless: "never",
} as const);

/** Single source of truth for observable Claude Code workflow compatibility. */
export const CLAUDE_WORKFLOW_CONTRACT = Object.freeze({
  oracleVersion: CLAUDE_WORKFLOW_ORACLE_VERSION,
  invocation: Object.freeze({
    sourcePrecedence: Object.freeze(["scriptPath", "script", "name"] as const),
    minimumSources: 1,
    argsGlobal: "args",
  }),
  runtime: Object.freeze({
    maximumConcurrentAgents: 16,
    maximumAgentsPerRun: 1_000,
    orchestrationGlobals: Object.freeze(["agent", "parallel", "pipeline", "phase", "args"] as const),
    piExtensionsGlobal: "pi" as const,
    codeGeneration: Object.freeze({ strings: false, wasm: false }),
    directFilesystem: false,
    directShell: false,
    directNetwork: false,
    imports: false,
    midRunUserInput: false,
  }),
  lifecycle: Object.freeze({ transitions: lifecycleTransitions, resumeScope: "session" as const }),
  approval: Object.freeze({ byMode: approvalByMode, ultracodeSkipsLaunchApproval: true }),
  agents: Object.freeze({
    permissionMode: "acceptEdits" as const,
    optionNames: Object.freeze(["label", "phase", "schema", "model", "effort", "isolation", "agentType"] as const),
  }),
  trigger: Object.freeze({ keyword: "ultracode", allowedOrigins: Object.freeze(["human"] as const) }),
  storage: Object.freeze({
    projectDirectory: ".pi/workflows",
    personalDirectoryName: "workflows",
    extension: ".js",
    projectPrecedesPersonal: true,
    nearestProjectDefinitionWins: true,
  }),
  largeWorkflow: Object.freeze({ agentThreshold: 25, projectedTokenThreshold: 1_500_000, advisory: true }),
  errors: Object.freeze({
    categories: Object.freeze([
      "INVALID_INVOCATION",
      "INVALID_SCRIPT_PATH",
      "PROJECT_NOT_TRUSTED",
      "APPROVAL_DENIED",
      "PERMISSION_DENIED",
      "TOOL_NOT_ALLOWED",
      "IMPORT_DISABLED",
      "CODE_GENERATION_DISABLED",
      "SANDBOX_VIOLATION",
      "ORCHESTRATION_TIMEOUT",
      "CONCURRENCY_LIMIT",
      "AGENT_LIMIT",
      "RESUME_SCOPE_MISMATCH",
      "INVALID_LIFECYCLE_TRANSITION",
      "INVALID_SAVED_WORKFLOW",
    ] as const satisfies readonly ClaudeWorkflowErrorCategory[]),
  }),
});

/** Resolve the highest-precedence non-empty workflow invocation source. */
export function resolveClaudeWorkflowInvocationSource(input: {
  scriptPath?: unknown;
  script?: unknown;
  name?: unknown;
}): ClaudeWorkflowInvocationSource {
  for (const source of CLAUDE_WORKFLOW_CONTRACT.invocation.sourcePrecedence) {
    if (typeof input[source] === "string" && input[source].trim().length > 0) return source;
  }
  throw new Error("INVALID_INVOCATION: expected at least one of scriptPath, script, or name");
}

/** Check whether a lifecycle transition is allowed by the compatibility contract. */
export function canTransitionClaudeWorkflow(
  from: ClaudeWorkflowLifecycleState,
  to: ClaudeWorkflowLifecycleState,
): boolean {
  return CLAUDE_WORKFLOW_CONTRACT.lifecycle.transitions[from].includes(to);
}

/** Accept keyword-triggered workflows only from contract-approved input origins. */
export function shouldTriggerClaudeWorkflowKeyword(
  keywordPresent: boolean,
  origin: ClaudeWorkflowInputOrigin,
): boolean {
  return keywordPresent && CLAUDE_WORKFLOW_CONTRACT.trigger.allowedOrigins.includes(origin as "human");
}

/** Decide whether workflow size warrants the advisory warning. */
export function shouldWarnForLargeClaudeWorkflow(
  agentCount: number,
  projectedTokens: number,
  ultracode: boolean,
): boolean {
  if (ultracode) return false;
  return (
    agentCount > CLAUDE_WORKFLOW_CONTRACT.largeWorkflow.agentThreshold ||
    projectedTokens > CLAUDE_WORKFLOW_CONTRACT.largeWorkflow.projectedTokenThreshold
  );
}
