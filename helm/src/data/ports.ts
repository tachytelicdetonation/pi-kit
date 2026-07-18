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
import type { HelmFooterModel, Session, UsageDetail, Workflow, WorkflowDetail } from "../state/types.js";

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
  /** Fire when lanes/agents change (WorkflowManager events); returns unsubscribe. */
  subscribe(callback: () => void): () => void;
}

/** The usage/quota backend (usage-health UsageService, adapted). */
export interface UsagePort {
  /** The live footer model (provider budgets, burn, spend, ctx, cost, model). */
  getFooter(): HelmFooterModel;
  /** The ctrl+u popover detail (per-provider %, reset dates, spend, per-goal split). */
  getUsageDetail(): UsageDetail;
  /** Fire when quota snapshots refresh; returns unsubscribe. */
  subscribe(callback: () => void): () => void;
}
