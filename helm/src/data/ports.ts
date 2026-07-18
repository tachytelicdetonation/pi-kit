/**
 * Ports — the boundary between {@link RealDataSource} and the live backends.
 *
 * RealDataSource composes helm-native state (goals/loops/escalations/precedents,
 * owned by the HelmStore) with backend-derived slices pulled through these ports.
 * The SAME RealDataSource runs in tests (fakes) and production (adapters over the
 * dynamic-workflows WorkflowManager, claude-cmux fleet manager, and usage-health
 * UsageService) — only the port implementations differ. Keeping the surface this
 * small is what lets the conformance contract validate the composition hermetically.
 */
import type { HelmFooterModel, IntakeWorkflowPlan, LoopDraft, Session, UsageDetail, Workflow, WorkflowDetail } from "../state/types.js";

export interface UsageCostRecord {
  goalId?: string;
  goalName?: string;
  costUsd: number;
  at: number;
  contributor: string;
}

export interface UsageAccountingSnapshot {
  spentUsd: number;
  providerRemaining: Partial<Record<"codex" | "claude" | "kimi", number>>;
  records: UsageCostRecord[];
}

export interface WorkflowGoalMetrics {
  startedAtMs?: number;
  completedAtMs?: number;
  unitsDone: number;
  unitsTotal: number;
  unit: string;
  added?: number;
  removed?: number;
  commits?: number;
  verificationPassed: number;
  verificationTotal: number;
  costUsd?: number;
  interventions: number;
  largestCostContributor?: { name: string; costUsd: number };
}

/** The workflow/session backend (dynamic-workflows + claude-cmux, adapted). */
export interface WorkflowPort {
  /** The current top-level lanes → HelmState.workflows (subagent trees fold behind enter). */
  listWorkflows(): Workflow[];
  /** The 6c drill-in for a lane; `undefined` when unknown (caller declines to descend). */
  getDrillIn(workflowId: string): WorkflowDetail | undefined;
  /** The 4a transcript for a worktree; `undefined` when unknown. */
  getSession(worktreeId: string): Session | undefined;
  /** Ask the backend to pause a lane (the store also updates optimistically). */
  pauseWorkflow(id: string): void;
  /** Resume a paused lane. */
  resumeWorkflow(id: string): Promise<boolean>;
  /** Pause/resume all live workflow-manager lanes. */
  pauseAll(): void;
  resumeAll(): void;
  /** Launch the real workflow runs that implement a locked goal plan. */
  startGoal(input: {
    goalId: string;
    goalName: string;
    prompt: string;
    plan: IntakeWorkflowPlan[];
  }): Promise<string[]>;
  /** Execute one supervised loop trial through the workflow manager. */
  trialLoop(loop: LoopDraft): Promise<{ ok: boolean; runId?: string }>;
  /** Execute one due scheduled loop and resolve after its workflow verifies. */
  runLoop(loop: LoopDraft): Promise<{ ok: boolean; runId?: string }>;
  /** Completion/progress derived from all persisted runs belonging to a Helm goal. */
  getGoalProgress(goalId: string): { progress: number; complete: boolean } | undefined;
  /** Measured queue, receipt, verification, and accounting totals for one goal. */
  getGoalMetrics(goalId: string): WorkflowGoalMetrics | undefined;
  /** Persisted workflow/session cost ledger, including goal attribution. */
  listUsageCostRecords(): UsageCostRecord[];
  /** Fire when lanes/agents change (WorkflowManager events); returns unsubscribe. */
  subscribe(callback: () => void): () => void;
}

/** The usage/quota backend (usage-health UsageService, adapted). */
export interface UsagePort {
  /** The live footer model (provider budgets, burn, spend, ctx, cost, model). */
  getFooter(): HelmFooterModel;
  /** The ctrl+u popover detail (per-provider %, reset dates, spend, per-goal split). */
  getUsageDetail(): UsageDetail;
  /** Numeric lifetime spend/quota snapshot used as the persisted digest baseline. */
  getAccountingSnapshot(): UsageAccountingSnapshot;
  /** Fire when quota snapshots refresh; returns unsubscribe. */
  subscribe(callback: () => void): () => void;
}
