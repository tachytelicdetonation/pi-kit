import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TuiLike } from "../../src/app.js";
import type { UsagePort, WorkflowPort } from "../../src/data/ports.js";
import { RealDataSource, type RealDataSourceDeps } from "../../src/data/real.js";
import { createHelmRepository } from "../../src/state/persistence.js";
import type {
  Closeout,
  DigestData,
  HelmState,
  IntakeDraft,
  LoopDraft,
  Session,
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
  loopRuns: LoopDraft[];
}

export interface SourceOptions {
  state?: Partial<HelmState>;
  workflows?: Workflow[];
  details?: Map<string, WorkflowDetail>;
  sessions?: Map<string, Session>;
  usage?: UsageDetail;
  footer?: HelmState["footer"];
  trialResult?: { ok: boolean };
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

export function makePersistentSource(root: string, options: SourceOptions = {}) {
  const statePath = join(root, ".helm-test", "state.json");
  const spies: WorkflowSpies = {
    started: [], paused: [], resumed: [], pauseAll: 0, resumeAll: 0, trials: [], loopRuns: [],
  };
  const workflowPort: WorkflowPort = {
    listWorkflows: () => options.workflows ?? [],
    getDrillIn: (id) => options.details?.get(id),
    getSession: (id) => options.sessions?.get(id),
    pauseWorkflow: (id) => { spies.paused.push(id); },
    resumeWorkflow: async (id) => { spies.resumed.push(id); return true; },
    pauseAll: () => { spies.pauseAll += 1; },
    resumeAll: () => { spies.resumeAll += 1; },
    startGoal: async (input) => {
      spies.started.push({ goalId: input.goalId, prompt: input.prompt });
      return input.plan.map((_, index) => `run-${index + 1}`);
    },
    trialLoop: async (loop) => {
      spies.trials.push(loop.id);
      return { ok: options.trialResult?.ok ?? true, runId: `trial-${loop.id}` };
    },
    runLoop: async (loop) => {
      spies.loopRuns.push(structuredClone(loop));
      return { ok: true, runId: `run-${loop.id}` };
    },
    getGoalProgress: () => undefined,
    subscribe: () => () => {},
  };
  const usagePort: UsagePort = {
    getFooter: () => options.footer ?? options.state?.footer ?? { cwd: root, providers: [] },
    getUsageDetail: () => options.usage ?? { providers: [], spendToday: "$0.00", spendWeek: "$0.00", perGoal: [] },
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
    trialLoop: async () => options.trialResult ?? { ok: true },
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
