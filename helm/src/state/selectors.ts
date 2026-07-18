/**
 * Pure derivations over {@link HelmState}.
 *
 * Every function here is a pure passthrough / count — no wall-clock reads, no
 * sorting (the store owns order). They are the single source of truth for the
 * numbers the header, sections and selection logic show, so the renderer and the
 * key dispatcher agree exactly on counts and row ordering.
 */
import type { HelmFooterModel, HelmState, Workflow } from "./types.js";

/** How many needs-you items are queued (the header count). */
export function needsYouCount(state: HelmState): number {
  return state.escalations.length;
}

/** Top-level workflows belonging to a goal, in stored (insertion) order. */
export function workflowsForGoal(state: HelmState, goalId: string): Workflow[] {
  return state.workflows.filter((workflow) => workflow.goalId === goalId);
}

/** Active loops = everything not paused (the "(N active)" header count). */
export function activeLoopCount(state: HelmState): number {
  return state.loops.filter((loop) => loop.health !== "paused").length;
}

/**
 * Split a [0, 1] progress fraction into filled / empty cells of an 8-cell bar.
 * e.g. 0.6 → { filled: 5, empty: 3 }. Non-finite / out-of-range inputs clamp.
 */
export function progressBar8(progress: number): { filled: number; empty: number } {
  const clamped = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  const filled = Math.round(clamped * 8);
  return { filled, empty: 8 - filled };
}

/** Footer numbers passthrough (kept a selector so call sites never reach into state). */
export function footerModel(state: HelmState): HelmFooterModel {
  return state.footer;
}

/** A single selectable row on the home screen (needs-you / goal / workflow / loop). */
export interface SelectableRow {
  kind: "escalation" | "goal" | "workflow" | "loop";
  id: string;
}

/**
 * The flat, ordered list of selectable rows — the SAME order the renderer walks:
 * escalations first, then each goal followed by its top-level workflows, then
 * loops. Section headers are NOT selectable. The renderer's highlight index
 * and the key dispatcher's selection index both index into this list, so they can
 * never disagree about which row is "current".
 */
export function selectableRows(state: HelmState): SelectableRow[] {
  const rows: SelectableRow[] = [];
  for (const escalation of state.escalations) rows.push({ kind: "escalation", id: escalation.id });
  for (const goal of state.goals) {
    rows.push({ kind: "goal", id: goal.id });
    for (const workflow of workflowsForGoal(state, goal.id)) rows.push({ kind: "workflow", id: workflow.id });
  }
  for (const loop of state.loops) rows.push({ kind: "loop", id: loop.id });
  return rows;
}

/** Count of selectable rows (for clamping selection). */
export function selectableCount(state: HelmState): number {
  return selectableRows(state).length;
}

/**
 * The next needs-you item for the tab triage walk. With no `currentId` (tab from
 * anywhere else) it is the FIRST queued escalation; from an escalation it is the
 * NEXT one in queue order, WRAPPING at the end so the walk never dead-ends. Returns
 * `undefined` when the queue is empty (caller no-ops, staying put).
 */
export function nextNeedsYouId(state: HelmState, currentId?: string): string | undefined {
  const queue = state.escalations;
  if (queue.length === 0) return undefined;
  if (!currentId) return queue[0].id;
  const index = queue.findIndex((escalation) => escalation.id === currentId);
  if (index < 0) return queue[0].id;
  return queue[(index + 1) % queue.length].id;
}
