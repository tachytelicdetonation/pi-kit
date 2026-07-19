import { removeTempDir, tempDir } from "../helpers/tmp.js";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readAssistantOutput, transcriptOffset, truncateOutput } from "../../src/cmux/transcript.js";

test("reads only non-sidechain assistant text after the captured offset", async () => {
  const directory = tempDir("claude-cmux-transcript-");
  const path = join(directory, "session.jsonl");
  try {
    await writeFile(path, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "old" }] } })}\n`);
    const offset = await transcriptOffset(path);
    const lines = [
      { type: "user", message: { content: "new prompt" } },
      { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent" }] } },
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "hidden" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "final answer" }] } },
    ];
    await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", { flag: "a" });
    assert.equal(await readAssistantOutput(path, offset), "final answer");
  } finally {
    removeTempDir(directory);
  }
});

test("output truncation keeps the tail and marks omission", () => {
  const result = truncateOutput(`prefix-${"x".repeat(200)}-suffix`, 64);
  assert.equal(result.truncated, true);
  assert.match(result.text, /Earlier output omitted/);
  assert.match(result.text, /suffix$/);
});
