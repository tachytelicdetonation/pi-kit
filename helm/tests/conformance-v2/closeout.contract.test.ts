import assert from "node:assert/strict";
import test from "node:test";
import { HelmApp } from "../../src/app.js";
import { RealDataSource } from "../../src/data/real.js";
import { createHelmRepository } from "../../src/state/persistence.js";
import type { Closeout, Precedent } from "../../src/state/types.js";
import { fakeTui, flush, makePersistentSource, theme256, withTempProject } from "./helpers.js";

const proposal: Precedent = {
  id: "precedent-contract",
  signature: "decision:contract:scope",
  question: "Keep the narrow contract?",
  decision: "yes",
  rationale: "bounded change",
};

function closeout(goalId: string): Closeout {
  return {
    goalId,
    goalName: "contract closeout",
    startedText: "started",
    landedText: "landed",
    packagesDone: 3,
    packagesTotal: 3,
    unit: "packages",
    addedText: "+12",
    removedText: "−4",
    commitsText: "2 commits",
    greenText: "100% green",
    actualCost: "$1.25",
    estCost: "$2.00",
    yourTime: "1 decision · 2 min",
    interventions: "0 interventions",
    overrunWhy: "none",
    proposedPrecedents: [proposal],
  };
}

test("Closeout contract row: declining a precedent persists and suppresses it after relaunch", async () => {
  await withTempProject(async (root) => {
    const repository = createHelmRepository(root, `${root}/state.json`);
    repository.save({
      ...repository.load(),
      goals: [{ id: "goal-closeout", name: "contract closeout", phase: "complete", progress: 1 }],
      precedents: [proposal],
      closeouts: [closeout("goal-closeout")],
    });
    const firstDeps = makePersistentSource(root, { deps: { repository } }).deps;
    const first = new RealDataSource(firstDeps);
    first.declinePrecedent(proposal.id);

    const relaunched = new RealDataSource(firstDeps);
    assert.equal(relaunched.precedents().find((item) => item.id === proposal.id)?.declined, true);
    assert.equal(relaunched.getCloseout("goal-closeout")?.proposedPrecedents.some((item) => item.id === proposal.id), false);
  });
});

test("Closeout contract row: digits toggle a numbered precedent to declined and apply sends only accepted ones", async () => {
  class CloseoutSource extends RealDataSource {
    applied: string[] = [];

    override async execute(command: Parameters<RealDataSource["execute"]>[0]) {
      if (command.type === "goal.applyPrecedents") {
        this.applied = this.getCloseout(command.goalId)?.proposedPrecedents.map((item) => item.id) ?? [];
      }
      return super.execute(command);
    }
  }

  await withTempProject(async (root) => {
    const repository = createHelmRepository(root, `${root}/state.json`);
    repository.save({
      ...repository.load(),
      goals: [{ id: "goal-closeout", name: "contract closeout", phase: "complete", progress: 1 }],
      closeouts: [closeout("goal-closeout")],
    });
    const deps = makePersistentSource(root, { deps: { repository } }).deps;
    const source = new CloseoutSource(deps);
    const app = new HelmApp(fakeTui(), theme256, () => {}, source);
    app.handleInput("/");
    for (const ch of "contract closeout") app.handleInput(ch);
    app.handleInput("\r");
    app.handleInput("1");
    assert.equal(source.precedents().find((item) => item.id === proposal.id)?.declined, true);
    app.handleInput("a");
    app.handleInput("y");
    await flush();
    assert.deepEqual(source.applied, []);
  });
});

test("Closeout contract row: applied precedent state survives relaunch", async () => {
  await withTempProject(async (root) => {
    const repository = createHelmRepository(root, `${root}/state.json`);
    repository.save({
      ...repository.load(),
      goals: [{ id: "goal-closeout", name: "contract closeout", phase: "complete", progress: 1 }],
      precedents: [proposal],
      closeouts: [closeout("goal-closeout")],
    });
    const deps = makePersistentSource(root, { deps: { repository } }).deps;
    const first = new RealDataSource(deps);
    const result = await first.execute({ type: "goal.applyPrecedents", goalId: "goal-closeout" });
    assert.equal(result.ok, true);

    const relaunched = new RealDataSource(deps);
    assert.ok(relaunched.precedents().find((item) => item.id === proposal.id)?.appliesTo);
    assert.equal(relaunched.getCloseout("goal-closeout")?.proposedPrecedents.some((item) => item.id === proposal.id), false);
  });
});
