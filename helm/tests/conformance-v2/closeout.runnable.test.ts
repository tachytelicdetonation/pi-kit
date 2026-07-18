import assert from "node:assert/strict";
import test from "node:test";
import { RealDataSource } from "../../src/data/real.js";
import { emptyState, makePersistentSource, withTempProject } from "./helpers.js";

test("Closeout row: a completed goal exposes concrete measured metrics, not placeholder prose", async () => {
  await withTempProject(async (root) => {
    const base = makePersistentSource(root, { repository: false });
    const source = new RealDataSource({
      ...base.deps,
      nativeState: emptyState(root, {
        goals: [{ id: "goal-receipts", name: "receipt-backed goal", phase: "running", progress: 0.8, estCost: "~$12" }],
      }),
      workflows: {
        ...base.deps.workflows,
        getGoalProgress: (goalId) => goalId === "goal-receipts" ? { progress: 1, complete: true } : undefined,
      },
    });
    const closeout = source.getCloseout("goal-receipts");
    assert.ok(closeout);
    assert.match(`${closeout.packagesDone}/${closeout.packagesTotal}`, /^\d+\/\d+$/);
    assert.match(closeout.addedText, /^\+[\d,.]+[kKmM]?$/);
    assert.match(closeout.removedText, /^−[\d,.]+[kKmM]?$/);
    assert.match(closeout.commitsText, /^\d+ commits?$/);
    assert.match(closeout.greenText, /^\d+(?:\.\d+)?% green(?: \(.+\))?$/);
    assert.match(closeout.actualCost, /^\$\d+\.\d{2}$/);
    assert.match(closeout.estCost, /^~?\$\d+(?:\.\d{2})?$/);
    assert.match(closeout.yourTime, /\d+ decisions?.*\d+ min/);
    assert.match(closeout.interventions, /\d+/);
    assert.doesNotMatch(
      [closeout.addedText, closeout.removedText, closeout.commitsText, closeout.greenText, closeout.actualCost, closeout.interventions, closeout.overrunWhy].join(" "),
      /tracked in git|repository receipts available|see usage|see activity log|see workflow history/i,
    );
  });
});
