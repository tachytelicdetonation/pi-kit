import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveAgentModelSpec } from "./agent.js";
import { InheritedToolHost } from "./inherited-tool-host.js";
import { canonicalModelSpec } from "./model-spec.js";
/** Process-isolated subagent whose only tools are parent-executed proxies. */
export class ProcessWorkflowAgent {
    hostContext;
    inheritedTools;
    runId;
    maximumOldSpaceMb;
    childModulePath;
    constructor(options) {
        this.hostContext = options.hostContext;
        this.inheritedTools = new InheritedToolHost(options.hostContext);
        this.runId = options.runId;
        this.maximumOldSpaceMb = options.maximumOldSpaceMb;
        this.childModulePath = options.childModulePath;
    }
    async run(prompt, options = {}) {
        const childPath = realpathSync(this.childModulePath ?? resolveChildModule());
        const nonce = randomBytes(32).toString("hex");
        const internalTools = new Map([...(options.systemTools ?? []), ...(options.tools ?? [])].map((definition) => [definition.name, definition]));
        const inherited = filterToolDefinitions(this.inheritedTools.listDefinitions(), options.toolNames, options.disallowedToolNames);
        const descriptors = [...inherited, ...internalTools.values()].map(toolDescriptor);
        const cwd = options.cwd ?? this.hostContext.cwd;
        const parentModel = this.hostContext.model ? canonicalModelSpec(this.hostContext.model) : undefined;
        const requestedModel = resolveAgentModelSpec(options, parentModel, undefined, (tier) => options.onModelFallback?.(`unconfigured tier ${tier}`));
        const agentId = options.label?.trim() || `agent-${randomBytes(6).toString("hex")}`;
        const child = spawn(process.execPath, [`--max-old-space-size=${normalizeMemoryLimit(this.maximumOldSpaceMb)}`, childPath], {
            cwd,
            env: process.env,
            stdio: ["ignore", "ignore", "pipe", "ipc"],
            windowsHide: true,
        });
        return new Promise((resolve, reject) => {
            let settled = false;
            let stderr = "";
            const toolControllers = new Map();
            const finish = (error, value) => {
                if (settled)
                    return;
                settled = true;
                options.signal?.removeEventListener("abort", abort);
                for (const controller of toolControllers.values())
                    controller.abort();
                toolControllers.clear();
                child.removeAllListeners();
                if (child.connected)
                    child.disconnect();
                if (!child.killed)
                    child.kill("SIGKILL");
                if (error)
                    reject(error);
                else
                    resolve(value);
            };
            const abort = () => {
                send(child, { type: "abort", nonce });
                finish(new Error("Subagent was aborted"));
            };
            child.stderr?.on("data", (chunk) => {
                if (stderr.length < 32_768)
                    stderr += chunk.toString("utf8").slice(0, 32_768 - stderr.length);
            });
            child.on("error", (error) => finish(error));
            child.on("exit", (code, signal) => {
                if (!settled) {
                    finish(new Error(`Subagent process exited before returning a result (code=${String(code)}, signal=${String(signal)})${stderr ? `: ${stderr.trim()}` : ""}`));
                }
            });
            child.on("message", (message) => {
                if (!message || message.nonce !== nonce)
                    return;
                if (message.type === "result") {
                    const result = message;
                    if (result.ok)
                        finish(undefined, result.value);
                    else
                        finish(remoteError(result.error));
                    return;
                }
                if (message.type === "model" && typeof message.model === "string") {
                    options.onModelResolved?.(message.model);
                    return;
                }
                if (message.type === "model-fallback" && typeof message.model === "string") {
                    options.onModelFallback?.(message.model);
                    return;
                }
                if (message.type === "history" && Array.isArray(message.history)) {
                    options.onHistory?.(message.history);
                    return;
                }
                if (message.type === "usage" && message.usage && typeof message.usage === "object") {
                    options.onUsage?.(normalizeUsage(message.usage));
                    return;
                }
                if (message.type === "tool-abort" && typeof message.id === "number") {
                    toolControllers.get(message.id)?.abort();
                    return;
                }
                if (message.type === "tool-request") {
                    void executeToolRequest(child, message, nonce, this.inheritedTools, internalTools, this.hostContext, this.runId, agentId, cwd, toolControllers);
                }
            });
            if (options.signal?.aborted)
                return abort();
            options.signal?.addEventListener("abort", abort, { once: true });
            send(child, {
                type: "init",
                nonce,
                prompt,
                cwd,
                label: options.label,
                instructions: options.instructions,
                model: requestedModel,
                thinkingLevel: options.thinkingLevel ?? this.hostContext.thinkingLevel,
                schema: options.schema ? jsonClone(options.schema) : undefined,
                maxSchemaRetries: options.maxSchemaRetries,
                tools: descriptors,
            });
        });
    }
}
async function executeToolRequest(child, request, nonce, inherited, internalTools, hostContext, runId, agentId, cwd, controllers) {
    const controller = new AbortController();
    controllers.set(request.id, controller);
    try {
        const internal = internalTools.get(request.toolName);
        const value = internal
            ? await executeInternalTool(internal, request, controller.signal, hostContext, cwd)
            : await inherited.execute({
                runId,
                agentId,
                toolCallId: request.toolCallId,
                toolName: request.toolName,
                input: request.input,
                cwd,
                signal: controller.signal,
            });
        send(child, { type: "tool-response", nonce, id: request.id, ok: true, value });
    }
    catch (error) {
        send(child, { type: "tool-response", nonce, id: request.id, ok: false, error: { message: errorMessage(error) } });
    }
    finally {
        controllers.delete(request.id);
    }
}
function executeInternalTool(definition, request, signal, context, cwd) {
    if (!context.toolExecutionContext) {
        return Promise.reject(new Error("HOST_CAPABILITY_UNAVAILABLE: missing parent tool execution context"));
    }
    return definition.execute(request.toolCallId, request.input, signal, undefined, executionContextForCwd(context.toolExecutionContext, cwd));
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
function filterToolDefinitions(definitions, allow, deny) {
    const allowed = allow ? new Set(allow) : undefined;
    const denied = new Set(deny ?? []);
    return definitions.filter((definition) => (!allowed || allowed.has(definition.name)) && !denied.has(definition.name));
}
function toolDescriptor(definition) {
    return {
        name: definition.name,
        label: definition.label,
        description: definition.description,
        parameters: jsonClone(definition.parameters),
        promptSnippet: definition.promptSnippet,
        promptGuidelines: definition.promptGuidelines ? [...definition.promptGuidelines] : undefined,
    };
}
function jsonClone(value) {
    return JSON.parse(JSON.stringify(value));
}
function resolveChildModule() {
    const adjacent = fileURLToPath(new URL("./process-agent-child.js", import.meta.url));
    if (existsSync(adjacent))
        return adjacent;
    const built = fileURLToPath(new URL("../../dist/workflows/process-agent-child.js", import.meta.url));
    if (existsSync(built))
        return built;
    throw new Error(`Process subagent child module is unavailable: ${adjacent}. Build the package first.`);
}
function normalizeMemoryLimit(value) {
    if (value === undefined || !Number.isFinite(value))
        return 512;
    return Math.min(2_048, Math.max(128, Math.floor(value)));
}
function normalizeUsage(value) {
    const number = (key) => (typeof value[key] === "number" ? value[key] : 0);
    return {
        input: number("input"),
        output: number("output"),
        cacheRead: number("cacheRead"),
        cacheWrite: number("cacheWrite"),
        total: number("total"),
        cost: number("cost"),
    };
}
function remoteError(value) {
    const error = new Error(value?.message ?? "Subagent process failed");
    error.name = value?.name ?? "Error";
    Object.assign(error, { code: value?.code, recoverable: value?.recoverable });
    return error;
}
function send(child, message) {
    if (!child.connected)
        return;
    try {
        child.send(message, () => { });
    }
    catch {
        // The child may have exited between the connected check and send.
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
