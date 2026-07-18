/**
 * Workflow manager for background execution, pause/resume, and run management.
 */
import { EventEmitter } from "node:events";
import { preview } from "./display.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { createRunPersistence, generateRunId, } from "./run-persistence.js";
import { parseWorkflowScript, runWorkflow } from "./workflow.js";
export class WorkflowManager extends EventEmitter {
    runs = new Map();
    persistence;
    cwd;
    concurrency;
    loadSavedWorkflow;
    agent;
    /** The session's main model (provider/id), for auto-tiering explore agents. */
    mainModel;
    /** The host Pi session's model registry, shared with subagents. */
    modelRegistry;
    /** The current pi session id; runs are stamped with it and listRuns() filters by it. */
    sessionId;
    defaultAgentTimeoutMs;
    defaultAgentRetries;
    persistAgentSessions;
    constructor(options = {}) {
        super();
        this.cwd = options.cwd ?? process.cwd();
        this.concurrency = options.concurrency ?? 8;
        this.loadSavedWorkflow = options.loadSavedWorkflow;
        this.agent = options.agent;
        this.mainModel = options.mainModel;
        this.modelRegistry = options.modelRegistry;
        this.sessionId = options.sessionId;
        this.defaultAgentTimeoutMs = options.defaultAgentTimeoutMs ?? null;
        this.defaultAgentRetries = options.defaultAgentRetries ?? 0;
        this.persistAgentSessions = options.persistAgentSessions ?? false;
        this.persistence = createRunPersistence(this.cwd);
        this.recoverStaleRuns();
    }
    /** Bind the manager to the current pi session, so new runs are tagged with it and
     * the navigator/task-panel show only this session's runs (set on session_start). */
    setSessionId(id) {
        this.sessionId = id;
    }
    /**
     * On startup, any persisted run still marked "running" belongs to a process
     * that died mid-run (this fresh manager has it nowhere in memory). Reconcile it
     * to "paused" — never "failed" — so its journal is preserved and resume() can
     * replay the completed prefix and finish the rest.
     */
    recoverStaleRuns() {
        try {
            for (const p of this.listAllRuns()) {
                if (p.status === "running" && !this.runs.has(p.runId)) {
                    const lease = this.persistence.acquireRunLease(p.runId);
                    if (!lease)
                        continue;
                    try {
                        this.persistence.save({ ...p, status: "paused" });
                    }
                    finally {
                        this.persistence.releaseRunLease(lease);
                    }
                }
            }
        }
        catch {
            // Recovery is best-effort; never let it block manager construction.
        }
    }
    /** Set the session's main model (provider/id). Used to auto-tier explore agents. */
    setMainModel(spec) {
        this.mainModel = spec;
    }
    /** Set the host session's model registry so subagents resolve models consistently. */
    setModelRegistry(registry) {
        this.modelRegistry = registry;
    }
    /**
     * Expose the host session's model registry to integrations sharing this
     * manager. Workflow execution reads the same registry internally.
     */
    getModelRegistry() {
        return this.modelRegistry;
    }
    /**
     * Start a workflow in the background.
     * Returns immediately with a run ID; the workflow executes asynchronously.
     */
    startInBackground(script, args, exec = {}) {
        const parsed = parseWorkflowScript(script);
        const slug = parsed.meta.name
            ? parsed.meta.name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 40) || "workflow"
            : "";
        const runId = slug ? `${slug}-${generateRunId()}` : generateRunId();
        const controller = new AbortController();
        const lease = this.persistence.acquireRunLease(runId);
        if (!lease)
            throw new Error(`Could not acquire workflow run lease for ${runId}`);
        const managed = {
            runId,
            status: "running",
            snapshot: {
                name: parsed.meta.name,
                description: parsed.meta.description,
                phases: parsed.meta.phases?.map((p) => p.title) ?? [],
                logs: [],
                agents: [],
                agentCount: 0,
                runningCount: 0,
                doneCount: 0,
                errorCount: 0,
            },
            controller,
            startedAt: new Date(),
            script,
            args,
            journal: [],
            background: true,
            lease,
            autoResume: exec.autoResume,
            hostContext: exec.hostContext,
        };
        this.runs.set(runId, managed);
        try {
            // Persist initial state
            this.persistence.save({
                runId,
                workflowName: parsed.meta.name,
                script,
                args,
                sessionId: this.sessionId,
                status: "running",
                phases: managed.snapshot.phases,
                agents: [],
                logs: [],
                startedAt: managed.startedAt.toISOString(),
                updatedAt: managed.startedAt.toISOString(),
                autoResume: managed.autoResume,
            });
        }
        catch (err) {
            this.releaseRunLease(managed);
            this.runs.delete(runId);
            throw err;
        }
        // Run workflow asynchronously.
        // Attach a side-channel catch to prevent Node.js unhandled-rejection crashes
        // when a workflow is aborted/paused/stopped — executeRun()'s catch block
        // already records status/event/persist, but the promise still rejects.
        // The original promise is returned so callers can await it in try/catch.
        const promise = this.executeRun(managed, script, args, exec);
        promise.catch(() => { });
        return { runId, promise };
    }
    /**
     * Execute a workflow synchronously (blocking) while still tracking it like a
     * background run, so the `/workflows` navigator and the live task panel see it.
     * `onProgress` fires on every progress event with the current snapshot, letting
     * a caller (e.g. the workflow tool) drive its own inline display.
     */
    async runSync(script, args, exec = {}) {
        const managed = this.createManaged(script, args);
        const lease = this.persistence.acquireRunLease(managed.runId);
        if (!lease)
            throw new Error(`Could not acquire workflow run lease for ${managed.runId}`);
        managed.lease = lease;
        managed.autoResume = exec.autoResume;
        managed.hostContext = exec.hostContext;
        this.runs.set(managed.runId, managed);
        // Persist the initial state immediately so listRuns()/the task panel can see
        // the run the moment it starts, not only after the first agent journals.
        this.persistRun(managed);
        return this.executeRun(managed, script, args, exec);
    }
    /** Build a fresh managed run with an empty snapshot. */
    createManaged(script, args) {
        const parsed = parseWorkflowScript(script);
        const slug = parsed.meta.name
            ? parsed.meta.name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 40) || "workflow"
            : "";
        const runId = slug ? `${slug}-${generateRunId()}` : generateRunId();
        return {
            runId,
            status: "running",
            snapshot: {
                name: parsed.meta.name,
                description: parsed.meta.description,
                phases: parsed.meta.phases?.map((p) => p.title) ?? [],
                logs: [],
                agents: [],
                agentCount: 0,
                runningCount: 0,
                doneCount: 0,
                errorCount: 0,
            },
            controller: new AbortController(),
            startedAt: new Date(),
            script,
            args,
            journal: [],
            background: false,
        };
    }
    async executeRun(managed, script, args, exec = {}) {
        const { resumeJournal, maxAgents, agentTimeoutMs, externalSignal, onProgress, tokenBudget, concurrency, agentRetries, confirm, hostContext: requestedHostContext, } = exec;
        const hostContext = requestedHostContext ?? managed.hostContext;
        managed.hostContext = hostContext;
        const resolvedAgentTimeoutMs = agentTimeoutMs !== undefined ? agentTimeoutMs : this.defaultAgentTimeoutMs;
        const resolvedConcurrency = concurrency ?? this.concurrency;
        const resolvedAgentRetries = agentRetries ?? this.defaultAgentRetries;
        const progress = () => onProgress?.(managed.snapshot);
        // Let a host abort (e.g. Esc during a blocking tool call) cancel this run.
        if (externalSignal) {
            if (externalSignal.aborted)
                managed.controller.abort();
            else
                externalSignal.addEventListener("abort", () => managed.controller.abort(), { once: true });
        }
        try {
            const result = await runWorkflow(script, {
                cwd: this.cwd,
                args,
                hostContext,
                // Use the managed run's persisted id as the workflow runId so the value
                // returned in result.runId matches the id that listRuns()/resume() use.
                // Otherwise runWorkflow mints an ephemeral `run-<ts>` id and the sync
                // path would surface a non-resumable id to the model.
                runId: managed.runId,
                agent: this.agent,
                mainModel: this.mainModel,
                modelRegistry: this.modelRegistry,
                persistAgentSessions: this.persistAgentSessions,
                signal: managed.controller.signal,
                concurrency: resolvedConcurrency,
                agentRetries: resolvedAgentRetries,
                maxAgents,
                agentTimeoutMs: resolvedAgentTimeoutMs,
                tokenBudget,
                confirm,
                loadSavedWorkflow: this.loadSavedWorkflow,
                resumeJournal,
                resumeFromRunId: resumeJournal ? managed.runId : undefined,
                onAgentJournal: (entry) => {
                    // Append (crash-safe-ish): keep the latest entry per index, then persist.
                    managed.journal = managed.journal.filter((e) => e.index !== entry.index);
                    managed.journal.push(entry);
                    this.persistRun(managed);
                },
                onLog: (message) => {
                    managed.snapshot.logs.push(message);
                    this.emit("log", { runId: managed.runId, message });
                    progress();
                },
                onPhase: (title) => {
                    managed.snapshot.currentPhase = title;
                    if (!managed.snapshot.phases.includes(title)) {
                        managed.snapshot.phases.push(title);
                    }
                    this.emit("phase", { runId: managed.runId, title });
                    progress();
                },
                onAgentStart: (event) => {
                    const at = Date.now();
                    managed.snapshot.agents.push({
                        id: managed.snapshot.agents.length + 1,
                        label: event.label,
                        phase: event.phase,
                        prompt: event.prompt,
                        status: "running",
                        model: event.model,
                        // Liveness stamps: startedAt drives run elapsed; lastEventAt drives the
                        // per-agent stall flag and is bumped on each observed agent event below.
                        startedAt: at,
                        lastEventAt: at,
                    });
                    this.emit("agentStart", { runId: managed.runId, ...event });
                    progress();
                },
                onAgentEnd: (event) => {
                    const agent = [...managed.snapshot.agents]
                        .reverse()
                        .find((a) => a.label === event.label && a.status === "running");
                    if (agent) {
                        agent.status = event.result === null ? "error" : "done";
                        agent.resultPreview = preview(event.result);
                        agent.error = event.error;
                        agent.errorCode = event.errorCode;
                        agent.recoverable = event.recoverable;
                        agent.tokens = event.tokens;
                        agent.lastEventAt = Date.now();
                        if (event.tokenUsage)
                            agent.tokenUsage = event.tokenUsage;
                        if (event.model)
                            agent.model = event.model;
                    }
                    this.emit("agentEnd", { runId: managed.runId, ...event });
                    progress();
                },
                onAgentHistory: (event) => {
                    const agent = [...managed.snapshot.agents]
                        .reverse()
                        .find((a) => a.label === event.label && a.status === "running");
                    if (agent) {
                        agent.history = event.history;
                        // A streamed history entry is the freshest proof the agent is alive —
                        // the strongest signal that resets the stall clock mid-agent.
                        agent.lastEventAt = Date.now();
                    }
                    this.emit("agentHistory", { runId: managed.runId, ...event });
                    progress();
                },
                onTokenUsage: (usage) => {
                    managed.snapshot.tokenUsage = usage;
                    this.emit("tokenUsage", { runId: managed.runId, usage });
                    progress();
                },
                onCheckpointAuto: () => {
                    managed.snapshot.autoCheckpointCount = (managed.snapshot.autoCheckpointCount ?? 0) + 1;
                    progress();
                },
            });
            managed.status = "completed";
            managed.result = result;
            this.emit("complete", { runId: managed.runId, result });
            // Persist final state
            this.persistRun(managed);
            this.releaseRunLease(managed);
            return result;
        }
        catch (error) {
            const workflowError = error instanceof WorkflowError
                ? error
                : new WorkflowError(error instanceof Error ? error.message : String(error), WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
            const usageLimitPaused = !managed.controller.signal.aborted && workflowError.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;
            if (managed.controller.signal.aborted) {
                // Intentional abort (pause/stop/Esc) — preserve status set by pause()/stop()
                if (managed.status === "running") {
                    managed.status = "aborted";
                }
            }
            else if (usageLimitPaused) {
                // Provider quota/usage limit: NOT a failure. Checkpoint the run as paused so
                // the persisted journal (completed agent results) is replayed by resume()
                // once the budget refills — instead of the user starting from scratch.
                managed.status = "paused";
            }
            else {
                managed.status = "failed";
            }
            managed.error = workflowError;
            if (usageLimitPaused) {
                this.emit("paused", {
                    runId: managed.runId,
                    reason: "usage_limit",
                    error: workflowError,
                    resetHint: workflowError.resetHint,
                });
            }
            else {
                this.emit("error", { runId: managed.runId, error: workflowError });
            }
            // Persist final state
            this.persistRun(managed);
            this.releaseRunLease(managed);
            throw workflowError;
        }
    }
    releaseRunLease(managed) {
        if (!managed.lease)
            return;
        this.persistence.releaseRunLease(managed.lease);
        managed.lease = undefined;
    }
    persistRun(managed) {
        try {
            this.persistence.save({
                runId: managed.runId,
                workflowName: managed.snapshot.name,
                // Persist the real script + journal so the run can be resumed. Runs live
                // in workflow run storage — protect via directory permissions, not blanking.
                script: managed.script,
                args: managed.args,
                sessionId: this.sessionId,
                journal: managed.journal,
                status: managed.status,
                // Persisted every write (not just at pause) so a stale read during the
                // "paused" event race (see UsageLimitScheduler) is still correct — this
                // is fixed at run-start and doesn't change over the run's lifetime.
                autoResume: managed.autoResume,
                // Why a usage-limit pause happened, so the navigator / a future cold start
                // can show it and (eventually) re-arm resume after the budget refills.
                pauseReason: managed.status === "paused" && managed.error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT
                    ? "usage_limit"
                    : undefined,
                resetHint: managed.status === "paused" && managed.error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT
                    ? managed.error.resetHint
                    : undefined,
                phases: managed.snapshot.phases,
                currentPhase: managed.snapshot.currentPhase,
                agents: managed.snapshot.agents.map((a) => ({
                    ...a,
                    startedAt: managed.startedAt.toISOString(),
                    endedAt: new Date().toISOString(),
                })),
                logs: managed.snapshot.logs,
                result: managed.result?.result,
                tokenUsage: managed.snapshot.tokenUsage
                    ? {
                        input: managed.snapshot.tokenUsage.input,
                        output: managed.snapshot.tokenUsage.output,
                        total: managed.snapshot.tokenUsage.total,
                        cost: managed.snapshot.tokenUsage.cost,
                        cacheRead: managed.snapshot.tokenUsage.cacheRead,
                        cacheWrite: managed.snapshot.tokenUsage.cacheWrite,
                    }
                    : undefined,
                startedAt: managed.startedAt.toISOString(),
                updatedAt: new Date().toISOString(),
                completedAt: managed.status === "completed" ? new Date().toISOString() : undefined,
                durationMs: managed.result?.durationMs,
            });
        }
        catch (err) {
            // Persistence is best-effort: the run is still healthy in memory.
            // Log so an operator debugging state-loss has a lead, but never crash
            // the workflow over a disk-full situation.
            console.warn("[workflow-manager] Persist run failed:", err);
        }
    }
    /**
     * Pause a running workflow.
     */
    pause(runId) {
        const managed = this.runs.get(runId);
        if (managed?.status !== "running")
            return false;
        managed.controller.abort();
        managed.status = "paused";
        this.emit("paused", { runId });
        this.persistRun(managed);
        this.releaseRunLease(managed);
        return true;
    }
    /**
     * Resume an interrupted run: replay journaled results for the unchanged prefix
     * and run the rest live. Returns false if there is nothing resumable.
     *
     * `opts.script` lets the orchestrating model resume with an EDITED script
     * (cached-prefix reuse / iteration): unchanged agent() calls whose content
     * hash still matches the journal entry at their positional callIndex replay
     * from cache, while the first changed or newly inserted call — and everything
     * after it — re-runs live. When `opts.script` is omitted, resume behaves
     * exactly as before and uses the persisted script (auto-resume, TUI resume);
     * this keeps the existing single-arg `resume(runId)` callers (e.g. the
     * UsageLimitScheduler) unchanged. `opts.args` overrides the persisted args
     * only when provided; otherwise the persisted args are kept.
     */
    async resume(runId, opts) {
        // Guard: refuse to resume a run that is already running, or one that was
        // intentionally aborted (pause/stop/Esc). Paused and failed runs can restart.
        const active = this.runs.get(runId);
        if (active?.status === "running")
            return false;
        if (active?.status === "aborted")
            return false;
        const persisted = this.persistence.load(runId);
        if (!persisted?.script || persisted.status === "completed" || persisted.status === "aborted")
            return false;
        const lease = this.persistence.acquireRunLease(runId);
        if (!lease)
            return false;
        // Use the edited script when supplied, else the persisted one (backward-compat).
        const script = opts?.script ?? persisted.script;
        const args = opts?.args !== undefined ? opts.args : persisted.args;
        const controller = new AbortController();
        const managed = {
            runId,
            status: "running",
            snapshot: {
                name: persisted.workflowName,
                phases: persisted.phases ?? [],
                logs: persisted.logs ?? [],
                agents: [],
                agentCount: 0,
                runningCount: 0,
                doneCount: 0,
                errorCount: 0,
            },
            controller,
            startedAt: new Date(),
            // The (possibly edited) script + args become the run's own — persistRun()
            // writes them below, so a later resume of this run sees the edited script.
            script,
            args,
            journal: persisted.journal ?? [],
            background: true,
            lease,
            // Carry the original opt-out forward across resumes; it's fixed at
            // run-start and persistRun() re-persists it on every subsequent write.
            autoResume: persisted.autoResume,
            hostContext: opts?.hostContext ?? active?.hostContext,
        };
        this.runs.set(runId, managed);
        // Persist before notifying renderers: listRuns() is their source of truth for
        // lifecycle status, while getRun() supplies the live in-memory snapshot.
        this.persistRun(managed);
        const resumeJournal = new Map((persisted.journal ?? []).map((e) => [e.index, e]));
        this.emit("resumed", { runId });
        // Run in the background; executeRun records status/errors on the managed run.
        void this.executeRun(managed, script, args, { resumeJournal, hostContext: managed.hostContext }).catch(() => { });
        return true;
    }
    /**
     * Stop a running workflow.
     */
    stop(runId) {
        const managed = this.runs.get(runId);
        if (!managed || (managed.status !== "running" && managed.status !== "paused"))
            return false;
        managed.controller.abort();
        managed.status = "aborted";
        this.emit("stopped", { runId });
        this.persistRun(managed);
        this.releaseRunLease(managed);
        return true;
    }
    /**
     * Get status of a specific run.
     */
    getRun(runId) {
        return this.runs.get(runId);
    }
    /**
     * List all runs (active + persisted).
     */
    /**
     * Runs for the navigator/task panel. Once bound to a session (setSessionId), only
     * that session's runs are returned — runs from other sessions stay on disk and
     * reappear when you switch back. Unbound (tests/legacy) returns everything.
     */
    listRuns() {
        const all = this.persistence.list();
        return this.sessionId ? all.filter((r) => r.sessionId === this.sessionId) : all;
    }
    /** All persisted runs regardless of session (used by cross-session recovery). */
    listAllRuns() {
        return this.persistence.list();
    }
    /**
     * Get snapshot of a run.
     */
    getSnapshot(runId) {
        return this.runs.get(runId)?.snapshot ?? null;
    }
    /**
     * Delete a persisted run.
     */
    deleteRun(runId) {
        const managed = this.runs.get(runId);
        if (managed)
            this.releaseRunLease(managed);
        this.runs.delete(runId);
        return this.persistence.delete(runId);
    }
    /**
     * Get the persistence layer (for saving workflows).
     */
    getPersistence() {
        return this.persistence;
    }
}
