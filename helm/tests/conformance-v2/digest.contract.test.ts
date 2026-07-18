import assert from "node:assert/strict";
import test from "node:test";
import { renderDigest } from "../../src/screens/digest.js";
import type { JournalEvent } from "../../src/state/types.js";
import { makePersistentSource, stripLines, theme256, withTempProject } from "./helpers.js";

test("Digest contract row: caught failure persists as selfCaughtPaused and renders self-caught · paused", async () => {
  await withTempProject(async (root) => {
    const caught: JournalEvent = {
      id: "caught-paused-1",
      kind: "selfCaughtPaused",
      timestampMs: Date.now(),
      label: "lint regression",
    };
    const { source } = makePersistentSource(root, { state: { journal: [caught] } });
    const digest = source.getDigest();
    assert.deepEqual(digest.failedHandled, ["self-caught · paused · lint regression"]);
    const text = stripLines(renderDigest(digest, theme256, 120, 20)).join("\n");
    assert.match(text, /self-caught · paused/);
  });
});
