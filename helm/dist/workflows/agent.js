import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { streamSimple as streamCompat } from "@earendil-works/pi-ai/compat";
import { createAgentSession, createCodingTools, getAgentDir, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { Check, Convert } from "typebox/value";
import { compactAgentHistory } from "./agent-history.js";
import { applyToolPolicy } from "./agent-registry.js";
import { classifyProviderLimit, WorkflowError, WorkflowErrorCode } from "./errors.js";
import { canonicalModelSpec, resolveModelSpecWithThinking } from "./model-spec.js";
import { formatTierFallbackNotice, loadModelTierConfig, resolveTierModel, } from "./model-tier-config.js";
import { createStructuredOutputTool } from "./structured-output.js";
/**
 * Find a JSON object/array in free-form text: a fenced ```json block if present,
 * else the first balanced {...} or [...]. Best-effort (the schema check is the
 * real gate). Returns the raw JSON string, or undefined when none is found.
 */
function findJsonBlock(text) {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1])
        return fence[1].trim();
    const start = text.search(/[{[]/);
    if (start === -1)
        return undefined;
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === open)
            depth++;
        else if (text[i] === close && --depth === 0)
            return text.slice(start, i + 1);
    }
    return undefined;
}
/**
 * Last-resort structured-output recovery: extract a JSON block from prose, coerce
 * it toward the schema, and accept it only if it then validates. Never fabricates
 * — returns undefined unless the parsed value genuinely satisfies the schema.
 */
export function extractValidated(text, schema) {
    const json = findJsonBlock(text);
    if (json === undefined)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        return undefined;
    }
    try {
        const converted = Convert(schema, parsed);
        if (Check(schema, converted))
            return converted;
    }
    catch {
        // typebox can throw on exotic schemas; treat as no match.
    }
    return undefined;
}
/**
 * The last assistant message's terminal metadata (stopReason/errorMessage). The pi
 * SDK does NOT throw provider usage/quota limits — it records them as an assistant
 * message with stopReason "error" and an errorMessage. This is the only place that
 * metadata is observable to the workflow layer.
 */
export function lastAssistantError(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message?.role !== "assistant")
            continue;
        return { stopReason: message.stopReason, errorMessage: message.errorMessage };
    }
    return undefined;
}
/**
 * If the subagent's turn ended in a provider usage/quota/rate-limit error, throw a
 * PROVIDER_USAGE_LIMIT WorkflowError carrying the real provider message + reset hint.
 * Gated on stopReason === "error" so a successful turn whose text merely mentions
 * "rate limit" is never misclassified. recoverable:false so the run checkpoints
 * (paused) rather than being retried into the same wall or collapsed to a silent null.
 */
export function throwIfProviderLimit(messages, label) {
    const err = lastAssistantError(messages);
    if (err?.stopReason !== "error")
        return;
    const { matched, resetHint } = classifyProviderLimit(err.errorMessage);
    if (!matched)
        return;
    throw new WorkflowError(err.errorMessage ?? "Provider usage/quota limit reached", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false, agentLabel: label, resetHint });
}
/**
 * Resolve a schema agent's result. If the tool was called, return the captured
 * value. Otherwise re-prompt up to maxSchemaRetries (tools restricted to
 * structured_output), then try strict schema-validated prose extraction, else
 * throw SCHEMA_NONCOMPLIANCE (non-recoverable — surfaced, never a silent null).
 * Module-level with an injected `lastText` so it is unit-testable.
 */
export async function resolveStructuredOutput(session, capture, schema, options, lastText) {
    if (capture.called)
        return capture.value;
    const maxRetries = Math.max(0, options.maxSchemaRetries ?? 2);
    // Restrict to the schema tool so the only useful next action is calling it
    // (takes effect on the next prompt turn). Best-effort.
    try {
        session.setActiveToolsByName?.(["structured_output"]);
    }
    catch {
        // ignore — the re-prompt alone still drives most models to comply
    }
    for (let attempt = 0; attempt < maxRetries && !capture.called; attempt++) {
        if (options.signal?.aborted)
            throw new Error("Subagent was aborted");
        await session.prompt("You did not call the structured_output tool. Call structured_output now as your only action, with the required fields filled in. Do not write a prose answer.");
    }
    if (capture.called)
        return capture.value;
    const extracted = extractValidated(lastText(session.messages), schema);
    if (extracted !== undefined) {
        console.warn("[workflow] structured_output recovered from prose extraction (the model never called the tool); prefer a tool-reliable model");
        return extracted;
    }
    // A repair re-prompt can itself hit the provider limit. Surface that as the real
    // (recoverable) cause instead of the misleading non-recoverable SCHEMA_NONCOMPLIANCE.
    throwIfProviderLimit(session.messages, options.label);
    throw new WorkflowError("Subagent did not produce valid structured_output after repair attempts", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false, agentLabel: options.label });
}
/**
 * Resolve which concrete model spec a subagent should use. Precedence, most
 * specific first:
 *   1. options.model — an explicit per-agent model (also carries agentType /
 *      phase model, which the workflow layer folds into options.model).
 *   2. options.tier  — resolved via the model-tiers config, falling back to the
 *      session's main model when the tier has no configured entry.
 *   3. DEFAULT TIER — when neither is set but the user has a model-tiers config,
 *      untagged agents default to the "medium" tier so a configured tier set
 *      actually affects the whole workflow (not just agents the script tagged).
 *      Fresh-install medium == the session model, so this is a no-op until the
 *      user customizes tiers via /workflows-models.
 * Returns undefined when nothing applies, so the session default is used.
 *
 * `loadConfig` is injectable for testing; it defaults to reading from disk.
 */
export function resolveAgentModelSpec(options, mainModel, loadConfig = loadModelTierConfig, onTierWithoutConfig) {
    if (options.model)
        return options.model;
    const config = loadConfig();
    if (options.tier) {
        // Tier requested but unconfigured → it silently falls back to mainModel.
        // Let the caller surface that (once) so the no-op is discoverable.
        if (!config)
            onTierWithoutConfig?.(options.tier);
        return (config ? resolveTierModel(options.tier, config) : undefined) ?? mainModel;
    }
    // Untagged agent: default to the configured medium tier when one exists.
    if (config) {
        const medium = resolveTierModel("medium", config);
        if (medium)
            return medium;
    }
    return undefined;
}
/**
 * List the user's currently available models (those with auth configured) with
 * the minimal fields tier ranking needs: canonical spec, output price, and
 * context window. This is the single place the SDK `Model` is projected into
 * the SDK-agnostic `RankableModel`. Best-effort: returns [] if the registry
 * can't be built.
 */
export function listAvailableModels(registry) {
    try {
        if (!registry)
            return [];
        return registry.getAvailable().map((model) => ({
            spec: canonicalModelSpec(model),
            costOutput: model.cost?.output,
            contextWindow: model.contextWindow,
        }));
    }
    catch {
        return [];
    }
}
/**
 * List the user's currently available models as `provider/modelId` specs. Used
 * to tell the workflow author which models it may route agents to. Best-effort:
 * returns [] if the registry can't be built.
 */
export function listAvailableModelSpecs(registry) {
    return listAvailableModels(registry).map((model) => model.spec);
}
/**
 * Emitted at most once per process: when an agent asks for a tier but no
 * model-tiers.json exists, the tier silently falls back to the session model.
 * Surface that once (with the mapping the user would get by configuring) so the
 * no-op is discoverable. Diagnostics only — never lets a failure break a run.
 */
let warnedTierUnconfigured = false;
function warnTierUnconfiguredOnce(mainModel, registry) {
    if (warnedTierUnconfigured)
        return;
    warnedTierUnconfigured = true;
    try {
        console.warn(formatTierFallbackNotice(mainModel, listAvailableModels(registry)));
    }
    catch {
        // best-effort diagnostic
    }
}
/**
 * Emitted at most once per process when persistAgentSessions is enabled and a
 * session is actually persisted: full subagent transcripts (which may include
 * secrets or other sensitive context) are being written to disk. Surface the
 * privacy trade-off at run time, not only in the docs.
 */
let warnedPersistSecrets = false;
function warnPersistSecretsOnce(sessionDir) {
    if (warnedPersistSecrets)
        return;
    warnedPersistSecrets = true;
    console.warn(`[workflow] persistAgentSessions is ON: full subagent transcripts (which may include secrets or other sensitive context) are being written to disk under ${sessionDir}. Disable persistAgentSessions if that isn't intended.`);
}
/**
 * Map session stats to an AgentUsage, or undefined when the provider reported
 * no usage at all (all-zero stats). Returning undefined — instead of a zero
 * breakdown — lets displays fall back to their scalar token count, so setups
 * on non-reporting providers render the same as before the split existed.
 */
export function usageFromStats(stats) {
    const { tokens, cost } = stats;
    if (tokens.total <= 0 && cost <= 0)
        return undefined;
    return {
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite,
        total: tokens.total,
        cost,
    };
}
const EMPTY_MODEL_REGISTRY = {
    getAvailable: () => [],
    getAll: () => [],
    find: () => undefined,
};
async function createLegacyFauxRuntime(model, agentDir) {
    if (!model?.api.startsWith("faux:"))
        return undefined;
    const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
        allowModelNetwork: false,
    });
    runtime.registerProvider(model.provider, {
        name: model.provider,
        api: model.api,
        apiKey: "faux-test-provider",
        baseUrl: model.baseUrl,
        streamSimple: (candidate, context, options) => streamCompat(candidate, context, options),
        models: [{
                id: model.id,
                name: model.name,
                api: model.api,
                baseUrl: model.baseUrl,
                reasoning: model.reasoning,
                thinkingLevelMap: model.thinkingLevelMap,
                input: model.input,
                cost: model.cost,
                contextWindow: model.contextWindow,
                maxTokens: model.maxTokens,
                headers: model.headers,
                compat: model.compat,
            }],
    });
    return runtime;
}
export class WorkflowAgent {
    /**
     * Appended to a subagent's prompt whenever a schema is in effect, instructing
     * the model to end its turn with a single structured_output tool call rather
     * than a prose answer.
     */
    static STRUCTURED_OUTPUT_CONTRACT = [
        "Final output contract:",
        "- End the task with exactly one structured_output tool call; its arguments are this subagent's return value.",
        "- Do not emit a prose final answer instead of structured_output.",
        "- Inspect files or run any commands you need first, then call structured_output exactly once as your final action.",
    ].join("\n");
    cwd;
    baseTools;
    sessionOptions;
    persistAgentSessions;
    instructions;
    mainModel;
    /** Shared registry from the host session, when provided. */
    sharedRegistry;
    diskRegistryPromise;
    diskModelRuntime;
    constructor(options = {}) {
        this.cwd = options.cwd ?? process.cwd();
        this.baseTools = options.tools ?? createCodingTools(this.cwd);
        this.sessionOptions = options.session ?? {};
        this.persistAgentSessions = options.persistAgentSessions ?? false;
        this.instructions = options.instructions;
        this.mainModel = options.mainModel;
        this.sharedRegistry = options.modelRegistry;
    }
    /**
     * Resolve the registry for a run: an explicit per-run registry wins, then the
     * constructor's shared registry. The empty facade preserves the synchronous
     * seam; routed standalone runs upgrade it through getDiskRegistry().
     */
    getRegistry(perRunRegistry) {
        if (perRunRegistry) {
            return perRunRegistry;
        }
        if (this.sharedRegistry) {
            return this.sharedRegistry;
        }
        return EMPTY_MODEL_REGISTRY;
    }
    getDiskRegistry() {
        if (!this.diskRegistryPromise) {
            const dir = getAgentDir();
            this.diskRegistryPromise = ModelRuntime.create({
                authPath: join(dir, "auth.json"),
                modelsPath: join(dir, "models.json"),
                allowModelNetwork: false,
            }).then((runtime) => {
                this.diskModelRuntime = runtime;
                return new ModelRegistry(runtime);
            });
        }
        return this.diskRegistryPromise;
    }
    /**
     * Session manager for one subagent run. File-backed (persisted under the
     * standard sessions dir, keyed by the runner's project cwd — never a
     * per-call worktree cwd) when persistAgentSessions is on; in-memory otherwise.
     *
     * SessionManager.create() only creates the session directory — the SDK writes
     * the session file lazily (synchronous fs calls, uncaught) on the first
     * assistant message, deep inside session.prompt(). A failure there would
     * otherwise throw mid-run and abort this subagent. Probe writability up front
     * so any create/write failure (permissions, disk full) degrades this single
     * agent to an in-memory session instead — the run continues, just without a
     * persisted transcript.
     */
    createSessionManager() {
        if (!this.persistAgentSessions)
            return SessionManager.inMemory();
        try {
            const manager = SessionManager.create(this.cwd);
            this.assertSessionDirWritable(manager.getSessionDir());
            warnPersistSecretsOnce(manager.getSessionDir());
            return manager;
        }
        catch (error) {
            console.warn(`[workflow] persistAgentSessions: could not persist this agent's session (${error instanceof Error ? error.message : String(error)}); continuing with an in-memory session`);
            return SessionManager.inMemory();
        }
    }
    /** Best-effort write probe: throws if the session directory isn't actually writable. */
    assertSessionDirWritable(dir) {
        const probePath = join(dir, `.write-probe-${randomUUID()}`);
        writeFileSync(probePath, "");
        unlinkSync(probePath);
    }
    async run(prompt, options = {}) {
        const capture = { called: false, value: undefined };
        const runCwd = options.cwd ?? this.cwd;
        const customTools = this.assembleTools(runCwd, options, capture);
        const { model: resolvedModel, thinkingLevel: resolvedThinkingLevel } = await this.resolveRunModel(options);
        const agentDir = getAgentDir();
        const compatibilityRuntime = await createLegacyFauxRuntime(this.sessionOptions.model, agentDir);
        // Persisted transcripts are grouped by the runner's project cwd (this.cwd),
        // not the per-call runCwd, so worktree-scoped agents don't scatter their
        // sessions across throwaway worktree paths.
        const sessionManager = this.createSessionManager();
        const { session } = await createAgentSession({
            cwd: runCwd,
            agentDir,
            sessionManager,
            // A real SettingsManager reads ~/.pi/settings.json, so the subagent inherits
            // the user's configured default provider/model. The in-memory variant skips
            // that file and would instead select the first available model (e.g.
            // openai-codex), which frequently lacks valid auth and returns empty output.
            settingsManager: SettingsManager.create(this.cwd, agentDir),
            customTools,
            ...(compatibilityRuntime || this.diskModelRuntime
                ? { modelRuntime: compatibilityRuntime ?? this.diskModelRuntime }
                : {}),
            ...this.sessionOptions,
            // A per-call model/thinking level takes priority over sessionOptions defaults.
            ...(resolvedModel ? { model: resolvedModel } : {}),
            ...(resolvedThinkingLevel || options.thinkingLevel
                ? { thinkingLevel: resolvedThinkingLevel ?? options.thinkingLevel }
                : {}),
        });
        // Tag the persisted session so it can be recognized in session pickers. Skipped
        // when an injected sessionManager override is in play (tests/embedders).
        if (this.persistAgentSessions && !this.sessionOptions.sessionManager && options.sessionName) {
            try {
                sessionManager.appendSessionInfo(options.sessionName);
            }
            catch {
                // Session naming is cosmetic; a failure must never abort the run.
            }
        }
        let detachAbort;
        let detachHistory;
        let lastHistoryAt = 0;
        const flushHistory = () => options.onHistory?.(compactAgentHistory(session.messages));
        const throttledHistory = () => {
            if (!options.onHistory)
                return;
            const now = Date.now();
            if (now - lastHistoryAt < 250)
                return;
            lastHistoryAt = now;
            flushHistory();
        };
        try {
            if (options.signal?.aborted)
                throw new Error("Subagent was aborted");
            if (options.signal) {
                const onAbort = () => void session.abort();
                options.signal.addEventListener("abort", onAbort, { once: true });
                detachAbort = () => options.signal?.removeEventListener("abort", onAbort);
            }
            if (options.onHistory) {
                detachHistory = session.subscribe(() => throttledHistory());
            }
            await session.prompt(this.buildPrompt(prompt, options, Boolean(options.schema)));
            if (options.signal?.aborted)
                throw new Error("Subagent was aborted");
            // The SDK does not throw provider usage/quota/rate-limit failures; it records
            // them on the terminal assistant message. Check for that first — ahead of the
            // schema and empty-text branches — so it becomes a recoverable checkpoint
            // instead of a SCHEMA_NONCOMPLIANCE error or a silently-null empty output.
            throwIfProviderLimit(session.messages, options.label);
            if (options.schema) {
                return (await resolveStructuredOutput(session, capture, options.schema, options, (messages) => this.lastAssistantText(messages)));
            }
            const text = this.lastAssistantText(session.messages);
            if (!text.trim()) {
                throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
                    recoverable: true,
                    agentLabel: options.label,
                });
            }
            return text;
        }
        finally {
            detachAbort?.();
            detachHistory?.();
            try {
                flushHistory();
            }
            catch {
                // A final history emission is diagnostic only and must not hide the outcome.
            }
            if (options.onUsage) {
                try {
                    // Usage must be read before dispose() tears down the session state.
                    const usage = usageFromStats(session.getSessionStats());
                    if (usage)
                        options.onUsage(usage);
                }
                catch {
                    // Usage reporting is best-effort; a stats failure must not hide the outcome.
                }
            }
            session.dispose();
        }
    }
    /**
     * Build the tool set for one run. A per-call cwd gets freshly-constructed coding
     * tools because tools bind their working directory at construction. The agentType
     * allowlist/denylist is applied first; the always-available system tools and the
     * schema's structured_output tool are layered on afterwards so a restrictive
     * policy can never remove them.
     */
    assembleTools(runCwd, options, capture) {
        const base = runCwd === this.cwd ? this.baseTools : createCodingTools(runCwd);
        const tools = applyToolPolicy([...base, ...(options.tools ?? [])], options.toolNames, options.disallowedToolNames);
        if (options.systemTools?.length) {
            tools.push(...options.systemTools);
        }
        if (options.schema) {
            tools.push(createStructuredOutputTool({ schema: options.schema, capture }));
        }
        return tools;
    }
    /**
     * Choose the concrete model (and thinking level) for one run. Precedence is
     * explicit model > tier > default tier, which composes with workflow.ts phase
     * routing since that only sets options.model on a phase match. Specs are parsed
     * Pi-CLI style, honoring an optional :thinking suffix (e.g. gpt-5.5:xhigh); an
     * unresolvable spec logs a warning and leaves the session default in place.
     */
    async resolveRunModel(options) {
        let registry = this.getRegistry(options.modelRegistry);
        const spec = resolveAgentModelSpec(options, this.mainModel, loadModelTierConfig, () => warnTierUnconfiguredOnce(this.mainModel, registry));
        if (!spec)
            return {};
        if (registry === EMPTY_MODEL_REGISTRY)
            registry = await this.getDiskRegistry();
        const resolved = resolveModelSpecWithThinking(spec, registry);
        if (resolved.warning)
            console.warn(`[workflow] ${resolved.warning}`);
        if (!resolved.model) {
            console.warn(`[workflow] model "${spec}" not found; using session default`);
            options.onModelFallback?.(spec);
            return {};
        }
        options.onModelResolved?.(resolved.resolvedSpec ?? canonicalModelSpec(resolved.model));
        return { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
    }
    buildPrompt(prompt, options, structured) {
        const segments = [];
        const append = (segment) => {
            if (segment)
                segments.push(segment);
        };
        append(this.instructions);
        append(options.instructions);
        if (options.label)
            append(`Task label: ${options.label}`);
        append(prompt);
        if (structured)
            append(WorkflowAgent.STRUCTURED_OUTPUT_CONTRACT);
        return segments.join("\n\n");
    }
    lastAssistantText(messages) {
        for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index];
            if (message?.role !== "assistant" || !Array.isArray(message.content))
                continue;
            const combined = message.content.reduce((acc, part) => (part.type === "text" ? acc + part.text : acc), "");
            if (combined.trim())
                return combined;
        }
        return "";
    }
}
