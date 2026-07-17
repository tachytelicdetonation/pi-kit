"use strict";
/**
 * pi-kit fold registry (Round 4 backlog §1) — run coalescing as retroactive
 * collapse.
 *
 * Consecutive related Tier-0 tool calls (same tool + same key, back-to-back)
 * collapse into the NEWEST header; the older members render zero-height. The
 * survivor's header gains a `×N` run segment. ctrl+o on the survivor unfolds the
 * whole run back into normal per-row rendering.
 *
 * Mechanism (grounded in the Phase-0 spike):
 *   • The extension loads ONCE per process, so this module's state persists for
 *     the whole session and can track calls across rows.
 *   • Each row keeps its own persistent `ctx.state` bag. We stash the row's
 *     registry member on `ctx.state.__kitRunMember` — that (not the ctx object,
 *     which is re-created every frame by the host) is the durable per-row key.
 *   • A past row repaints when we call its `ctx.invalidate()`; that re-runs its
 *     renderCall/renderResult, which (guarded by `__kitFolded`) return
 *     `kit.zeroText(ctx)` → the row genuinely vanishes (renderShell:"self").
 *   • ALL collapses triggered by one new call are coalesced into ONE microtask /
 *     invalidate pass (an above-viewport collapse forces a full redraw; batching
 *     keeps it to a single flicker). This mirrors kit.markDone's discipline:
 *     one scheduled microtask, guarded against re-entrancy, self-terminating
 *     because a folded row that repaints does NOT re-fold anything.
 */
Object.defineProperty(exports, "__esModule", { value: true });

// Cap the global registration list so a long session can't grow it unbounded.
const MAX_MEMBERS = 50;

// Global registration order. Each entry (a "member") is:
//   { tool, key, ctx, state, run, folded }
// A "run" is a maximal consecutive same-(tool,key) sequence: { members: [] }.
// The LAST member of a run is the survivor; all earlier members fold to zero.
let members = [];

// --- batched, re-entrancy-guarded invalidate (mirrors kit.markDone) ---------
let pending = new Set();
let flushScheduled = false;
function scheduleInvalidate(list) {
    for (const m of list)
        pending.add(m);
    if (flushScheduled)
        return; // one microtask already owns the whole batch
    flushScheduled = true;
    queueMicrotask(() => {
        flushScheduled = false;
        const batch = [...pending];
        pending.clear();
        for (const m of batch) {
            try {
                // Wrapped: a ctx captured before a session resume may be stale.
                m.ctx && m.ctx.invalidate && m.ctx.invalidate();
            }
            catch {
                /* tolerate stale ctx refs across session resume */
            }
        }
    });
}

function metaFor(member) {
    const run = member.run;
    const survivor = run.members[run.members.length - 1] === member;
    return { count: run.members.length, survivor, folded: !!member.folded };
}

// Reconcile every prior member's fold state to `wantFolded`; the survivor is
// never folded. Only members whose state actually changes are invalidated, and
// they are batched into a single pass — so a steady-state re-render (nothing
// changed) schedules NOTHING, which is what keeps this loop-free.
function reconcile(run, wantFolded) {
    const survivor = run.members[run.members.length - 1];
    const changed = [];
    for (const m of run.members) {
        if (m === survivor) {
            if (m.folded) {
                m.folded = false;
                if (m.state)
                    m.state.__kitFolded = false;
            }
            continue;
        }
        if (!!m.folded !== wantFolded) {
            m.folded = wantFolded;
            if (m.state)
                m.state.__kitFolded = wantFolded;
            // A folded row renders zero-height and never reaches kit.markDone
            // (its renderResult early-returns on __kitFolded), so it would never
            // leave the liveness heartbeat — the 250ms tick would invalidate a
            // vanished row forever and the timer could never self-clear. Evict it
            // here. Lazy require: liveness.js does not require runs.js (no cycle).
            if (wantFolded && m.ctx) {
                try {
                    require("./liveness.js").markStopped(m.ctx);
                }
                catch { /* stale ctx across resume — safe to skip */ }
            }
            changed.push(m);
        }
    }
    if (changed.length)
        scheduleInvalidate(changed);
}

/**
 * Register (or re-confirm) this row in the fold registry. Called at the TOP of
 * each Tier-0 tool's renderCall. Idempotent per row: the first call links the
 * member; later re-renders of the same row just refresh the live handles.
 *
 * Returns { count, survivor, folded } run metadata for the caller.
 */
function register(tool, key, ctx) {
    const state = ctx && ctx.state;
    if (!state)
        return { count: 1, survivor: true, folded: false };
    let member = state.__kitRunMember;
    if (!member) {
        // First-ever registration of this row → link it into a run.
        const last = members[members.length - 1];
        const run = last && last.tool === tool && last.key === key
            ? last.run // continuation of the most-recent run
            : { members: [] }; // starts a new run
        member = { tool, key, ctx, state, run, folded: false };
        run.members.push(member);
        members.push(member);
        state.__kitRunMember = member;
        if (members.length > MAX_MEMBERS)
            members.shift(); // drop oldest handle (bounded memory)
    }
    else {
        // Re-render of an already-registered row: refresh the live handles so
        // invalidate() targets the freshest ctx, but NEVER re-link (guards
        // against a folded/expanded row re-folding others). No-op on the run.
        member.ctx = ctx;
        member.state = state;
    }
    const run = member.run;
    const isSurvivor = run.members[run.members.length - 1] === member;
    // Only the survivor of a multi-member run drives fold/unfold, keyed on its
    // own expand state: collapsed survivor → priors folded; expanded → priors
    // unfolded (ctrl+o). Single-member runs do nothing.
    if (isSurvivor && run.members.length > 1)
        reconcile(run, !ctx.expanded);
    state.__kitRunCount = run.members.length;
    state.__kitRunSurvivor = isSurvivor;
    return metaFor(member);
}

/**
 * Break the current run. Non-folding renderers (bash, write) never call
 * register(), so they are invisible to register()'s adjacency check — without
 * this, `read(A) → bash → read(A)` would fold the two reads together as if
 * consecutive, hiding the first read and its distinct line range behind a bogus
 * ×2. Called at the top of every non-fold-eligible renderCall: it pushes a
 * sentinel member so the next register() sees a different last member and starts
 * a fresh run. Idempotent — consecutive breaks don't stack sentinels.
 */
function breakRun() {
    const last = members[members.length - 1];
    if (last && last.tool === null)
        return; // already broken; one sentinel is enough
    members.push({ tool: null, key: null, ctx: null, state: null, run: { members: [] }, folded: false });
    if (members.length > MAX_MEMBERS)
        members.shift();
}

/**
 * The survivor's `×N` run segment for setSummary/marker. Returns "" unless this
 * row is the survivor of a run with count > 1 (so folded/solo rows add nothing).
 */
function runSeg(ctx) {
    const state = ctx && ctx.state;
    if (!state || !state.__kitRunSurvivor)
        return "";
    const n = state.__kitRunCount || 1;
    return n > 1 ? `×${n}` : "";
}

// Explicit unfold/refold for a row's run (ctrl+o wiring / tests). Idempotent
// and batched — the register()/reconcile() path already reacts to ctx.expanded,
// so these are for callers that want to drive it directly.
function unfold(ctx) {
    const m = ctx && ctx.state && ctx.state.__kitRunMember;
    if (m)
        reconcile(m.run, false);
}
function refold(ctx) {
    const m = ctx && ctx.state && ctx.state.__kitRunMember;
    if (m)
        reconcile(m.run, true);
}

// Test/reset hook — drop all registry state. The preview harness calls this
// between independent scenarios so unrelated rows don't fold into each other.
function reset() {
    members = [];
    pending = new Set();
    flushScheduled = false;
}

exports.register = register;
exports.breakRun = breakRun;
exports.runSeg = runSeg;
exports.unfold = unfold;
exports.refold = refold;
exports.reset = reset;
//# sourceMappingURL=runs.js.map
