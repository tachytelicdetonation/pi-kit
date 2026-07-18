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
import type { AuditRecord, Escalation, Goal, HelmFooterModel, HelmState, JournalEvent, Loop, PauseAllCheckpoint, Precedent, Workflow } from "./types.js";

/**
 * Stable comparator for the needs-you queue: oldest-blocked first, ties broken by
 * id so the order is deterministic across snapshots.
 */
function compareEscalations(a: Escalation, b: Escalation): number {
  if (a.blockedSinceMs !== b.blockedSinceMs) return a.blockedSinceMs - b.blockedSinceMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Rank a loop for the active-first ordering: paused loops sink below the rest.
 * Relative order among same-rank loops is preserved (stable sort) so nothing
 * jitters when only a paused reason changes.
 */
function loopRank(loop: Loop): number {
  return loop.health === "paused" ? 1 : 0;
}

/** Stable sort helper — Array.prototype.sort is spec-stable in modern V8, but we
 * decorate with the original index to make stability explicit and portable. */
function stableSort<T>(items: T[], compare: (a: T, b: T) => number): T[] {
  return items
    .map((value, index) => ({ value, index }))
    .sort((a, b) => compare(a.value, b.value) || a.index - b.index)
    .map((entry) => entry.value);
}

export class HelmStore {
  private state: HelmState;
  private readonly subscribers = new Set<() => void>();

  constructor(initial: HelmState) {
    this.state = {
      ...initial,
      loops: initial.loops.map((loop) => loop.health === "paused"
        ? { ...loop, scheduledState: "paused", pausedReason: loop.pausedReason ?? "paused — reason unavailable from legacy state" }
        : { ...loop, scheduledState: loop.scheduledState ?? loop.health }),
      decisions: [...(initial.decisions ?? [])],
      audit: [...(initial.audit ?? [])],
    };
    this.resort();
  }

  /** The current state. Reference is stable between mutations (safe to compare). */
  getState(): HelmState {
    return this.state;
  }

  /** Register a change listener; returns an unsubscribe function. */
  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /** Engage pause-all: freeze every lane mid-step. Idempotent. */
  pauseAll(checkpoint?: PauseAllCheckpoint): void {
    if (this.state.pausedAll) return;
    this.state = { ...this.state, pausedAll: true, pauseCheckpoint: checkpoint };
    this.emit();
  }

  /** Release pause-all. Idempotent. */
  resumeAll(): void {
    if (!this.state.pausedAll) return;
    this.state = { ...this.state, pausedAll: false, pauseCheckpoint: undefined };
    this.emit();
  }

  /**
   * Pause a single workflow lane by id. A no-op (still notifies) if the id is
   * unknown or the lane is already paused. Order is recomputed because a state
   * change is the one time re-sorting is allowed — though top-level workflow order
   * is insertion order, so this is a stable no-op for them today.
   */
  pauseWorkflow(id: string): void {
    const workflows = this.state.workflows.map((workflow) =>
      workflow.id === id && workflow.state !== "paused"
        ? { ...workflow, state: "paused" as const }
        : workflow,
    );
    this.state = { ...this.state, workflows };
    this.resort();
    this.emit();
  }

  resumeWorkflow(id: string): void {
    const workflows = this.state.workflows.map((workflow) =>
      workflow.id === id && workflow.state === "paused"
        ? { ...workflow, state: "running" as const }
        : workflow,
    );
    this.state = { ...this.state, workflows };
    this.resort();
    this.emit();
  }

  addGoal(goal: Goal): void {
    if (this.state.goals.some((item) => item.id === goal.id)) return;
    this.state = { ...this.state, goals: [...this.state.goals, goal] };
    this.emit();
  }

  updateGoal(id: string, update: Partial<Omit<Goal, "id">>): void {
    this.state = {
      ...this.state,
      goals: this.state.goals.map((goal) => goal.id === id ? { ...goal, ...update } : goal),
    };
    this.emit();
  }

  /** The only draft/trial -> scheduled transition. Existing definitions are replaced atomically. */
  scheduleLoop(loop: Loop): void {
    if (loop.lifecycle !== "scheduled" || !loop.activeDefinition) {
      throw new Error("scheduleLoop requires an accepted, trial-verified activeDefinition");
    }
    if (loop.health === "paused" && !loop.pausedReason?.trim()) {
      throw new Error("paused scheduled loops require pausedReason");
    }
    const found = this.state.loops.some((item) => item.id === loop.id);
    this.state = {
      ...this.state,
      loops: found ? this.state.loops.map((item) => item.id === loop.id ? loop : item) : [...this.state.loops, loop],
    };
    this.resort();
    this.emit();
  }

  /** Update runtime scheduler fields without replacing the immutable active definition. */
  updateScheduledLoop(id: string, update: Partial<Omit<Loop, "id" | "activeDefinition" | "lifecycle">>): void {
    const current = this.state.loops.find((loop) => loop.id === id);
    const next = current ? { ...current, ...update } : undefined;
    if (next?.health === "paused" && !next.pausedReason?.trim()) {
      throw new Error("paused scheduled loops require pausedReason");
    }
    this.state = {
      ...this.state,
      loops: this.state.loops.map((loop) => loop.id === id ? { ...loop, ...update, activeDefinition: loop.activeDefinition } : loop),
    };
    this.resort();
    this.emit();
  }

  setLoopPendingDraft(id: string, pendingDraft: Loop["pendingDraft"]): void {
    this.state = {
      ...this.state,
      loops: this.state.loops.map((loop) => loop.id === id ? { ...loop, pendingDraft } : loop),
    };
    this.emit();
  }

  toggleLoop(id: string): void {
    this.state = {
      ...this.state,
      loops: this.state.loops.map((loop) => loop.id === id
        ? {
            ...loop,
            health: loop.health === "paused" ? "healthy" as const : "paused" as const,
            scheduledState: loop.health === "paused" ? "healthy" as const : "paused" as const,
            pausedReason: loop.health === "paused" ? undefined : "paused by operator",
          }
        : loop),
    };
    this.resort();
    this.emit();
  }

  appendJournal(event: JournalEvent): void {
    if (this.state.journal.some((item) => item.id === event.id)) return;
    this.state = { ...this.state, journal: [...this.state.journal, event] };
    this.emit();
  }

  appendAudit(record: AuditRecord): void {
    if (this.state.audit?.some((item) => item.id === record.id)) return;
    this.state = { ...this.state, audit: [...(this.state.audit ?? []), record] };
    this.emit();
  }

  replacePrecedents(precedents: Precedent[]): void {
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
  decide(escalationId: string, index: number): void {
    const escalation = this.state.escalations.find((item) => item.id === escalationId);
    if (!escalation || index < 0 || index >= escalation.options.length) {
      this.emit();
      return;
    }
    const precedent = { ...buildPrecedent(escalation, index), goalId: escalation.goalId };
    this.state = {
      ...this.state,
      precedents: [...this.state.precedents, precedent],
      escalations: this.state.escalations.filter((item) => item.id !== escalationId),
      decisions: [...(this.state.decisions ?? []), { ...escalation, resolved: true, precedentNote: `decided: ${precedent.decision}` }],
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
  addEscalation(escalation: Escalation): Escalation {
    const resolved = autoResolve(escalation, this.state.precedents);
    if (!resolved.resolved) {
      this.state = { ...this.state, escalations: [...this.state.escalations, resolved] };
      this.resort();
    } else {
      this.state = { ...this.state, decisions: [...(this.state.decisions ?? []), resolved] };
    }
    this.emit();
    return resolved;
  }

  declinePrecedent(id: string): boolean {
    const precedent = this.state.precedents.find((item) => item.id === id);
    return precedent ? this.setPrecedentDeclined(precedent, true) : false;
  }

  /** Upsert the durable operator decision so closeout receipt copies cannot override it. */
  setPrecedentDeclined(precedent: Precedent, declined: boolean): boolean {
    const existing = this.state.precedents.find((item) => item.id === precedent.id);
    if (existing?.declined === declined) {
      this.emit();
      return false;
    }
    const canonical = { ...(existing ?? precedent), declined };
    this.state = {
      ...this.state,
      precedents: existing
        ? this.state.precedents.map((item) => item.id === precedent.id ? canonical : item)
        : [...this.state.precedents, canonical],
    };
    this.emit();
    return true;
  }

  /** Mark an accepted closeout precedent as durably applied to repository guidance. */
  applyPrecedent(precedent: Precedent): boolean {
    const existing = this.state.precedents.find((item) => item.id === precedent.id);
    const appliesTo = precedent.appliesTo ?? existing?.appliesTo ?? "claudeMd";
    if (existing?.appliesTo === appliesTo) {
      this.emit();
      return false;
    }
    const canonical = { ...(existing ?? precedent), declined: false, appliesTo };
    this.state = {
      ...this.state,
      precedents: existing
        ? this.state.precedents.map((item) => item.id === precedent.id ? canonical : item)
        : [...this.state.precedents, canonical],
    };
    this.emit();
    return true;
  }

  /** Update a still-active escalation (for persisted follow-up questions/answers). */
  updateEscalation(id: string, update: Partial<Omit<Escalation, "id">>): void {
    this.state = {
      ...this.state,
      escalations: this.state.escalations.map((item) => item.id === id ? { ...item, ...update } : item),
    };
    this.resort();
    this.emit();
  }

  /**
   * Archive a goal: mark its phase `archived`. A no-op (still notifies) when the id
   * is unknown — a closeout goal may live only in the search corpus, never on home.
   */
  archiveGoal(id: string): void {
    const goals = this.state.goals.map((goal) =>
      goal.id === id ? { ...goal, phase: "archived" as const } : goal,
    );
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
  setWorkflows(workflows: Workflow[]): void {
    this.state = { ...this.state, workflows };
    this.resort();
    this.emit();
  }

  /** Replace the footer model (from the usage backend). Notifies. */
  setFooter(footer: HelmFooterModel): void {
    this.state = { ...this.state, footer };
    this.emit();
  }

  /** Recompute cached sort order. Called on construction and on every mutation. */
  private resort(): void {
    this.state = {
      ...this.state,
      escalations: stableSort(this.state.escalations, compareEscalations),
      loops: stableSort(this.state.loops, (a, b) => loopRank(a) - loopRank(b)),
      // goals + workflows keep insertion (created) order — no re-sort.
    };
  }

  private emit(): void {
    for (const callback of this.subscribers) callback();
  }
}
