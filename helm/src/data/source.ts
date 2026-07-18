/**
 * DataSource — the boundary between helm's UI and whatever feeds it.
 *
 * Reads and commands share this boundary so renderers stay pure while every
 * advertised key has one explicit, testable operation.
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
  TrialVerdict,
  UsageDetail,
  WorkflowDetail,
} from "./../state/types.js";

/** The corpus a `/` search spans — everything, ARCHIVED included (search is forever). */
export type SearchKind = "goal" | "workflow" | "loop" | "pr" | "decision" | "precedent" | "loopRun" | "audit";

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

export type HelmCommand =
  | { type: "goal.createDraft"; prompt: string; draftId?: string }
  | { type: "goal.answer"; draftId: string; text: string }
  | { type: "goal.editPlan"; draftId: string; index: number; text: string }
  | { type: "goal.discardDraft"; draftId: string }
  | { type: "goal.spawn"; draftId: string }
  | { type: "goal.togglePause"; goalId: string }
  | { type: "goal.archive"; goalId: string }
  | { type: "goal.applyPrecedents"; goalId: string }
  | { type: "goal.report"; goalId: string }
  | { type: "loop.createDraft"; prompt: string; draftId?: string }
  | { type: "loop.edit"; loopId: string; text: string }
  | { type: "loop.discardDraft"; loopId: string }
  | { type: "loop.schedule"; loopId: string }
  | { type: "loop.togglePause"; loopId: string }
  | { type: "workflow.togglePause"; workflowId: string }
  | { type: "worktree.togglePause"; workflowId: string; worktreeId: string }
  | { type: "worktree.reassign"; workflowId: string; worktreeId: string }
  | { type: "worktree.testDetails"; workflowId: string; worktreeId: string }
  | { type: "session.diff"; worktreeId: string }
  | { type: "session.merge"; worktreeId: string }
  | { type: "session.steer"; worktreeId: string; text: string }
  | { type: "escalation.ask"; escalationId: string; text: string }
  | { type: "digest.fullLog" };

export interface HelmCommandResult {
  /** Newly-created goal/loop/draft/run id. */
  id?: string;
  ok?: boolean;
  message?: string;
  /** Read-only document to show inside Helm. */
  document?: { title: string; lines: string[] };
  /** A judgment/destructive task intentionally handed to Pi's normal agent. */
  agentPrompt?: string;
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
  /** The recorded decision precedents (durable in the production source). */
  precedents(): Precedent[];
  /** Persistently decline a proposed precedent; it will never be proposed/applied again. */
  declinePrecedent(id: string): void;
  /** Persist a closeout digit toggle immediately; optional for legacy/custom sources. */
  setPrecedentDeclined?(precedent: Precedent, declined: boolean): void;
  /** Append an answer to an existing follow-up without resolving/closing the card. */
  answerEscalationFollowUp(escalationId: string, questionAt: number, answer: string): void;

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
  trialLoop(id: string): Promise<TrialVerdict>;
  /** Search everything — goals, PRs, decisions, precedents, loop runs; ARCHIVED included. */
  search(query: string): SearchResult[];

  /** Execute one user-visible Helm command. Every advertised key routes here. */
  execute(command: HelmCommand): Promise<HelmCommandResult>;
}
