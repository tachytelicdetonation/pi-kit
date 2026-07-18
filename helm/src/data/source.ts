/**
 * DataSource — the boundary between helm's UI and whatever feeds it.
 *
 * Phase 2 only exercises the read + pause surface (`snapshot`, `subscribe`,
 * `pauseAll`, `resumeAll`, `pauseWorkflow`); the full interface is declared now so
 * later phases (decide/archive/trial/search) plug in without reshaping call sites.
 * The unimplemented methods are clearly marked in {@link ./mock.ts}.
 */
import type { Screen } from "./../router.js";
import type {
  Closeout,
  DigestData,
  Escalation,
  HelmState,
  IntakeDraft,
  LoopDraft,
  Precedent,
  Session,
  UsageDetail,
  WorkflowDetail,
} from "./../state/types.js";

/** The corpus a `/` search spans — everything, ARCHIVED included (search is forever). */
export type SearchKind = "goal" | "workflow" | "loop" | "pr" | "decision" | "precedent" | "loopRun";

/**
 * A single search hit: a kind badge, a label (+ optional sublabel for context such
 * as "archived"), and the screen `enter` navigates to. `screen` is `undefined` for
 * a kind that has no dedicated screen yet — the app falls back to a sensible target.
 */
export interface SearchResult {
  kind: SearchKind;
  label: string;
  sublabel?: string;
  screen?: Screen;
}

export interface DataSource {
  /** The current, fully-sorted state (stable reference between mutations). */
  snapshot(): HelmState;
  /** Subscribe to state changes; returns an unsubscribe function. */
  subscribe(callback: () => void): () => void;

  /** Engage / release the global pause (freeze every lane mid-step). */
  pauseAll(): void;
  resumeAll(): void;
  /** Pause a single workflow lane by id. */
  pauseWorkflow(id: string): void;

  /**
   * The 6c drill-in detail for a workflow lane (Phase 3). `undefined` when the id
   * is unknown so the caller can decline to descend rather than dead-end.
   */
  getDrillIn(workflowId: string): WorkflowDetail | undefined;
  /** The 4a session transcript for a worktree (Phase 3). `undefined` when unknown. */
  getSession(worktreeId: string): Session | undefined;

  // ── 7b escalations + precedents (Phase 4) ────────────────────────────────
  /**
   * Resolve an escalation by choosing one of its numbered options. Records the
   * decision as a PRECEDENT and removes the escalation from the queue.
   */
  decide(escalationId: string, option: number): Promise<void>;
  /** One escalation by id (`undefined` when unknown / already resolved). */
  getEscalation(id: string): Escalation | undefined;
  /** The needs-you queue in order (the tab triage walk + `[ ]` cycle order). */
  listEscalations(): Escalation[];
  /** The recorded decision precedents (in-memory in Phase 4). */
  precedents(): Precedent[];

  // ── 7c catch-up digest (Phase 4) ─────────────────────────────────────────
  /** The catch-up digest payload (four line types + quota drain). */
  getDigest(): DigestData;
  /** True when away long enough (>30 min) to show the digest on launch. */
  shouldShowDigest(): boolean;

  // ── 6a / 7a / 7d drafts + closeout (Phase 5) ─────────────────────────────
  /** The 6a intent-intake draft for a goal (`undefined` when the id is unknown). */
  getIntake(draftId: string): IntakeDraft | undefined;
  /** The 7a loop-builder draft (synthesized for any id, like a session). */
  getLoopDraft(loopId: string): LoopDraft | undefined;
  /** The 7d closeout receipt for a completed goal (`undefined` when unknown). */
  getCloseout(goalId: string): Closeout | undefined;

  // ── Global features (Phase 5) ────────────────────────────────────────────
  /** The ctrl+u usage-popover detail (per-provider %, reset dates, spend, per-goal split). */
  getUsageDetail(): UsageDetail;
  /**
   * Add a new escalation to the needs-you queue (or auto-resolve it against a
   * precedent). Drives the "bell on a new needs-you item" heuristic in the app.
   */
  addEscalation(escalation: Escalation): void;

  // ── Archive + trial + search (Phase 5) ───────────────────────────────────
  /** Archive a completed goal (search still finds it — archived is forever). */
  archiveGoal(id: string): void;
  /** Run a loop's mandatory trial under full review. Resolves ok/failed once. */
  trialLoop(id: string): Promise<{ ok: boolean }>;
  /** Search everything — goals, PRs, decisions, precedents, loop runs; ARCHIVED included. */
  search(query: string): SearchResult[];
}
