import assert from "node:assert/strict";
import test from "node:test";
import { createHelmRepository } from "../../src/state/persistence.js";
import { renderDigest } from "../../src/screens/digest.js";
import type { DigestData } from "../../src/state/types.js";
import { makePersistentSource, stripLines, theme256, withTempProject } from "./helpers.js";

test("Digest row: launch gate is false at exactly 30 minutes and true one millisecond later", async () => {
  await withTempProject(async (root) => {
    const realNow = Date.now;
    const now = 1_800_000_000_000;
    Date.now = () => now;
    try {
      const repository = createHelmRepository(root, `${root}/state.json`);
      const domain = repository.load();
      repository.save({ ...domain, lastSeenAt: now - 30 * 60_000 });
      const exact = makePersistentSource(root, { deps: { repository } }).source;
      assert.equal(exact.shouldShowDigest(), false);

      repository.save({ ...repository.load(), lastSeenAt: now - 30 * 60_000 - 1 });
      const over = makePersistentSource(root, { deps: { repository } }).source;
      assert.equal(over.shouldShowDigest(), true);
    } finally {
      Date.now = realNow;
    }
  });
});

test("Digest row: starting a goal emits no prOpened journal event", async () => {
  await withTempProject(async (root) => {
    const { source } = makePersistentSource(root);
    const draft = await source.execute({ type: "goal.createDraft", prompt: "ship without pretending a PR exists", draftId: "goal-no-fake-pr" });
    assert.equal(draft.ok, true);
    const spawned = await source.execute({ type: "goal.spawn", draftId: "goal-no-fake-pr" });
    assert.equal(spawned.ok, true);
    assert.equal(source.snapshot().journal.some((event) => event.kind === "prOpened"), false);
  });
});

test("Digest row: spend and provider drain are deltas from the persisted last-seen usage snapshot", async () => {
  await withTempProject(async (root) => {
    const beforeUsage = {
      providers: [
        { id: "codex" as const, remaining: 90, resetText: "later" },
        { id: "claude" as const, remaining: 70, resetText: "later" },
        { id: "kimi" as const, remaining: 40, resetText: "later" },
      ],
      spendToday: "$10.00",
      spendWeek: "$50.00",
      perGoal: [],
    };
    makePersistentSource(root, {
      usage: beforeUsage,
      footer: { providers: beforeUsage.providers.map(({ id, remaining }) => ({ id, remaining })) },
    });

    const repository = createHelmRepository(root, `${root}/.helm-test/state.json`);
    repository.save({ ...repository.load(), lastSeenAt: Date.now() - 31 * 60_000 });

    const afterUsage = {
      providers: [
        { id: "codex" as const, remaining: 80, resetText: "later" },
        { id: "claude" as const, remaining: 70, resetText: "later" },
        { id: "kimi" as const, remaining: 35, resetText: "later" },
      ],
      spendToday: "$13.25",
      spendWeek: "$53.25",
      perGoal: [],
    };
    const { source } = makePersistentSource(root, {
      usage: afterUsage,
      footer: { providers: afterUsage.providers.map(({ id, remaining }) => ({ id, remaining })) },
    });
    const digest = source.getDigest();
    assert.equal(digest.spentText, "$3.25 spent");
    assert.deepEqual(digest.quotaDrain, [
      { provider: "codex", deltaPercent: -10 },
      { provider: "claude", deltaPercent: 0 },
      { provider: "kimi", deltaPercent: -5 },
    ]);
  });
});

test("Digest row: all four line types render in strict order", () => {
  const digest: DigestData = {
    spanText: "then → now",
    spentText: "$4.50 spent",
    shippedGoals: ["GOAL_SENTINEL"],
    shippedByLoops: ["LOOP_SENTINEL"],
    decisionsQueued: ["DECISION_SENTINEL"],
    failedHandled: ["FAILURE_SENTINEL self-caught · paused"],
    quotaDrain: [
      { provider: "codex", deltaPercent: 0 },
      { provider: "claude", deltaPercent: 0 },
      { provider: "kimi", deltaPercent: 0 },
    ],
  };
  const rendered = stripLines(renderDigest(digest, theme256, 140, 40));
  const indices = ["GOAL_SENTINEL", "LOOP_SENTINEL", "DECISION_SENTINEL", "FAILURE_SENTINEL"]
    .map((sentinel) => rendered.findIndex((line) => line.includes(sentinel)));
  assert.ok(indices.every((index) => index >= 0));
  assert.deepEqual([...indices].sort((a, b) => a - b), indices);
});

test("Digest row: a journal without a revert receipt never fabricates selfCaughtRevert", async () => {
  await withTempProject(async (root) => {
    const { source } = makePersistentSource(root, {
      state: {
        journal: [
          { id: "event-1", kind: "merged", timestampMs: 1, label: "confirmed merge" },
          { id: "event-2", kind: "escalated", timestampMs: 2, label: "operator decision" },
        ],
      },
    });
    assert.equal(source.snapshot().journal.some((event) => event.kind === "selfCaughtRevert"), false);
    assert.equal(source.getDigest().failedHandled.some((line) => /revert/i.test(line)), false);
  });
});
