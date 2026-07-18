import assert from "node:assert/strict";
import test from "node:test";
import { createHelmRepository } from "../../src/state/persistence.js";
import type { Loop } from "../../src/state/types.js";
import { makePersistentSource, withTempProject } from "./helpers.js";

test("Loops contract row: editing a scheduled loop preserves activeDefinition and resets the draft gate", async () => {
  await withTempProject(async (root) => {
    const { source } = makePersistentSource(root);
    const created = await source.execute({ type: "loop.createDraft", prompt: "every hour run ORIGINAL_STEP", draftId: "loop-isolated" });
    await source.trialLoop(created.id!);
    await source.execute({ type: "loop.schedule", loopId: created.id! });
    const activeBefore = structuredClone(source.snapshot().loops.find((loop) => loop.id === created.id)?.activeDefinition);
    assert.ok(activeBefore);

    await source.execute({ type: "loop.edit", loopId: created.id!, text: "every hour run PENDING_STEP" });
    const scheduled = source.snapshot().loops.find((loop) => loop.id === created.id);
    assert.deepEqual(scheduled?.activeDefinition, activeBefore);
    assert.match(source.getLoopDraft(created.id!)?.steps ?? "", /PENDING_STEP/);
    assert.equal(source.getLoopDraft(created.id!)?.trialPassed, false);
  });
});

test("Loops contract row: an armed firing reads immutable activeDefinition, never the pending draft", async () => {
  await withTempProject(async (root) => {
    const repository = createHelmRepository(root, `${root}/state.json`);
    const activeDefinition = {
      id: "loop-armed",
      name: "armed",
      prompt: "ORIGINAL_PROMPT",
      trigger: "every hour",
      steps: "ORIGINAL_STEP",
      skips: "none",
      guardrails: ["review"],
      trialStatement: "passed",
      trialPassed: true,
    };
    const scheduled: Loop = {
      id: "loop-armed",
      name: "armed",
      trigger: "every hour",
      pipelineSummary: "ORIGINAL_STEP",
      health: "healthy",
      scheduleEveryMs: 3_600_000,
      nextRunAtMs: Date.now() - 1,
      activeDefinition,
    };
    repository.save({
      ...repository.load(),
      loops: [scheduled],
      loopDrafts: [{ ...activeDefinition, prompt: "PENDING_PROMPT", steps: "PENDING_STEP", trialPassed: false }],
    });
    const { spies } = makePersistentSource(root, { deps: { repository } });
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(spies.loopRuns.length, 1);
    assert.equal(spies.loopRuns[0]?.steps, "ORIGINAL_STEP");
    assert.equal(spies.loopRuns[0]?.prompt, "ORIGINAL_PROMPT");
  });
});
