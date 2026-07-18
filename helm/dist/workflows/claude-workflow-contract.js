export const CLAUDE_WORKFLOW_ORACLE_VERSION = "2.1.212";
const lifecycleStates = (...states) => Object.freeze(states);
const lifecycleTransitions = Object.freeze({
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
});
/** Single source of truth for observable Claude Code workflow compatibility. */
export const CLAUDE_WORKFLOW_CONTRACT = Object.freeze({
    oracleVersion: CLAUDE_WORKFLOW_ORACLE_VERSION,
    invocation: Object.freeze({
        sourcePrecedence: Object.freeze(["scriptPath", "script", "name"]),
        minimumSources: 1,
        argsGlobal: "args",
    }),
    runtime: Object.freeze({
        maximumConcurrentAgents: 16,
        maximumAgentsPerRun: 1_000,
        orchestrationGlobals: Object.freeze(["agent", "parallel", "pipeline", "phase", "args"]),
        piExtensionsGlobal: "pi",
        codeGeneration: Object.freeze({ strings: false, wasm: false }),
        directFilesystem: false,
        directShell: false,
        directNetwork: false,
        imports: false,
        midRunUserInput: false,
    }),
    lifecycle: Object.freeze({ transitions: lifecycleTransitions, resumeScope: "session" }),
    approval: Object.freeze({ byMode: approvalByMode, ultracodeSkipsLaunchApproval: true }),
    agents: Object.freeze({
        permissionMode: "acceptEdits",
        optionNames: Object.freeze(["label", "phase", "schema", "model", "effort", "isolation", "agentType"]),
    }),
    trigger: Object.freeze({ keyword: "ultracode", allowedOrigins: Object.freeze(["human"]) }),
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
        ]),
    }),
});
/** Resolve the highest-precedence non-empty workflow invocation source. */
export function resolveClaudeWorkflowInvocationSource(input) {
    for (const source of CLAUDE_WORKFLOW_CONTRACT.invocation.sourcePrecedence) {
        if (typeof input[source] === "string" && input[source].trim().length > 0)
            return source;
    }
    throw new Error("INVALID_INVOCATION: expected at least one of scriptPath, script, or name");
}
/** Check whether a lifecycle transition is allowed by the compatibility contract. */
export function canTransitionClaudeWorkflow(from, to) {
    return CLAUDE_WORKFLOW_CONTRACT.lifecycle.transitions[from].includes(to);
}
/** Accept keyword-triggered workflows only from contract-approved input origins. */
export function shouldTriggerClaudeWorkflowKeyword(keywordPresent, origin) {
    return keywordPresent && CLAUDE_WORKFLOW_CONTRACT.trigger.allowedOrigins.includes(origin);
}
/** Decide whether workflow size warrants the advisory warning. */
export function shouldWarnForLargeClaudeWorkflow(agentCount, projectedTokens, ultracode) {
    if (ultracode)
        return false;
    return (agentCount > CLAUDE_WORKFLOW_CONTRACT.largeWorkflow.agentThreshold ||
        projectedTokens > CLAUDE_WORKFLOW_CONTRACT.largeWorkflow.projectedTokenThreshold);
}
