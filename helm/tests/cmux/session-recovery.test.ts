import { removeTempDir, tempDir } from "../helpers/tmp.js";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ClaudeSessionController } from "../../src/cmux/session-controller.js";
import { transcriptOffset } from "../../src/cmux/transcript.js";
import type { HookSessionRecord, ManagedSession } from "../../src/cmux/types.js";

interface Harness {
  controller: ClaudeSessionController;
  run: ManagedSession;
  offset: number;
  directory: string;
}

async function makeHarness(options: {
  lifecycle?: string;
  finalText?: string;
}): Promise<Harness> {
  const directory = tempDir("claude-cmux-recovery-");
  const transcriptPath = join(directory, "session.jsonl");
  await writeFile(transcriptPath, `${JSON.stringify({ type: "user", message: { content: "prompt" } })}\n`);
  const offset = await transcriptOffset(transcriptPath);
  if (options.finalText !== undefined) {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: options.finalText }] } });
    await writeFile(transcriptPath, `${line}\n`, { flag: "a" });
  }
  const run: ManagedSession = {
    runId: "run-1",
    name: "task",
    cwd: directory,
    state: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    keepOpen: true,
    permissionMode: "plan",
    sessionId: "session-1",
    surfaceId: "surface-1",
    workspaceId: "workspace-1",
    transcriptPath,
    lastEventSeq: 0,
    resumeAttempts: 0,
  };
  const record: HookSessionRecord | undefined = options.lifecycle
    ? { sessionId: "session-1", agentLifecycle: options.lifecycle, transcriptPath }
    : undefined;
  const controller = new ClaudeSessionController(run, {
    cmux: {} as never,
    events: {} as never,
    hooks: { findBySession: async () => record } as never,
    audit: { append: async () => {} } as never,
    config: {} as never,
    windowId: "window-1",
  });
  return { controller, run, offset, directory };
}

function recover(h: Harness, error: Error) {
  return (
    h.controller as unknown as {
      recoverTurnFromTranscript: (e: unknown, start: number, started: number) => Promise<unknown>;
    }
  ).recoverTurnFromTranscript(error, h.offset, Date.now());
}

test("recovers a completed turn from the transcript when the epoch aborts", async () => {
  const h = await makeHarness({ lifecycle: "idle", finalText: "final answer" });
  try {
    const result = (await recover(h, new Error("cmux event epoch changed while waiting"))) as
      | { output: string; recovered: boolean }
      | undefined;
    assert.ok(result, "expected recovery");
    assert.equal(result?.output, "final answer");
    assert.equal(result?.recovered, true);
    assert.equal(h.run.state, "recovering");
  } finally {
    removeTempDir(h.directory);
  }
});

test("fails closed when the session lifecycle is not input-ready", async () => {
  const h = await makeHarness({ lifecycle: "running", finalText: "partial" });
  try {
    assert.equal(await recover(h, new Error("cmux event stream reported a sequence gap")), undefined);
  } finally {
    removeTempDir(h.directory);
  }
});

test("fails closed when the transcript gained no assistant output", async () => {
  const h = await makeHarness({ lifecycle: "idle" });
  try {
    assert.equal(await recover(h, new Error("cmux event epoch changed while waiting")), undefined);
  } finally {
    removeTempDir(h.directory);
  }
});

test("does not recover for non-epoch errors like timeouts", async () => {
  const h = await makeHarness({ lifecycle: "idle", finalText: "final answer" });
  try {
    assert.equal(await recover(h, new Error("Timed out waiting for cmux event after 1000ms")), undefined);
  } finally {
    removeTempDir(h.directory);
  }
});
