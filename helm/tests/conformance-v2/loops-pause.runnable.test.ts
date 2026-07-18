import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowPort } from "../../src/host/adapters.js";
import { RealDataSource } from "../../src/data/real.js";
import type { LoopDraft, WorkflowDetail } from "../../src/state/types.js";
import type { PersistedRunState } from "../../src/workflows/run-persistence.js";
import type { WorkflowManager } from "../../src/workflows/workflow-manager.js";
import { makePersistentSource, withTempProject } from "./helpers.js";

test("Loops row: scheduling is rejected without a passed supervised verdict", async () => {
  await withTempProject(async (root) => {
    const { source } = makePersistentSource(root);
    const draft = await source.execute({ type: "loop.createDraft", prompt: "every hour inspect CI", draftId: "loop-gated" });
    const result = await source.execute({ type: "loop.schedule", loopId: draft.id! });
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /pass.*trial|trial.*pass/i);
    assert.equal(source.snapshot().loops.some((loop) => loop.id === draft.id), false);
  });
});

function loopDraft(id: string): LoopDraft {
  return {
    id,
    name: id,
    prompt: "every hour verify",
    trigger: "every hour",
    steps: "verify safely",
    skips: "destructive work",
    guardrails: ["review required"],
    trialStatement: "supervised",
  };
}

test("Loops row: machine-readable failed verdict overrides a technically completed trial run", async () => {
  const run: PersistedRunState = {
    runId: "trial-machine-verdict",
    workflowName: "trial",
    script: "",
    args: { helmLoopId: "loop-report-fails" },
    status: "completed",
    phases: ["Trial"],
    agents: [],
    logs: [],
    result: { passed: false, evidence: ["unsafe write observed"] },
    startedAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:01.000Z",
  };
  const manager = {
    startInBackground: () => ({ runId: run.runId, promise: Promise.resolve(run.result) }),
    listAllRuns: () => [run],
    listRuns: () => [run],
    on() {},
    off() {},
  } as unknown as WorkflowManager;
  const port = createWorkflowPort(manager, () => ({ listRuns: () => [] }) as never);
  const result = await port.trialLoop(loopDraft("loop-report-fails"));
  assert.equal(result.ok, false);
});

test("Loops row: failed trial persists no trialPassed gate and is invoked only once", async () => {
  await withTempProject(async (root) => {
    let invocations = 0;
    const base = makePersistentSource(root, { repository: false });
    const source = new RealDataSource({
      ...base.deps,
      repository: undefined,
      workflows: {
        ...base.deps.workflows,
        trialLoop: async () => { invocations += 1; return { passed: false, evidence: [], ok: false }; },
      },
    });
    const created = await source.execute({ type: "loop.createDraft", prompt: "every hour inspect CI", draftId: "loop-no-retry" });
    const verdict = await source.trialLoop(created.id!);
    assert.equal(verdict.ok, false);
    assert.notEqual(source.getLoopDraft(created.id!)?.trialPassed, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(invocations, 1, "failure does not schedule an automatic retry");
  });
});

test("Loops row: an operator-paused loop always carries a non-empty reason", async () => {
  await withTempProject(async (root) => {
    const { source } = makePersistentSource(root);
    const created = await source.execute({ type: "loop.createDraft", prompt: "every hour inspect CI", draftId: "loop-reason" });
    await source.trialLoop(created.id!);
    assert.equal((await source.execute({ type: "loop.schedule", loopId: created.id! })).ok, true);
    await source.execute({ type: "loop.togglePause", loopId: created.id! });
    const paused = source.snapshot().loops.find((loop) => loop.id === created.id);
    assert.equal(paused?.health, "paused");
    assert.ok(paused?.pausedReason?.trim());
  });
});

test("Pause row: global pause survives a fresh data-source instance", async () => {
  await withTempProject(async (root) => {
    const first = makePersistentSource(root).source;
    first.pauseAll();
    assert.equal(first.snapshot().pausedAll, true);
    const relaunched = makePersistentSource(root).source;
    assert.equal(relaunched.snapshot().pausedAll, true);
  });
});

test("Pause row: lanes paused before pause-all remain paused after resume-all", async () => {
  await withTempProject(async (root) => {
    const workflows = [
      { id: "already-paused", goalId: "goal", name: "paused", state: "paused" as const, summary: "operator paused" },
      { id: "was-running", goalId: "goal", name: "running", state: "running" as const, summary: "working" },
    ];
    const { source } = makePersistentSource(root, { workflows });
    source.pauseAll();
    source.resumeAll();
    const states = new Map(source.snapshot().workflows.map((workflow) => [workflow.id, workflow.state]));
    assert.equal(states.get("already-paused"), "paused");
    assert.equal(states.get("was-running"), "running");
  });
});

test("Pause row: loop deadline shifts by the full paused duration", async () => {
  await withTempProject(async (root) => {
    const originalNow = Date.now;
    let now = 1_800_000_000_000;
    Date.now = () => now;
    try {
      const { source } = makePersistentSource(root);
      const created = await source.execute({ type: "loop.createDraft", prompt: "every hour inspect CI", draftId: "loop-clock" });
      await source.trialLoop(created.id!);
      await source.execute({ type: "loop.schedule", loopId: created.id! });
      const before = source.snapshot().loops.find((loop) => loop.id === created.id)?.nextRunAtMs;
      assert.ok(before);
      source.pauseAll();
      now += 17 * 60_000;
      source.resumeAll();
      const after = source.snapshot().loops.find((loop) => loop.id === created.id)?.nextRunAtMs;
      assert.equal(after, before + 17 * 60_000);
    } finally {
      Date.now = originalNow;
    }
  });
});

test("Pause row: pausing one worktree leaves its sibling and top-level workflow running", async () => {
  await withTempProject(async (root) => {
    const detail: WorkflowDetail = {
      workflowId: "workflow-two-worktrees",
      label: "goal › two worktrees",
      lanes: 2,
      agents: 2,
      queueRemaining: 2,
      queueTotal: 2,
      queueUnit: "worktrees",
      burnPerHr: 0,
      etaText: "running",
      worktrees: [
        { id: "wt-a", name: "a", package: "a", chips: [{ stage: "fix" }], appliedText: "running", testState: "wobbling", testTicks: [] },
        { id: "wt-b", name: "b", package: "b", chips: [{ stage: "fix" }], appliedText: "running", testState: "wobbling", testTicks: [] },
      ],
    };
    const { source } = makePersistentSource(root, {
      workflows: [{ id: detail.workflowId, goalId: "goal", name: "two", state: "running", summary: "running" }],
      details: new Map([[detail.workflowId, detail]]),
    });
    const result = await source.execute({ type: "worktree.togglePause", workflowId: detail.workflowId, worktreeId: "wt-a" });
    assert.equal(result.ok, true);
    assert.equal(source.snapshot().workflows.find((workflow) => workflow.id === detail.workflowId)?.state, "running");
    assert.equal(source.getDrillIn(detail.workflowId)?.worktrees.find((worktree) => worktree.id === "wt-b")?.appliedText, "running");
  });
});
