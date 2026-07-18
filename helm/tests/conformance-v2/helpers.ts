import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TuiLike } from "../../src/app.js";
import type { UsageAccountingSnapshot, UsagePort, WorkflowGoalMetrics, WorkflowPort } from "../../src/data/ports.js";
import { RealDataSource, type RealDataSourceDeps } from "../../src/data/real.js";
import { createHelmRepository } from "../../src/state/persistence.js";
import type {
  Closeout,
  DigestData,
  HelmState,
  IntakeDraft,
  IntakeQuestion,
  LoopDefinition,
  LoopDraft,
  Session,
  TrialVerdict,
  UsageDetail,
  Workflow,
  WorkflowDetail,
} from "../../src/state/types.js";

export const theme256 = { getColorMode: () => "256color" as const };
export const themeTruecolor = { getColorMode: () => "truecolor" as const };

export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

export function stripLines(lines: string[]): string[] {
  return lines.map(stripAnsi);
}

export function fakeTui(rows = 40, columns = 120): TuiLike {
  return { terminal: { rows, columns }, requestRender() {} };
}

export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

export interface WorkflowSpies {
  started: Array<{ goalId: string; prompt: string }>;
  paused: string[];
  resumed: string[];
  pauseAll: number;
  resumeAll: number;
  trials: string[];
  loopRuns: LoopDefinition[];
}

export interface SourceOptions {
  state?: Partial<HelmState>;
  workflows?: Workflow[];
  details?: Map<string, WorkflowDetail>;
  sessions?: Map<string, Session>;
  usage?: UsageDetail;
  footer?: HelmState["footer"];
  trialResult?: Partial<TrialVerdict> & { ok: boolean };
  shouldShowDigest?: boolean;
  repository?: boolean;
  deps?: Partial<RealDataSourceDeps>;
}

export function emptyState(cwd: string, overrides: Partial<HelmState> = {}): HelmState {
  return {
    goals: [],
    workflows: [],
    loops: [],
    escalations: [],
    precedents: [],
    journal: [],
    pausedAll: false,
    footer: { cwd, providers: [] },
    mainModel: "gpt-default",
    ...overrides,
  };
}

function emptyDigest(): DigestData {
  return {
    spanText: "—",
    spentText: "$0.00 spent",
    shippedGoals: [],
    shippedByLoops: [],
    decisionsQueued: [],
    failedHandled: [],
    quotaDrain: [],
  };
}

function placeholderIntake(id: string): IntakeDraft {
  return {
    id,
    goalName: "test goal",
    goalPrompt: "test goal",
    preamble: "Need clarification",
    questions: [],
    planWorkflows: [],
    estWall: "unknown",
    estCost: "unknown",
    escalationRule: "ask",
    openQuestions: false,
  };
}

function placeholderLoop(id: string): LoopDraft {
  return {
    id,
    name: id,
    prompt: "every hour verify",
    trigger: "every hour",
    steps: "verify",
    skips: "none",
    guardrails: ["review required"],
    trialStatement: "one supervised trial",
  };
}

function placeholderCloseout(goalId: string): Closeout {
  return {
    goalId,
    goalName: goalId,
    startedText: "started",
    landedText: "landed",
    packagesDone: 0,
    packagesTotal: 0,
    unit: "packages",
    addedText: "+0",
    removedText: "−0",
    commitsText: "0 commits",
    greenText: "0% green",
    actualCost: "$0.00",
    estCost: "$0.00",
    yourTime: "0 decisions · 0 min",
    interventions: "0",
    overrunWhy: "none",
    proposedPrecedents: [],
  };
}

function parseMoney(value: string | undefined): number {
  const match = value?.match(/\$\s*([\d,.]+)/);
  const parsed = Number(match?.[1]?.replaceAll(",", "") ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function accountingSnapshot(usage: UsageDetail | undefined): UsageAccountingSnapshot {
  if (!usage) return { spentUsd: 0, providerRemaining: {}, records: [] };
  return {
    spentUsd: parseMoney(usage.spendWeek),
    providerRemaining: Object.fromEntries(usage.providers.map(({ id, remaining }) => [id, remaining])),
    records: usage.perGoal.map((goal, index) => ({
      goalName: goal.name,
      costUsd: parseMoney(goal.cost),
      at: index,
      contributor: goal.name,
    })),
  };
}

function deterministicPlan(prompt: string, answers: IntakeQuestion[]) {
  const answered = answers.filter((question) => question.answer?.trim());
  const detail = answered.at(-1)?.answer?.trim() || prompt.trim();
  const vague = !detail || /^(improve|fix|build|make|update)(?:\s+(?:it|this|that))?[.!]?$/i.test(detail);
  const questions = vague
    ? [{ id: "outcome", question: "What measurable outcome and scope should this goal achieve?" }]
    : answers.map((question) => ({ ...question }));
  const words = detail.split(/\s+/).filter(Boolean);
  const planName = words.slice(0, 3).join("-").toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "execute";
  return {
    questions,
    plan: [{ name: planName, description: `Implement and verify: ${detail || "clarify the requested outcome"}` }],
    estWall: words.length > 12 ? "2-4h" : "1-2h",
    estCost: words.length > 12 ? "~$12" : "~$8",
    escalationRule: `Escalate decisions outside: ${detail || "the clarified scope"}`,
  };
}

export function makePersistentSource(root: string, options: SourceOptions = {}) {
  const statePath = join(root, ".helm-test", "state.json");
  const spies: WorkflowSpies = {
    started: [], paused: [], resumed: [], pauseAll: 0, resumeAll: 0, trials: [], loopRuns: [],
  };
  const pausedWorkflows = new Set((options.workflows ?? []).filter((workflow) => workflow.state === "paused").map((workflow) => workflow.id));
  const pausedWorktrees = new Set<string>();
  const zeroGoalMetrics: WorkflowGoalMetrics = {
    unitsDone: 0,
    unitsTotal: 0,
    unit: "work units",
    added: 0,
    removed: 0,
    commits: 0,
    verificationPassed: 0,
    verificationTotal: 1,
    costUsd: 0,
    interventions: 0,
  };
  const workflowPort: WorkflowPort = {
    listWorkflows: () => options.workflows ?? [],
    getDrillIn: (id) => options.details?.get(id),
    getSession: (id) => options.sessions?.get(id),
    pauseWorkflow: (id) => { spies.paused.push(id); pausedWorkflows.add(id); },
    resumeWorkflow: async (id) => { spies.resumed.push(id); pausedWorkflows.delete(id); return true; },
    pauseWorktree: (id) => { pausedWorktrees.add(id); return true; },
    resumeWorktree: (id) => pausedWorktrees.delete(id),
    isWorktreePaused: (id) => pausedWorktrees.has(id),
    pauseAll: () => {
      spies.pauseAll += 1;
      const transitioned = (options.workflows ?? []).filter((workflow) => !pausedWorkflows.has(workflow.id)).map((workflow) => workflow.id);
      for (const id of transitioned) pausedWorkflows.add(id);
      return transitioned;
    },
    resumeAll: (runIds) => {
      spies.resumeAll += 1;
      for (const id of runIds) pausedWorkflows.delete(id);
    },
    planGoal: async ({ prompt, answers }) => deterministicPlan(prompt, answers),
    startGoal: async (input) => {
      spies.started.push({ goalId: input.goalId, prompt: input.prompt });
      return input.plan.map((_, index) => `run-${index + 1}`);
    },
    trialLoop: async (loop) => {
      spies.trials.push(loop.id);
      const passed = options.trialResult?.passed ?? options.trialResult?.ok ?? true;
      return {
        passed,
        evidence: options.trialResult?.evidence ?? [passed ? "supervised trial passed" : "supervised trial failed"],
        ok: passed,
        runId: options.trialResult?.runId ?? `trial-${loop.id}`,
      };
    },
    runLoop: async (loop) => {
      spies.loopRuns.push(structuredClone(loop));
      return { ok: true, runId: `run-${loop.id}` };
    },
    getGoalProgress: () => undefined,
    getGoalMetrics: () => zeroGoalMetrics,
    listUsageCostRecords: () => accountingSnapshot(options.usage).records,
    subscribe: () => () => {},
  };
  const usagePort: UsagePort = {
    getFooter: () => options.footer ?? options.state?.footer ?? { cwd: root, providers: [] },
    getUsageDetail: () => options.usage ?? { providers: [], spendToday: "$0.00", spendWeek: "$0.00", perGoal: [] },
    getAccountingSnapshot: () => accountingSnapshot(options.usage),
    subscribe: () => () => {},
  };
  const repository = options.repository === false
    ? undefined
    : options.deps?.repository ?? createHelmRepository(root, statePath);
  if (repository && options.state) {
    const loaded = repository.load();
    repository.save({
      ...loaded,
      goals: options.state.goals ?? loaded.goals,
      loops: options.state.loops ?? loaded.loops,
      escalations: options.state.escalations ?? loaded.escalations,
      precedents: options.state.precedents ?? loaded.precedents,
      journal: options.state.journal ?? loaded.journal,
    });
  }
  const deps: RealDataSourceDeps = {
    workflows: workflowPort,
    usage: usagePort,
    nativeState: emptyState(root, options.state),
    synthDigest: emptyDigest,
    synthIntake: placeholderIntake,
    synthLoopDraft: placeholderLoop,
    synthCloseout: placeholderCloseout,
    shouldShowDigestFlag: options.shouldShowDigest ?? false,
    repository,
    ...options.deps,
  };
  return { source: new RealDataSource(deps), spies, statePath, deps };
}

export async function withTempProject<T>(run: (root: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "helm-conformance-v2-"));
  try {
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
