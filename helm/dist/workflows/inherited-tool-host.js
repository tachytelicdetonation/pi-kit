/**
 * Executes only the immutable executable definitions captured from the parent.
 * Unknown/inactive tools and missing parent execution context fail closed. Every
 * call is authorized by the retained parent-session broker before execution.
 */
export class InheritedToolHost {
    context;
    definitions;
    constructor(context) {
        this.context = context;
        this.definitions = new Map(context.activeToolDefinitions.map((definition) => [definition.name, definition]));
    }
    listDefinitions() {
        return this.context.activeToolDefinitions;
    }
    async execute(request, onUpdate) {
        const definition = this.definitions.get(request.toolName);
        if (!definition || !this.context.activeToolNames.includes(request.toolName)) {
            throw new Error(`TOOL_NOT_ALLOWED: ${request.toolName} was not active at workflow launch`);
        }
        if (request.signal?.aborted)
            throw new Error("Workflow tool execution aborted");
        const decision = await this.context.permissionBroker.authorize({
            runId: request.runId,
            agentId: request.agentId,
            toolName: request.toolName,
            input: structuredClone(request.input),
            cwd: request.cwd,
            signal: request.signal,
        });
        if (!decision.allowed) {
            throw new Error(`PERMISSION_DENIED: ${decision.reason ?? `parent denied ${request.toolName}`}`);
        }
        const executionContext = this.context.toolExecutionContext;
        if (!executionContext) {
            throw new Error("HOST_CAPABILITY_UNAVAILABLE: parent tool execution context was not captured");
        }
        return definition.execute(request.toolCallId, structuredClone(request.input), request.signal, onUpdate, executionContextForCwd(executionContext, request.cwd));
    }
}
function executionContextForCwd(context, cwd) {
    if (context.cwd === cwd)
        return context;
    return new Proxy(context, {
        get(target, property, receiver) {
            return property === "cwd" ? cwd : Reflect.get(target, property, receiver);
        },
    });
}
