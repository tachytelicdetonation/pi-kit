import { removeTempDir, tempDir } from "./helpers/tmp.js";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { RealDataSource } from "../src/data/real.js";
import type { UsagePort, WorkflowPort } from "../src/data/ports.js";
import { createHelmRepository } from "../src/state/persistence.js";
import type { Closeout, Escalation, HelmState, LoopDefinition, Precedent } from "../src/state/types.js";

function workflowPort(overrides: Partial<WorkflowPort> = {}): WorkflowPort {
  return {
    listWorkflows: () => [],
    getDrillIn: () => undefined,
    getSession: () => undefined,
    pauseWorkflow: () => {},
    resumeWorkflow: () => Promise.resolve(true),
    pauseWorktree: () => true,
    resumeWorktree: () => true,
    isWorktreePaused: () => false,
    pauseAll: () => [],
    resumeAll: () => {},
    planGoal: async ({ prompt }) => ({ questions: prompt ? [] : [{ id: "outcome", question: "What outcome?" }], plan: [{ name: "execute", description: "implement and verify" }], estWall: "1-3h", estCost: "~$8-20", escalationRule: "ambiguous decisions escalate" }),
    startGoal: () => Promise.resolve(["run-1"]),
    trialLoop: () => Promise.resolve({ passed: true, ok: true, evidence: ["fixture passed"], runId: "trial-1" }),
    runLoop: () => Promise.resolve({ ok: true, runId: "loop-1" }),
    getGoalProgress: () => undefined,
    getGoalMetrics: () => undefined,
    listUsageCostRecords: () => [],
    subscribe: () => () => {},
    ...overrides,
  };
}

function usagePort(): UsagePort {
  return {
    getFooter: () => ({ providers: [] }),
    getUsageDetail: () => ({ providers: [], spendToday: "—", spendWeek: "—", perGoal: [] }),
    getAccountingSnapshot: () => ({ spentUsd: 0, providerRemaining: {}, records: [] }),
    subscribe: () => () => {},
  };
}

function emptyState(cwd: string): HelmState {
  return {
    goals: [], workflows: [], loops: [], escalations: [], precedents: [], journal: [], pausedAll: false,
    footer: { cwd, providers: [] }, mainModel: "",
  };
}

function source(cwd: string, statePath: string, workflows = workflowPort()): RealDataSource {
  return new RealDataSource({
    workflows,
    usage: usagePort(),
    nativeState: emptyState(cwd),
    synthDigest: () => ({ spanText: "—", spentText: "—", shippedGoals: [], shippedByLoops: [], decisionsQueued: [], failedHandled: [], quotaDrain: [] }),
    synthIntake: () => { throw new Error("production never synthesizes seeded intake"); },
    synthLoopDraft: () => { throw new Error("production never synthesizes seeded loop drafts"); },
    synthCloseout: () => { throw new Error("production never synthesizes seeded closeout"); },
    shouldShowDigestFlag: false,
    repository: createHelmRepository(cwd, statePath),
  });
}

function closeout(goalId: string, proposedPrecedents: Precedent[]): Closeout {
  return {
    goalId,
    goalName: "completed goal",
    startedText: "started",
    landedText: "landed",
    packagesDone: 1,
    packagesTotal: 1,
    unit: "package",
    addedText: "+1",
    removedText: "−0",
    commitsText: "1 commit",
    greenText: "100% green",
    actualCost: "$1",
    estCost: "$1",
    yourTime: "1 min",
    interventions: "none",
    overrunWhy: "none",
    proposedPrecedents,
  };
}

test("real data source refuses decline changes after a precedent is handed off", () => {
  const cwd = tempDir("helm-project-");
  const statePath = join(cwd, ".state", "helm.json");
  const precedent: Precedent = {
    id: "handed-off",
    signature: "decision:handed-off",
    question: "Keep the durable rule?",
    decision: "yes",
    rationale: "already handed off",
    declined: false,
    appliesTo: "handoff",
  };
  try {
    const repository = createHelmRepository(cwd, statePath);
    repository.save({
      ...repository.load(),
      precedents: [precedent],
      closeouts: [closeout("goal-complete", [precedent])],
    });
    const ds = source(cwd, statePath);
    const auditCount = ds.snapshot().audit?.length ?? 0;

    ds.declinePrecedent(precedent.id);
    ds.setPrecedentDeclined(precedent.id, false);

    assert.deepEqual(ds.precedents().find((item) => item.id === precedent.id), precedent);
    assert.equal(ds.snapshot().audit?.length ?? 0, auditCount);
  } finally {
    removeTempDir(cwd);
  }
});

test("applying an empty closeout is a no-op without audit or agent handoff", async () => {
  const cwd = tempDir("helm-project-");
  const statePath = join(cwd, ".state", "helm.json");
  try {
    const repository = createHelmRepository(cwd, statePath);
    repository.save({
      ...repository.load(),
      closeouts: [closeout("goal-empty", [])],
    });
    const ds = source(cwd, statePath);
    const auditCount = ds.snapshot().audit?.length ?? 0;

    const result = await ds.execute({ type: "goal.applyPrecedents", goalId: "goal-empty" });

    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /no proposed precedents/i);
    assert.equal(result.agentPrompt, undefined);
    assert.equal(ds.snapshot().audit?.length ?? 0, auditCount);
  } finally {
    removeTempDir(cwd);
  }
});

test("goal intent and scheduled-loop definitions survive a fresh data-source instance", async () => {
  const cwd = tempDir("helm-project-");
  const statePath = join(cwd, ".state", "helm.json");
  try {
    const first = source(cwd, statePath);
    const goalDraft = await first.execute({ type: "goal.createDraft", prompt: "ship a durable goal" });
    assert.ok(goalDraft.id);
    await first.execute({ type: "goal.spawn", draftId: goalDraft.id! });

    const loopDraft = await first.execute({ type: "loop.createDraft", prompt: "every 2 hours verify documentation links" });
    assert.ok(loopDraft.id);
    assert.deepEqual(await first.trialLoop(loopDraft.id!), { passed: true, ok: true, evidence: ["fixture passed"], runId: "trial-1" });
    const scheduled = await first.execute({ type: "loop.schedule", loopId: loopDraft.id! });
    assert.equal(scheduled.ok, true);

    const reloaded = source(cwd, statePath);
    assert.equal(reloaded.snapshot().goals.some((goal) => goal.name === "ship a durable goal"), true);
    const loop = reloaded.snapshot().loops.find((item) => item.id === loopDraft.id);
    assert.equal(loop?.health, "healthy");
    assert.equal(loop?.scheduleEveryMs, 2 * 3_600_000);
    assert.equal(reloaded.getLoopDraft(loopDraft.id!)?.trialPassed, true);
    await reloaded.execute({ type: "loop.togglePause", loopId: loopDraft.id! });
  } finally {
    removeTempDir(cwd);
  }
});

test("a loop cannot be scheduled until its current definition passes trial", async () => {
  const cwd = tempDir("helm-project-");
  const statePath = join(cwd, ".state", "helm.json");
  try {
    const ds = source(cwd, statePath);
    const draft = await ds.execute({ type: "loop.createDraft", prompt: "every hour inspect CI" });
    const result = await ds.execute({ type: "loop.schedule", loopId: draft.id! });
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /trial/i);
  } finally {
    removeTempDir(cwd);
  }
});

test("scheduled firings use the immutable active definition while edits remain a pending draft", async () => {
  const cwd = tempDir("helm-project-");
  const statePath = join(cwd, ".state", "helm.json");
  const fired: LoopDefinition[] = [];
  try {
    const ds = source(cwd, statePath, workflowPort({
      runLoop: async (definition) => {
        fired.push(definition);
        return { ok: true, runId: "scheduled-1" };
      },
    }));
    const created = await ds.execute({ type: "loop.createDraft", prompt: "every 2 hours inspect CI with original guardrails" });
    await ds.trialLoop(created.id!);
    await ds.execute({ type: "loop.schedule", loopId: created.id! });
    const activeBefore = structuredClone(ds.snapshot().loops.find((loop) => loop.id === created.id)!.activeDefinition!);

    await ds.execute({ type: "loop.edit", loopId: created.id!, text: "every 2 hours inspect CI. Guardrails: read-only, $1 cap" });
    const edited = ds.snapshot().loops.find((loop) => loop.id === created.id)!;
    assert.deepEqual(edited.activeDefinition, activeBefore, "editing cannot mutate the live definition");
    assert.deepEqual(edited.pendingDraft?.guardrails, ["read-only", "$1 cap"]);
    assert.equal(edited.pendingDraft?.trialPassed, false);

    await (ds as unknown as { fireLoop(id: string): Promise<void> }).fireLoop(created.id!);
    assert.equal(fired.length, 1);
    assert.deepEqual(fired[0], activeBefore, "the due firing reads only activeDefinition");
    assert.ok(ds.search("completed").some((hit) => hit.kind === "audit" || hit.kind === "loopRun"));
  } finally {
    removeTempDir(cwd);
  }
});

test("failed trial persists a machine verdict, reopens draft lifecycle, and never schedules", async () => {
  const cwd = tempDir("helm-project-");
  const statePath = join(cwd, ".state", "helm.json");
  try {
    const ds = source(cwd, statePath, workflowPort({
      trialLoop: async () => ({ passed: false, ok: false, evidence: ["guardrail violation"] }),
    }));
    const created = await ds.execute({ type: "loop.createDraft", prompt: "every hour inspect CI" });
    const verdict = await ds.trialLoop(created.id!);
    assert.deepEqual(verdict, { passed: false, ok: false, evidence: ["guardrail violation"] });
    const draft = ds.getLoopDraft(created.id!)!;
    assert.equal(draft.lifecycle, "draft");
    assert.equal(draft.trialPassed, false);
    assert.deepEqual(draft.lastTrialVerdict?.evidence, ["guardrail violation"]);
    assert.equal((await ds.execute({ type: "loop.schedule", loopId: created.id! })).ok, false);
  } finally {
    removeTempDir(cwd);
  }
});

test("pause-all survives relaunch, resumes only checkpointed runs, and shifts only active loop deadlines", async () => {
  const cwd = tempDir("helm-project-");
  const statePath = join(cwd, ".state", "helm.json");
  const resumed: string[][] = [];
  let scheduledRuns = 0;
  try {
    const first = source(cwd, statePath, workflowPort({ pauseAll: () => ["run-global"], runLoop: async () => { scheduledRuns += 1; return { ok: true }; } }));
    const active = await first.execute({ type: "loop.createDraft", prompt: "every 2 hours active loop" });
    await first.trialLoop(active.id!);
    await first.execute({ type: "loop.schedule", loopId: active.id! });
    const individuallyPaused = await first.execute({ type: "loop.createDraft", prompt: "every 3 hours individual loop" });
    await first.trialLoop(individuallyPaused.id!);
    await first.execute({ type: "loop.schedule", loopId: individuallyPaused.id! });
    await first.execute({ type: "loop.togglePause", loopId: individuallyPaused.id! });
    first.pauseAll();
    const checkpoint = first.snapshot().pauseCheckpoint!;
    assert.deepEqual(checkpoint.runIds, ["run-global"]);
    assert.deepEqual(checkpoint.loops.map((item) => item.loopId), [active.id]);

    const reloaded = source(cwd, statePath, workflowPort({
      pauseAll: () => [],
      resumeAll: (ids) => { resumed.push([...ids]); },
      runLoop: async () => { scheduledRuns += 1; return { ok: true }; },
    }));
    assert.equal(reloaded.snapshot().pausedAll, true, "global pause is restored before timers rearm");
    assert.equal(scheduledRuns, 0, "no loop fires during globally-paused relaunch");
    reloaded.resumeAll();
    assert.deepEqual(resumed, [["run-global"]], "individually paused lanes are not swept into resume-all");
    assert.equal(reloaded.snapshot().loops.find((loop) => loop.id === individuallyPaused.id)?.health, "paused");
    assert.ok(reloaded.snapshot().loops.find((loop) => loop.id === active.id)!.nextRunAtMs! > Date.now());
  } finally {
    removeTempDir(cwd);
  }
});

function escalation(id: string, overrides: Partial<Escalation> = {}): Escalation {
  return {
    id,
    source: { kind: "workflow", label: "pkg/api" },
    question: "Which export-map shape should be used?",
    verb: "decide",
    blockedSinceMs: Date.now(),
    problem: "Two valid export-map shapes conflict.",
    evidence: ["current vs proposed"],
    options: [{ text: "keep conditional exports", recommended: true }, { text: "use a flat map" }],
    blockedMinutes: 0,
    idleNote: "one lane idle",
    signature: "legacy:export-map",
    conflictKind: "export map conflict",
    scope: "packages/pkg-api",
    ...overrides,
  };
}

test("decision signatures auto-resolve stably, declined precedents persist, and permission prompts never auto-resolve", async () => {
  const cwd = tempDir("helm-project-");
  const statePath = join(cwd, ".state", "helm.json");
  try {
    const first = source(cwd, statePath);
    first.addEscalation(escalation("decision-1"));
    await first.decide("decision-1", 0);
    const precedent = first.precedents().find((item) => item.decision === "keep conditional exports")!;
    first.addEscalation(escalation("decision-2", { source: { kind: "workflow", label: "renamed lane" } }));
    assert.equal(first.getEscalation("decision-2"), undefined, "explicit scope keeps the signature stable across labels");
    assert.ok(first.search("auto-resolved").some((hit) => hit.screen?.id === "viewer"));

    first.declinePrecedent(precedent.id);
    const reloaded = source(cwd, statePath);
    assert.equal(reloaded.precedents().find((item) => item.id === precedent.id)?.declined, true);
    reloaded.addEscalation(escalation("decision-3"));
    assert.ok(reloaded.getEscalation("decision-3"), "declined precedent is never applied after relaunch");

    const permission = escalation("permission-1", { resolutionClass: "permission", signature: "permission:same", conflictKind: undefined, scope: undefined });
    reloaded.addEscalation(permission);
    await reloaded.decide(permission.id, 0);
    reloaded.addEscalation({ ...permission, id: "permission-2" });
    assert.ok(reloaded.getEscalation("permission-2"), "permission-class ingress never auto-resolves");
  } finally {
    removeTempDir(cwd);
  }
});

test("follow-up questions and answers persist while the escalation stays active", () => {
  const cwd = tempDir("helm-project-");
  const statePath = join(cwd, ".state", "helm.json");
  try {
    const ds = source(cwd, statePath);
    ds.addEscalation(escalation("follow-up", { conflictKind: undefined, scope: undefined }));
    void ds.execute({ type: "escalation.ask", escalationId: "follow-up", text: "What breaks on Node 20?" });
    const at = ds.getEscalation("follow-up")!.followUps![0]!.at;
    ds.answerEscalationFollowUp("follow-up", at, "The legacy condition order changes resolution.");
    const reloaded = source(cwd, statePath);
    assert.equal(reloaded.getEscalation("follow-up")?.followUps?.[0]?.answer, "The legacy condition order changes resolution.");
    assert.equal(reloaded.getEscalation("follow-up")?.resolved, undefined);
  } finally {
    removeTempDir(cwd);
  }
});

test("intake planning happens before spawn and re-plans until all structured questions are answered", async () => {
  const cwd = tempDir("helm-project-");
  const statePath = join(cwd, ".state", "helm.json");
  let plans = 0;
  let starts = 0;
  try {
    const ds = source(cwd, statePath, workflowPort({
      planGoal: async ({ answers }) => {
        plans += 1;
        const answer = answers.find((item) => item.id === "choice")?.answer;
        return {
          questions: [{ id: "choice", question: "Which package is authoritative?", answer }],
          plan: [{ name: "migration", description: answer ? `migrate ${answer}` : "migrate the selected package" }],
          estWall: answer ? "2h wall" : "3-5h wall",
          estCost: answer ? "~$12" : "~$20",
          escalationRule: "permissions escalate",
        };
      },
      startGoal: async () => { starts += 1; return ["goal-run"]; },
    }));
    const created = await ds.execute({ type: "goal.createDraft", prompt: "migrate the ambiguous package" });
    assert.equal(plans, 1);
    assert.equal(starts, 0, "planning cannot spawn workflow work");
    assert.equal(ds.getIntake(created.id!)?.openQuestions, true);
    assert.equal((await ds.execute({ type: "goal.spawn", draftId: created.id! })).ok, false);
    assert.equal(starts, 0);
    await ds.execute({ type: "goal.answer", draftId: created.id!, text: "pkg/api" });
    assert.equal(plans, 2);
    assert.equal(ds.getIntake(created.id!)?.openQuestions, false);
    assert.equal(ds.getIntake(created.id!)?.estCost, "~$12");
    assert.equal((await ds.execute({ type: "goal.spawn", draftId: created.id! })).ok, true);
    assert.equal(starts, 1);
    assert.ok(ds.search("started goal").some((hit) => hit.kind === "audit"));
  } finally {
    removeTempDir(cwd);
  }
});
