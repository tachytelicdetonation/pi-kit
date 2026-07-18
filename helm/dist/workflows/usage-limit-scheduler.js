/**
 * Auto-resume for runs paused on a provider usage limit.
 *
 * A workflow run pauses (does not fail) when a provider quota/usage limit is hit
 * (see errors.ts PROVIDER_USAGE_LIMIT, workflow-manager.ts executeRun()'s catch
 * block). Left alone, the run just sits there until a human runs /workflows and
 * hits resume. This module watches the manager's public event stream and, for
 * runs that are auto-resume-eligible, arms a timer to call manager.resume() once
 * the provider's quota is likely to have refilled — with exponential backoff if
 * it keeps hitting the wall, and a hard attempt cap so it never retries forever.
 *
 * Deliberately standalone: it consumes ONLY WorkflowManager's public surface
 * (on/off, listAllRuns, resume, getPersistence) so it stays decoupled from
 * manager/persistence internals. It owns its own timers and its own bookkeeping
 * (in-memory, best-effort persisted) — it does not rely on manager.stop(), which
 * only operates on in-memory runs.
 */
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MIN_DELAY_MS = 60_000;
const DEFAULT_FALLBACK_DELAY_MS = 300_000;
const DEFAULT_MAX_DELAY_MS = 6 * 60 * 60 * 1000;
/**
 * Best-effort parse of a provider's human reset hint ("Resets in ~3h",
 * "resets in 5m", "in 90s", "1h30m") into milliseconds. Sums every
 * (number, unit) pair found, so combined forms like "1h30m" work for free.
 * Returns undefined when nothing recognizable is found — callers should fall
 * back to a fixed delay rather than guess.
 */
export function parseResetHintMs(hint) {
    if (!hint)
        return undefined;
    // No trailing \b: combined forms like "1h30m" have a digit right after the
    // unit letter, which is itself a word character, so \b would never match
    // there. A negative lookahead for another letter is the correct boundary —
    // it still stops "hours" from partially matching as bare "h" mid-word while
    // allowing a unit to be followed immediately by the next (digit, unit) pair.
    const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi;
    let match;
    let totalMs = 0;
    let found = false;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
    while ((match = re.exec(hint)) !== null) {
        const value = Number.parseFloat(match[1]);
        if (!Number.isFinite(value))
            continue;
        const unit = match[2].toLowerCase();
        found = true;
        if (unit.startsWith("h"))
            totalMs += value * 3_600_000;
        else if (unit.startsWith("m"))
            totalMs += value * 60_000;
        else if (unit.startsWith("s"))
            totalMs += value * 1_000;
    }
    return found ? totalMs : undefined;
}
/**
 * delay = clamp(minDelayMs, remaining * 2^(attempts-1), maxDelayMs), where
 * remaining = parsed(resetHint) ?? fallbackDelayMs, minus time already elapsed.
 * The exponent is capped defensively so a pathological attempt count can't
 * overflow the multiplication to Infinity/NaN before the maxDelayMs clamp runs.
 */
export function computeAutoResumeDelayMs(params) {
    const base = parseResetHintMs(params.resetHint) ?? params.fallbackDelayMs;
    const remaining = base - params.elapsedMs;
    const exponent = Math.min(Math.max(params.attempts - 1, 0), 30);
    const backoff = remaining * 2 ** exponent;
    return Math.min(params.maxDelayMs, Math.max(params.minDelayMs, backoff));
}
/**
 * Watches a WorkflowManager for usage-limit pauses and auto-resumes eligible
 * runs once the provider's quota is likely to have refilled.
 *
 * Event-driven "fire and watch": an attempt is consumed when a run ENTERS a
 * usage_limit pause (live via the "paused" event, or once at cold start for a
 * run that was already paused), never when a resume is merely fired. When an
 * armed timer fires, resume() is called; if it returns false (lease busy, run
 * already gone, etc.) no attempt is consumed and a short un-backed-off retry is
 * armed instead, unless the run has reached a terminal state on disk. If resume()
 * returns true, this scheduler steps back — the existing "paused" subscription
 * re-arms with backoff if the run hits the wall again, and "complete"/"error"/
 * "stopped" clean up its timer.
 */
export class UsageLimitScheduler {
    manager;
    now;
    setTimer;
    clearTimer;
    maxAttempts;
    minDelayMs;
    fallbackDelayMs;
    maxDelayMs;
    diagnostic;
    state = new Map();
    disposed = false;
    onPaused = (event) => {
        this.safe(() => this.handlePaused(event));
    };
    onTerminal = (event) => {
        this.safe(() => this.cleanup(event?.runId));
    };
    constructor(manager, options = {}) {
        this.manager = manager;
        this.now = options.now ?? Date.now;
        this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
        this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
        this.minDelayMs = options.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
        this.fallbackDelayMs = options.fallbackDelayMs ?? DEFAULT_FALLBACK_DELAY_MS;
        this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
        this.diagnostic =
            options.onDiagnostic ??
                ((message, detail) => {
                    console.warn(message, detail ?? "");
                });
        this.manager.on("paused", this.onPaused);
        this.manager.on("complete", this.onTerminal);
        this.manager.on("error", this.onTerminal);
        this.manager.on("stopped", this.onTerminal);
        // Cold-start re-arm: pick up any run that was already paused-on-usage_limit
        // before this process (and thus this scheduler instance) existed.
        this.safe(() => this.coldStartRearm());
    }
    /** Clear every armed timer and unsubscribe from the manager. Idempotent. */
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.manager.off("paused", this.onPaused);
        this.manager.off("complete", this.onTerminal);
        this.manager.off("error", this.onTerminal);
        this.manager.off("stopped", this.onTerminal);
        for (const entry of this.state.values()) {
            if (entry.timer !== undefined)
                this.clearTimer(entry.timer);
        }
        this.state.clear();
    }
    /** Test/diagnostic helper: in-memory attempt count tracked for a run, if any. */
    getAttemptCount(runId) {
        return this.state.get(runId)?.attempts;
    }
    /** Test/diagnostic helper: whether a resume timer is currently armed for a run. */
    hasArmedTimer(runId) {
        return this.state.get(runId)?.timer !== undefined;
    }
    // ---- event handlers -----------------------------------------------------
    handlePaused(event) {
        if (this.disposed || !event?.runId || event.reason !== "usage_limit")
            return;
        const runId = event.runId;
        // The "paused" event fires BEFORE the manager's own persistRun() write for
        // this pause (see executeRun()'s catch block: emit then persist). A disk
        // read here can therefore be stale for fields this exact pause is about to
        // set (status/pauseReason/resetHint) — but NOT for `autoResume`, which is
        // fixed at run-start and persisted on every persistRun() call since, so a
        // stale read of it is still correct. resetHint comes off the event itself,
        // not disk, to avoid that race.
        const persisted = this.safeLoad(runId);
        if (persisted?.autoResume === false) {
            this.diagnostic(`[usage-limit-scheduler] ${runId}: autoResume is disabled for this run, not arming`);
            return;
        }
        const priorAttempts = this.state.get(runId)?.attempts ?? persisted?.autoResumeAttempts ?? 0;
        this.arm(runId, {
            attempts: priorAttempts + 1,
            resetHint: event.resetHint ?? persisted?.resetHint,
            elapsedMs: 0,
        });
    }
    cleanup(runId) {
        if (!runId)
            return;
        const entry = this.state.get(runId);
        if (entry?.timer !== undefined)
            this.clearTimer(entry.timer);
        this.state.delete(runId);
    }
    coldStartRearm() {
        const runs = this.manager.listAllRuns();
        for (const run of runs) {
            if (run.status !== "paused" || run.pauseReason !== "usage_limit")
                continue;
            if (run.autoResume === false)
                continue;
            if (this.state.has(run.runId))
                continue;
            const priorAttempts = run.autoResumeAttempts ?? 0;
            const updatedAtMs = Date.parse(run.updatedAt);
            const elapsedMs = Number.isFinite(updatedAtMs) ? Math.max(0, this.now() - updatedAtMs) : 0;
            this.arm(run.runId, {
                attempts: priorAttempts + 1,
                resetHint: run.resetHint,
                elapsedMs,
            });
        }
    }
    // ---- arming / firing ------------------------------------------------------
    arm(runId, params) {
        const existing = this.state.get(runId);
        if (existing?.timer !== undefined)
            this.clearTimer(existing.timer);
        if (params.attempts > this.maxAttempts) {
            const alreadyLogged = existing?.gaveUp === true;
            this.state.set(runId, { attempts: params.attempts, gaveUp: true });
            this.persistAttempts(runId, params.attempts);
            if (!alreadyLogged) {
                this.diagnostic(`[usage-limit-scheduler] ${runId}: giving up after ${params.attempts - 1} auto-resume attempt(s) ` +
                    `(max ${this.maxAttempts}); leaving paused for manual resume`);
            }
            return;
        }
        const delay = computeAutoResumeDelayMs({
            resetHint: params.resetHint,
            attempts: params.attempts,
            elapsedMs: params.elapsedMs,
            minDelayMs: this.minDelayMs,
            fallbackDelayMs: this.fallbackDelayMs,
            maxDelayMs: this.maxDelayMs,
        });
        const timer = this.setTimer(() => this.safe(() => this.onTimerFire(runId)), delay);
        this.state.set(runId, { attempts: params.attempts, timer });
        this.persistAttempts(runId, params.attempts);
    }
    async onTimerFire(runId) {
        if (this.disposed)
            return;
        const entry = this.state.get(runId);
        if (!entry || entry.gaveUp)
            return;
        // The timer that just fired is spent; clear its handle while we await.
        this.state.set(runId, { ...entry, timer: undefined });
        let resumed = false;
        try {
            resumed = await this.manager.resume(runId);
        }
        catch (err) {
            this.diagnostic(`[usage-limit-scheduler] ${runId}: resume() threw`, err);
            resumed = false;
        }
        if (this.disposed)
            return;
        if (resumed) {
            // Don't consume/advance anything further here — the existing "paused"
            // subscription re-arms (with backoff) if this run hits the wall again,
            // and "complete"/"error"/"stopped" clean up on any terminal outcome.
            return;
        }
        // resume() returned false without throwing: it refused for a structural
        // reason (already running/aborted, no persisted script, or the lease is
        // held elsewhere) rather than a real failed attempt. Per the fix for bug
        // (a), that must NOT consume an attempt. Distinguish "gone for good" from
        // "try again shortly":
        const status = this.safeStatus(runId);
        if (status === undefined || status === "completed" || status === "aborted") {
            this.cleanup(runId);
            return;
        }
        const current = this.state.get(runId) ?? entry;
        const timer = this.setTimer(() => this.safe(() => this.onTimerFire(runId)), this.minDelayMs);
        this.state.set(runId, { attempts: current.attempts, timer });
    }
    // ---- helpers --------------------------------------------------------------
    safeLoad(runId) {
        try {
            return this.manager.getPersistence().load(runId) ?? undefined;
        }
        catch (err) {
            this.diagnostic(`[usage-limit-scheduler] ${runId}: persistence load failed`, err);
            return undefined;
        }
    }
    safeStatus(runId) {
        try {
            return this.manager.listAllRuns().find((r) => r.runId === runId)?.status;
        }
        catch (err) {
            this.diagnostic(`[usage-limit-scheduler] ${runId}: listAllRuns() failed`, err);
            return undefined;
        }
    }
    /**
     * Best-effort persist of the in-memory attempt counter, so a cold start after
     * a crash can approximately resume the backoff sequence instead of restarting
     * it. Deferred to a microtask so it lands AFTER the manager's own persistRun()
     * write for this same pause (which happens synchronously, right after the
     * "paused" event we're reacting to returns control to executeRun()) — writing
     * synchronously here would just get clobbered, since persistRun() writes a
     * fresh PersistedRunState object literal that doesn't know about this field.
     * This is still inherently racy across process crashes (see class docs); it
     * is a best-effort durability aid, not a correctness requirement for the live
     * (in-memory) path.
     */
    persistAttempts(runId, attempts) {
        queueMicrotask(() => {
            if (this.disposed)
                return;
            try {
                const persistence = this.manager.getPersistence();
                const current = persistence.load(runId);
                if (!current)
                    return;
                persistence.save({ ...current, autoResumeAttempts: attempts });
            }
            catch (err) {
                this.diagnostic(`[usage-limit-scheduler] ${runId}: failed to persist autoResumeAttempts`, err);
            }
        });
    }
    safe(fn) {
        try {
            const result = fn();
            if (result && typeof result.catch === "function") {
                result.catch((err) => {
                    this.diagnostic("[usage-limit-scheduler] async handler error", err);
                });
            }
        }
        catch (err) {
            this.diagnostic("[usage-limit-scheduler] handler error", err);
        }
    }
}
