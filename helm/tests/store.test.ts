import assert from "node:assert/strict";
import test from "node:test";
import { HelmStore } from "../src/state/store.js";
import { seedState } from "../src/data/mock.js";
import type { Escalation } from "../src/state/types.js";

/** A minimal Escalation for sort tests — only id / blockedSinceMs matter here. */
function esc(id: string, blockedSinceMs: number): Escalation {
  return {
    id,
    source: { kind: "goal", label: "x" },
    question: "q",
    verb: "v",
    blockedSinceMs,
    problem: "p",
    evidence: [],
    options: [{ text: "o", recommended: true }],
    blockedMinutes: 1,
    idleNote: "idle",
    signature: `sig:${id}`,
  };
}

test("a mutation notifies subscribers", () => {
  const store = new HelmStore(seedState());
  let notified = 0;
  const unsub = store.subscribe(() => (notified += 1));
  store.pauseAll();
  assert.equal(notified, 1);
  unsub();
  store.resumeAll();
  assert.equal(notified, 1, "unsubscribed callback is not called");
});

test("pauseAll / resumeAll toggle pausedAll", () => {
  const store = new HelmStore(seedState());
  assert.equal(store.getState().pausedAll, false);
  store.pauseAll();
  assert.equal(store.getState().pausedAll, true);
  store.resumeAll();
  assert.equal(store.getState().pausedAll, false);
});

test("pauseAll is idempotent (no re-notify when already paused)", () => {
  const store = new HelmStore(seedState());
  let notified = 0;
  store.subscribe(() => (notified += 1));
  store.pauseAll();
  store.pauseAll();
  assert.equal(notified, 1);
});

test("pauseWorkflow sets that lane to paused", () => {
  const store = new HelmStore(seedState());
  store.pauseWorkflow("w-codemod");
  const lane = store.getState().workflows.find((w) => w.id === "w-codemod");
  assert.equal(lane?.state, "paused");
});

test("escalations are stored oldest-blocked first, ties broken by id", () => {
  const base = seedState();
  const store = new HelmStore({
    ...base,
    escalations: [esc("b", 5), esc("a", 5), esc("c", 1)],
  });
  assert.deepEqual(
    store.getState().escalations.map((e) => e.id),
    ["c", "a", "b"],
  );
});

test("paused loops sink below active ones, order otherwise preserved", () => {
  const base = seedState();
  const store = new HelmStore({
    ...base,
    loops: [
      { id: "p1", name: "p1", trigger: "t", pipelineSummary: "s", health: "paused" },
      { id: "h1", name: "h1", trigger: "t", pipelineSummary: "s", health: "healthy" },
      { id: "i1", name: "i1", trigger: "t", pipelineSummary: "s", health: "idle" },
    ],
  });
  assert.deepEqual(
    store.getState().loops.map((l) => l.id),
    ["h1", "i1", "p1"],
  );
});

test("sort order is stable across snapshots when nothing changed", () => {
  const store = new HelmStore(seedState());
  const first = store.getState();
  const second = store.getState();
  assert.strictEqual(first, second, "same reference between mutations");
  assert.deepEqual(
    first.escalations.map((e) => e.id),
    second.escalations.map((e) => e.id),
  );
});
