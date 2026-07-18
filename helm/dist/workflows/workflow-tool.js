import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { listAgentTypes, loadAgentRegistry } from "./agent-registry.js";
import { resolveClaudeWorkflowInvocationSource } from "./claude-workflow-contract.js";
import { createToolUpdateWorkflowDisplay, createWorkflowSnapshot, fmtCost, fmtFull, fmtTokenSegment, recomputeWorkflowSnapshot, renderWorkflowText, tokenFigures, } from "./display.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { parseWorkflowScript } from "./workflow.js";
import { WorkflowManager } from "./workflow-manager.js";
import { createWorkflowStorage } from "./workflow-saved.js";
import { loadWorkflowSettings } from "./workflow-settings.js";
/**
 * Model routing guideline for workflow authors.
 * Tells the LLM about opts.tier (small/medium/big) for runtime-enforced
 * model selection, and opts.model for an exact provider/id override.
 *
 * This string is injected into the workflow tool's promptGuidelines and
 * therefore appears in the LLM's system prompt for every workflow execution.
 */
export function modelRoutingGuideline() {
    return [
        "For workflow, the user configures per-tier models (/workflows-models), so TAG EVERY agent with opts.tier by role so those models are actually used.",
        "opts.tier accepts 'small', 'medium', or 'big' and is enforced at runtime.",
        "Small tier: lightweight exploration/search/inventory agents.",
        "Medium tier: balanced analysis agents.",
        "Big tier: synthesis/judgment/decision agents spanning the full context.",
        "An agent with no opts.tier and no opts.model falls back to the user's medium tier; do not rely on that — tag agents explicitly so small/big are used where they fit.",
        "Use opts.model only when the user names a specific model; pass that exact provider/id. opts.model always takes precedence over opts.tier.",
        "Exact model specs may include Pi CLI-style thinking suffixes such as openai-codex/gpt-5.5:xhigh or anthropic/claude-fable-5:max when the user requests a specific effort level.",
    ].join(" ");
}
/**
 * Tells the LLM which named subagent definitions (agentType) are available, so
 * it can route an agent() to a reusable role that binds tools+model+prompt.
 * Returns undefined when no definitions are registered (nothing to advertise).
 */
export function agentTypeGuideline(cwd = process.cwd()) {
    let types;
    try {
        types = listAgentTypes(loadAgentRegistry(cwd));
    }
    catch {
        return undefined;
    }
    if (!types.length)
        return undefined;
    const list = types.map((t) => (t.description ? `${t.name} (${t.description})` : t.name)).join(", ");
    return `For workflow, opts.agentType routes an agent to a named definition that binds its tools, model, and role prompt. Available agentTypes: ${list}. An explicit opts.model still overrides the definition's model.`;
}
const workflowToolSchema = Type.Object({
    script: Type.Optional(Type.String({
        description: "Inline JavaScript workflow. Used when scriptPath is absent and takes precedence over name.",
    })),
    scriptPath: Type.Optional(Type.String({ description: "Path to a JavaScript workflow file. Takes precedence over script and name." })),
    name: Type.Optional(Type.String({ description: "Saved workflow name, used when scriptPath and script are absent." })),
    args: Type.Optional(Type.Any({ description: "Optional JSON value exposed to the workflow script as global `args`." })),
    background: Type.Optional(Type.Boolean({
        description: "Run the workflow in the background. Default: true — the tool returns immediately with a run ID, the turn ends so the user isn't blocked, and the result is delivered back into the conversation when it finishes. Set to false only when you need the result inline in this same turn (the call will block until the workflow completes).",
    })),
    maxAgents: Type.Optional(Type.Number({
        description: "Maximum number of agents allowed in this run. Default: 1000.",
    })),
    concurrency: Type.Optional(Type.Number({
        description: "Maximum concurrent agents for this run. Clamped to the runtime maximum. Use when provider/transport stability matters.",
    })),
    agentRetries: Type.Optional(Type.Number({
        description: "Retry attempts for recoverable agent failures such as timeout, connection failure, or empty assistant output. Default 0 unless configured.",
    })),
    agentTimeoutMs: Type.Optional(Type.Number({
        description: "Timeout per agent in milliseconds. Omit for no hard timeout by default. Set only when the user asks to bound time.",
    })),
    tokenBudget: Type.Optional(Type.Number({
        description: "Hard total-token budget for the whole run. Once spent reaches it, further agent() calls fail and the run stops. Omit for no limit. Set it when the user asks to cap spend.",
    })),
    resumeFromRunId: Type.Optional(Type.String({
        description: [
            "Resume a prior run (this ID) with an edited `script` instead of starting a new run.",
            "Unchanged agent() calls replay from that run's cache; the first changed/new call onward re-runs.",
            "Calls match by position: keep earlier good calls identical and in order. Always background.",
        ].join(" "),
    })),
});
export function createWorkflowTool(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const storage = options.storage ?? createWorkflowStorage(cwd);
    const runDefaults = resolveWorkflowToolDefaults(options, cwd);
    const manager = options.manager ??
        new WorkflowManager({
            cwd: options.cwd,
            concurrency: runDefaults.concurrency,
            loadSavedWorkflow: (savedName) => storage.load(savedName)?.script,
            defaultAgentTimeoutMs: runDefaults.agentTimeoutMs,
            defaultAgentRetries: runDefaults.agentRetries,
        });
    return defineTool({
        name: "workflow",
        label: "Workflow",
        description: [
            "Execute a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), and pipeline().",
            "Provide scriptPath, inline script, or a saved name. Source precedence is scriptPath, then script, then name.",
        ].join(" "),
        promptSnippet: "Run a deterministic JavaScript workflow. Required script header: export const meta = { name: 'short_snake_case', description: 'non-empty description', phases: [{ title: 'Phase' }] }.",
        // Defined as a getter because the SDK reads promptGuidelines fresh on each
        // tool-registry refresh; that lets an updated agentType registry flow
        // through agentTypeGuideline() into the advertised guidance without
        // rebuilding the tool.
        get promptGuidelines() {
            return [
                "Use workflow only when the user explicitly asks for a workflow, workflows, fan-out, or multi-agent orchestration.",
                "For workflow, provide scriptPath, inline script, or a saved name. scriptPath takes precedence over script, which takes precedence over name.",
                "For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description', phases: [{ title: 'Phase name' }] }`; meta.name and meta.description are required non-empty strings.",
                "For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), or new Date().",
                "For workflow, Claude-compatible globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), and args. Pi additions are namespaced under pi: pi.log(message), pi.budget, pi.checkpoint(), pi.workflow(), and the quality helpers. Every workflow must call agent() at least once; do not use workflow only to declare phases or return a static object.",
                "For workflow, prefer Pi's namespaced quality helpers when they fit (each is built on agent()/parallel() and returns plain data): pi.verify(item, {reviewers, threshold, lens}) for adversarial fact-checking; pi.judgePanel(attempts, {judges, rubric}) to score N candidates and return the best; pi.loopUntilDry({round, key, consecutiveEmpty}) to keep finding until rounds stop yielding new items; pi.completenessCheck(args, results) as a final 'what's missing' critic.",
                "For workflow, when meta.phases declares more than one phase, call phase('Exact Title') at the start of each phase's work (or set opts.phase on each agent) so every agent groups under the correct phase; never declare a phase you don't switch into — a declared phase with no agents shows as 0/0 and any agent you forgot to move stays in the previous phase.",
                "For workflow, do not set tokenBudget or agentTimeoutMs unless the user explicitly asks to cap spend or time; the defaults are unbounded.",
                "For workflow, to bound spend: pass tokenBudget for a hard run-wide cap; carve a per-phase ceiling with phase('Name', {budget: N}) (that phase throws at its sub-budget without touching the run total — wrap its work in try/catch so later phases proceed); use pi.retry(thunk, {attempts, until}) for bounded retry, and pi.gate(thunk, validator, {attempts}) when validator feedback should steer the next attempt. To degrade gracefully, branch on pi.budget.remaining() to skip optional rounds or choose a lighter tier.",
                "For workflow, prefer it for decomposable work: repository inspection, independent research/checks, multi-perspective review, or fan-out/fan-in synthesis. Do not use it for a single quick file read/edit or when ordinary tools are enough.",
                "For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.",
                "For workflow, pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).",
                "For workflow, every agent() call should include a unique short label option, 2-5 words, such as { label: 'repo inventory' } or { label: 'source modules' }; unique labels make live status and error reporting readable.",
                "For workflow, use low concurrency and agentRetries for unstable provider/transport fan-out runs; retries apply only to recoverable agent failures and still require explicit null handling after exhaustion.",
                "For workflow, failed agent(), parallel(), or pipeline() branches return null and log the failure unless the workflow is aborted. Check for nulls before synthesizing conclusions.",
                "For workflow, include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.",
                "For workflow, the default quality shape for fan-out work is finder -> verify -> merge: run one agent per angle or work-unit (in parallel), pass each candidate finding through verify() and drop the unconfirmed, then a single synthesis agent that de-duplicates, ranks by confidence/severity, and caps the output. If nothing survives verification, return an empty result and say so rather than padding.",
                "For workflow, give each subagent a substantive, self-contained task: do not spawn an agent just to read one file or run one command, and do not use one agent only to check on another. Prefer fewer, higher-level agents over many trivial micro-tasks.",
                "For workflow, if agent() needs machine-readable output, pass a plain JSON Schema via opts.schema; agent() will return the validated object. Use JSON Schema syntax, not TypeScript or TypeBox constructors.",
                modelRoutingGuideline(),
                agentTypeGuideline(),
                "For workflow, do not assume the parent assistant has repository code context inside subagents; include enough task context and relevant paths in each agent prompt.",
                "For workflow, runs are background by default: the tool returns immediately with a run ID, the turn ends so the user isn't blocked, and the result is delivered back into the conversation when the run finishes. Pass background: false only when you must use the result inline in this same turn (it will block).",
                "For workflow, you may call `await pi.workflow('saved-name', argsObject)` to run a saved workflow inline and use its result; nesting is one level deep only, and the global 16-concurrent / 1000-total caps hold across the nesting.",
            ].filter((entry) => Boolean(entry));
        },
        parameters: workflowToolSchema,
        prepareArguments: (args) => normalizeWorkflowToolArgs(args),
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const resolvedSource = resolveWorkflowSource(params, storage, cwd, ctx);
            let script = resolvedSource.script;
            let parsed = parseWorkflowScript(script);
            // Vet (and optionally rewrite) an untrusted launch before anything runs.
            // A denial aborts the call; a returned replacement script is re-normalized
            // and re-parsed so the rest of execute() works from the approved source.
            if (options.reviewLaunch) {
                const decision = await options.reviewLaunch({
                    script,
                    sourcePath: resolvedSource.sourcePath,
                    workflowName: parsed.meta.name,
                    ctx,
                });
                if (!decision.approved) {
                    throw new Error("APPROVAL_DENIED: workflow launch was denied");
                }
                if (decision.script !== undefined && decision.script !== script) {
                    script = normalizeWorkflowScript(decision.script);
                    parsed = parseWorkflowScript(script);
                }
            }
            const hostContext = options.createHostContext?.(ctx, signal);
            // Cached-prefix iteration. Given a prior run id we replay that run with
            // this (edited) script rather than opening a new one: byte-identical
            // agent() calls replay from the run's journal, while the first changed or
            // newly inserted call — and everything after it — runs live. A resumed run
            // is always detached/background.
            if (params.resumeFromRunId) {
                const priorRunId = params.resumeFromRunId;
                const resumed = await manager.resume(priorRunId, { script, args: params.args, hostContext });
                if (!resumed) {
                    throw new Error(resumeFailureText(manager, priorRunId));
                }
                return {
                    content: [{ type: "text", text: resumedText(parsed.meta.name, priorRunId) }],
                    details: { runId: priorRunId, background: true, resumedFrom: priorRunId },
                };
            }
            // Detached execution is the default: start the run, hand back its id, and
            // let the turn end so the user isn't blocked. The manager feeds the result
            // back into the conversation once it finishes. Only an explicit
            // background:false blocks for the result inline (handled below).
            if (params.background ?? true) {
                const { runId } = manager.startInBackground(script, params.args, {
                    maxAgents: params.maxAgents,
                    concurrency: params.concurrency,
                    agentRetries: params.agentRetries,
                    agentTimeoutMs: params.agentTimeoutMs,
                    tokenBudget: params.tokenBudget,
                    hostContext,
                });
                return {
                    content: [{ type: "text", text: backgroundStartedText(parsed.meta.name, runId) }],
                    details: { runId, background: true },
                };
            }
            // Inline blocking path. checkpoint() can only prompt a human when the run
            // owns UI; a detached run cannot, so it stays headless. Here we bridge
            // checkpoint() to ctx.ui.confirm (a yes/no gate) whenever the host exposes
            // one, and leave it undefined otherwise.
            const uiCtx = ctx;
            const uiConfirm = uiCtx?.hasUI ? uiCtx.ui?.confirm : undefined;
            const confirm = uiConfirm
                ? (promptText) => uiConfirm.call(uiCtx?.ui, "Workflow checkpoint", promptText)
                : undefined;
            // The blocking run still goes through the manager so it appears live in the
            // /workflows navigator and the task panel and lands in history; we simply
            // await its result and return it within the same turn.
            let snapshot = createWorkflowSnapshot(parsed.meta);
            const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, {
                key: "workflow",
                streamToolUpdates: true,
                maxAgents: 4,
                showResultPreviews: false,
            });
            let result;
            try {
                result = await manager.runSync(script, params.args, {
                    maxAgents: params.maxAgents,
                    concurrency: params.concurrency,
                    agentRetries: params.agentRetries,
                    agentTimeoutMs: params.agentTimeoutMs,
                    tokenBudget: params.tokenBudget,
                    confirm,
                    hostContext,
                    externalSignal: signal,
                    onProgress(live) {
                        snapshot = recomputeWorkflowSnapshot(live);
                        display.update(snapshot);
                    },
                });
            }
            catch (error) {
                const wasAborted = Boolean(signal?.aborted) ||
                    (error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED);
                if (!wasAborted)
                    throw error;
                // On abort, flip any still-running agents to skipped so the final
                // snapshot reflects reality, push it to the display, then surface a
                // clean abort error to the caller.
                for (const agent of snapshot.agents) {
                    if (agent.status === "running") {
                        agent.status = "skipped";
                        agent.error = "aborted";
                    }
                }
                snapshot = recomputeWorkflowSnapshot(snapshot);
                display.complete(snapshot);
                throw new Error("Workflow was aborted");
            }
            if (result.agentCount === 0) {
                throw new Error("workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents");
            }
            snapshot.result = result.result;
            snapshot.durationMs = result.durationMs;
            snapshot = recomputeWorkflowSnapshot(snapshot);
            display.complete(snapshot);
            // Summarize token usage, appending the provider-reported cost when present.
            const tokenSegment = fmtTokenSegment(tokenFigures(result.tokenUsage), fmtFull);
            const costSuffix = result.tokenUsage?.cost ? ` (${fmtCost(result.tokenUsage.cost)})` : "";
            const tokenInfo = tokenSegment ? `\n\nToken usage: ${tokenSegment}${costSuffix}` : "";
            const resultBlock = result.result !== undefined ? `\n\`\`\`json\n${JSON.stringify(result.result, null, 2)}\n\`\`\`` : "";
            const summaryText = `Workflow **${result.meta.name}** completed with **${result.agentCount}** agent(s).${tokenInfo}\n\n## Result${resultBlock}\n\n${reviseHint(result.runId)}`;
            return {
                content: [{ type: "text", text: summaryText }],
                details: {
                    ...snapshot,
                    meta: result.meta,
                    phases: result.phases,
                    logs: result.logs,
                    result: result.result,
                    durationMs: result.durationMs,
                    tokenUsage: result.tokenUsage,
                    runId: result.runId,
                },
            };
        },
        renderCall(_args, theme) {
            return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
        },
        renderResult(result, { isPartial }, theme) {
            const snapshot = result.details;
            if (snapshot?.name) {
                return new Text(renderWorkflowText(snapshot, !isPartial), 0, 0);
            }
            // No snapshot to render: fall back to the LLM-facing text. That text keeps
            // its markdown, but the TUI's Text component prints literally, so strip the
            // markers (bold **, fenced code, leading ##) before displaying it.
            const first = result.content?.[0];
            const raw = first?.type === "text" ? first.text : theme.fg("muted", "workflow");
            const stripped = raw
                .replace(/\*\*/g, "")
                .replace(/```[a-z]*\n/g, "")
                .replace(/```/g, "")
                .replace(/^##+\s*/gm, "")
                .trim();
            return new Text(stripped || theme.fg("muted", "workflow"), 0, 0);
        },
    });
}
function resolveWorkflowToolDefaults(options, cwd) {
    const settings = loadWorkflowSettings({ cwd });
    return {
        agentTimeoutMs: options.defaultAgentTimeoutMs !== undefined
            ? options.defaultAgentTimeoutMs
            : (settings.defaultAgentTimeoutMs ?? null),
        concurrency: options.defaultConcurrency ?? options.concurrency ?? settings.defaultConcurrency,
        agentRetries: options.defaultAgentRetries ?? settings.defaultAgentRetries ?? 0,
    };
}
/**
 * The tool result returned when a workflow starts in the background. It both
 * informs the model and tells it to reassure the user: the run continues on its
 * own and the conversation will resume automatically when it finishes, so the
 * user can just wait here (or go do something else).
 */
export function backgroundStartedText(name, runId) {
    return [
        `Workflow "${name}" started in the background.`,
        `Run ID: ${runId}`,
        "It keeps running on its own. When it finishes, the result is delivered back",
        "here and the conversation continues automatically — the user does not need to",
        "do anything. Tell the user they can simply wait here for it to finish (it will",
        "resume the conversation by itself), or keep chatting / working on other things",
        "in the meantime; either way the result will come back to this conversation.",
        `They can also track or cancel it with /workflows status ${runId} or /workflows stop ${runId}.`,
        reviseHint(runId),
    ].join("\n");
}
/**
 * One-line hint telling the model it can iterate on a finished/running run by
 * resuming it with an edited script instead of re-running the whole workflow.
 * Unchanged agent() calls replay from the journal (cache); only edited/new ones
 * re-run. Omitted when there is no runId to reference.
 */
export function reviseHint(runId) {
    if (!runId)
        return "";
    return `To revise without re-running everything: re-call workflow with resumeFromRunId="${runId}" and an edited script — unchanged agent() calls replay from cache, only edited/new ones re-run.`;
}
/**
 * The tool result returned when the model resumes a run with an edited script.
 * The resumed run is always background, so its result is delivered back later.
 */
export function resumedText(name, runId) {
    return [
        `Workflow "${name}" resumed from run ${runId} with your edited script.`,
        "Unchanged agent() calls replay from that run's journal (cache); the first",
        "edited or newly inserted agent() call — and everything after it — re-runs live.",
        "It runs in the background; the result is delivered back here when it finishes,",
        "and the conversation continues automatically. The user can wait or keep working.",
        `Track or cancel it with /workflows status ${runId} or /workflows stop ${runId}.`,
    ].join("\n");
}
/**
 * Explain why a resumeFromRunId could not be resumed, so the model gets a clear
 * tool error instead of a silent failure. Inspects live + persisted state to
 * name the concrete reason (not found / running / completed / stopped).
 */
export function resumeFailureText(manager, runId) {
    const active = manager.getRun(runId);
    if (active?.status === "running") {
        return `Cannot resume workflow run "${runId}": it is still running. Wait for it to finish (or /workflows stop ${runId}) before resuming with an edited script.`;
    }
    const persisted = manager.getPersistence().load(runId);
    if (!persisted) {
        return `Cannot resume workflow run "${runId}": no run with that ID was found. Use the runId from a prior workflow result, or omit resumeFromRunId to start a new run.`;
    }
    if (persisted.status === "completed") {
        return `Cannot resume workflow run "${runId}": it already completed. Start a new run instead (omit resumeFromRunId).`;
    }
    if (persisted.status === "aborted" || active?.status === "aborted") {
        return `Cannot resume workflow run "${runId}": it was stopped/aborted and is not resumable. Start a new run instead (omit resumeFromRunId).`;
    }
    if (!persisted.script) {
        return `Cannot resume workflow run "${runId}": it has no persisted script to resume. Start a new run instead (omit resumeFromRunId).`;
    }
    return `Cannot resume workflow run "${runId}": it is not currently resumable (it may be busy under another process). Try again shortly, or start a new run.`;
}
function normalizeWorkflowToolArgs(args) {
    if (typeof args !== "object" || args === null) {
        throw new Error("workflow requires an object argument");
    }
    const record = args;
    const nonEmpty = (candidate) => typeof candidate === "string" && candidate.length > 0;
    if (!nonEmpty(record.scriptPath) && !nonEmpty(record.script) && !nonEmpty(record.name)) {
        throw new Error("workflow requires at least one of `scriptPath`, `script`, or `name`");
    }
    const normalized = { ...record };
    if (typeof record.script === "string") {
        normalized.script = normalizeWorkflowScript(record.script);
    }
    return normalized;
}
function resolveWorkflowSource(input, storage, cwd, ctx) {
    const source = resolveClaudeWorkflowInvocationSource(input);
    if (source === "scriptPath") {
        const trusted = ctx?.isProjectTrusted?.() ?? false;
        if (!trusted)
            throw new Error("workflow scriptPath requires a trusted project");
        const canonical = realpathSync(resolve(cwd, input.scriptPath));
        if (extname(canonical).toLowerCase() !== ".js" || !statSync(canonical).isFile()) {
            throw new Error("workflow scriptPath must reference a regular JavaScript file");
        }
        return { script: normalizeWorkflowScript(readFileSync(canonical, "utf8")), sourcePath: canonical };
    }
    if (source === "script")
        return { script: normalizeWorkflowScript(input.script) };
    const saved = storage.load(input.name);
    if (!saved)
        throw new Error(`Saved workflow not found: ${input.name}`);
    return { script: normalizeWorkflowScript(saved.script), sourcePath: saved.path };
}
/** Matches an entire string wrapped in a ``` / ```js / ```javascript fence. */
const FENCED_SCRIPT_PATTERN = /^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i;
function normalizeWorkflowScript(script) {
    const trimmed = script.trim();
    const fenced = FENCED_SCRIPT_PATTERN.exec(trimmed);
    return fenced ? fenced[1].trim() : trimmed;
}
function _isAbortError(error) {
    if (!(error instanceof Error))
        return false;
    return /\babort(?:ed)?\b/i.test(error.message);
}
