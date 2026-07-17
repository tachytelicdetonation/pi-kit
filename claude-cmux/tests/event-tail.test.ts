import assert from "node:assert/strict";
import test from "node:test";
import { CmuxEventTail, isTopLevelStop, isUserPromptSubmit } from "../src/event-tail.js";
import type { CmuxEventFrame, CmuxStreamFrame } from "../src/types.js";

function event(seq: number, name: string, sessionId = "session-1", bootId = "boot-a"): CmuxEventFrame {
  return {
    type: "event",
    boot_id: bootId,
    seq,
    id: `${bootId}-${seq}`,
    name,
    category: "agent",
    payload: { session_id: sessionId },
  };
}

function inject(tail: CmuxEventTail, frame: CmuxStreamFrame): void {
  (tail as unknown as { handleFrame: (value: CmuxStreamFrame) => void }).handleFrame(frame);
}

test("turn predicates distinguish top-level Stop from SubagentStop", () => {
  assert.equal(isUserPromptSubmit(event(1, "agent.hook.UserPromptSubmit"), "session-1"), true);
  assert.equal(isUserPromptSubmit(event(1, "agent.hook.UserPromptSubmit", "claude-session-1"), "session-1"), true);
  assert.equal(isTopLevelStop(event(2, "agent.hook.SubagentStop"), "session-1"), false);
  assert.equal(isTopLevelStop(event(3, "agent.hook.Stop"), "session-1"), true);
  assert.equal(isTopLevelStop(event(4, "agent.hook.Stop", "other"), "session-1"), false);
});

test("waitFor checks retained history without racing prompt submission", async () => {
  const tail = new CmuxEventTail({ cmuxBin: "cmux", cursorFile: "/tmp/unused" });
  inject(tail, { type: "ack", boot_id: "boot-a", resume: { latest_seq: 9 } });
  inject(tail, event(10, "agent.hook.UserPromptSubmit"));
  const found = await tail.waitFor((value) => isUserPromptSubmit(value, "session-1"), {
    afterSeq: 9,
    bootId: "boot-a",
    timeoutMs: 100,
  });
  assert.equal(found.seq, 10);
});

test("a new cmux boot resets sequence history to the new epoch", () => {
  const tail = new CmuxEventTail({ cmuxBin: "cmux", cursorFile: "/tmp/unused" });
  inject(tail, { type: "ack", boot_id: "boot-a", resume: { latest_seq: 900 } });
  inject(tail, event(901, "agent.hook.Stop"));
  inject(tail, { type: "ack", boot_id: "boot-b", resume: { latest_seq: 4, gap: true } });
  assert.equal(tail.latestSeq, 4);
  assert.equal(tail.bootId, "boot-b");
});

test("waitFor rejects an in-flight turn when cmux boot epoch changes", async () => {
  const tail = new CmuxEventTail({ cmuxBin: "cmux", cursorFile: "/tmp/unused" });
  inject(tail, { type: "ack", boot_id: "boot-a", resume: { latest_seq: 10 } });
  const waiting = tail.waitFor((value) => isTopLevelStop(value, "session-1"), {
    afterSeq: 10,
    bootId: "boot-a",
    timeoutMs: 1_000,
  });
  inject(tail, { type: "ack", boot_id: "boot-b", resume: { latest_seq: 1, gap: true } });
  await assert.rejects(waiting, /epoch changed/);
});

test("waitFor aborts an in-flight turn on a same-boot sequence gap", async () => {
  const tail = new CmuxEventTail({ cmuxBin: "cmux", cursorFile: "/tmp/unused" });
  inject(tail, { type: "ack", boot_id: "boot-a", resume: { latest_seq: 10 } });
  const waiting = tail.waitFor((value) => isTopLevelStop(value, "session-1"), {
    afterSeq: 10,
    bootId: "boot-a",
    timeoutMs: 1_000,
  });
  // Same boot_id, but the reconnect ack reports a gap (retention eviction or a
  // crash that rolled the counter back): the Stop event may be lost, so abort.
  inject(tail, { type: "ack", boot_id: "boot-a", resume: { latest_seq: 6, gap: true } });
  await assert.rejects(waiting, /sequence gap/);
});

test("boot change is detected on a heartbeat frame, not only acks", async () => {
  const tail = new CmuxEventTail({ cmuxBin: "cmux", cursorFile: "/tmp/unused" });
  inject(tail, { type: "ack", boot_id: "boot-a", resume: { latest_seq: 10 } });
  const waiting = tail.waitFor((value) => isTopLevelStop(value, "session-1"), {
    afterSeq: 10,
    bootId: "boot-a",
    timeoutMs: 1_000,
  });
  // A heartbeat is the first frame after reconnect; the new boot_id must reset
  // the sequence high-water mark and abort the in-flight waiter.
  inject(tail, { type: "heartbeat", boot_id: "boot-b", latest_seq: 2 });
  await assert.rejects(waiting, /epoch changed/);
  assert.equal(tail.bootId, "boot-b");
  assert.equal(tail.latestSeq, 2);
});
