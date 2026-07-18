import { promptMetadata } from "./audit-log.js";
import { isTopLevelStop, isUserPromptSubmit } from "./event-tail.js";
import { isManagedClaudeProcess, isProcessAlive, sleep } from "./process.js";
import { readAssistantOutput, transcriptOffset, truncateOutput } from "./transcript.js";
export class ClaudeSessionController {
    run;
    options;
    constructor(run, options) {
        this.run = run;
        this.options = options;
    }
    async launch(signal) {
        this.transition("launching");
        await this.options.audit.append({ event: "session.launching", runId: this.run.runId, data: { cwd: this.run.cwd } });
        const created = await this.options.cmux.createClaudeWorkspace({
            cwd: this.run.cwd,
            name: this.workspaceName(),
            permissionMode: this.run.permissionMode,
            windowId: this.options.windowId,
            signal,
        });
        this.run.workspaceRef = created.workspaceRef;
        this.run.workspaceId = created.workspaceId;
        this.run.surfaceId = created.surfaceId;
        this.transition("registering");
        await this.options.audit.append({
            event: "session.workspace_created",
            runId: this.run.runId,
            workspaceId: created.workspaceId,
            surfaceId: created.surfaceId,
            data: { workspaceRef: created.workspaceRef },
        });
        await this.register(created.surfaceId, signal);
    }
    async resume(signal) {
        if (!this.run.sessionId)
            throw new Error("Cannot resume a Claude session without a session ID");
        if (this.run.resumeAttempts >= this.options.config.maxResumeAttempts) {
            throw new Error(`Resume limit reached for ${this.run.runId}`);
        }
        this.run.resumeAttempts++;
        this.transition("recovering");
        await this.options.audit.append({
            event: "session.resuming",
            runId: this.run.runId,
            sessionId: this.run.sessionId,
            data: { attempt: this.run.resumeAttempts },
        });
        const created = await this.options.cmux.createClaudeWorkspace({
            cwd: this.run.cwd,
            name: this.workspaceName(),
            permissionMode: this.run.permissionMode,
            windowId: this.options.windowId,
            resumeSessionId: this.run.sessionId,
            signal,
        });
        this.run.workspaceRef = created.workspaceRef;
        this.run.workspaceId = created.workspaceId;
        this.run.surfaceId = created.surfaceId;
        this.transition("registering");
        const record = await this.register(created.surfaceId, signal);
        if (record.sessionId !== this.run.sessionId) {
            throw new Error(`Resume created the wrong Claude session (${record.sessionId})`);
        }
        await this.options.audit.append({
            event: "session.resumed",
            runId: this.run.runId,
            sessionId: this.run.sessionId,
            workspaceId: this.run.workspaceId,
            surfaceId: this.run.surfaceId,
        });
    }
    async runPrompt(prompt, signal, timeoutMs) {
        if (this.run.state !== "ready")
            throw new Error(`Session ${this.run.runId} is ${this.run.state}, not ready`);
        if (!this.run.surfaceId || !this.run.sessionId)
            throw new Error("Session registration is incomplete");
        const started = Date.now();
        const transcriptStart = await transcriptOffset(this.run.transcriptPath);
        const baselineSeq = this.options.events.latestSeq;
        const bootId = this.options.events.bootId;
        const deadline = timeoutMs ?? this.options.config.turnTimeoutMs;
        this.transition("submitting");
        await this.options.audit.append({
            event: "turn.submitting",
            runId: this.run.runId,
            sessionId: this.run.sessionId,
            workspaceId: this.run.workspaceId,
            surfaceId: this.run.surfaceId,
            data: promptMetadata(prompt),
        });
        await this.options.cmux.paste(this.run.surfaceId, prompt, signal);
        await this.options.cmux.sendKey(this.run.surfaceId, "ENTER", signal);
        const submitted = await this.options.events.waitFor((event) => isUserPromptSubmit(event, this.run.sessionId) || this.isClosedEvent(event), { afterSeq: baselineSeq, bootId, timeoutMs: Math.min(deadline, 60_000), signal });
        if (this.isClosedEvent(submitted))
            throw new Error("Managed cmux surface closed before Claude accepted the prompt");
        this.run.lastEventSeq = submitted.seq;
        this.run.bootId = submitted.boot_id;
        this.transition("running");
        await this.options.audit.append({
            event: "turn.submitted",
            runId: this.run.runId,
            sessionId: this.run.sessionId,
            data: { seq: submitted.seq, bootId: submitted.boot_id },
        });
        const elapsed = Date.now() - started;
        let stopped;
        try {
            stopped = await this.options.events.waitFor((event) => isTopLevelStop(event, this.run.sessionId) || this.isClosedEvent(event), { afterSeq: submitted.seq, bootId: submitted.boot_id, timeoutMs: Math.max(1, deadline - elapsed), signal });
        }
        catch (error) {
            const recovered = await this.recoverTurnFromTranscript(error, transcriptStart, started);
            if (recovered)
                return recovered;
            throw error;
        }
        if (this.isClosedEvent(stopped))
            throw new Error("Managed cmux surface closed while Claude was running");
        this.run.lastEventSeq = stopped.seq;
        await this.waitForInputReady(Math.min(20_000, Math.max(1, deadline - (Date.now() - started))), signal);
        await sleep(this.options.config.settleMs, signal);
        const record = await this.options.hooks.findBySession(this.run.sessionId);
        if (record)
            this.applyRecord(record);
        let output = await readAssistantOutput(this.run.transcriptPath, transcriptStart);
        if (!output && record?.lastBody)
            output = record.lastBody;
        if (!output && this.run.surfaceId)
            output = (await this.options.cmux.readScreen(this.run.surfaceId, 80, signal)).trim();
        const truncated = truncateOutput(output || "(Claude completed without a text response.)");
        this.transition("ready");
        await this.options.audit.append({
            event: "turn.completed",
            runId: this.run.runId,
            sessionId: this.run.sessionId,
            data: { seq: stopped.seq, elapsedMs: Date.now() - started, outputTruncated: truncated.truncated },
        });
        return { run: { ...this.run }, output: truncated.text, elapsedMs: Date.now() - started };
    }
    /**
     * When the Stop wait aborts because the cmux event epoch changed or the stream
     * reported a sequence gap (a restart mid-turn), the completing Stop event may
     * have fallen in the lost window. The Claude transcript is durable, so recover
     * the turn READ-ONLY: only treat it as complete when the transcript gained
     * assistant output AND the hook store shows the session back at an input-ready
     * lifecycle (the Stop hook writes that before Claude exits). Anything less is a
     * genuinely interrupted turn — fail closed by returning undefined. Never
     * resends the prompt, so the no-auto-resend invariant holds.
     */
    async recoverTurnFromTranscript(error, transcriptStart, started) {
        if (!/epoch changed|sequence gap/.test(message(error)) || !this.run.sessionId)
            return undefined;
        const record = await this.options.hooks.findBySession(this.run.sessionId).catch(() => undefined);
        const lifecycleReady = Boolean(record && ["idle", "needsInput"].includes(record.agentLifecycle ?? ""));
        const output = await readAssistantOutput(this.run.transcriptPath, transcriptStart).catch(() => "");
        if (!output || !lifecycleReady)
            return undefined;
        if (record)
            this.applyRecord(record);
        const truncated = truncateOutput(output);
        // Surface/PID are stale after the restart; leave the run recovering so fleet
        // reconciliation heals keep-open sessions rather than reusing a dead surface.
        this.transition("recovering");
        await this.options.audit.append({
            event: "turn.recovered",
            runId: this.run.runId,
            sessionId: this.run.sessionId,
            data: { reason: message(error), elapsedMs: Date.now() - started, outputTruncated: truncated.truncated },
        });
        return { run: { ...this.run }, output: truncated.text, elapsedMs: Date.now() - started, recovered: true };
    }
    async terminate() {
        if (this.run.state === "terminated")
            return;
        this.transition("exiting");
        await this.options.audit.append({
            event: "session.exiting",
            runId: this.run.runId,
            sessionId: this.run.sessionId,
            workspaceId: this.run.workspaceId,
            surfaceId: this.run.surfaceId,
        });
        if (this.run.surfaceId) {
            try {
                await this.options.cmux.sendText(this.run.surfaceId, "/exit");
                await this.options.cmux.sendKey(this.run.surfaceId, "ENTER");
            }
            catch {
                // The surface may already be gone; workspace close remains authoritative.
            }
        }
        await this.waitForPidExit(3_000);
        if (this.run.workspaceId) {
            try {
                await this.options.cmux.closeWorkspace(this.run.workspaceId);
            }
            catch {
                // Reconcile with process liveness below.
            }
        }
        await this.waitForPidExit(2_000);
        if (this.run.pid && (await isManagedClaudeProcess(this.run.pid, this.run.sessionId))) {
            try {
                process.kill(this.run.pid, "SIGTERM");
            }
            catch { }
            await this.waitForPidExit(2_000);
            if (await isManagedClaudeProcess(this.run.pid, this.run.sessionId)) {
                try {
                    process.kill(this.run.pid, "SIGKILL");
                }
                catch { }
            }
        }
        this.transition("terminated");
        await this.options.audit.append({
            event: "session.terminated",
            runId: this.run.runId,
            sessionId: this.run.sessionId,
            data: { pidAlive: isProcessAlive(this.run.pid) },
        });
    }
    applyRecord(record) {
        this.run.sessionId = record.sessionId;
        this.run.workspaceId = record.workspaceId ?? this.run.workspaceId;
        this.run.surfaceId = record.surfaceId ?? this.run.surfaceId;
        this.run.pid = record.pid;
        this.run.transcriptPath = record.transcriptPath;
        this.run.updatedAt = Date.now();
        this.options.onStateChange?.(this.run);
    }
    fail(error) {
        this.run.error = message(error).slice(0, 500);
        this.transition("failed");
    }
    async register(surfaceId, signal) {
        let trustHandled = false;
        let lastScreenCheck = 0;
        const record = await this.options.hooks.waitForSurface(surfaceId, this.options.config.registrationTimeoutMs, {
            signal,
            onTick: async (elapsed) => {
                if (elapsed - lastScreenCheck < 1_000)
                    return;
                lastScreenCheck = elapsed;
                const screen = await this.options.cmux.readScreen(surfaceId, 50, signal).catch(() => "");
                if (/No conversation found/i.test(screen))
                    throw new Error("Claude could not find the requested conversation");
                if (isTrustDialog(screen) && !trustHandled) {
                    trustHandled = true;
                    this.transition("trust-required");
                    const approved = (await this.options.trustDecider?.({ ...this.run }, screen)) ?? false;
                    await this.options.audit.append({
                        event: "dialog.trust",
                        runId: this.run.runId,
                        surfaceId,
                        data: { approved },
                    });
                    if (!approved)
                        throw new Error("Claude project trust was denied");
                    await this.options.cmux.sendKey(surfaceId, "ENTER", signal);
                    this.transition("registering");
                    return;
                }
                if (isKnownOnboardingDialog(screen)) {
                    throw new Error("Claude is blocked on an onboarding/theme dialog; complete it manually and retry");
                }
            },
        });
        this.applyRecord(record);
        this.run.bootId = this.options.events.bootId;
        this.transition("ready");
        await this.options.audit.append({
            event: "session.registered",
            runId: this.run.runId,
            sessionId: record.sessionId,
            workspaceId: record.workspaceId,
            surfaceId: record.surfaceId,
            data: { pid: record.pid, lifecycle: record.agentLifecycle },
        });
        return record;
    }
    async waitForInputReady(timeoutMs, signal) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            if (signal?.aborted)
                throw abortError();
            if (!this.run.sessionId)
                return;
            const record = await this.options.hooks.findBySession(this.run.sessionId);
            if (record && ["idle", "needsInput"].includes(record.agentLifecycle ?? "")) {
                this.applyRecord(record);
                return;
            }
            await sleep(250, signal);
        }
        throw new Error("Claude emitted Stop but did not return to an input-ready lifecycle");
    }
    isClosedEvent(event) {
        return ((event.name === "surface.closed" && event.surface_id === this.run.surfaceId) ||
            (event.name === "workspace.closed" && event.workspace_id === this.run.workspaceId));
    }
    async waitForPidExit(timeoutMs) {
        const started = Date.now();
        while (isProcessAlive(this.run.pid) && Date.now() - started < timeoutMs)
            await sleep(100);
    }
    transition(state) {
        this.run.state = state;
        this.run.updatedAt = Date.now();
        this.options.onStateChange?.(this.run);
    }
    workspaceName() {
        return `pi-claude-${this.run.runId.slice(0, 8)} ${this.run.name}`.slice(0, 80);
    }
}
export function isTrustDialog(screen) {
    return /trust (?:the files in |)this folder|project you created or one you trust|yes, I trust this folder/i.test(screen);
}
export function isKnownOnboardingDialog(screen) {
    return /choose the text style|select (?:a |your )?theme|how do you want Claude Code to look/i.test(screen);
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
function abortError() {
    const error = new Error("Operation aborted");
    error.name = "AbortError";
    return error;
}
