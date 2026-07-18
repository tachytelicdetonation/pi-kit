export class HostWorkflowCapabilityError extends Error {
    code = "HOST_CAPABILITY_UNAVAILABLE";
    constructor(message) {
        super(message);
        this.name = "HostWorkflowCapabilityError";
    }
}
function freezeToolDefinition(definition) {
    return Object.freeze({ ...definition });
}
/** Build the immutable launch-time contract consumed by workflow subagents. */
export function createHostWorkflowContext(options) {
    const activeToolNames = Object.freeze([...new Set(options.activeToolNames)]);
    const definitionsByName = new Map([...options.activeToolDefinitions].map((definition) => [definition.name, freezeToolDefinition(definition)]));
    const missing = activeToolNames.filter((name) => !definitionsByName.has(name));
    if (missing.length > 0) {
        throw new HostWorkflowCapabilityError(`Host did not provide executable definitions for active tools: ${missing.join(", ")}`);
    }
    const activeToolDefinitions = Object.freeze(activeToolNames.map((name) => definitionsByName.get(name)));
    return Object.freeze({
        sessionId: options.sessionId,
        cwd: options.cwd,
        inputOrigin: options.inputOrigin,
        mode: options.mode,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        activeToolNames,
        activeToolDefinitions,
        projectTrusted: options.projectTrusted,
        permissionMode: options.permissionMode,
        permissionBroker: options.permissionBroker,
        toolExecutionContext: options.toolExecutionContext,
        uiBroker: options.uiBroker,
        abortSignal: options.abortSignal,
    });
}
