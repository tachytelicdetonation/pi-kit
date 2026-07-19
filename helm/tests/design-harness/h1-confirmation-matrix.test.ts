import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { HelmApp } from "../../src/app.js";
import {
  seedCodemodDrillIn,
  seedExportMapEscalation,
  seedSession,
} from "../../src/data/mock.js";
import { createHelmRepository } from "../../src/state/persistence.js";
import type { Goal, Loop, Precedent, Workflow } from "../../src/state/types.js";
import {
  fakeTui,
  flush,
  makePersistentSource,
  stripLines,
  theme256,
  withTempProject,
} from "../conformance-v2/helpers.js";

const destructiveCommands = [
  "goal.discardDraft",
  "loop.discardDraft",
  "goal.archive",
  "goal.applyPrecedents",
  "worktree.reassign",
  "session.merge",
] as const;

const nonDestructiveCommands = [
  "goal.createDraft",
  "goal.answer",
  "goal.editPlan",
  "goal.spawn",
  "goal.togglePause",
  "goal.report",
  "loop.createDraft",
  "loop.edit",
  "loop.schedule",
  "loop.togglePause",
  "workflow.togglePause",
  "worktree.togglePause",
  "worktree.testDetails",
  "session.diff",
  "session.steer",
  "escalation.ask",
  "digest.fullLog",
] as const;

const appSource = readFileSync(new URL("../../src/app.ts", import.meta.url), "utf8");
const commandSource = readFileSync(new URL("../../src/data/source.ts", import.meta.url), "utf8");

function text(app: HelmApp): string {
  return stripLines(app.render(140)).join("\n");
}

function hasConfirmation(app: HelmApp): boolean {
  return /confirm .+ · y yes · n no/i.test(text(app));
}

async function settle(): Promise<void> {
  await flush();
  await flush();
}

function fleetFixture(): { goal: Goal; workflow: Workflow } {
  return {
    goal: { id: "g-confirm", name: "confirmation matrix goal", phase: "running", progress: 0.5 },
    workflow: {
      id: "w-codemod",
      goalId: "g-confirm",
      name: "codemod",
      state: "running",
      summary: "changing packages",
    },
  };
}

test("H1: the known safety classification exactly covers the HelmCommand registry", () => {
  const union = commandSource.slice(
    commandSource.indexOf("export type HelmCommand"),
    commandSource.indexOf("export interface HelmCommandResult"),
  );
  const exposed = [...union.matchAll(/\{\s*type:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(
    [...destructiveCommands, ...nonDestructiveCommands].sort(),
    [...exposed].sort(),
    "a newly exposed command must be explicitly classified as destructive or non-destructive",
  );

  const confirmed = [...appSource.matchAll(/this\.confirm\([\s\S]{0,320}?\{\s*type:\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(
    [...confirmed].sort(),
    [...destructiveCommands].sort(),
    "every command classified destructive must remain behind HelmApp.confirm",
  );
  assert.match(appSource, /if \(option\?\.requiresConfirm\)[\s\S]{0,180}this\.confirm/,
    "destructive escalation options must remain driven by requiresConfirm metadata");
});

test("H1: discarding a goal draft requires a second confirmation key before durable deletion", async () => {
  await withTempProject(async (root) => {
    const { source, statePath } = makePersistentSource(root);
    const repository = createHelmRepository(root, statePath);
    const app = new HelmApp(fakeTui(), theme256, () => {}, source);

    app.handleInput("n");
    await settle();
    assert.equal(repository.load().intakes.length, 1, "the draft exists before discard");
    app.handleInput("x");
    assert.equal(repository.load().intakes.length, 1, "first keypress cannot delete the draft");
    assert.equal(hasConfirmation(app), true);
    app.handleInput("y");
    await settle();
    assert.equal(repository.load().intakes.length, 0, "confirmation durably deletes the draft");
    assert.match(text(app), /mission control/i);
    app.dispose();
  });
});

test("H1: discarding a loop draft requires a second confirmation key before durable deletion", async () => {
  await withTempProject(async (root) => {
    const { source, statePath } = makePersistentSource(root);
    const repository = createHelmRepository(root, statePath);
    const app = new HelmApp(fakeTui(), theme256, () => {}, source);

    app.handleInput("N");
    await settle();
    assert.equal(repository.load().loopDrafts.length, 1, "the draft exists before discard");
    app.handleInput("x");
    assert.equal(repository.load().loopDrafts.length, 1, "first keypress cannot delete the draft");
    assert.equal(hasConfirmation(app), true);
    app.handleInput("y");
    await settle();
    assert.equal(repository.load().loopDrafts.length, 0, "confirmation durably deletes the draft");
    assert.match(text(app), /mission control/i);
    app.dispose();
  });
});

test("H1: archiving a completed goal requires confirmation before its durable phase changes", async () => {
  await withTempProject(async (root) => {
    const goal: Goal = { id: "g-archive", name: "archive safety", phase: "complete", progress: 1 };
    const { source, statePath } = makePersistentSource(root, { state: { goals: [goal] } });
    const repository = createHelmRepository(root, statePath);
    const app = new HelmApp(fakeTui(), theme256, () => {}, source);

    app.handleInput("\r");
    assert.match(text(app), /goal complete · archive safety/i);
    app.handleInput("x");
    assert.equal(repository.load().goals[0]?.phase, "complete", "first keypress cannot archive the goal");
    assert.equal(hasConfirmation(app), true);
    app.handleInput("y");
    await settle();
    assert.equal(repository.load().goals[0]?.phase, "archived", "confirmation durably archives the goal");
    assert.match(text(app), /mission control/i);
    app.dispose();
  });
});

test("H1: applying precedents requires confirmation before durable handoff", async () => {
  await withTempProject(async (root) => {
    const statePath = `${root}/.helm-test/state.json`;
    const repository = createHelmRepository(root, statePath);
    const goal: Goal = { id: "g-precedent", name: "precedent safety", phase: "complete", progress: 1 };
    const precedent: Precedent = {
      id: "p-confirm",
      goalId: goal.id,
      signature: "decision:workflow:confirm:scope",
      question: "How should the safety seam behave?",
      decision: "Require an explicit confirmation",
      rationale: "operator decision",
    };
    repository.save({ ...repository.load(), goals: [goal], precedents: [precedent] });
    const { source } = makePersistentSource(root, { deps: { repository } });
    let handoff = "";
    const app = new HelmApp(fakeTui(), theme256, () => {}, source, undefined, (prompt) => { handoff = prompt; });

    app.handleInput("\r");
    app.handleInput("a");
    assert.equal(repository.load().precedents[0]?.appliesTo, undefined, "first keypress cannot hand off guidance");
    assert.equal(handoff, "");
    assert.equal(hasConfirmation(app), true);
    app.handleInput("y");
    await settle();
    assert.equal(repository.load().precedents[0]?.appliesTo, "handoff", "confirmation durably marks the handoff");
    assert.match(handoff, /Apply these approved Helm precedents/i);
    app.dispose();
  });
});

for (const scenario of [
  { name: "worktree reassignment", key: "r", descendToSession: false, expected: /Reassign the work/i },
  { name: "session merge", key: "m", descendToSession: true, expected: /Merge the completed work/i },
] as const) {
  test(`H1: ${scenario.name} cannot cross the Pi handoff boundary on its first keypress`, async () => {
    await withTempProject(async (root) => {
      const { goal, workflow } = fleetFixture();
      const detail = seedCodemodDrillIn();
      const { source } = makePersistentSource(root, {
        state: { goals: [goal] },
        workflows: [workflow],
        details: new Map([[workflow.id, detail]]),
        sessions: new Map([[detail.worktrees[0]!.id, seedSession(detail.worktrees[0]!.id)]]),
      });
      let handoff = "";
      let closes = 0;
      const app = new HelmApp(fakeTui(), theme256, () => { closes += 1; }, source, undefined, (prompt) => { handoff = prompt; });
      app.handleInput("\r");
      if (scenario.descendToSession) app.handleInput("\r");

      app.handleInput(scenario.key);
      assert.equal(handoff, "", "first keypress cannot reach the agent handoff boundary");
      assert.equal(closes, 0, "the full-screen view remains open while confirmation is pending");
      assert.equal(hasConfirmation(app), true);
      app.handleInput("y");
      await settle();
      assert.match(handoff, scenario.expected);
      assert.equal(closes, 1, "confirmed handoff closes Helm exactly once");
      app.dispose();
    });
  });
}

test("H1: a destructive numbered escalation option requires confirmation before durable resolution", async () => {
  await withTempProject(async (root) => {
    const escalation = seedExportMapEscalation();
    escalation.options = escalation.options.map((option, index) => ({ ...option, requiresConfirm: index === 0 }));
    const { source, statePath } = makePersistentSource(root, { state: { escalations: [escalation] } });
    const repository = createHelmRepository(root, statePath);
    const app = new HelmApp(fakeTui(), theme256, () => {}, source);

    app.handleInput("\r");
    app.handleInput("1");
    assert.equal(repository.load().escalations.length, 1, "first number key cannot resolve a protected option");
    assert.equal(repository.load().decisions.length, 0);
    assert.equal(hasConfirmation(app), true);
    app.handleInput("y");
    await settle();
    assert.equal(repository.load().escalations.length, 0, "confirmation resolves the escalation");
    assert.equal(repository.load().decisions.length, 1, "the decision is durable");
    app.dispose();
  });
});

test("H1: global pause and resume take effect immediately without a confirmation prompt", async () => {
  await withTempProject(async (root) => {
    const { source, statePath } = makePersistentSource(root);
    const repository = createHelmRepository(root, statePath);
    const app = new HelmApp(fakeTui(), theme256, () => {}, source);

    app.handleInput("\x10");
    assert.equal(repository.load().pausedAll, true);
    assert.equal(hasConfirmation(app), false);
    app.handleInput("\x10");
    assert.equal(repository.load().pausedAll, false);
    assert.equal(hasConfirmation(app), false);
    app.dispose();
  });
});

test("H1: loop pause and resume take effect immediately without a confirmation prompt", async () => {
  await withTempProject(async (root) => {
    const loop: Loop = {
      id: "l-pause",
      name: "pause matrix loop",
      trigger: "manual",
      pipelineSummary: "inspect → report",
      health: "healthy",
      lifecycle: "scheduled",
      scheduledState: "healthy",
    };
    const { source } = makePersistentSource(root, { state: { loops: [loop] } });
    const app = new HelmApp(fakeTui(), theme256, () => {}, source);

    app.handleInput("p");
    await settle();
    assert.equal(source.snapshot().loops[0]?.health, "paused");
    assert.equal(hasConfirmation(app), false);
    app.handleInput("p");
    await settle();
    assert.equal(source.snapshot().loops[0]?.health, "healthy");
    assert.equal(hasConfirmation(app), false);
    app.dispose();
  });
});

test("H1: worktree pause/resume and read-only test details never show a confirmation prompt", async () => {
  await withTempProject(async (root) => {
    const { goal, workflow } = fleetFixture();
    const detail = seedCodemodDrillIn();
    const { source } = makePersistentSource(root, {
      state: { goals: [goal] },
      workflows: [workflow],
      details: new Map([[workflow.id, detail]]),
    });
    const app = new HelmApp(fakeTui(), theme256, () => {}, source);
    app.handleInput("\r");

    app.handleInput("p");
    await settle();
    assert.equal(hasConfirmation(app), false);
    assert.equal(source.snapshot().audit?.at(-1)?.kind, "pause");
    app.handleInput("p");
    await settle();
    assert.equal(hasConfirmation(app), false);
    assert.equal(source.snapshot().audit?.at(-1)?.kind, "resume");

    app.handleInput("t");
    await settle();
    assert.equal(hasConfirmation(app), false);
    assert.match(text(app), /test race · wt-1/i, "read-only detail opens directly");
    app.dispose();
  });
});
