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

/** A user goal. Lifecycle: draft → running → complete → archived. */
export interface Goal {
  id: string;
  name: string;
  phase: "draft" | "running" | "complete" | "archived";
  /** Completion fraction in [0, 1]; rendered as an 8-cell bar + percent. */
  progress: number;
  /** Pre-rendered ETA hint, e.g. "~6h left". Optional (unknown for drafts). */
  etaText?: string;
  /** Durable lifecycle timestamps used by measured closeout receipts. */
  startedAtMs?: number;
  completedAtMs?: number;
  /** Original intake estimate, preserved verbatim for the closeout comparison. */
  estCost?: string;
}

/**
 * A TOP-LEVEL workflow (lane) under a goal. Subagent trees are NEVER modeled or
 * rendered on the home screen — they fold behind `enter` (Phase 3). Lifecycle:
 * running / verifying / queued / paused.
 */
export interface Workflow {
  id: string;
  goalId: string;
  name: string;
  state: "running" | "verifying" | "queued" | "paused";
  /** One-line status summary for the middle column. */
  summary: string;
  /** Purple model tag — set ONLY when this lane's model differs from the main session model. */
  modelTag?: string;
}

/**
 * A background loop. Lifecycle: draft → trial → scheduled, where a scheduled loop
 * is healthy / idle / paused-with-reason. Right-column text is chosen by which of
 * the optional fields is present (yield → idle/last-fired → next-run).
 */
export interface Loop {
  id: string;
  name: string;
  trigger: string;
  pipelineSummary: string;
  health: "healthy" | "idle" | "paused";
  pausedReason?: string;
  yieldToday?: string;
  costToday?: string;
  lastFired?: string;
  nextRun?: string;
  /** Durable scheduler cadence and next deadline (never read directly by renderers). */
  scheduleEveryMs?: number;
  nextRunAtMs?: number;
  /** Explicit persisted lifecycle; rows in HelmState.loops are always scheduled. */
  lifecycle?: "scheduled";
  /** Scheduled lifecycle substate. `health` is the renderer-compatible projection. */
  scheduledState?: "healthy" | "idle" | "paused";
  /** Definition used by every scheduled firing until an accepted trial promotes a replacement. */
  activeDefinition?: LoopDefinition;
  /** Edited definition awaiting a passed trial and explicit acceptance. */
  pendingDraft?: LoopDraft;
  /** Durable timestamp used to detect a missed interval and assign idle. */
  lastFiredAtMs?: number;
}

/** One numbered option on a 7b escalation card. Exactly one is `recommended`. */
export interface EscalationOption {
  text: string;
  requiresConfirm?: boolean;
  /** pi's recommended option — highlighted GREEN on the card. At most one true. */
  recommended?: boolean;
  /** Destructive/permission choices must pass through the app's y/n gate. */
  requiresConfirm?: boolean;
}

/**
 * A needs-you item: something blocked on an operator decision. `blockedSinceMs`
 * is the raw wall-clock start (for stable sort + age display); it is never used
 * to re-sort inside render.
 *
 * Phase 4 turns this into a full 7b decision card: a one-sentence {@link problem},
 * a MINIMAL {@link evidence} block (never the full file), numbered {@link options}
 * with one recommended, and a {@link signature} used to match precedents so an
 * identical future conflict auto-resolves (see {@link ./precedents.ts}).
 */
export interface Escalation {
  id: string;
  source: { kind: "goal" | "workflow" | "loop"; label: string };
  question: string;
  /** Action verb shown with the number key, e.g. "review", "answer". */
  verb: string;
  blockedSinceMs: number;
  /** Pre-rendered idle-cost hint, e.g. "$0.40 idle". Optional. */
  idleCost?: string;

  // ── 7b escalation card (Phase 4) ─────────────────────────────────────────
  /** ONE-sentence problem statement shown at the top of the card. */
  problem: string;
  /** The MINIMAL evidence block — a few lines (e.g. the 4-line conflict), never a full file. */
  evidence: string[];
  /** Numbered options (1..N); exactly one carries `recommended`. */
  options: EscalationOption[];
  /** Minutes blocked, rendered `blocked N min` in the header. */
  blockedMinutes: number;
  /** What is idle while you decide, e.g. "wt-3 idle while you decide". */
  idleNote: string;
  /** Normalized signature (`source.kind` + a conflict key) for precedent matching. */
  signature: string;
  /** Short phrase remembered as a precedent, e.g. "export maps → conditional block". */
  precedentPhrase?: string;
  /** The worktree `enter` opens; when absent a generic session id is derived. */
  worktreeId?: string;
  /** Set when auto-resolved by a matching precedent — flags "auto-resolved by precedent …". */
  precedentNote?: string;
  /** True once auto-resolved by precedent (kept out of the blocking queue). */
  resolved?: boolean;
  /** Owning goal when known, so resolved decisions can feed its closeout. */
  goalId?: string;
  /** Follow-up questions keep the card active and are persisted with it. */
  followUps?: { question: string; answer?: string; at: number }[];
  /** Only decision-class escalations may use precedents. */
  resolutionClass?: "decision" | "permission" | "approval";
  /** Stable decision-signature inputs. */
  conflictKind?: string;
  scope?: string;
}

/**
 * One pipeline chip on a worktree row — a single agent working a stage. Rendered
 * as {@link GLYPH.chip} in the stage color (fix=warning, review=purple,
 * apply=success). Grouped by stage into the `fix → review → apply` row.
 */
export interface WorktreeChip {
  stage: "fix" | "review" | "apply";
}

/**
 * A worktree row on the 6c drill-in: a package under active fix→review→apply
 * work, plus its own race-to-green test strip. `testState` + `statusTime` drive
 * the ROW's right column; `testTicks` + `raceStatus` + `raceTime` drive the
 * separate per-package race strip (a worktree with no `testTicks` has no strip).
 */
export interface Worktree {
  id: string;
  name: string;
  package: string;
  /** One chip per agent; render groups them by stage in fix→review→apply order. */
  chips: WorktreeChip[];
  /** Left/middle text for the row's right column, e.g. "252 applied" / "55 in review". */
  appliedText: string;
  /** Row-level test verdict (drives the right column's word + color). */
  testState: "green" | "wobbling" | "red";
  /** Pre-rendered clock for a green row, e.g. "14:02". Optional. */
  statusTime?: string;
  /** Purple model tag — set ONLY when this worktree runs a non-default model. */
  modelTag?: string;
  /** Race-to-green ticks (one per test run). Empty = no strip for this worktree. */
  testTicks: ("red" | "green")[];
  /** The race strip's aggregate status (may differ from the row's `testState`). */
  raceStatus?: "green" | "wobbling" | "red";
  /** Pre-rendered clock for a green strip, e.g. "14:02". Optional. */
  raceTime?: string;
}

/**
 * The 6c workflow drill-in detail: fleet counts for the header, the work-queue
 * burn-down numbers, and the worktree rows. `worktrees` is the array; the header
 * count is `worktrees.length` (never a separate wall-clock read).
 */
export interface WorkflowDetail {
  workflowId: string;
  /** Breadcrumb shown in the header, e.g. "esm › codemod". */
  label: string;
  /** Internal pipelines (NEVER called "loops" here — that word is reserved for 6b). */
  lanes: number;
  /** Total agents across the lanes (header: "· N agents"). */
  agents: number;
  /** Work-queue burn-down: remaining / total items, the unit word, hourly burn, ETA. */
  queueRemaining: number;
  queueTotal: number;
  queueUnit: string;
  burnPerHr: number;
  etaText: string;
  /** Free-text queue note shown on the right of the burn-down line. Optional. */
  queueNote?: string;
  worktrees: Worktree[];
}

/** The four first-class activity verbs on a 4a session line (9-char left column). */
export type ActivityVerb = "context" | "parallel" | "edit" | "verify";

/**
 * One activity line in a 4a session — an ACTION, not a tool log. `context` /
 * `parallel` / `verify` carry a `result` string (timing/receipt); `edit` carries
 * `added` / `removed` counts. An expandable line has a `peek` (3-line for edits,
 * 1-line for verify) and, for edits, a `moreCount` for the "… N more" hint.
 */
export interface ActivityLine {
  verb: ActivityVerb;
  /** Middle column: file for `edit`, joined summary for the rest. */
  target: string;
  /** Right column for context/parallel/verify (timing or receipt). Unused for edit. */
  result: string;
  /** `o` can expand this line to show its peek. */
  expandable?: boolean;
  /** The 3-line (edit) / 1-line (verify) peek shown when expanded. */
  peek?: string[];
  /** Hidden-line count for the "… N more · d full diff" hint (edits). */
  moreCount?: number;
  /** Lines added (edit) — rendered `+N` in success. */
  added?: number;
  /** Lines removed (edit) — rendered `−N` in error / dim when 0. */
  removed?: number;
}

/** Verification receipts shown on the 4a header right side. */
export interface SessionReceipts {
  build: boolean;
  lint: boolean;
  tests: number;
}

/**
 * A 4a per-worktree session (transcript). `prompt` is the turn's request (echoed
 * at the top), `lines` the activity transcript, `claim` the closing sentence.
 */
export interface Session {
  worktreeId: string;
  /** Header label, e.g. "add rate limiting to /api" (rendered as "task: …"). */
  task: string;
  /** The turn's request, echoed at the top of the transcript. */
  prompt: string;
  receipts: SessionReceipts;
  lines: ActivityLine[];
  claim: string;
}

/**
 * A stored decision precedent (written by 7b escalations and 7d closeout).
 *
 * `signature` matches an {@link Escalation.signature}: a subsequently-seen
 * escalation with the same signature auto-resolves against a non-`declined`
 * precedent. Production state persists these per project; mock state remains
 * intentionally in-memory for deterministic tests and previews.
 */
export interface Precedent {
  id: string;
  /** Signature of the conflict this precedent auto-resolves (matches Escalation.signature). */
  signature: string;
  /** The question that was decided (for the "/" search index + 7d proposal). */
  question: string;
  /** The chosen option's text. */
  decision: string;
  /** Why it was decided (recommendation accepted / operator override). */
  rationale: string;
  /** When true, the precedent is NEVER auto-applied (declined in 7d). */
  declined?: boolean;
  /** Where the precedent was proposed to live, if applied (7d). */
  appliesTo?: "claudeMd" | "skill";
  /** Goal whose escalation produced this decision, when attributable. */
  goalId?: string;
}

/** A single provider's overnight quota drain for the 7c digest footer. */
export interface QuotaDrain {
  provider: string;
  /** Percent change; 0 renders "untouched", negative renders "−N%". */
  deltaPercent: number;
}

/**
 * The 7c catch-up digest payload. Exactly four line types, rendered IN THIS ORDER:
 * shipped goals (✓), shipped by loops (✓), decisions queued (▲), failed-and-handled
 * (✕). Any section may be empty (omitted) but the relative order is preserved.
 */
export interface DigestData {
  /** Time span, e.g. "9:40 pm → 7:15 am". */
  spanText: string;
  /** Money spent while away, e.g. "$9.80 spent". */
  spentText: string;
  shippedGoals: string[];
  shippedByLoops: string[];
  decisionsQueued: string[];
  failedHandled: string[];
  /** Per-provider overnight quota drain shown on the right of the digest footer. */
  quotaDrain: QuotaDrain[];
}

/**
 * An activity-journal event feeding the catch-up digest (7c). Minimal shape.
 */
export interface JournalEvent {
  id: string;
  kind: JournalEventKind;
  timestampMs: number;
  label: string;
}

/**
 * Journal vocabulary. Only the first four user-visible receipt kinds feed digest
 * lines; goal/loop lifecycle events remain auditable without fabricating PRs.
 */
export type JournalEventKind =
  | "merged"
  | "prOpened"
  | "escalated"
  | "selfCaughtRevert"
  | "selfCaughtPaused"
  | "goalStarted"
  | "loopRunCompleted";

/** Durable append-only record for autonomous boundaries controlled by Helm. */
export interface AuditRecord {
  id: string;
  kind:
    | "goalStarted"
    | "runCompleted"
    | "pause"
    | "resume"
    | "autoResolve"
    | "precedentApplied"
    | "precedentDeclined"
    | "loopPromoted"
    | "selfCaughtPause";
  targetIds: string[];
  at: number;
  summary: string;
  detail: string;
}

/**
 * 6a — Intent-intake draft. A plain conversation (ZERO agents until "go"): pi asks
 * only the un-inferable questions (numbered), then proposes a PLAN — one line per
 * workflow. `openQuestions` is true while pi is still waiting on answers, which is
 * what renders the `g go` action DIM/disabled (locking intent is a no-op until the
 * questions are resolved). Everything is pre-rendered strings — no wall-clock.
 */
export interface IntakeWorkflowPlan {
  /** Workflow name, e.g. "codemod". */
  name: string;
  /** One-line description, e.g. "4 worktrees, per-package lanes". */
  description: string;
  /** Purple model tag — set ONLY when this workflow's model differs from the default. */
  modelTag?: string;
}

export interface IntakeDraft {
  id: string;
  /** The goal being shaped, echoed as the context, e.g. "migrate repo to ESM". */
  goalName: string;
  /** The operator's original request, echoed as a `❯` line. */
  goalPrompt: string;
  /** Lead-in to the questions, e.g. "Before I plan workflows — three things I can't infer:". */
  preamble: string;
  /** The un-inferable questions, rendered NUMBERED. */
  questions: string[];
  /** Structured form retained across re-planning; `questions` is its renderer projection. */
  questionDetails?: IntakeQuestion[];
  /** The operator's answer line (a `❯` echo), once they have replied. Optional. */
  userReply?: string;
  /** The PLAN block: one line per workflow. */
  planWorkflows: IntakeWorkflowPlan[];
  /** Pre-rendered wall-time estimate, e.g. "6-9h wall". */
  estWall: string;
  /** Pre-rendered cost estimate, e.g. "~$40". */
  estCost: string;
  /** The escalation rule, e.g. "export-map touches escalate to you". */
  escalationRule: string;
  /** True while pi still has open questions — `g go` renders dim/disabled. */
  openQuestions: boolean;
}

export interface IntakeQuestion {
  id: string;
  question: string;
  answer?: string;
}

/** One guardrail with a per-step model note, rendered with a purple model tag. */
export interface LoopGuardrailModel {
  /** The model, e.g. "haiku-5" (rendered purple). */
  model: string;
  /** The scope note, e.g. "for triage step". */
  note: string;
}

/**
 * 7a — Loop-builder draft. The operator describes a loop in prose; pi STRUCTURES it
 * into trigger / steps / skips / guardrails rows. A loop goes live ONLY after one
 * trial run under full review — `trialState` tracks that mandatory gate. A FAILED
 * trial reports and reopens the builder (never auto-retries).
 */
export interface LoopDraft {
  id: string;
  /** Loop name, e.g. "gh-issues", echoed as the context. */
  name: string;
  /** The operator's prose description, echoed as a `❯` line. */
  prompt: string;
  /** What fires the loop. */
  trigger: string;
  /** The pipeline steps, e.g. "triage → reproduce → fix → verify → PR". */
  steps: string;
  /** What the loop skips / escalates instead of handling. */
  skips: string;
  /** Guardrail chips, e.g. ["never merges", "$3/day cap", "max 3 concurrent"]. */
  guardrails: string[];
  /** Optional per-step model guardrail, rendered with a purple model tag. */
  guardrailModel?: LoopGuardrailModel;
  /** The trial statement, e.g. "run once on issue #4307 under full review …". */
  trialStatement: string;
  /** Durable proof that the current draft definition passed its supervised trial. */
  trialPassed?: boolean;
  /** Explicit persisted builder lifecycle. */
  lifecycle?: "draft" | "trial" | "scheduled";
  /** Machine-readable last trial receipt; failures reopen lifecycle=draft. */
  lastTrialVerdict?: TrialVerdict;
}

/** Immutable executable subset promoted to a scheduled loop. */
export type LoopDefinition = Omit<LoopDraft, "trialPassed" | "lifecycle" | "lastTrialVerdict">;

export interface TrialVerdict {
  passed: boolean;
  evidence: string[];
  runId?: string;
  /** Compatibility projection for pre-contract callers. */
  ok?: boolean;
}

/** The 7a trial gate view state, seeded from the draft's durable trial result. */
export type TrialState = "idle" | "trialing" | "passed" | "failed";

/**
 * 7d — Goal closeout receipt. What LANDED, what it COST, how much of the operator's
 * attention it consumed, and why the estimate slipped — then the goal's friction
 * turned into one-key PRECEDENTS (the SAME store as 7b). Formatted values are
 * pre-rendered strings (the codebase's no-wall-clock discipline). DECLINED
 * precedents are filtered out before proposal, so they are never re-proposed.
 */
export interface Closeout {
  goalId: string;
  /** The goal name, e.g. "migrate repo to ESM". */
  goalName: string;
  /** Pre-rendered start marker, e.g. "started tue 9:04 am". */
  startedText: string;
  /** Pre-rendered landing marker, e.g. "landed thu 3:12 pm". */
  landedText: string;
  /** Big receipt count numerator/denominator, e.g. 17 / 17 packages. */
  packagesDone: number;
  packagesTotal: number;
  /** The receipt's unit word, e.g. "packages". */
  unit: string;
  /** Pre-rendered added/removed line counts, e.g. "+41.2k" / "−38.7k". */
  addedText: string;
  removedText: string;
  /** Pre-rendered commit + green summaries, e.g. "611 commits" / "100% green". */
  commitsText: string;
  greenText: string;
  /** Actual cost vs the original estimate, e.g. "$61.40" / "~$40". */
  actualCost: string;
  estCost: string;
  /** `your time` row: decisions count + total attention. */
  yourTime: string;
  /** `interventions` row. */
  interventions: string;
  /** `overrun why` row. */
  overrunWhy: string;
  /** Proposed precedents (NUMBERED). Declined ones are already filtered out. */
  proposedPrecedents: Precedent[];
  /** Optional "next" nudge, e.g. "pi suggests …". */
  nextSuggestion?: string;
}

/** One provider's detail row in the ctrl+u usage popover. */
export interface UsageProviderDetail {
  id: "codex" | "claude" | "kimi";
  /** Remaining budget percent [0, 100]. */
  remaining: number;
  /** Pre-rendered reset hint, e.g. "resets in 3d". */
  resetText: string;
}

/** One goal's cost slice in the ctrl+u usage popover. */
export interface UsageGoalCost {
  name: string;
  /** Pre-rendered cost, e.g. "$4.20". */
  cost: string;
}

/**
 * The ctrl+u usage popover detail: per-provider % + reset dates, spend today/week,
 * and the per-goal cost split. Drawn as a centered bordered overlay OVER the body.
 */
export interface UsageDetail {
  providers: UsageProviderDetail[];
  /** Pre-rendered spend totals, e.g. "$18.40" / "$96.20". */
  spendToday: string;
  spendWeek: string;
  perGoal: UsageGoalCost[];
}

/** A single provider's remaining-budget snapshot, in fixed provider order. */
export interface FooterProvider {
  id: "codex" | "claude" | "kimi";
  /** Remaining budget percent [0, 100]; undefined = unknown (renders gray, no invented %). */
  remaining?: number;
}

/**
 * Everything the helm footer renders. `providers` is the multi-provider budget;
 * the remaining fields are ambient session/fleet facts. Session variant uses
 * `ctxPercent` + `costUsd`; fleet variant uses `burnRatePerMin` + `spendTodayUsd`.
 */
export interface HelmFooterModel {
  cwd?: string;
  branch?: string;
  providers: FooterProvider[];
  ctxPercent?: number;
  costUsd?: number;
  burnRatePerMin?: number;
  spendTodayUsd?: number;
  model?: string;
  effort?: string;
}

/**
 * The complete home-screen state. Arrays are stored already-sorted (the store
 * caches order on mutation) so selectors and the renderer are pure passthroughs.
 */
export interface HelmState {
  goals: Goal[];
  workflows: Workflow[];
  loops: Loop[];
  escalations: Escalation[];
  precedents: Precedent[];
  journal: JournalEvent[];
  /** Resolved and auto-resolved escalations are retained forever for audit/search. */
  decisions?: Escalation[];
  /** Append-only autonomous-action corpus. */
  audit?: AuditRecord[];
  /** True while ctrl+p pause-all is engaged (footer turns yellow). */
  pausedAll: boolean;
  pauseCheckpoint?: PauseAllCheckpoint;
  footer: HelmFooterModel;
  /** The main session model; workflows tag themselves only when they differ from it. */
  mainModel: string;
}

export interface PauseAllCheckpoint {
  runIds: string[];
  loops: { loopId: string; remainingDelayMs: number }[];
  pausedAt: number;
}
