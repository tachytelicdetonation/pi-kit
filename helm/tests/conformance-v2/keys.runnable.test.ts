import assert from "node:assert/strict";
import test from "node:test";
import { HelmApp } from "../../src/app.js";
import { MockDataSource, seedState } from "../../src/data/mock.js";
import type { HelmState } from "../../src/state/types.js";
import { fakeTui, flush, stripAnsi, stripLines, theme256 } from "./helpers.js";

function header(app: HelmApp): string {
  return stripAnsi(app.render(120)[0] ?? "");
}

function prompt(app: HelmApp): string {
  return stripLines(app.render(120)).filter((line) => line.includes("❯")).at(-1) ?? "";
}

test("Keys row: q is unbound and types into an empty prompt; ctrl+q exits", () => {
  let exits = 0;
  const app = new HelmApp(fakeTui(), theme256, () => { exits += 1; });
  app.handleInput("q");
  assert.equal(exits, 0);
  assert.match(prompt(app), /❯ q$/);

  app.handleInput("\x1b");
  app.handleInput("\x11");
  assert.equal(exits, 1);
});

test("Keys row: escape at empty home never exits, even repeatedly", () => {
  let exits = 0;
  const app = new HelmApp(fakeTui(), theme256, () => { exits += 1; });
  for (let index = 0; index < 10; index += 1) app.handleInput("\x1b");
  assert.equal(exits, 0);
  assert.match(header(app), /mission control/);
});

function screenCases(): Array<{ name: string; create: () => HelmApp }> {
  const base = () => new HelmApp(fakeTui(), theme256, () => {});
  return [
    { name: "mission control", create: base },
    { name: "workflow drill-in", create: () => { const app = base(); app.handleInput("j"); app.handleInput("j"); app.handleInput("\r"); return app; } },
    { name: "session", create: () => { const app = base(); app.handleInput("j"); app.handleInput("j"); app.handleInput("\r"); app.handleInput("\r"); return app; } },
    { name: "escalation", create: () => { const app = base(); app.handleInput("\r"); return app; } },
    { name: "digest", create: () => new HelmApp(fakeTui(), theme256, () => {}, new MockDataSource({ shouldShowDigest: true })) },
    { name: "intake", create: () => { const app = base(); app.handleInput("n"); return app; } },
    { name: "loop builder", create: () => { const app = base(); app.handleInput("N"); return app; } },
    { name: "closeout", create: () => { const app = base(); app.handleInput("/"); for (const ch of "migrate") app.handleInput(ch); app.handleInput("\r"); return app; } },
    { name: "search", create: () => { const app = base(); app.handleInput("/"); return app; } },
  ];
}

for (const scenario of screenCases()) {
  test(`Keys row: tab jumps to needs-you from ${scenario.name}`, () => {
    const app = scenario.create();
    app.handleInput("\t");
    assert.match(header(app), /needs you/, `tab failed from ${scenario.name}`);
  });
}

class GoalRowsSource extends MockDataSource {
  constructor(private readonly goalState: HelmState) {
    super();
  }

  override snapshot(): HelmState {
    return this.goalState;
  }

  override getCloseout(id: string) {
    const value = super.getCloseout(id);
    const goal = this.goalState.goals.find((item) => item.id === id);
    return value && goal ? { ...value, goalName: goal.name } : value;
  }
}

test("Keys row: enter on a completed goal opens its closeout", () => {
  const state = seedState();
  state.escalations = [];
  state.loops = [];
  state.workflows = [];
  state.goals = [{ id: "g-complete-contract", name: "completed contract goal", phase: "complete", progress: 1 }];
  const app = new HelmApp(fakeTui(), theme256, () => {}, new GoalRowsSource(state));
  app.handleInput("\r");
  assert.match(header(app), /goal complete · completed contract goal/);
});

test("Keys row: enter on an active goal opens its top workflow drill-in", () => {
  const state = seedState();
  state.escalations = [];
  state.loops = [];
  state.goals = [{ id: "g-esm", name: "active contract goal", phase: "running", progress: 0.5 }];
  state.workflows = state.workflows.filter((workflow) => workflow.goalId === "g-esm");
  const app = new HelmApp(fakeTui(), theme256, () => {}, new GoalRowsSource(state));
  app.handleInput("\r");
  assert.match(header(app), /esm › codemod/);
});

test("Keys row: p on an escalation card is a strict no-op", () => {
  const app = new HelmApp(fakeTui(), theme256, () => {});
  app.handleInput("\r");
  const before = app.render(120);
  app.handleInput("p");
  assert.deepEqual(app.render(120), before);
});

test("Keys row: p with no selectable home row is a strict no-op", () => {
  const state = seedState();
  state.escalations = [];
  state.goals = [];
  state.workflows = [];
  state.loops = [];
  const app = new HelmApp(fakeTui(), theme256, () => {}, new GoalRowsSource(state));
  const before = app.render(120);
  app.handleInput("p");
  assert.deepEqual(app.render(120), before);
});

class DeferredTrialSource extends MockDataSource {
  resolveTrial!: (value: { ok: boolean }) => void;

  override trialLoop(): Promise<{ passed: boolean; evidence: string[]; ok: boolean }> {
    return new Promise<{ ok: boolean }>((resolve) => { this.resolveTrial = resolve; })
      .then(({ ok }) => ({ passed: ok, evidence: [], ok }));
  }
}

test("Keys row: loop-builder e is rejected while trialing and after pass until r", async () => {
  const source = new DeferredTrialSource();
  const app = new HelmApp(fakeTui(), theme256, () => {}, source);
  app.handleInput("N");
  app.handleInput("t");
  app.handleInput("e");
  assert.doesNotMatch(prompt(app), /describe the loop behavior/);

  source.resolveTrial({ ok: true });
  await flush();
  app.handleInput("e");
  assert.doesNotMatch(prompt(app), /describe the loop behavior/);

  app.handleInput("r");
  app.handleInput("e");
  assert.match(prompt(app), /describe the loop behavior/);
});
