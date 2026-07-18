import { createHash } from "node:crypto";
import { parse } from "acorn";
import { WorkflowAgent } from "./agent.js";
import { agentDefinitionKey, loadAgentRegistry, resolveAgentType, } from "./agent-registry.js";
import { DEFAULT_AGENT_TIMEOUT_MS, MAX_AGENT_RETRIES, MAX_AGENTS_PER_RUN, MAX_CONCURRENCY } from "./config.js";
import { WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import { createWorkflowLogger } from "./logger.js";
import { parseModelRoutingFromMeta, resolveModelForPhase } from "./model-routing.js";
import { ProcessWorkflowAgent } from "./process-agent.js";
import { createAgentStoreTools, SharedStore } from "./shared-store.js";
import { runWorkflowSandbox } from "./workflow-sandbox.js";
import { createWorktree, removeWorktree } from "./worktree.js";
/** Fold a sandbox child's quality tally into the shared runtime (nested runs roll up). */
function mergeQuality(target, source) {
    target.verify.checks += source.verify.checks;
    target.verify.confirmed += source.verify.confirmed;
    target.verify.votes += source.verify.votes;
    target.judge.panels += source.judge.panels;
    target.judge.candidates += source.judge.candidates;
    target.judge.bestScore = Math.max(target.judge.bestScore, source.judge.bestScore);
    target.completeness.runs += source.completeness.runs;
    target.completeness.incomplete += source.completeness.incomplete;
    target.completeness.gaps += source.completeness.gaps;
}
/**
 * Globals whose values differ between two runs of the same script. Because
 * journaled resume replays past calls by position, a script must be a pure
 * function of its inputs — so wall-clock and RNG entry points are refused. This
 * is only the fast, parse-time authoring guard; the sandbox prelude is the real
 * enforcement boundary. The table is the source of truth; the matcher is built
 * from it so adding a construct never means touching a hand-written alternation.
 */
const NON_DETERMINISTIC_GLOBALS = [
    { label: "Date.now()", pattern: String.raw `\bDate\s*\.\s*now\b` },
    { label: "Math.random()", pattern: String.raw `\bMath\s*\.\s*random\b` },
    { label: "new Date()", pattern: String.raw `\bnew\s+Date\s*\(\s*\)` },
];
const nonDeterministicMatcher = new RegExp(NON_DETERMINISTIC_GLOBALS.map((g) => g.pattern).join("|"));
/** True when the script text references any banned non-deterministic global. */
function usesNonDeterministicGlobal(script) {
    return nonDeterministicMatcher.test(script);
}
export async function runWorkflow(script, options = {}) {
    const started = Date.now();
    const { meta, body } = parseWorkflowScript(script);
    // Per-phase model routing from meta.phases[].model, with meta.model as the default.
    const routingConfig = parseModelRoutingFromMeta(meta.phases, meta.model);
    const maxAgents = options.maxAgents ?? MAX_AGENTS_PER_RUN;
    const agentTimeoutMs = options.agentTimeoutMs !== undefined ? options.agentTimeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
    const runId = options.runId ?? `run-${started.toString(36)}`;
    const baseCwd = options.cwd ?? process.cwd();
    // Snapshot the agentType registry ONCE per run so two agent() calls can't
    // observe a mid-run edit (determinism); a later resume re-reads it.
    const agentRegistry = options.agentRegistry ?? loadAgentRegistry(baseCwd);
    // Initialize logger
    const logger = createWorkflowLogger({
        runId,
        cwd: options.cwd ?? process.cwd(),
        persist: options.persistLogs ?? true,
        onLog: options.onLog,
    });
    const state = {
        logs: [],
        // When the script declares meta.phases, default the current phase to the
        // first one so agents created before any explicit phase() call still group
        // under a declared phase instead of an orphan "(no phase)" bucket. An
        // explicit phase() (or agent({ phase })) overrides this.
        phases: meta.phases?.[0]?.title ? [meta.phases[0].title] : [],
        currentPhase: meta.phases?.[0]?.title,
        phaseBudgets: new Map(),
        callSeq: 0,
        firstMiss: Number.POSITIVE_INFINITY,
    };
    const agentRunner = options.agent ??
        (options.hostContext
            ? new ProcessWorkflowAgent({ hostContext: options.hostContext, runId })
            : new WorkflowAgent(options));
    const concurrency = normalizeConcurrency(options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2));
    // Global caps + budget are shared with any nested workflow() so they hold across nesting.
    const shared = options.sharedRuntime ?? {
        limiter: createLimiter(concurrency),
        agentCount: 0,
        spent: 0,
        tokenUsage: { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
        depth: 0,
        quality: {
            verify: { checks: 0, confirmed: 0, votes: 0 },
            judge: { panels: 0, candidates: 0, bestScore: 0 },
            completeness: { runs: 0, incomplete: 0, gaps: 0 },
        },
        autoCheckpoints: [],
    };
    const limiter = shared.limiter;
    // One store instance per run; nested workflow() calls inherit the parent's store
    // so all agents across nesting levels share the same key-value space.
    const store = options.sharedStore ?? new SharedStore();
    const log = (message) => {
        const text = String(message);
        state.logs.push(text);
        logger.log(text);
    };
    const phase = (title, phaseOptions) => {
        state.currentPhase = title;
        if (!state.phases.includes(title))
            state.phases.push(title);
        // Carve a soft sub-budget from the run total for work done under this phase.
        // Re-declaring re-bases from the current spent (idempotent across resume: the
        // script re-runs phase() and the ceiling is recomputed from live spent).
        if (typeof phaseOptions?.budget === "number" && phaseOptions.budget > 0) {
            state.phaseBudgets.set(title, { budget: phaseOptions.budget, startSpent: shared.spent, warned: false });
        }
        options.onPhase?.(title);
    };
    const budget = Object.freeze({
        total: options.tokenBudget ?? null,
        spent: () => shared.spent,
        remaining: () => (options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - shared.spent)),
    });
    const throwIfAborted = () => {
        if (options.signal?.aborted) {
            throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
        }
    };
    const agent = async (prompt, agentOptions = {}) => {
        throwIfAborted();
        // Check agent limit
        if (shared.agentCount >= maxAgents) {
            throw new WorkflowError(`Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`, WorkflowErrorCode.AGENT_LIMIT_EXCEEDED, { recoverable: false });
        }
        if (budget.total !== null && budget.remaining() <= 0) {
            throw new WorkflowError("workflow token budget exhausted", WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED, {
                recoverable: false,
            });
        }
        const assignedPhase = agentOptions.phase ?? state.currentPhase;
        // Per-phase soft sub-budget gate: a noisy phase can exhaust its own ceiling
        // without touching the run's overall budget. Soft (spent accrues post-agent),
        // warns once at ~80%, throws at 100%. Scripts can try/catch around a phase's
        // work so later phases still proceed.
        if (assignedPhase) {
            const pb = state.phaseBudgets.get(assignedPhase);
            if (pb) {
                const phaseSpent = shared.spent - pb.startSpent;
                if (phaseSpent >= pb.budget) {
                    throw new WorkflowError(`phase "${assignedPhase}" token sub-budget exhausted (${pb.budget})`, WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED, { recoverable: false });
                }
                if (!pb.warned && phaseSpent >= pb.budget * 0.8) {
                    pb.warned = true;
                    log(`phase "${assignedPhase}" at ${Math.round((phaseSpent / pb.budget) * 100)}% of its token sub-budget`);
                }
            }
        }
        const requestedLabel = agentOptions.label?.trim();
        // Resolve a named agentType to its bound definition (tools/model/prompt).
        const agentDef = resolveAgentType(agentOptions.agentType, agentRegistry);
        if (agentOptions.agentType && !agentDef) {
            log(`unknown agentType "${agentOptions.agentType}"; using default tools/model`);
        }
        // Model precedence: explicit agentOptions.model > agentType.model > tier > phase model.
        // The "explicit-level" model is opts.model, else the definition's model — either
        // beats tier/phase. When only a tier is set, pass undefined here so the tier (not
        // the phase model) decides inside WorkflowAgent.run().
        const explicitModel = agentOptions.model ?? agentDef?.model;
        const modelSpec = explicitModel ?? (agentOptions.tier ? undefined : resolveModelForPhase(assignedPhase, routingConfig));
        // For display in /workflows: the model this agent runs on — its explicit/phase
        // spec, else the session's main model. The real resolved id overrides this via
        // onModelResolved once the subagent session is created.
        let displayModel = modelSpec ?? options.mainModel;
        // Deterministic resume key: assigned at lexical call time, before the limiter,
        // so parallel()/pipeline() fan-out is reproducible for a fixed script.
        const callIndex = state.callSeq++;
        const callHash = hashAgentCall(prompt, modelSpec, assignedPhase, agentOptions, agentDefinitionKey(agentDef));
        // Store delta key: callIndex alone is NOT run-unique. A nested workflow()
        // call (see workflowFn below) shares this run's SharedStore instance but
        // restarts its own callSeq at 0, so a parent agent and a concurrently
        // running nested-run agent can both get callIndex 0 and collide in
        // SharedStore.agentDeltas — whichever commits last steals/overwrites the
        // other's journaled delta. Composing the run's own runId (unique per
        // top-level run AND per nested run, see `${runId}-nested${shared.depth}`
        // below) with callIndex makes the key unique across the whole store.
        const deltaKey = `${runId}:${callIndex}`;
        // Reserve the agent slot synchronously — atomic with the limit/budget gate
        // above (no await in between) — so a parallel() fan-out can't all observe the
        // same agentCount and overshoot maxAgents. (Token budget stays a soft gate:
        // spent accrues after each agent, matching Claude Code; in-flight agents may
        // push slightly past total, then further agent() calls throw.)
        shared.agentCount++;
        const label = requestedLabel || defaultAgentLabel(assignedPhase, shared.agentCount);
        // Longest-unchanged-prefix resume: replay a cached result only while the
        // prefix is still intact — this call's index is before the first changed/new
        // call. Once any call misses, it AND everything after it run live (matching
        // Claude Code's contract), so an edited upstream call never leaves stale
        // downstream results served from the journal.
        const cached = options.resumeJournal?.get(callIndex);
        const hashMatches = cached != null && cached.hash === callHash;
        const cachedEmptyOutput = hashMatches && isEmptyTextAgentResult(cached.result, agentOptions.schema);
        if (hashMatches && !cachedEmptyOutput && callIndex < state.firstMiss) {
            options.onAgentStart?.({ label, phase: assignedPhase, prompt, model: displayModel });
            options.onAgentEnd?.({ label, phase: assignedPhase, result: cached.result, tokens: 0, model: displayModel });
            // Apply this agent's write delta so live agents later in the run see a
            // consistent store. Additive apply preserves parallel-agent writes that
            // came from higher-callIndex agents finishing before this one.
            if (cached.storeDelta)
                store.applyDelta(cached.storeDelta);
            return cached.result;
        }
        // A genuine miss (no journal entry, or the hash changed) marks where the
        // unchanged prefix ends; this call and every later one then run live.
        if (!hashMatches || cachedEmptyOutput)
            state.firstMiss = Math.min(state.firstMiss, callIndex);
        return limiter(async () => {
            const timeout = agentOptions.timeoutMs !== undefined ? agentOptions.timeoutMs : agentTimeoutMs;
            const retryAttempts = normalizeAgentRetries(agentOptions.retries ?? options.agentRetries ?? 0);
            const maxAttempts = retryAttempts + 1;
            options.onAgentStart?.({ label, phase: assignedPhase, prompt, model: displayModel });
            // Optional per-agent worktree isolation (deterministic name -> stable resume keys).
            // Precedence: explicit call-site isolation > agentDef isolation.
            // Note: passing { isolation: undefined } falls through ?? to the def's value — there
            // is no sentinel to suppress a def's isolation at the call site. Remove the agentType
            // or override with a def that has no isolation field if opt-out is needed.
            let worktree;
            const resolvedIsolation = agentOptions.isolation ?? agentDef?.isolation;
            if (resolvedIsolation === "worktree") {
                worktree = await createWorktree(baseCwd, `${runId}-${callIndex}-${label}`);
                if (!worktree.isolated)
                    log(`isolation ignored for "${label}" (${worktree.reason})`);
            }
            const runCwd = worktree?.isolated ? worktree.cwd : undefined;
            // Captured from the subagent's real session usage; falls back to an
            // estimate when the provider reports no usage (total === 0). Usage is reset
            // per retry attempt so a failed attempt does not double-count the next one.
            let usage;
            const recordTokens = (result) => {
                const tokens = usage && usage.total > 0 ? usage.total : estimateTokens(result) + estimateTokens(prompt);
                if (usage) {
                    shared.tokenUsage.input += usage.input;
                    shared.tokenUsage.output += usage.output;
                    shared.tokenUsage.cost += usage.cost;
                    shared.tokenUsage.cacheRead += usage.cacheRead;
                    shared.tokenUsage.cacheWrite += usage.cacheWrite;
                }
                shared.tokenUsage.total += tokens;
                shared.spent += tokens;
                return tokens;
            };
            try {
                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    usage = undefined;
                    try {
                        throwIfAborted();
                        // Run each attempt with its own cancellation scope. A timeout aborts
                        // and fully settles the underlying agent before a retry can start.
                        const attemptSignal = createLinkedAbortController(options.signal);
                        const result = await withTimeout(agentRunner.run(prompt, {
                            label,
                            // Identifiable name for persisted sessions (persistAgentSessions).
                            sessionName: `workflow:${runId} ${label}`,
                            schema: agentOptions.schema,
                            signal: attemptSignal.signal,
                            instructions: buildAgentInstructions(assignedPhase, agentOptions, agentDef, resolvedIsolation),
                            model: modelSpec,
                            tier: agentOptions.tier,
                            thinkingLevel: agentOptions.effort,
                            modelRegistry: options.modelRegistry,
                            toolNames: agentDef?.tools,
                            disallowedToolNames: agentDef?.disallowedTools,
                            // Per-agent store tools track this agent's writes by the
                            // run-unique deltaKey so the delta can be journaled and replayed
                            // correctly on resume, even when a nested workflow() run shares
                            // this store concurrently with the parent run.
                            systemTools: createAgentStoreTools(store, deltaKey),
                            cwd: runCwd,
                            onModelResolved: (id) => {
                                displayModel = id;
                            },
                            onModelFallback: (spec) => {
                                // Make the silent degrade visible in /workflows, not just console.
                                log(`${label}: model "${spec}" unavailable — using the session default`);
                            },
                            onUsage: (u) => {
                                usage = u;
                            },
                            onHistory: (history) => {
                                options.onAgentHistory?.({ label, phase: assignedPhase, history });
                            },
                        }), timeout, label, () => attemptSignal.abort()).finally(attemptSignal.dispose);
                        throwIfAborted();
                        if (isEmptyTextAgentResult(result, agentOptions.schema)) {
                            throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
                                recoverable: true,
                                agentLabel: label,
                            });
                        }
                        const tokens = recordTokens(result);
                        options.onAgentJournal?.({
                            index: callIndex,
                            hash: callHash,
                            result,
                            storeDelta: store.commitDelta(deltaKey),
                        });
                        options.onAgentEnd?.({
                            label,
                            phase: assignedPhase,
                            result,
                            tokens,
                            tokenUsage: usage,
                            worktree: runCwd,
                            model: displayModel,
                        });
                        return result;
                    }
                    catch (error) {
                        if (options.signal?.aborted)
                            throw error;
                        const workflowError = wrapError(error, { agentLabel: label });
                        logger.error(`agent ${label} attempt ${attempt}/${maxAttempts} failed: ${workflowError.message}`);
                        const tokens = recordTokens(null);
                        if (workflowError.recoverable && attempt < maxAttempts) {
                            log(`agent "${label}" attempt ${attempt}/${maxAttempts} failed: ${workflowError.code} ${workflowError.message}; retrying`);
                            continue;
                        }
                        options.onAgentEnd?.({
                            label,
                            phase: assignedPhase,
                            result: null,
                            tokens,
                            tokenUsage: usage,
                            worktree: runCwd,
                            model: displayModel,
                            error: workflowError.message,
                            errorCode: workflowError.code,
                            recoverable: workflowError.recoverable,
                        });
                        if (workflowError.recoverable) {
                            log(`agent "${label}" exhausted ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}: ${workflowError.code} ${workflowError.message}`);
                            return null;
                        }
                        throw workflowError;
                    }
                }
                return null;
            }
            finally {
                // Always tear down the worktree, even on timeout/abort.
                if (worktree?.isolated)
                    await removeWorktree(worktree);
            }
        });
    };
    const parallel = async (thunks) => {
        throwIfAborted();
        if (!Array.isArray(thunks))
            throw new TypeError("parallel() expects an array of functions");
        if (thunks.some((thunk) => typeof thunk !== "function")) {
            throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
        }
        return Promise.all(thunks.map(async (thunk, index) => {
            try {
                return await thunk();
            }
            catch (error) {
                if (options.signal?.aborted)
                    throw error;
                const workflowError = wrapError(error);
                // Non-recoverable failures (token budget / agent limit exhausted) must
                // halt the whole run, exactly like a directly-awaited agent() — not be
                // swallowed into a null in the result array.
                if (!workflowError.recoverable)
                    throw workflowError;
                log(`parallel[${index}] failed: ${workflowError.message}`);
                return null;
            }
        }));
    };
    const _pipeline = async (items, ...stages) => {
        throwIfAborted();
        if (!Array.isArray(items))
            throw new TypeError("pipeline() expects an array as the first argument");
        if (stages.some((stage) => typeof stage !== "function")) {
            throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
        }
        return Promise.all(items.map(async (item, index) => {
            let value = item;
            for (const stage of stages) {
                try {
                    throwIfAborted();
                    value = await stage(value, item, index);
                    throwIfAborted();
                }
                catch (error) {
                    if (options.signal?.aborted)
                        throw error;
                    const workflowError = wrapError(error);
                    // Non-recoverable failures halt the whole run (see parallel()).
                    if (!workflowError.recoverable)
                        throw workflowError;
                    log(`pipeline[${index}] failed: ${workflowError.message}`);
                    return null;
                }
            }
            return value;
        }));
    };
    // Nested workflow(): run a saved workflow (or a raw script) inline, sharing this
    // run's limiter/counters/budget so the global caps hold. One level deep only.
    const workflowFn = async (nameOrScript, childArgs) => {
        throwIfAborted();
        if (shared.depth >= 1) {
            throw new WorkflowError("workflow() can nest only one level deep", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
                recoverable: false,
            });
        }
        const resolved = options.loadSavedWorkflow?.(String(nameOrScript));
        const childScript = resolved ?? String(nameOrScript);
        shared.depth++;
        try {
            const child = await runWorkflow(childScript, {
                ...options,
                args: childArgs,
                sharedRuntime: shared,
                // Propagate the parent's store so nested agents share the same key-value space.
                sharedStore: store,
                // A nested run is its own script; never reuse the parent's resume journal.
                resumeJournal: undefined,
                resumeFromRunId: undefined,
                runId: `${runId}-nested${shared.depth}`,
                persistLogs: false,
            });
            return child.result;
        }
        finally {
            shared.depth--;
        }
    };
    // ── Quality-pattern stdlib: reusable, deterministic helpers built purely on
    // agent()/parallel() (so callSeq ordering stays stable and resume keeps working).
    // Injected as globals so workflow scripts compose them directly. ──
    const VERIFY_SCHEMA = {
        type: "object",
        properties: { real: { type: "boolean" }, reason: { type: "string" } },
        required: ["real"],
    };
    const _verify = async (item, opts = {}) => {
        const reviewers = Math.max(1, opts.reviewers ?? 2);
        const threshold = opts.threshold ?? 0.5;
        const lenses = opts.lens ? (Array.isArray(opts.lens) ? opts.lens : [opts.lens]) : [];
        const claim = typeof item === "string" ? item : JSON.stringify(item);
        const votes = (await parallel(Array.from({ length: reviewers }, (_v, i) => () => agent(`Adversarially review whether the following is REAL/correct. Try to refute it; default to real=false if unsure.${lenses.length ? ` Focus lens: ${lenses[i % lenses.length]}.` : ""}\n\n${claim}`, { label: `verify ${i + 1}`, schema: VERIFY_SCHEMA })))).filter(Boolean);
        const realCount = votes.filter((v) => v?.real).length;
        const real = votes.length > 0 && realCount / votes.length >= threshold;
        shared.quality.verify.checks++;
        shared.quality.verify.votes += votes.length;
        if (real)
            shared.quality.verify.confirmed++;
        return { real, realCount, total: votes.length, votes };
    };
    const JUDGE_SCHEMA = {
        type: "object",
        properties: { score: { type: "number" }, reason: { type: "string" } },
        required: ["score"],
    };
    const _judgePanel = async (attempts, opts = {}) => {
        const judges = Math.max(1, opts.judges ?? 3);
        const rubric = opts.rubric ?? "overall quality and correctness";
        const scored = (await parallel((Array.isArray(attempts) ? attempts : []).map((att, idx) => async () => {
            const text = typeof att === "string" ? att : JSON.stringify(att);
            const js = (await parallel(Array.from({ length: judges }, (_v, j) => () => agent(`Score this candidate from 0 to 1 on: ${rubric}. Reply with the score.\n\nCandidate:\n${text}`, {
                label: `judge ${idx + 1}.${j + 1}`,
                schema: JUDGE_SCHEMA,
            })))).filter(Boolean);
            const score = js.length ? js.reduce((s, v) => s + (Number(v?.score) || 0), 0) / js.length : 0;
            return { index: idx, attempt: att, score, judgments: js };
        }))).filter(Boolean);
        // Highest mean score; stable tie-break by input index.
        let best = scored[0];
        for (const s of scored)
            if (s.score > best.score || (s.score === best.score && s.index < best.index))
                best = s;
        shared.quality.judge.panels++;
        shared.quality.judge.candidates += scored.length;
        if (best && typeof best.score === "number") {
            shared.quality.judge.bestScore = Math.max(shared.quality.judge.bestScore, best.score);
        }
        return best;
    };
    const _loopUntilDry = async (opts) => {
        if (!opts || typeof opts.round !== "function")
            throw new TypeError("loopUntilDry requires { round: (i) => items[] }");
        const key = opts.key ?? ((x) => JSON.stringify(x));
        const consecutiveEmpty = Math.max(1, opts.consecutiveEmpty ?? 2);
        const maxRounds = opts.maxRounds ?? 50;
        const seen = new Set();
        const all = [];
        let dry = 0;
        for (let r = 0; r < maxRounds && dry < consecutiveEmpty; r++) {
            let items;
            try {
                items = (await opts.round(r)) ?? [];
            }
            catch (error) {
                // Budget / agent-limit exhaustion: return the partial result, don't abort.
                const code = error?.code;
                if (code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED || code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED)
                    break;
                throw error;
            }
            const fresh = (Array.isArray(items) ? items : []).filter((x) => x != null && !seen.has(key(x)));
            if (!fresh.length) {
                dry++;
                continue;
            }
            dry = 0;
            for (const x of fresh) {
                seen.add(key(x));
                all.push(x);
            }
        }
        return all;
    };
    const COMPLETENESS_SCHEMA = {
        type: "object",
        properties: { complete: { type: "boolean" }, missing: { type: "array", items: { type: "string" } } },
        required: ["complete"],
    };
    const _completenessCheck = async (taskArgs, results) => {
        const result = (await agent(`Given the task and the results gathered so far, list what is still MISSING (modalities not covered, claims unverified, gaps). Be specific and concise.\n\nTask:\n${JSON.stringify(taskArgs)}\n\nResults so far:\n${JSON.stringify(results).slice(0, 4000)}`, { label: "completeness critic", schema: COMPLETENESS_SCHEMA }));
        shared.quality.completeness.runs++;
        if (result && result.complete === false) {
            shared.quality.completeness.incomplete++;
            shared.quality.completeness.gaps += Array.isArray(result.missing) ? result.missing.length : 0;
        }
        return result;
    };
    // Thin bounded-retry / validation-gate combinators. Sugar over the for-loop +
    // agent() pattern, but each attempt is a real agent() call so it auto-journals
    // under a stable callSeq (resume-safe). No backoff: there is no timer in the vm
    // and a delay has no resume value. NOTE: attempt N+1's call hash depends on N's
    // live result, so a retry/gate chain cache-miss-cascades on resume (correct).
    const _retry = async (thunk, opts = {}) => {
        const attempts = Math.max(1, opts.attempts ?? 3);
        let last;
        for (let i = 0; i < attempts; i++) {
            last = await thunk(i);
            if (!opts.until || opts.until(last))
                return last;
        }
        return last; // attempts exhausted — return the last result (caller inspects it)
    };
    const _gate = async (thunk, validator, opts = {}) => {
        const attempts = Math.max(1, opts.attempts ?? 3);
        let feedback;
        let last;
        for (let i = 0; i < attempts; i++) {
            last = await thunk(feedback, i);
            const verdict = await validator(last);
            if (verdict?.ok)
                return { ok: true, value: last, attempts: i + 1 };
            feedback = verdict?.feedback; // fed into the next attempt
        }
        return { ok: false, value: last, attempts };
    };
    // Deterministic, journaled, replayable human checkpoint. Spends no tokens, so it
    // is gated on the agent counter + abort (not budget). On resume the human's reply
    // replays by callIndex exactly like a cached agent() — the genuine edge over CC,
    // whose steering is in-session only. Headless (no UI threaded in): takes the
    // declared default and journals THAT, so a detached/background run never hangs.
    const checkpoint = async (promptText, checkpointOptions = {}) => {
        throwIfAborted();
        if (typeof promptText !== "string")
            throw new TypeError("checkpoint(promptText, options?) needs a prompt string");
        if (shared.agentCount >= maxAgents) {
            throw new WorkflowError(`Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`, WorkflowErrorCode.AGENT_LIMIT_EXCEEDED, { recoverable: false });
        }
        const callIndex = state.callSeq++;
        const callHash = hashCheckpoint(promptText, checkpointOptions);
        const cached = options.resumeJournal?.get(callIndex);
        if (cached != null && cached.hash === callHash && callIndex < state.firstMiss) {
            shared.agentCount++;
            // Replay the journaled reply; re-record auto-resolutions so the run's
            // auto-checkpoint tally survives resume exactly.
            if (cached.auto)
                shared.autoCheckpoints.push({ prompt: promptText, reply: cached.result });
            return cached.result;
        }
        if (cached == null || cached.hash !== callHash)
            state.firstMiss = Math.min(state.firstMiss, callIndex);
        shared.agentCount++;
        let reply;
        let autoResolved = false;
        if (options.confirm) {
            reply = await options.confirm(promptText, checkpointOptions);
        }
        else if (checkpointOptions.headless === "abort") {
            throw new WorkflowError(`checkpoint "${promptText}" needs human input but none is available (headless run)`, WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: false });
        }
        else {
            // Headless: the gate resolves to its declared default WITHOUT a human seeing
            // it. Record and surface it — a silent auto-approval must not look human-made.
            reply = checkpointOptions.default ?? true;
            autoResolved = true;
            shared.autoCheckpoints.push({ prompt: promptText, reply });
            options.onCheckpointAuto?.({ prompt: promptText, reply });
            const short = (v) => {
                const text = (typeof v === "string" ? v : JSON.stringify(v)).replace(/\s+/g, " ").trim();
                return text.length > 60 ? `${text.slice(0, 59)}…` : text;
            };
            log(`⚠ checkpoint auto-approved (no UI to ask): "${short(promptText)}" → ${short(reply)}`);
        }
        throwIfAborted();
        options.onAgentJournal?.({
            index: callIndex,
            hash: callHash,
            result: reply,
            ...(autoResolved ? { auto: true } : {}),
        });
        return reply;
    };
    try {
        const result = await runWorkflowSandbox({
            body,
            filename: `${meta.name || "workflow"}.js`,
            args: options.args,
            cwd: baseCwd,
            initialPhase: state.currentPhase,
            budgetTotal: options.tokenBudget ?? null,
            budgetSpent: shared.spent,
            signal: options.signal,
            compatibilityMode: Boolean(options.hostContext),
            onQuality: (quality) => mergeQuality(shared.quality, quality),
            handlers: {
                agent: (prompt, sandboxOptions) => agent(prompt, sandboxOptions),
                workflow: workflowFn,
                checkpoint: (promptText, sandboxOptions) => checkpoint(promptText, sandboxOptions),
                phase,
                log,
                budgetSpent: () => shared.spent,
            },
        });
        // Persist logs
        const logFile = logger.persist();
        if (logFile) {
            log(`Logs persisted to ${logFile}`);
        }
        // Emit final token usage
        options.onTokenUsage?.(shared.tokenUsage);
        return {
            meta,
            result: result,
            logs: state.logs,
            phases: state.phases,
            agentCount: shared.agentCount,
            durationMs: Date.now() - started,
            runId,
            tokenUsage: shared.tokenUsage,
            // Run-global confidence signals accumulate on the shared runtime; only the
            // top-level run reports them (a nested workflow() contributes upward).
            ...(options.sharedRuntime
                ? {}
                : {
                    quality: shared.quality,
                    ...(shared.autoCheckpoints.length > 0 ? { autoCheckpoints: shared.autoCheckpoints } : {}),
                }),
        };
    }
    finally {
        // Dispose the store only when this run created it; nested runs inherit the
        // parent's store and must not tear it down while the parent is still running.
        if (!options.sharedStore)
            store.dispose();
    }
}
/**
 * Split a workflow script into its validated `meta` header and the executable
 * body with that header removed. The header must be the very first statement so
 * the rest of the file is a plain script the sandbox can run; everything about
 * the header — that it is `export const meta = <literal>` and nothing else — is
 * checked here before a single agent runs.
 */
function rejectScript(message) {
    throw new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
}
export function parseWorkflowScript(script) {
    if (usesNonDeterministicGlobal(script)) {
        rejectScript("Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable");
    }
    const program = parse(script, {
        ecmaVersion: "latest",
        sourceType: "module",
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
        ranges: false,
    });
    const head = program.body?.[0];
    if (head?.type !== "ExportNamedDeclaration") {
        rejectScript("`export const meta = { name, description, phases }` must be the first statement in the script");
    }
    const decl = head.declaration;
    if (decl?.type !== "VariableDeclaration" || decl.kind !== "const") {
        rejectScript("meta export must be `export const meta = ...`");
    }
    const declarators = decl.declarations;
    if (declarators.length !== 1)
        rejectScript("meta export must declare only `meta`");
    const binding = declarators[0];
    const id = binding.id;
    if (id?.type !== "Identifier" || id.name !== "meta")
        rejectScript("meta export must declare `meta`");
    const init = binding.init;
    if (!init)
        rejectScript("meta must have a literal value");
    const meta = readLiteralNode(init, "meta");
    validateMeta(meta);
    return {
        meta,
        body: script.slice(0, head.start) + script.slice(head.end),
    };
}
/** Property keys that would let a crafted literal reach the prototype chain. */
const UNSAFE_META_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/**
 * Read one AST node as a JSON-style constant. Dispatch is table-driven: each
 * supported node kind maps to a reader, and anything without an entry is, by
 * definition, not a literal. Readers recurse back through this function so the
 * `path` breadcrumb (`meta.phases[0].title`) is threaded through every level for
 * precise error messages. Only the constant subset of JS is admitted — no
 * identifiers, calls, spreads, computed keys, accessors, or interpolation —
 * which is what keeps the header a static, side-effect-free value.
 */
function readLiteralNode(node, path) {
    const reader = LITERAL_READERS[node.type];
    if (!reader)
        throw new Error(`non-literal node type in ${path}: ${node.type}`);
    return reader(node, path);
}
const LITERAL_READERS = {
    Literal: (node) => node.value,
    ObjectExpression: (node, path) => {
        const record = {};
        for (const member of node.properties) {
            if (member.type === "SpreadElement")
                throw new Error(`spread not allowed in ${path}`);
            if (member.type !== "Property")
                throw new Error(`only plain properties allowed in ${path}`);
            if (member.computed)
                throw new Error(`computed keys not allowed in ${path}`);
            if (member.kind !== "init" || member.method)
                throw new Error(`methods/accessors not allowed in ${path}`);
            const key = propertyKey(member.key, path);
            if (UNSAFE_META_KEYS.has(key))
                throw new Error(`reserved key name not allowed in ${path}: ${key}`);
            record[key] = readLiteralNode(member.value, `${path}.${key}`);
        }
        return record;
    },
    ArrayExpression: (node, path) => node.elements.map((element, index) => {
        if (!element)
            throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement")
            throw new Error(`spread not allowed in ${path}`);
        return readLiteralNode(element, `${path}[${index}]`);
    }),
    TemplateLiteral: (node, path) => {
        if (node.expressions.length > 0)
            throw new Error(`template interpolation not allowed in ${path}`);
        return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("");
    },
    UnaryExpression: (node, path) => {
        const arg = node.argument;
        if (node.operator === "-" && arg?.type === "Literal" && typeof arg.value === "number")
            return -arg.value;
        throw new Error(`only negative-number unary allowed in ${path}`);
    },
};
/** Resolve a property key node to its string name (identifier or string/number literal). */
function propertyKey(node, path) {
    if (node.type === "Identifier")
        return node.name;
    if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) {
        return String(node.value);
    }
    throw new Error(`unsupported key type in ${path}: ${node.type}`);
}
/** Non-empty-string test used for both required meta fields. */
function isFilledString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
/**
 * Assert that a decoded literal satisfies the WorkflowMeta contract, narrowing
 * the caller's `unknown` on success. Enforced: `name`/`description` are non-empty
 * strings, an optional `model` is a string, and an optional `phases` is an array
 * whose every entry carries a string `title`. Unknown extra fields are tolerated
 * so scripts using retired header fields keep parsing.
 */
function validateMeta(meta) {
    if (typeof meta !== "object" || meta === null)
        throw new Error("meta must be an object");
    const fields = meta;
    if (!isFilledString(fields.name))
        throw new Error("meta.name must be a non-empty string");
    if (!isFilledString(fields.description))
        throw new Error("meta.description must be a non-empty string");
    if (fields.model !== undefined && typeof fields.model !== "string")
        throw new Error("meta.model must be a string");
    if (fields.phases !== undefined) {
        if (!Array.isArray(fields.phases))
            throw new Error("meta.phases must be an array");
        for (const entry of fields.phases) {
            const title = entry?.title;
            if (typeof title !== "string")
                throw new Error("each meta phase must have a title string");
        }
    }
}
/**
 * Build a concurrency gate that runs at most `limit` tasks at once and queues
 * the rest FIFO. Modeled as an explicit acquire/release pair: acquiring blocks
 * on a parked resolver when the pool is full, and releasing wakes exactly one
 * parked waiter (or just frees the slot when none wait), so the in-flight count
 * never exceeds the limit and ordering is preserved.
 */
function createLimiter(limit) {
    let inFlight = 0;
    const parked = [];
    const acquire = async () => {
        if (inFlight >= limit) {
            await new Promise((wake) => {
                parked.push(wake);
            });
        }
        inFlight++;
    };
    const release = () => {
        inFlight--;
        parked.shift()?.();
    };
    return async (task) => {
        await acquire();
        try {
            return await task();
        }
        finally {
            release();
        }
    };
}
function defaultAgentLabel(phase, index) {
    return phase ? `${phase} agent ${index}` : `agent ${index}`;
}
/** Stable identity hash for an agent() call — a cache miss on resume when anything changes. */
function hashCheckpoint(promptText, options) {
    const identity = JSON.stringify({
        promptText,
        kind: options.kind ?? "confirm",
        choices: options.choices ?? null,
    });
    return createHash("sha256").update(identity).digest("hex");
}
function hashAgentCall(prompt, model, phase, options, agentDefKey) {
    const identity = JSON.stringify({
        prompt,
        model: model ?? null,
        label: options.label?.trim() || null,
        tier: options.tier ?? null,
        effort: options.effort ?? null,
        phase: phase ?? null,
        isolation: options.isolation ?? null,
        agentType: options.agentType ?? null,
        // Resolved definition (tools/model/prompt) so editing an agent .md invalidates
        // this call's cached result on a later resume.
        agentDef: agentDefKey,
        schema: options.schema ?? null,
    });
    return createHash("sha256").update(identity).digest("hex");
}
function buildAgentInstructions(phase, options, def, resolvedIsolation) {
    const lines = [];
    // A resolved agentType binds a real role prompt (the definition body). Only
    // fall back to the prose hint when the agentType named no known definition.
    if (def?.prompt)
        lines.push(def.prompt);
    else if (options.agentType)
        lines.push(`Act as workflow subagent type: ${options.agentType}`);
    if (phase)
        lines.push(`Workflow phase: ${phase}`);
    // Use resolvedIsolation so the annotation fires whether isolation came from
    // the call site or from the agentDef's isolation field.
    if (resolvedIsolation)
        lines.push(`Requested isolation: ${resolvedIsolation}`);
    // Note: options.model is applied for real via the session, not injected as prose.
    return lines.length ? lines.join("\n\n") : undefined;
}
function isEmptyTextAgentResult(result, schema) {
    return schema === undefined && typeof result === "string" && result.trim().length === 0;
}
/**
 * Rough token count for a value when the provider reports no real usage: serialize
 * it and charge one token per four characters (the standard ~4-chars/token rule of
 * thumb). Nullish values serialize as an empty string so they cost a floor of one.
 */
function estimateTokens(value) {
    const serialized = JSON.stringify(value ?? "");
    return Math.ceil(serialized.length / 4);
}
function normalizeConcurrency(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1)
        return 1;
    return Math.min(MAX_CONCURRENCY, Math.floor(value));
}
function normalizeAgentRetries(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        return 0;
    return Math.min(MAX_AGENT_RETRIES, Math.floor(value));
}
/**
 * Run a promise with a timeout.
 */
async function withTimeout(promise, ms, label, onTimeout) {
    if (ms === null)
        return promise;
    let timeoutId;
    let timedOut = false;
    const timeoutError = new WorkflowError(`Agent "${label}" timed out after ${ms}ms; raise or omit timeoutMs/agentTimeoutMs to allow longer runs`, WorkflowErrorCode.AGENT_TIMEOUT, { recoverable: true });
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            timedOut = true;
            reject(timeoutError);
            onTimeout?.();
        }, ms);
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    }
    catch (error) {
        if (timedOut) {
            await promise.catch(() => undefined);
            throw timeoutError;
        }
        throw error;
    }
    finally {
        if (timeoutId)
            clearTimeout(timeoutId);
    }
}
function createLinkedAbortController(parent) {
    const controller = new AbortController();
    const abort = () => controller.abort(parent?.reason);
    if (parent?.aborted)
        abort();
    else
        parent?.addEventListener("abort", abort, { once: true });
    controller.dispose = () => parent?.removeEventListener("abort", abort);
    return controller;
}
