import { RealDataSource } from "../data/real.js";
import type { UsagePort, WorkflowPort } from "../data/ports.js";
import { createHelmRepository } from "../state/persistence.js";

export function createHelmDataSource(
  deps: { workflows: WorkflowPort; usage: UsagePort },
  cwd = process.cwd(),
): RealDataSource {
  let source: RealDataSource | undefined;
  source = new RealDataSource({
    workflows: deps.workflows,
    usage: deps.usage,
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
