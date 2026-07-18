import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createRunId } from "./audit-log.js";
import { collectSurfaceIds, collectWorkspaceIds } from "./cmux-client.js";
import { checkCompatibility } from "./compatibility.js";
import { findClaudePidsForSession, isManagedClaudeProcess, isProcessAlive } from "./process.js";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StateStore } from "./state-store.js";
import { PermissionBroker } from "./permission-broker.js";
import { ClaudeSessionController } from "./session-controller.js";
export class ClaudeFleetManager {
    options;
    runs = new Map();
    controllers = new Map();
    deciders = new Map();
    windowId;
    started = false;
    startPromise;
    persistChain = Promise.resolve();
    reconcilePromise;
    reconcileAgain = false;
    broker;
    removeAckListener;
    removeLifecycleListener;
    compatibility;
    constructor(options) {
        this.options = options;
    }
    async start() {
        if (this.startPromise)
            return this.startPromise;
        this.startPromise = this.startInternal();
        return this.startPromise;
    }
    async startInternal() {
        this.compatibility = await checkCompatibility(this.options.cmux, {
            strict: this.options.config.strictCompatibility,
            env: this.options.cmux.env,
        });
        await this.options.audit.append({
            event: "orchestrator.compatibility",
            data: {
                ok: this.compatibility.ok,
                cmuxVersion: this.compatibility.cmuxVersion,
                claudeVersion: this.compatibility.claudeVersion,
                warnings: this.compatibility.warnings,
                errors: this.compatibility.errors,
            },
        });
        if (!this.compatibility.ok)
            return this.compatibility;
        const identity = await this.options.cmux.callerIdentity();
        this.windowId = identity.caller?.window_id ?? identity.focused?.window_id;
        if (!this.windowId) {
            const fallback = await this.options.cmux.identify();
            this.windowId = fallback.focused?.window_id;
        }
        if (!this.windowId) {
            this.compatibility.errors.push("Could not resolve a cmux window for new workspaces");
            this.compatibility.ok = false;
            return this.compatibility;
        }
        await this.markInstanceOwner();
        await this.sweepOrphanInstances();
        for (const run of await this.options.state.load()) {
            if (run.state !== "terminated")
                this.runs.set(run.runId, run);
        }
        this.removeAckListener = this.options.events.onAck((ack, bootChanged) => {
            if (ack.resume?.gap || bootChanged) {
                void this.options.audit.append({
                    event: "events.reconcile_required",
                    data: { bootId: ack.boot_id, bootChanged, gap: ack.resume?.gap ?? false },
                });
                setTimeout(() => void this.reconcile("event-gap"), this.options.config.recoveryGraceMs).unref();
            }
        });
        this.removeLifecycleListener = this.options.events.onEvent((event) => {
            if (event.name !== "surface.closed" && event.name !== "workspace.closed")
                return;
            const relevant = [...this.runs.values()].some((run) => !["submitting", "running", "permission-pending", "exiting"].includes(run.state) &&
                ((event.surface_id && run.surfaceId === event.surface_id) ||
                    (event.workspace_id && run.workspaceId === event.workspace_id)));
            if (relevant)
                setTimeout(() => void this.reconcile(event.name), 250).unref();
        });
        this.broker = new PermissionBroker({
            cmux: this.options.cmux,
            events: this.options.events,
            audit: this.options.audit,
            timeoutMs: this.options.config.permissionTimeoutMs,
            resolveRun: (sessionId) => this.bySessionId(sessionId),
            resolveDecider: (runId) => this.deciders.get(runId),
            onStateChange: (run) => this.changed(run),
        });
        // Subscribe before the stream starts so retained PermissionRequest replay
        // cannot race past the broker in the same stdout chunk as the initial ack.
        this.broker.start();
        await this.options.events.start();
        this.started = true;
        if (this.runs.size > 0)
            await this.reconcile("startup");
        return this.compatibility;
    }
    async runTask(input, options = {}) {
        await this.ensureReady();
        await access(input.cwd, constants.R_OK);
        if (!(await stat(input.cwd)).isDirectory())
            throw new Error(`Claude cwd is not a directory: ${input.cwd}`);
        const now = Date.now();
        const run = {
            runId: createRunId(),
            name: input.name?.trim() || "Claude task",
            cwd: input.cwd,
            state: "created",
            createdAt: now,
            updatedAt: now,
            keepOpen: input.keepOpen ?? false,
            permissionMode: input.permissionMode ?? "plan",
            lastEventSeq: this.options.events.latestSeq,
            resumeAttempts: 0,
        };
        this.runs.set(run.runId, run);
        if (options.decider)
            this.deciders.set(run.runId, options.decider);
        const controller = this.createController(run, options.trustDecider);
        await this.persist();
        try {
            await controller.launch(options.signal);
            const result = await controller.runPrompt(input.prompt, options.signal, input.timeoutMs);
            if (!run.keepOpen)
                await controller.terminate();
            return { ...result, run: { ...run } };
        }
        catch (error) {
            controller.fail(error);
            await this.options.audit.append({
                event: "run.failed",
                runId: run.runId,
                sessionId: run.sessionId,
                data: { error: message(error) },
            });
            await controller.terminate().catch(() => { });
            throw error;
        }
        finally {
            this.deciders.delete(run.runId);
            await this.persist();
        }
    }
    async runFleet(tasks, options = {}) {
        await this.ensureReady();
        const limit = Math.max(1, Math.min(options.concurrency ?? this.options.config.maxConcurrency, this.options.config.maxConcurrency));
        const results = new Array(tasks.length);
        let next = 0;
        let finished = 0;
        const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
            while (true) {
                const index = next++;
                if (index >= tasks.length)
                    return;
                const task = tasks[index];
                try {
                    results[index] = {
                        id: task.id,
                        ok: true,
                        result: await this.runTask(task, {
                            signal: options.signal,
                            decider: options.decider,
                            trustDecider: options.trustDecider,
                        }),
                    };
                }
                catch (error) {
                    results[index] = { id: task.id, ok: false, error: message(error) };
                }
                finally {
                    finished++;
                    options.onProgress?.(finished, tasks.length);
                }
            }
        });
        await Promise.all(workers);
        return results;
    }
    listRuns() {
        return [...this.runs.values()].map((run) => ({ ...run }));
    }
    async stop(runId) {
        const controller = this.controllers.get(runId);
        const run = this.runs.get(runId);
        if (!run)
            return false;
        if (controller)
            await controller.terminate();
        else {
            const restored = this.createController(run);
            await restored.terminate();
        }
        await this.persist();
        return true;
    }
    async stopAll() {
        const active = [...this.runs.values()].filter((run) => run.state !== "terminated");
        await mapLimited(active, this.options.config.maxConcurrency, async (run) => {
            await (this.controllers.get(run.runId) ?? this.createController(run)).terminate().catch(() => { });
        });
        await this.persist();
    }
    async reconcile(reason) {
        // A trigger that arrives while a pass is running would otherwise be dropped
        // (its facts — a newer gap/topology — never examined). Coalesce it: set a
        // flag and re-run one more pass after the current one, all under a single
        // in-flight promise so no two passes run concurrently.
        if (this.reconcilePromise) {
            this.reconcileAgain = true;
            return this.reconcilePromise;
        }
        this.reconcilePromise = (async () => {
            let pass = reason;
            do {
                this.reconcileAgain = false;
                await this.reconcileInternal(pass);
                pass = `${reason}+coalesced`;
            } while (this.reconcileAgain);
        })().finally(() => {
            this.reconcilePromise = undefined;
        });
        return this.reconcilePromise;
    }
    async reconcileInternal(reason) {
        if (!this.compatibility?.ok || !this.windowId)
            return;
        // Reconcile must run after every cmux restart (each one changes boot_id and
        // kills all managed Claude PIDs), but only for runs that are still live —
        // skip the topology/hook-store round-trip entirely when nothing is managed.
        const hasActiveRun = [...this.runs.values()].some((run) => !["terminated", "failed", "exiting"].includes(run.state));
        if (!hasActiveRun)
            return;
        await this.options.audit.append({ event: "reconcile.started", data: { reason } });
        const [topology, hookStore] = await Promise.all([this.options.cmux.topology(), this.options.hooks.read()]);
        const workspaceIds = collectWorkspaceIds(topology);
        const surfaceIds = collectSurfaceIds(topology);
        for (const run of this.runs.values()) {
            if (["terminated", "failed", "exiting"].includes(run.state))
                continue;
            const record = run.sessionId ? hookStore.sessions[run.sessionId] : undefined;
            const candidatePid = record?.pid ?? run.pid;
            const alive = Boolean(candidatePid && (await isManagedClaudeProcess(candidatePid, run.sessionId)));
            const surfaceExists = Boolean((record?.surfaceId ?? run.surfaceId) && surfaceIds.has((record?.surfaceId ?? run.surfaceId)));
            const workspaceExists = Boolean((record?.workspaceId ?? run.workspaceId) && workspaceIds.has((record?.workspaceId ?? run.workspaceId)));
            const controller = this.controllers.get(run.runId) ?? this.createController(run);
            if (record && alive && surfaceExists && workspaceExists) {
                controller.applyRecord(record);
                run.bootId = this.options.events.bootId;
                run.state = record.agentLifecycle === "running" ? "running" : "ready";
                this.changed(run);
                continue;
            }
            if (!run.sessionId) {
                run.error = "Session disappeared before Claude registered";
                run.state = "failed";
                this.changed(run);
                continue;
            }
            if (!this.options.config.autoRecover) {
                run.state = "recovering";
                run.error = "Recovery required; run /claude-cmux-recover";
                this.changed(run);
                continue;
            }
            if (alive && !surfaceExists) {
                run.state = "failed";
                run.error = "Claude PID is alive but its managed surface is missing; refusing duplicate resume";
                this.changed(run);
                continue;
            }
            try {
                await controller.resume();
            }
            catch (error) {
                controller.fail(error);
            }
        }
        await this.sweepDuplicateResumes();
        await this.persist();
        await this.options.audit.append({ event: "reconcile.completed", data: { reason, runs: this.runs.size } });
    }
    // cmux auto-resumes managed sessions on restart and can spawn several
    // `claude --resume <id>` instances for one session (one per restored surface).
    // The hook store keeps a single record per session (last writer wins), so every
    // twin except the bound one is a live interactive agent no run tracks — it can
    // never be terminated and its hook-record can flap the bound surface/pid. After
    // reconciliation has settled each run's pid, SIGTERM any live Claude for the
    // session that is not the bound pid.
    async sweepDuplicateResumes() {
        for (const run of this.runs.values()) {
            if (["terminated", "failed", "exiting"].includes(run.state))
                continue;
            // Only sweep once a run is bound to a definite pid — otherwise we cannot
            // tell the legitimate instance from a duplicate and must leave both alone.
            if (!run.sessionId || !run.pid)
                continue;
            const strays = (await findClaudePidsForSession(run.sessionId)).filter((pid) => pid !== run.pid);
            for (const pid of strays) {
                try {
                    process.kill(pid, "SIGTERM");
                }
                catch { }
                await this.options.audit.append({
                    event: "reconcile.duplicate_closed",
                    runId: run.runId,
                    sessionId: run.sessionId,
                    data: { strayPid: pid, boundPid: run.pid },
                });
            }
        }
    }
    // Records the owning Pi process id so a later Pi process can tell whether this
    // instance's sessions are still supervised by a live peer or orphaned.
    async markInstanceOwner() {
        if (!this.options.instanceId || !this.options.instancesRoot)
            return;
        const file = join(this.options.instancesRoot, this.options.instanceId, "owner.pid");
        try {
            await mkdir(dirname(file), { recursive: true, mode: 0o700 });
            await writeFile(file, String(process.pid), { encoding: "utf8", mode: 0o600 });
        }
        catch {
            // Best-effort; absence just means peers can't detect our liveness.
        }
    }
    // A previous Pi process that crashed or was replaced leaves its per-instance
    // state file with live, now-unsupervised Claude sessions (no event tail, no
    // permission broker, no turn timeout). On startup, find sibling instances whose
    // owner process is dead and terminate their still-live managed Claude
    // processes and workspaces. A live peer Pi (owner pid alive) is never touched;
    // PID reuse of a dead owner only causes us to skip cleanup — the safe direction.
    async sweepOrphanInstances() {
        const root = this.options.instancesRoot;
        if (!root || !this.options.instanceId)
            return;
        let entries;
        try {
            entries = await readdir(root);
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry === this.options.instanceId)
                continue;
            const instanceDir = join(root, entry);
            const ownerPid = Number((await readFile(join(instanceDir, "owner.pid"), "utf8").catch(() => "")).trim());
            // Only sweep an instance whose owner is AFFIRMATIVELY dead. A missing or
            // unreadable owner.pid (write failed, or an older extension version) must
            // NOT trigger a sweep — that could SIGTERM a live peer's sessions.
            if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1 || isProcessAlive(ownerPid))
                continue;
            const runs = await new StateStore(join(instanceDir, "state.json")).load().catch(() => []);
            for (const run of runs) {
                if (["terminated", "failed", "exiting"].includes(run.state) || !run.sessionId)
                    continue;
                // Kill by session-bound argv, not the recorded pid alone: if cmux
                // restarted after the owner died it respawned `claude --resume <id>`
                // under a new pid that the stale state file never captured.
                const pids = await findClaudePidsForSession(run.sessionId);
                if (pids.length === 0)
                    continue;
                for (const pid of pids) {
                    try {
                        process.kill(pid, "SIGTERM");
                    }
                    catch { }
                }
                if (run.workspaceId)
                    await this.options.cmux.closeWorkspace(run.workspaceId).catch(() => { });
                await this.options.audit.append({
                    event: "orphan.terminated",
                    runId: run.runId,
                    sessionId: run.sessionId,
                    data: { instance: entry, pids, ownerPid },
                });
            }
        }
    }
    async shutdown(cleanup) {
        // A never-started holder (e.g. the bootstrap manager replaced on session_start)
        // has no stack, no runs, and no owner file — skip teardown so it never writes
        // an empty state.json into its instance dir.
        if (!this.started && this.runs.size === 0)
            return;
        if (cleanup)
            await this.stopAll();
        this.broker?.stop();
        this.removeAckListener?.();
        this.removeLifecycleListener?.();
        this.options.events.stop();
        await this.persist();
        this.started = false;
    }
    createController(run, trustDecider) {
        const existing = this.controllers.get(run.runId);
        if (existing)
            return existing;
        if (!this.windowId)
            throw new Error("cmux window is unavailable");
        const controller = new ClaudeSessionController(run, {
            cmux: this.options.cmux,
            events: this.options.events,
            hooks: this.options.hooks,
            audit: this.options.audit,
            config: this.options.config,
            windowId: this.windowId,
            trustDecider,
            onStateChange: (changed) => this.changed(changed),
        });
        this.controllers.set(run.runId, controller);
        return controller;
    }
    changed(run) {
        this.runs.set(run.runId, run);
        void this.persist();
    }
    persist() {
        this.pruneFinishedRuns();
        this.persistChain = this.persistChain
            .catch(() => { })
            .then(() => this.options.state.save(this.runs.values()));
        return this.persistChain;
    }
    pruneFinishedRuns() {
        if (this.runs.size <= 200)
            return;
        const removable = [...this.runs.values()]
            .filter((run) => ["terminated", "failed"].includes(run.state))
            .sort((left, right) => left.updatedAt - right.updatedAt);
        while (this.runs.size > 200 && removable.length > 0) {
            const run = removable.shift();
            this.runs.delete(run.runId);
            this.controllers.delete(run.runId);
            this.deciders.delete(run.runId);
        }
    }
    bySessionId(sessionId) {
        return [...this.runs.values()].find((run) => run.sessionId === sessionId);
    }
    async ensureReady() {
        const report = await this.start();
        if (!report.ok)
            throw new Error(`Claude cmux compatibility gate failed:\n${report.errors.join("\n")}`);
        if (!this.started)
            throw new Error("Claude cmux orchestrator did not start");
    }
}
async function mapLimited(items, limit, fn) {
    let next = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
        while (true) {
            const index = next++;
            if (index >= items.length)
                return;
            await fn(items[index]);
        }
    });
    await Promise.all(workers);
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
