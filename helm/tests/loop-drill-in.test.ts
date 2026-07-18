import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { HelmApp, type TuiLike } from "../src/app.js";
import { RealDataSource } from "../src/data/real.js";
import type { UsagePort, WorkflowPort } from "../src/data/ports.js";
import { createHelmRepository } from "../src/state/persistence.js";
import type { AuditRecord, HelmState, Loop, LoopDefinition } from "../src/state/types.js";

const theme = { getColorMode: () => "256color" as const };
const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakeTui(rows: number, columns = 120): TuiLike {
  return { terminal: { rows, columns }, requestRender() {} };
}

function workflowPort(): WorkflowPort {
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
    planGoal: async () => ({ questions: [], plan: [], estWall: "—", estCost: "—", escalationRule: "—" }),
    startGoal: () => Promise.resolve([]),
    trialLoop: () => Promise.resolve({ passed: true, evidence: [] }),
    runLoop: () => Promise.resolve({ ok: true }),
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

function definition(id: string, guardrails = ["read-only", "$2 cap"]): LoopDefinition {
  return {
    id,
    name: "audit loop",
    prompt: "Every hour inspect CI and report regressions",
    trigger: "every hour",
    steps: "inspect CI → diagnose → report",
    skips: "never merge",
    guardrails,
    trialStatement: "Run once under full review.",
  };
}

function loopFixture(id = "loop-audit", overrides: Partial<Loop> = {}): Loop {
  const activeDefinition = definition(id);
  return {
    id,
    name: activeDefinition.name,
    trigger: activeDefinition.trigger,
    pipelineSummary: activeDefinition.steps,
    health: "healthy",
    lifecycle: "scheduled",
    scheduledState: "healthy",
    activeDefinition,
    ...overrides,
  };
}

function audit(
  id: string,
  kind: AuditRecord["kind"],
  targetIds: string[],
  at: number,
  summary = id,
  detail = `${id} detail`,
): AuditRecord {
  return { id, kind, targetIds, at, summary, detail };
}

function persistedSource(
  t: TestContext,
  loop: Loop,
  records: AuditRecord[] = [],
): RealDataSource {
  const cwd = mkdtempSync(join(tmpdir(), "helm-loop-drill-in-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const statePath = join(cwd, ".state", "helm.json");
  const repository = createHelmRepository(cwd, statePath);
  repository.save({ ...repository.load(), loops: [loop], audit: records });
  return new RealDataSource({
    workflows: workflowPort(),
    usage: usagePort(),
    nativeState: emptyState(cwd),
    synthDigest: () => ({ spanText: "—", spentText: "—", shippedGoals: [], shippedByLoops: [], decisionsQueued: [], failedHandled: [], quotaDrain: [] }),
    synthIntake: () => { throw new Error("persisted mode must not synthesize intake"); },
    synthLoopDraft: () => { throw new Error("persisted mode must not synthesize loop drafts"); },
    synthCloseout: () => { throw new Error("persisted mode must not synthesize closeouts"); },
    shouldShowDigestFlag: false,
    repository,
  });
}

function openLoopDrillIn(app: HelmApp): void {
  app.handleInput("\r");
}

function type(app: HelmApp, value: string): void {
  for (const character of value) app.handleInput(character);
}

test("failed loop firings appear as failure runs and only primary loop targets are projected", (t) => {
  const loop = loopFixture();
  const ds = persistedSource(t, loop, [
    audit("goal-record", "runCompleted", ["goal-1", loop.id], 1_000, "must stay excluded"),
    audit("failure-record", "selfCaughtPause", [loop.id, "run-failed"], 2_000, "scheduled run failed", "operator review required"),
  ]);

  assert.deepEqual(ds.listLoopRuns(loop.id), [{
    id: "run-failed",
    loopId: loop.id,
    timestamp: new Date(2_000).toISOString(),
    outcome: "failure",
    summary: "scheduled run failed",
    yieldNote: "operator review required",
  }]);

  const app = new HelmApp(fakeTui(30), theme, () => {}, ds);
  openLoopDrillIn(app);
  const screen = app.render(120).map(stripAnsi).join("\n");
  assert.match(screen, /✗ failure.*scheduled run failed/);
  assert.doesNotMatch(screen, /no runs yet|must stay excluded/);
});

test("malformed legacy audit records are skipped without breaking the drill-in screen", (t) => {
  const loop = loopFixture();
  const records = [
    { id: "missing-targets", kind: "runCompleted", at: 1, summary: "bad", detail: "bad" },
    audit("empty-targets", "runCompleted", [], 2),
    audit("invalid-date", "runCompleted", [loop.id], Number.NaN),
    audit("valid", "runCompleted", [loop.id, "run-valid"], 3, "valid run"),
  ] as unknown as AuditRecord[];
  const ds = persistedSource(t, loop, records);
  const app = new HelmApp(fakeTui(30), theme, () => {}, ds);

  openLoopDrillIn(app);
  assert.doesNotThrow(() => app.render(120));
  const screen = app.render(120).map(stripAnsi).join("\n");
  assert.match(screen, /valid run/);
  assert.match(screen, /1 run/);
});

test("summary, selected boundary run, and active/pending guardrails survive constrained windowing", (t) => {
  const base = loopFixture();
  const loop = loopFixture(base.id, {
    pendingDraft: {
      ...definition(base.id, ["read-only", "$1 cap"]),
      lifecycle: "draft",
      trialPassed: false,
    },
  });
  const records = Array.from({ length: 100 }, (_, index) =>
    audit(`audit-${index}`, "runCompleted", [loop.id, `run-${index}`], index + 1, `run ${index}`));
  const ds = persistedSource(t, loop, records);
  // Four chrome rows leave exactly height=20 for renderLoopDrillIn.
  const app = new HelmApp(fakeTui(24), theme, () => {}, ds);
  openLoopDrillIn(app);

  for (let selection = 0; selection < 100; selection++) {
    const screen = app.render(120).map(stripAnsi).join("\n");
    assert.match(screen, /100 runs/, `summary missing at selection ${selection}`);
    assert.match(screen, /active\s+read-only · \$2 cap/, `active guardrails missing at selection ${selection}`);
    assert.match(screen, /pending trial\s+read-only · \$1 cap/, `pending guardrails missing at selection ${selection}`);
    if (selection < 99) app.handleInput("j");
  }

  // Four chrome rows leave body height=5: summary + selected run + guardrail
  // header + both guardrail rows. The optional run-history header must yield.
  const constrained = new HelmApp(fakeTui(9), theme, () => {}, ds);
  openLoopDrillIn(constrained);
  let screen = constrained.render(120).map(stripAnsi).join("\n");
  assert.match(screen, /run 99/, "selected first run missing at body height 5");
  assert.match(screen, /active\s+read-only · \$2 cap/, "active guardrails missing at first boundary");
  assert.match(screen, /pending trial\s+read-only · \$1 cap/, "pending guardrails missing at first boundary");

  for (let selection = 0; selection < 99; selection++) constrained.handleInput("j");
  screen = constrained.render(120).map(stripAnsi).join("\n");
  assert.match(screen, /run 0/, "selected last run missing at body height 5");
  assert.match(screen, /active\s+read-only · \$2 cap/, "active guardrails missing at last boundary");
  assert.match(screen, /pending trial\s+read-only · \$1 cap/, "pending guardrails missing at last boundary");
});

test("persisted loop fallback supports edit, trial, schedule, discard, and reopen", async (t) => {
  const loop = loopFixture();
  const ds = persistedSource(t, loop);
  const app = new HelmApp(fakeTui(30), theme, () => {}, ds);

  openLoopDrillIn(app);
  app.handleInput("\r");
  const screen = app.render(120).map(stripAnsi).join("\n");
  assert.match(screen, /pi · new loop/);
  assert.match(screen, /Every hour inspect CI and report regressions/);
  assert.match(screen, /trigger\s+every hour/);
  assert.match(screen, /steps\s+inspect CI → diagnose → report/);
  assert.match(screen, /skips\s+never merge/);
  assert.match(screen, /guardrails\s+read-only · \$2 cap/);
  assert.match(screen, /trial passed under review/);
  assert.equal(ds.getLoopDraft(loop.id)?.lifecycle, "scheduled");
  assert.equal(ds.getLoopDraft(loop.id)?.trialPassed, true);

  app.handleInput("r");
  app.handleInput("e");
  type(app, "every 2 hours inspect CI and report regressions");
  app.handleInput("\r");
  await flush();
  assert.equal(ds.getLoopDraft(loop.id)?.trigger, "every 2 hours inspect CI and report regressions");
  assert.equal(ds.getLoopDraft(loop.id)?.trialPassed, false);

  app.handleInput("t");
  await flush();
  assert.equal(ds.getLoopDraft(loop.id)?.trialPassed, true);
  assert.match(app.render(120).map(stripAnsi).join("\n"), /s accept schedule/);

  app.handleInput("s");
  await flush();
  const scheduled = ds.snapshot().loops.find((item) => item.id === loop.id);
  assert.equal(scheduled?.activeDefinition?.prompt, "every 2 hours inspect CI and report regressions");
  assert.equal(scheduled?.scheduleEveryMs, 2 * 60 * 60 * 1_000);

  app.handleInput("\r");
  const beforeDiscard = ds.getLoopDraft(loop.id);
  app.handleInput("x");
  app.handleInput("y");
  await flush();
  app.handleInput("\r");
  const reopened = ds.getLoopDraft(loop.id);
  assert.notStrictEqual(reopened, beforeDiscard, "discard must force a fresh active-definition derivation");
  assert.equal(reopened?.prompt, "every 2 hours inspect CI and report regressions");
  assert.match(app.render(120).map(stripAnsi).join("\n"), /s accept schedule/);

  app.handleInput("r");
  app.handleInput("t");
  await flush();
  assert.equal(ds.getLoopDraft(loop.id)?.trialPassed, true, "reopened fallback remains actionable");
});

test("loop drill-in enter stays put when neither a stored draft nor active definition exists", (t) => {
  const loop = loopFixture("legacy-loop", { activeDefinition: undefined });
  const ds = persistedSource(t, loop);
  const app = new HelmApp(fakeTui(30), theme, () => {}, ds);

  openLoopDrillIn(app);
  app.handleInput("\r");
  const screen = app.render(120).map(stripAnsi).join("\n");
  assert.match(screen, /pi · loop › audit loop/);
  assert.match(screen, /run history/);
  assert.doesNotMatch(screen, /pi · new loop/);
});

test("same-millisecond runs render newest-appended first", (t) => {
  const loop = loopFixture();
  const at = Date.UTC(2026, 6, 18, 12, 0, 0, 123);
  const ds = persistedSource(t, loop, [
    audit("earlier-append", "runCompleted", [loop.id, "run-earlier"], at, "earlier appended"),
    audit("later-append", "runCompleted", [loop.id, "run-later"], at, "later appended"),
  ]);
  const app = new HelmApp(fakeTui(30), theme, () => {}, ds);

  openLoopDrillIn(app);
  const lines = app.render(120).map(stripAnsi);
  const later = lines.findIndex((line) => line.includes("later appended"));
  const earlier = lines.findIndex((line) => line.includes("earlier appended"));
  assert.ok(later >= 0 && earlier >= 0);
  assert.ok(later < earlier, `expected later append first, got lines ${later} and ${earlier}`);
  assert.deepEqual(ds.listLoopRuns(loop.id).map((run) => run.id), ["run-later", "run-earlier"]);
});

test("pending guardrail labels reflect trial state and reordered identical sets stay active-only", (t) => {
  const passed = loopFixture("passed-pending", {
    pendingDraft: {
      ...definition("passed-pending", ["read-only", "$1 cap"]),
      lifecycle: "trial",
      trialPassed: true,
    },
  });
  const passedApp = new HelmApp(fakeTui(30), theme, () => {}, persistedSource(t, passed));
  openLoopDrillIn(passedApp);
  const passedScreen = passedApp.render(120).map(stripAnsi).join("\n");
  assert.match(passedScreen, /trial passed · pending schedule\s+read-only · \$1 cap/);

  const reordered = loopFixture("reordered", {
    pendingDraft: {
      ...definition("reordered", ["$2 cap", "read-only"]),
      lifecycle: "draft",
      trialPassed: false,
    },
  });
  const reorderedApp = new HelmApp(fakeTui(30), theme, () => {}, persistedSource(t, reordered));
  openLoopDrillIn(reorderedApp);
  const reorderedScreen = reorderedApp.render(120).map(stripAnsi).join("\n");
  assert.match(reorderedScreen, /active\s+read-only · \$2 cap/);
  assert.doesNotMatch(reorderedScreen, /pending trial|pending schedule/);
});
