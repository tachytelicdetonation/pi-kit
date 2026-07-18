import { RealDataSource } from "../data/real.js";
import { seedCloseout, seedDigest, seedIntake, seedLoopDraft } from "../data/mock.js";
import type { UsagePort, WorkflowPort } from "../data/ports.js";

export function createHelmDataSource(deps: { workflows: WorkflowPort; usage: UsagePort }): RealDataSource {
  return new RealDataSource({
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
      footer: { providers: [] },
      mainModel: "",
    },
    trialLoop: async () => ({ ok: true }),
    synthDigest: () => seedDigest(),
    synthIntake: (id) => seedIntake(id),
    synthLoopDraft: (id, name) => seedLoopDraft(id, name),
    synthCloseout: (goalId) => seedCloseout(goalId),
    shouldShowDigestFlag: false,
  });
}
