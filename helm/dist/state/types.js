/**
 * Typed state models for helm's mission-control surface.
 *
 * These mirror the "State Management" section of the stage-4 handoff. Phase 2
 * fully uses {@link Goal}, {@link Workflow}, {@link Loop}, {@link Escalation} and
 * {@link HelmFooterModel}; {@link Precedent} and {@link JournalEvent} are declared
 * now (minimal shapes) so later phases plug in without reshaping {@link HelmState}.
 *
 * A note on discipline: nothing here is derived from wall-clock time at render.
 * Ages/ETAs are pre-rendered strings (`etaText`, `lastFired`, …) or raw millis
 * (`blockedSinceMs`) sorted ONCE on mutation — the store caches order so rows
 * never jitter on a progress tick. See {@link ./store.ts}.
 */
export {};
