import { RealDataSource } from "../data/real.js";
import type { UsagePort, WorkflowPort } from "../data/ports.js";
import { createHelmRepository } from "../state/persistence.js";

function withWorkflowAccounting(usage: UsagePort, workflows: WorkflowPort): UsagePort {
  const records = () => workflows.listUsageCostRecords();
  const formatCost = (cost: number) => `$${cost.toFixed(2)}`;
  return {
    ...usage,
    getAccountingSnapshot() {
      const base = usage.getAccountingSnapshot();
      const persisted = records();
      return {
        ...base,
        spentUsd: persisted.reduce((total, record) => total + record.costUsd, 0),
        records: persisted,
      };
    },
    getUsageDetail() {
      const base = usage.getUsageDetail();
      const persisted = records();
      const now = Date.now();
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      const weekStart = now - 7 * 86_400_000;
      const byGoal = new Map<string, { name: string; cost: number }>();
      for (const record of persisted) {
        if (!record.goalId) continue;
        const goal = byGoal.get(record.goalId) ?? { name: record.goalName ?? record.goalId, cost: 0 };
        goal.cost += record.costUsd;
        byGoal.set(record.goalId, goal);
      }
      return {
        ...base,
        spendToday: formatCost(persisted.filter((record) => record.at >= todayStart.getTime()).reduce((sum, record) => sum + record.costUsd, 0)),
        spendWeek: formatCost(persisted.filter((record) => record.at >= weekStart).reduce((sum, record) => sum + record.costUsd, 0)),
        perGoal: [...byGoal.values()]
          .sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name))
          .map((goal) => ({ name: goal.name, cost: formatCost(goal.cost) })),
      };
    },
  };
}

export function createHelmDataSource(
  deps: { workflows: WorkflowPort; usage: UsagePort },
  cwd = process.cwd(),
): RealDataSource {
  let source: RealDataSource | undefined;
  source = new RealDataSource({
    workflows: deps.workflows,
    usage: withWorkflowAccounting(deps.usage, deps.workflows),
    nativeState: {
      goals: [],
      workflows: [],
      loops: [],
      escalations: [],
      precedents: [],
      journal: [],
      pausedAll: false,
      footer: { cwd, providers: [] },
      mainModel: "",
    },
    trialLoop: async (id) => {
      const draft = source?.getLoopDraft(id);
      return draft ? deps.workflows.trialLoop(draft) : { ok: false };
    },
    synthDigest: () => ({
      spanText: "no recorded activity",
      spentText: "—",
      shippedGoals: [],
      shippedByLoops: [],
      decisionsQueued: [],
      failedHandled: [],
      quotaDrain: [],
    }),
    synthIntake: (id) => ({
      id,
      goalName: "new goal",
      goalPrompt: "",
      preamble: "Describe the outcome you want Pi to own.",
      questions: [],
      planWorkflows: [],
      estWall: "pending",
      estCost: "pending",
      escalationRule: "ambiguous or destructive decisions escalate to you",
      openQuestions: true,
    }),
    synthLoopDraft: (id, name) => ({
      id,
      name: name ?? "new loop",
      prompt: "",
      trigger: "manual until scheduled",
      steps: "describe → execute → verify → report",
      skips: "ambiguous or destructive work",
      guardrails: ["never merges", "requires review"],
      trialStatement: "run once under full review before scheduling",
    }),
    synthCloseout: (goalId) => ({
      goalId,
      goalName: "goal",
      startedText: "started by Helm",
      landedText: "in progress",
      packagesDone: 0,
      packagesTotal: 1,
      unit: "goal",
      addedText: "—",
      removedText: "—",
      commitsText: "—",
      greenText: "verification pending",
      actualCost: "see usage",
      estCost: "pending",
      yourTime: "—",
      interventions: "—",
      overrunWhy: "—",
      proposedPrecedents: [],
    }),
    shouldShowDigestFlag: false,
    repository: createHelmRepository(cwd),
  });
  return source;
}
