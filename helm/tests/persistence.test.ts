import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RealDataSource } from "../src/data/real.js";
import type { UsagePort, WorkflowPort } from "../src/data/ports.js";
import { createHelmRepository } from "../src/state/persistence.js";
import type { HelmState } from "../src/state/types.js";

function workflowPort(): WorkflowPort {
  return {
    listWorkflows: () => [],
    getDrillIn: () => undefined,
    getSession: () => undefined,
    pauseWorkflow: () => {},
    resumeWorkflow: () => Promise.resolve(true),
    pauseAll: () => {},
    resumeAll: () => {},
    startGoal: () => Promise.resolve(["run-1"]),
    trialLoop: () => Promise.resolve({ ok: true, runId: "trial-1" }),
    runLoop: () => Promise.resolve({ ok: true, runId: "loop-1" }),
    getGoalProgress: () => undefined,
    getGoalMetrics: () => undefined,
    listUsageCostRecords: () => [],
    subscribe: () => () => {},
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

function source(cwd: string, statePath: string): RealDataSource {
  return new RealDataSource({
    workflows: workflowPort(),
    usage: usagePort(),
    nativeState: emptyState(cwd),
    trialLoop: () => Promise.resolve({ ok: true }),
    synthDigest: () => ({ spanText: "—", spentText: "—", shippedGoals: [], shippedByLoops: [], decisionsQueued: [], failedHandled: [], quotaDrain: [] }),
    synthIntake: () => { throw new Error("production never synthesizes seeded intake"); },
    synthLoopDraft: () => { throw new Error("production never synthesizes seeded loop drafts"); },
    synthCloseout: () => { throw new Error("production never synthesizes seeded closeout"); },
    shouldShowDigestFlag: false,
    repository: createHelmRepository(cwd, statePath),
  });
}

test("goal intent and scheduled-loop definitions survive a fresh data-source instance", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "helm-project-"));
  const statePath = join(cwd, ".state", "helm.json");
  try {
    const first = source(cwd, statePath);
    const goalDraft = await first.execute({ type: "goal.createDraft", prompt: "ship a durable goal" });
    assert.ok(goalDraft.id);
    await first.execute({ type: "goal.spawn", draftId: goalDraft.id! });

    const loopDraft = await first.execute({ type: "loop.createDraft", prompt: "every 2 hours verify documentation links" });
    assert.ok(loopDraft.id);
    assert.deepEqual(await first.trialLoop(loopDraft.id!), { ok: true });
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
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a loop cannot be scheduled until its current definition passes trial", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "helm-project-"));
  const statePath = join(cwd, ".state", "helm.json");
  try {
    const ds = source(cwd, statePath);
    const draft = await ds.execute({ type: "loop.createDraft", prompt: "every hour inspect CI" });
    const result = await ds.execute({ type: "loop.schedule", loopId: draft.id! });
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /trial/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
