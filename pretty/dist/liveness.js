"use strict";
/**
 * pi-pretty: liveness registry — the ONE shared heartbeat behind the spinner.
 *
 * A running tool call must FEEL alive: its status glyph animates and (past 3s)
 * its header shows a ticking elapsed seg. Both are driven from here so the seven
 * tool renderers stay untouched — kit.glyph()/kit.header() read currentFrame()
 * and the tick-stamped elapsed; kit.markDone() stops the ctx.
 *
 * ── CRITICAL convergence invariant ──────────────────────────────────────────
 * The frame index is a MODULE-LEVEL counter that advances ONLY inside tick().
 * glyph() must NEVER derive the frame from Date.now() at render time: the host
 * (and the preview harness) re-render each entry multiple passes and assert the
 * output stops changing. A time-at-render frame would differ every pass → the
 * output never converges → a FALSE loop. Because the counter is frozen between
 * ticks, every render pass within one settle returns the SAME braille char →
 * converges. A tick advances the counter AND invalidates the running ctxs → the
 * next settle shows the next frame → converges again. One tick = one bounded
 * settle. Same discipline for elapsed: whole seconds are stamped on tick(), so
 * they too are constant within a settle.
 */
Object.defineProperty(exports, "__esModule", { value: true });

// Single-cell braille frames (U+2800 block — all narrow/1-column).
const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧";
const TICK_MS = 250;
const ELAPSED_FLOOR_MS = 3000; // only show a live elapsed seg past 3s

// Registry keyed by the SHARED ctx.state (stable across render passes) → the
// freshest ctx (its .invalidate ref is refreshed every render). Keying by state
// rather than the ctx object collapses the harness's per-pass ephemeral ctxs to
// one entry, and lets markStopped() — called from markDone with a *different*
// ctx that shares the same state — remove exactly the right entry.
const running = new Map(); // Map<state, ctx>
let timer = null;
let frame = 0;

function tick() {
    frame = (frame + 1) % FRAMES.length;
    const now = Date.now();
    for (const [state, ctx] of running) {
        // Stamp whole-second elapsed here (tick-driven) so kit.header reads a
        // value that is constant between ticks → convergent within a settle.
        if (state && state.__runStart) {
            state.__elapsedSec = Math.floor((now - state.__runStart) / 1000);
        }
        try {
            ctx && ctx.invalidate && ctx.invalidate();
        }
        catch {
            // Stale invalidate ref (e.g. after a session resume) — never throw
            // out of the shared heartbeat; the ctx will be re-registered or
            // dropped on its next render/completion.
        }
    }
}

function ensureTimer() {
    if (timer || running.size === 0)
        return;
    try {
        timer = setInterval(tick, TICK_MS);
        // Never keep the process alive for the spinner alone (matters for the
        // node harness and any host that drains the loop). Guarded — some hosts
        // hand back a plain id without .unref.
        if (timer && typeof timer.unref === "function")
            timer.unref();
    }
    catch {
        // Host sandbox blocks timers → degrade gracefully: no heartbeat, glyph
        // stays on whatever frame it last held (static). Never crash.
        timer = null;
    }
}

function clearTimerIfIdle() {
    if (timer && running.size === 0) {
        try {
            clearInterval(timer);
        }
        catch { /* ignore */ }
        timer = null;
    }
}

/** Register a ctx as currently running; lazily starts the shared heartbeat. */
function markRunning(ctx) {
    if (!ctx || !ctx.state)
        return; // no shared state → nothing stable to key/invalidate
    running.set(ctx.state, ctx); // refresh to the freshest ctx/invalidate ref
    ensureTimer();
}

/** Remove a ctx from the running set; clears the heartbeat once idle. */
function markStopped(ctx) {
    if (!ctx || !ctx.state)
        return;
    running.delete(ctx.state);
    delete ctx.state.__elapsedSec; // settled: no stale elapsed on a later render
    clearTimerIfIdle();
}

/** Current animation frame index (advances only on tick). */
function currentFrame() {
    return frame;
}

exports.FRAMES = FRAMES;
exports.ELAPSED_FLOOR_MS = ELAPSED_FLOOR_MS;
exports.markRunning = markRunning;
exports.markStopped = markStopped;
exports.currentFrame = currentFrame;

// --- test-only introspection (used by the standalone assertion) -------------
exports.__running = running;
exports.__hasTimer = () => timer !== null;
exports.__tick = tick; // advance the counter deterministically without waiting
//# sourceMappingURL=liveness.js.map
