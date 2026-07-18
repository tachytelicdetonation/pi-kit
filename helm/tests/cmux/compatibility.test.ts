import assert from "node:assert/strict";
import test from "node:test";
import { parseVersion } from "../../src/cmux/compatibility.js";
import { CmuxClient } from "../../src/cmux/cmux-client.js";

test("parseVersion accepts cmux and Claude version output", () => {
  assert.deepEqual(parseVersion("cmux 0.64.19 (99) [abc]"), [0, 64, 19]);
  assert.deepEqual(parseVersion("2.1.212 (Claude Code)"), [2, 1, 212]);
  assert.equal(parseVersion("unknown"), undefined);
});

test("cmux client refuses newline-bearing send text", async () => {
  const client = new CmuxClient({ bin: "does-not-run" });
  await assert.rejects(client.sendText("surface-id", "hello\n/exit"), /Refusing multiline/);
});
