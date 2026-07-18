/**
 * HelmStore — the single owner of {@link HelmState}.
 *
 * Sort order is the important invariant here: the handoff requires that "rows
 * re-sort ONLY on state change (stable; no jitter on progress ticks)". We honor
 * that by sorting the arrays ONCE at construction and again ONLY inside mutators —
 * never inside a selector or the renderer, and never from wall-clock time. Between
 * mutations `getState()` returns the same object, so order is trivially stable.
 *
 * Subscribers are notified on mutation only (a mutation that changes nothing still
 * notifies — callers debounce at the render layer).
 */
import { autoResolve, buildPrecedent } from "./precedents.js";
/**
 * Stable comparator for the needs-you queue: oldest-blocked first, ties broken by
 * id so the order is deterministic across snapshots.
 */
function compareEscalations(a, b) {
    if (a.blockedSinceMs !== b.blockedSinceMs)
        return a.blockedSinceMs - b.blockedSinceMs;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
/**
 * Rank a loop for the active-first ordering: paused loops sink below the rest.
 * Relative order among same-rank loops is preserved (stable sort) so nothing
 * jitters when only a paused reason changes.
 */
function loopRank(loop) {
    return loop.health === "paused" ? 1 : 0;
}
/** Stable sort helper — Array.prototype.sort is spec-stable in modern V8, but we
 * decorate with the original index to make stability explicit and portable. */
function stableSort(items, compare) {
    return items
        .map((value, index) => ({ value, index }))
        .sort((a, b) => compare(a.value, b.value) || a.index - b.index)
        .map((entry) => entry.value);
}
export class HelmStore {
    state;
    subscribers = new Set();
    constructor(initial) {
        this.state = { ...initial };
        this.resort();
    }
    /** The current state. Reference is stable between mutations (safe to compare). */
    getState() {
        return this.state;
    }
    /** Register a change listener; returns an unsubscribe function. */
    subscribe(callback) {
        this.subscribers.add(callback);
        return () => {
            this.subscribers.delete(callback);
        };
    }
    /** Engage pause-all: freeze every lane mid-step. Idempotent. */
    pauseAll() {
        if (this.state.pausedAll)
            return;
        this.state = { ...this.state, pausedAll: true };
        this.emit();
    }
    /** Release pause-all. Idempotent. */
    resumeAll() {
        if (!this.state.pausedAll)
            return;
        this.state = { ...this.state, pausedAll: false };
        this.emit();
    }
    /**
     * Pause a single workflow lane by id. A no-op (still notifies) if the id is
     * unknown or the lane is already paused. Order is recomputed because a state
     * change is the one time re-sorting is allowed — though top-level workflow order
     * is insertion order, so this is a stable no-op for them today.
     */
    pauseWorkflow(id) {
        const workflows = this.state.workflows.map((workflow) => workflow.id === id && workflow.state !== "paused"
            ? { ...workflow, state: "paused" }
            : workflow);
        this.state = { ...this.state, workflows };
        this.resort();
        this.emit();
    }
    resumeWorkflow(id) {
        const workflows = this.state.workflows.map((workflow) => workflow.id === id && workflow.state === "paused"
            ? { ...workflow, state: "running" }
            : workflow);
        this.state = { ...this.state, workflows };
        this.resort();
        this.emit();
    }
    addGoal(goal) {
        if (this.state.goals.some((item) => item.id === goal.id))
            return;
        this.state = { ...this.state, goals: [...this.state.goals, goal] };
        this.emit();
    }
    updateGoal(id, update) {
        this.state = {
            ...this.state,
            goals: this.state.goals.map((goal) => goal.id === id ? { ...goal, ...update } : goal),
        };
        this.emit();
    }
    upsertLoop(loop) {
        const found = this.state.loops.some((item) => item.id === loop.id);
        this.state = {
            ...this.state,
            loops: found ? this.state.loops.map((item) => item.id === loop.id ? loop : item) : [...this.state.loops, loop],
        };
        this.resort();
        this.emit();
    }
    toggleLoop(id) {
        this.state = {
            ...this.state,
            loops: this.state.loops.map((loop) => loop.id === id
                ? {
                    ...loop,
                    health: loop.health === "paused" ? "healthy" : "paused",
                    pausedReason: loop.health === "paused" ? undefined : "paused by operator",
                }
                : loop),
        };
        this.resort();
        this.emit();
    }
    appendJournal(event) {
        if (this.state.journal.some((item) => item.id === event.id))
            return;
        this.state = { ...this.state, journal: [...this.state.journal, event] };
        this.emit();
    }
    replacePrecedents(precedents) {
        this.state = { ...this.state, precedents: [...precedents] };
        this.emit();
    }
    /**
     * Resolve an escalation by choosing option `index`: record the decision as a
     * PRECEDENT and remove the escalation from the needs-you queue. Unknown ids or
     * out-of-range indices are a no-op (still notifies — callers debounce renders).
     *
     * The store remains filesystem-agnostic. RealDataSource persists its complete
     * project domain immediately after this mutation.
     */
    decide(escalationId, index) {
        const escalation = this.state.escalations.find((item) => item.id === escalationId);
        if (!escalation || index < 0 || index >= escalation.options.length) {
            this.emit();
            return;
        }
        const precedent = buildPrecedent(escalation, index);
        this.state = {
            ...this.state,
            precedents: [...this.state.precedents, precedent],
            escalations: this.state.escalations.filter((item) => item.id !== escalationId),
        };
        this.resort();
        this.emit();
    }
    /**
     * See a new escalation. If its signature matches a non-declined precedent it is
     * auto-resolved + flagged (and kept OUT of the blocking queue); otherwise it
     * joins the needs-you queue. Returns the (possibly auto-resolved) escalation so
     * callers can observe the outcome.
     */
    addEscalation(escalation) {
        const resolved = autoResolve(escalation, this.state.precedents);
        if (!resolved.resolved) {
            this.state = { ...this.state, escalations: [...this.state.escalations, resolved] };
            this.resort();
        }
        this.emit();
        return resolved;
    }
    /**
     * Archive a goal: mark its phase `archived`. A no-op (still notifies) when the id
     * is unknown — a closeout goal may live only in the search corpus, never on home.
     */
    archiveGoal(id) {
        const goals = this.state.goals.map((goal) => goal.id === id ? { ...goal, phase: "archived" } : goal);
        this.state = { ...this.state, goals };
        this.resort();
        this.emit();
    }
    /**
     * Replace the backend-derived workflow lanes (from the workflow backend). The
     * native state (goals/loops/escalations) is untouched. Workflows keep insertion
     * order — this is the one mutation allowed to re-sort, but it's a stable no-op for
     * them. Notifies so the panel repaints when the fleet changes.
     */
    setWorkflows(workflows) {
        this.state = { ...this.state, workflows };
        this.resort();
        this.emit();
    }
    /** Replace the footer model (from the usage backend). Notifies. */
    setFooter(footer) {
        this.state = { ...this.state, footer };
        this.emit();
    }
    /** Recompute cached sort order. Called on construction and on every mutation. */
    resort() {
        this.state = {
            ...this.state,
            escalations: stableSort(this.state.escalations, compareEscalations),
            loops: stableSort(this.state.loops, (a, b) => loopRank(a) - loopRank(b)),
            // goals + workflows keep insertion (created) order — no re-sort.
        };
    }
    emit() {
        for (const callback of this.subscribers)
            callback();
    }
}
