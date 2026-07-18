import assert from "node:assert/strict";
import test from "node:test";
import { HelmApp } from "../../src/app.js";
import { MockDataSource, seedState } from "../../src/data/mock.js";
import type { HelmCommand, HelmCommandResult, SearchResult } from "../../src/data/source.js";
import { createHelmRepository } from "../../src/state/persistence.js";
import type {
  HelmState,
  Loop,
  LoopDefinition,
  LoopDraft,
  LoopRun,
} from "../../src/state/types.js";
import {
  fakeTui,
  flush,
  makePersistentSource,
  stripLines,
  theme256,
  withTempProject,
} from "./helpers.js";

function definition(id: string, name: string, guardrails = ["review required"]): LoopDefinition {
  return {
    id,
    name,
    prompt: `builder prompt for ${id}`,
    trigger: "every hour",
    steps: "inspect → verify",
    skips: "destructive work",
    guardrails,
    trialStatement: "one supervised trial passed",
  };
}

function loopFixture(id: string, name: string, overrides: Partial<Loop> = {}): Loop {
  return {
    id,
    name,
    trigger: "every hour",
    pipelineSummary: "inspect → verify",
    health: "healthy",
    activeDefinition: definition(id, name),
    ...overrides,
  };
}

function runFixture(
  id: string,
  loopId: string,
  timestamp: string,
  outcome: LoopRun["outcome"],
  summary: string,
  overrides: Partial<LoopRun> = {},
): LoopRun {
  return { id, loopId, timestamp, outcome, summary, ...overrides };
}

class LoopFixtureSource extends MockDataSource {
  readonly requestedRunIds: string[] = [];
  private readonly fixtureState: HelmState;
  private readonly runsByLoop: ReadonlyMap<string, readonly LoopRun[]>;

  constructor(loops: Loop[], runsByLoop: ReadonlyMap<string, readonly LoopRun[]> = new Map()) {
    super();
    this.fixtureState = {
      ...seedState(),
      goals: [],
      workflows: [],
      loops: structuredClone(loops),
      escalations: [],
      precedents: [],
      journal: [],
    };
    this.runsByLoop = runsByLoop;
  }

  override snapshot(): HelmState {
    return this.fixtureState;
  }

  override listLoopRuns(loopId: string): LoopRun[] {
    this.requestedRunIds.push(loopId);
    return structuredClone([...(this.runsByLoop.get(loopId) ?? [])]);
  }

  override getLoopDraft(loopId: string): LoopDraft | undefined {
    const loop = this.fixtureState.loops.find((item) => item.id === loopId);
    if (!loop) return undefined;
    if (loop.pendingDraft) return structuredClone(loop.pendingDraft);
    return loop.activeDefinition
      ? { ...structuredClone(loop.activeDefinition), lifecycle: "scheduled" }
      : undefined;
  }

  override async execute(command: HelmCommand): Promise<HelmCommandResult> {
    if (command.type !== "loop.togglePause") return super.execute(command);
    const index = this.fixtureState.loops.findIndex((loop) => loop.id === command.loopId);
    if (index < 0) return { ok: false, message: "Loop no longer exists." };
    const loop = this.fixtureState.loops[index]!;
    const paused = loop.health !== "paused";
    this.fixtureState.loops[index] = {
      ...loop,
      health: paused ? "paused" : "healthy",
      pausedReason: paused ? "operator paused" : undefined,
    };
    return { ok: true };
  }
}

class UnknownLoopSearchSource extends LoopFixtureSource {
  constructor() {
    super([loopFixture("known-loop", "known loop")]);
  }

  override search(_query: string): SearchResult[] {
    return [{
      kind: "loop",
      label: "missing loop",
      screen: { id: "loopDrillin", loopId: "does-not-exist" },
    }];
  }
}

function appFor(source: LoopFixtureSource, rows = 60): HelmApp {
  return new HelmApp(fakeTui(rows, 180), theme256, () => {}, source);
}

function rendered(app: HelmApp, width = 180): string[] {
  return stripLines(app.render(width));
}

function renderedText(app: HelmApp): string {
  return rendered(app).join("\n");
}

function header(app: HelmApp): string {
  return rendered(app)[0] ?? "";
}

function prompt(app: HelmApp): string {
  return rendered(app).reverse().find((line) => line.includes("❯")) ?? "";
}

function selectedLine(app: HelmApp): string {
  return rendered(app).find((line) => line.startsWith("▌")) ?? "";
}

function openFirstLoop(app: HelmApp): void {
  app.handleInput("\r");
}

function isoMillis(run: LoopRun): number {
  return new Date(run.timestamp).getTime();
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("Loop drill-in N1: enter on a home loop row opens drill-in, not the builder", () => {
  const loop = loopFixture("loop-nav", "nav sentinel loop");
  const source = new LoopFixtureSource([loop], new Map([[loop.id, [
    runFixture("run-nav", loop.id, "2026-07-18T15:00:00.000Z", "success", "NAV_RUN_SENTINEL"),
  ]]]));
  const app = appFor(source);

  openFirstLoop(app);

  assert.match(header(app), /nav sentinel loop/);
  assert.match(renderedText(app), /NAV_RUN_SENTINEL/);
  assert.doesNotMatch(renderedText(app), /builder prompt for loop-nav|trial run/);
});

test("Loop drill-in N2: enter in drill-in opens the builder for the same loop id", () => {
  const loop = loopFixture("same-id-loop", "same id loop");
  const source = new LoopFixtureSource([loop], new Map([[loop.id, [
    runFixture("same-id-new", loop.id, "2026-07-18T15:02:00.000Z", "success", "SAME_ID_NEW"),
    runFixture("same-id-old", loop.id, "2026-07-18T15:01:00.000Z", "failure", "SAME_ID_OLD"),
  ]]]));
  const app = appFor(source);
  openFirstLoop(app);
  app.handleInput("j");
  assert.match(selectedLine(app), /SAME_ID_OLD/);

  app.handleInput("\r");

  assert.match(header(app), /new loop/);
  assert.match(renderedText(app), /builder prompt for same-id-loop/);
});

test("Loop drill-in N3: escape ascends builder to drill-in to home with no dead end", () => {
  const loop = loopFixture("loop-stack", "stack sentinel loop");
  const source = new LoopFixtureSource([loop], new Map([[loop.id, [
    runFixture("run-stack", loop.id, "2026-07-18T15:00:00.000Z", "success", "STACK_RUN_SENTINEL"),
  ]]]));
  const app = appFor(source);
  openFirstLoop(app);
  app.handleInput("\r");
  assert.match(renderedText(app), /builder prompt for loop-stack/);

  app.handleInput("\x1b");
  assert.match(header(app), /stack sentinel loop/);
  assert.match(renderedText(app), /STACK_RUN_SENTINEL/);

  app.handleInput("\x1b");
  assert.match(header(app), /mission control/);
  app.handleInput("\x1b");
  assert.match(header(app), /mission control/);
});

test("Loop drill-in N4: run selection is isolated by loop id", () => {
  const alpha = loopFixture("loop-alpha", "alpha loop");
  const beta = loopFixture("loop-beta", "beta loop");
  const source = new LoopFixtureSource([alpha, beta], new Map([
    [alpha.id, [
      runFixture("a-3", alpha.id, "2026-07-18T15:03:00.000Z", "success", "ALPHA_FIRST"),
      runFixture("a-2", alpha.id, "2026-07-18T15:02:00.000Z", "failure", "ALPHA_MIDDLE"),
      runFixture("a-1", alpha.id, "2026-07-18T15:01:00.000Z", "trial", "ALPHA_LAST"),
    ]],
    [beta.id, [
      runFixture("b-2", beta.id, "2026-07-18T15:02:00.000Z", "success", "BETA_FIRST"),
      runFixture("b-1", beta.id, "2026-07-18T15:01:00.000Z", "failure", "BETA_LAST"),
    ]],
  ]));
  const app = appFor(source);
  openFirstLoop(app);
  app.handleInput("j");
  app.handleInput("j");
  assert.match(selectedLine(app), /ALPHA_LAST/);

  app.handleInput("\x1b");
  app.handleInput("j");
  app.handleInput("\r");

  assert.match(header(app), /beta loop/);
  assert.match(selectedLine(app), /BETA_FIRST/);
});

test("Loop drill-in R1: header context includes the loop name", () => {
  const app = appFor(new LoopFixtureSource([
    loopFixture("loop-context", "nightly dependency sentinel"),
  ]));

  openFirstLoop(app);

  assert.match(header(app), /nightly dependency sentinel/);
});

test("Loop drill-in R2: runs render newest-first with success, failure, and distinct trial markers", () => {
  const loop = loopFixture("loop-history", "history loop");
  const source = new LoopFixtureSource([loop], new Map([[loop.id, [
    runFixture("run-new", loop.id, "2026-07-18T15:03:00.000Z", "success", "NEWEST_SUCCESS"),
    runFixture("run-mid", loop.id, "2026-07-18T15:02:00.000Z", "failure", "MIDDLE_FAILURE"),
    runFixture("run-old", loop.id, "2026-07-18T15:01:00.000Z", "trial", "OLDEST_TRIAL"),
  ]]]));
  const app = appFor(source);
  openFirstLoop(app);
  const lines = rendered(app);
  const successIndex = lines.findIndex((line) => line.includes("NEWEST_SUCCESS"));
  const failureIndex = lines.findIndex((line) => line.includes("MIDDLE_FAILURE"));
  const trialIndex = lines.findIndex((line) => line.includes("OLDEST_TRIAL"));
  assert.ok(successIndex >= 0 && successIndex < failureIndex && failureIndex < trialIndex);
  assert.match(lines[successIndex]!, /✓/);
  assert.match(lines[failureIndex]!, /✗/);
  assert.doesNotMatch(lines[trialIndex]!, /[✓✗]/);

  const markerSignature = (line: string, summary: string) => line
    .replace(summary, "<SUMMARY>")
    .replaceAll("▌", "")
    .replace(/\d/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  const successSignature = markerSignature(lines[successIndex]!, "NEWEST_SUCCESS");
  const failureSignature = markerSignature(lines[failureIndex]!, "MIDDLE_FAILURE");
  const trialSignature = markerSignature(lines[trialIndex]!, "OLDEST_TRIAL");
  assert.notEqual(trialSignature, successSignature, "trial marker differs from success");
  assert.notEqual(trialSignature, failureSignature, "trial marker differs from failure");
});

test("Loop drill-in R3: a loop with no run history renders exact empty text", () => {
  const app = appFor(new LoopFixtureSource([
    loopFixture("loop-empty", "empty history loop"),
  ]));

  openFirstLoop(app);

  assert.ok(rendered(app).some((line) => line.trim() === "no runs yet"));
});

test("Loop drill-in R4: active guardrails stay active and differing draft guardrails are pending trial", () => {
  const id = "loop-guardrails";
  const activeDefinition = definition(id, "guardrail loop", ["ACTIVE_ONLY_REVIEW", "ACTIVE_ONLY_CAP"]);
  const pendingDraft: LoopDraft = {
    ...definition(id, "guardrail loop", ["PENDING_ONLY_MERGE_RIGHT"]),
    lifecycle: "draft",
    trialPassed: false,
  };
  const loop = loopFixture(id, "guardrail loop", { activeDefinition, pendingDraft });
  const app = appFor(new LoopFixtureSource([loop]));
  openFirstLoop(app);
  const lines = rendered(app);
  const text = lines.join("\n");

  assert.match(text, /ACTIVE_ONLY_REVIEW/);
  assert.match(text, /ACTIVE_ONLY_CAP/);
  const pendingLines = lines.filter((line) => line.includes("PENDING_ONLY_MERGE_RIGHT"));
  assert.ok(pendingLines.length > 0);
  for (const line of pendingLines) assert.match(line, /pending trial/i);
});

test("Loop drill-in R5: an unknown loop id does not crash and renders a not-found or empty body", () => {
  const app = appFor(new UnknownLoopSearchSource());

  assert.doesNotThrow(() => {
    app.handleInput("/");
    app.handleInput("\r");
    app.render(180);
  });

  const lines = rendered(app);
  const body = lines.slice(2, -2);
  const bodyText = body.join("\n");
  assert.ok(
    body.every((line) => line.trim() === "") || /not found|unknown|no runs yet/i.test(bodyText),
    `expected an explicit not-found state or empty body, got:\n${bodyText}`,
  );
});

test("Loop drill-in D1: mock run history is seeded, newest-first, and covers every outcome", () => {
  const source = new MockDataSource();
  const histories = source.snapshot().loops.map((loop) => ({
    loopId: loop.id,
    runs: source.listLoopRuns(loop.id),
  }));
  const allRuns = histories.flatMap(({ runs }) => runs);

  assert.ok(allRuns.length >= 3);
  assert.deepEqual(new Set(allRuns.map((run) => run.outcome)), new Set(["success", "failure", "trial"]));
  assert.ok(allRuns.every((run) => Number.isFinite(isoMillis(run))), "mock timestamps are valid ISO dates");
  for (const { loopId, runs } of histories) {
    assert.ok(runs.every((run) => run.loopId === loopId), `history leaked across loop ${loopId}`);
    for (let index = 1; index < runs.length; index += 1) {
      assert.ok(isoMillis(runs[index - 1]!) >= isoMillis(runs[index]!), `${loopId} is not newest-first`);
    }
  }
});

test("Loop drill-in D2: a never-fired real loop has no fabricated history and shows no runs yet", async () => {
  await withTempProject(async (root) => {
    const loop = loopFixture("real-never-fired", "real never fired");
    const { source } = makePersistentSource(root, { state: { loops: [loop] } });
    assert.deepEqual(source.listLoopRuns(loop.id), []);

    const app = new HelmApp(fakeTui(60, 180), theme256, () => {}, source);
    openFirstLoop(app);
    assert.ok(rendered(app).some((line) => line.trim() === "no runs yet"));
  });
});

test("Loop drill-in D3: a real completed firing appears with summary from its durable event", async () => {
  await withTempProject(async (root) => {
    const repository = createHelmRepository(root, `${root}/loop-drillin-state.json`);
    const loopId = "real-fired-loop";
    const activeDefinition = definition(loopId, "real fired loop");
    repository.save({
      ...repository.load(),
      loops: [loopFixture(loopId, "real fired loop", {
        activeDefinition,
        lifecycle: "scheduled",
        scheduledState: "healthy",
        scheduleEveryMs: 3_600_000,
        nextRunAtMs: Date.now() - 1,
      })],
      loopDrafts: [{ ...activeDefinition, lifecycle: "scheduled", trialPassed: true }],
    });
    const { source, spies } = makePersistentSource(root, { deps: { repository } });

    await waitFor(() => spies.loopRuns.length === 1 && source.listLoopRuns(loopId).length > 0);

    const completed = source.listLoopRuns(loopId).find((run) => run.outcome === "success");
    assert.ok(completed);
    assert.equal(completed.loopId, loopId);
    const state = source.snapshot();
    const recordedSummaries = [
      ...state.journal.filter((event) => event.kind === "loopRunCompleted").map((event) => event.label),
      ...(state.audit ?? [])
        .filter((record) => record.kind === "runCompleted" && record.targetIds.includes(loopId))
        .flatMap((record) => [record.summary, record.detail]),
    ];
    assert.ok(recordedSummaries.length > 0, "the execution path wrote a durable completion event");
    assert.ok(
      recordedSummaries.some((recorded) =>
        recorded === completed.summary
        || recorded.includes(completed.summary)
        || completed.summary.includes(recorded)),
      `run summary was not drawn from a recorded event: ${completed.summary}`,
    );
  });
});

test("Loop drill-in K1: j/k selection stays bounded at the first and last run", () => {
  const loop = loopFixture("loop-bounds", "bounded selection loop");
  const source = new LoopFixtureSource([loop], new Map([[loop.id, [
    runFixture("bound-3", loop.id, "2026-07-18T15:03:00.000Z", "success", "BOUND_FIRST"),
    runFixture("bound-2", loop.id, "2026-07-18T15:02:00.000Z", "failure", "BOUND_MIDDLE"),
    runFixture("bound-1", loop.id, "2026-07-18T15:01:00.000Z", "trial", "BOUND_LAST"),
  ]]]));
  const app = appFor(source);
  openFirstLoop(app);

  for (let index = 0; index < 10; index += 1) app.handleInput("k");
  assert.match(selectedLine(app), /BOUND_FIRST/);
  for (let index = 0; index < 10; index += 1) app.handleInput("j");
  assert.match(selectedLine(app), /BOUND_LAST/);
  app.handleInput("j");
  assert.match(selectedLine(app), /BOUND_LAST/);
});

test("Loop drill-in K2: p toggles only the current loop pause state", async () => {
  const target = loopFixture("loop-pause-target", "pause target");
  const sibling = loopFixture("loop-pause-sibling", "pause sibling");
  const source = new LoopFixtureSource([target, sibling]);
  const app = appFor(source);
  openFirstLoop(app);

  app.handleInput("p");
  await flush();
  assert.equal(source.snapshot().loops.find((loop) => loop.id === target.id)?.health, "paused");
  assert.equal(source.snapshot().loops.find((loop) => loop.id === sibling.id)?.health, "healthy");

  app.handleInput("p");
  await flush();
  assert.equal(source.snapshot().loops.find((loop) => loop.id === target.id)?.health, "healthy");
});

test("Loop drill-in K3: an unbound printable character types into the prompt", () => {
  const app = appFor(new LoopFixtureSource([
    loopFixture("loop-gmail-unbound", "gmail unbound loop"),
  ]));
  openFirstLoop(app);

  app.handleInput("z");

  assert.match(prompt(app), /❯ z$/);
});

test("Loop drill-in K4: a bound key is literal while the prompt is non-empty", async () => {
  const loop = loopFixture("loop-gmail-bound", "gmail bound loop");
  const source = new LoopFixtureSource([loop]);
  const app = appFor(source);
  openFirstLoop(app);
  app.handleInput("z");

  app.handleInput("p");
  await flush();

  assert.match(prompt(app), /❯ zp$/);
  assert.equal(source.snapshot().loops[0]?.health, "healthy");
});

test("Loop drill-in EXTRA: summary row shows present values and omits absent fields", () => {
  const full = loopFixture("loop-summary-full", "full summary loop", {
    yieldToday: "YIELD_SENTINEL",
    costToday: "$12.34",
    lastFired: "LAST_FIRED_SENTINEL",
    nextRun: "NEXT_RUN_SENTINEL",
  });
  const sparse = loopFixture("loop-summary-sparse", "sparse summary loop");
  const source = new LoopFixtureSource([full, sparse], new Map([
    [full.id, [
      runFixture("summary-2", full.id, "2026-07-18T15:02:00.000Z", "success", "SUMMARY_NEW"),
      runFixture("summary-1", full.id, "2026-07-18T15:01:00.000Z", "trial", "SUMMARY_OLD"),
    ]],
    [sparse.id, [
      runFixture("sparse-1", sparse.id, "2026-07-18T15:01:00.000Z", "success", "SPARSE_RUN"),
    ]],
  ]));
  const app = appFor(source);
  openFirstLoop(app);
  const fullText = renderedText(app);
  assert.match(fullText, /2 runs?/);
  assert.match(fullText, /YIELD_SENTINEL/);
  assert.match(fullText, /\$12\.34/);
  assert.match(fullText, /LAST_FIRED_SENTINEL/);
  assert.match(fullText, /NEXT_RUN_SENTINEL/);

  app.handleInput("\x1b");
  app.handleInput("j");
  app.handleInput("\r");
  const sparseSummary = rendered(app).find((line) => /1 runs?/.test(line)) ?? "";
  assert.ok(sparseSummary, "sparse loop still renders its run count");
  assert.doesNotMatch(sparseSummary, /yield|cost|last fired|next run|undefined|null/i);
});

test("Loop drill-in EXTRA: the app requests history for the current loop only", () => {
  const alpha = loopFixture("history-alpha", "history alpha");
  const beta = loopFixture("history-beta", "history beta");
  const source = new LoopFixtureSource([alpha, beta], new Map([
    [alpha.id, [runFixture("alpha-run", alpha.id, "2026-07-18T15:00:00.000Z", "success", "ALPHA_HISTORY_ONLY")]],
    [beta.id, [runFixture("beta-run", beta.id, "2026-07-18T15:00:00.000Z", "failure", "BETA_HISTORY_ONLY")]],
  ]));
  const app = appFor(source);

  openFirstLoop(app);
  const text = renderedText(app);

  assert.match(text, /ALPHA_HISTORY_ONLY/);
  assert.doesNotMatch(text, /BETA_HISTORY_ONLY/);
  assert.ok(source.requestedRunIds.length > 0);
  assert.ok(source.requestedRunIds.every((id) => id === alpha.id));
});
