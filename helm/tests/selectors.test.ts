import assert from "node:assert/strict";
import test from "node:test";
import {
  activeLoopCount,
  needsYouCount,
  progressBar8,
  selectableCount,
  selectableRows,
  workflowsForGoal,
} from "../src/state/selectors.js";
import { seedState } from "../src/data/mock.js";

test("needsYouCount counts escalations", () => {
  assert.equal(needsYouCount(seedState()), 2);
});

test("progressBar8 splits a fraction into 8 filled/empty cells", () => {
  assert.deepEqual(progressBar8(0.6), { filled: 5, empty: 3 });
  assert.deepEqual(progressBar8(0), { filled: 0, empty: 8 });
  assert.deepEqual(progressBar8(1), { filled: 8, empty: 0 });
  // Out-of-range / non-finite inputs clamp rather than throw.
  assert.deepEqual(progressBar8(2), { filled: 8, empty: 0 });
  assert.deepEqual(progressBar8(Number.NaN), { filled: 0, empty: 8 });
});

test("workflowsForGoal returns only that goal's top-level workflows", () => {
  const state = seedState();
  const esm = workflowsForGoal(state, "g-esm").map((w) => w.id);
  const perf = workflowsForGoal(state, "g-perf").map((w) => w.id);
  assert.deepEqual(esm, ["w-codemod", "w-test-repair", "w-docs"]);
  assert.deepEqual(perf, ["w-profiling"]);
  assert.equal(workflowsForGoal(state, "nope").length, 0);
});

test("activeLoopCount excludes paused loops", () => {
  const state = seedState();
  assert.equal(activeLoopCount(state), 3);
  const paused = { ...state, loops: state.loops.map((l, i) => (i === 0 ? { ...l, health: "paused" as const } : l)) };
  assert.equal(activeLoopCount(paused), 2);
});

test("selectableRows lists escalations, then per-goal workflows, then loops", () => {
  const rows = selectableRows(seedState());
  assert.deepEqual(rows.slice(0, 2).map((r) => r.kind), ["escalation", "escalation"]);
  assert.deepEqual(
    rows.map((r) => r.id),
    [
      "e-export-map",
      "e-api-rename",
      "w-codemod",
      "w-test-repair",
      "w-docs",
      "w-profiling",
      "l-gh-issues",
      "l-ci-red",
      "l-deps",
    ],
  );
  assert.equal(selectableCount(seedState()), 9);
});
