import { removeTempDir, tempDir } from "../helpers/tmp.js";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { AuditLog } from "../../src/cmux/audit-log.js";
import type { CmuxClient } from "../../src/cmux/cmux-client.js";
import { CmuxEventTail } from "../../src/cmux/event-tail.js";
import { PermissionBroker } from "../../src/cmux/permission-broker.js";
import type { CmuxEventFrame, ManagedSession } from "../../src/cmux/types.js";

function inject(tail: CmuxEventTail, frame: CmuxEventFrame): void {
  (tail as unknown as { handleFrame: (value: CmuxEventFrame) => void }).handleFrame(frame);
}

test("ExitPlan permission is correlated from claude-prefixed workstream IDs and delivered once", async () => {
  const directory = tempDir("claude-cmux-broker-");
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const cmux = {
    rpc: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { delivered: true };
    },
  } as unknown as CmuxClient;
  const tail = new CmuxEventTail({ cmuxBin: "cmux", cursorFile: join(directory, "cursor") });
  const run: ManagedSession = {
    runId: "run-1",
    name: "test",
    cwd: "/tmp",
    state: "running",
    createdAt: 1,
    updatedAt: 1,
    keepOpen: false,
    permissionMode: "plan",
    sessionId: "session-1",
    lastEventSeq: 0,
    resumeAttempts: 0,
  };
  const broker = new PermissionBroker({
    cmux,
    events: tail,
    audit: new AuditLog(join(directory, "audit.jsonl")),
    timeoutMs: 1_000,
    resolveRun: (sessionId) => (sessionId === run.sessionId ? run : undefined),
    resolveDecider: () => async () => ({ action: "plan-manual" }),
  });
  broker.start();
  const frame: CmuxEventFrame = {
    type: "event",
    boot_id: "boot",
    seq: 1,
    id: "boot-1",
    name: "agent.hook.PermissionRequest",
    category: "agent",
    payload: {
      session_id: "claude-session-1",
      request_id: "request-1",
      hook_event_name: "PermissionRequest",
      tool_name: "ExitPlanMode",
      phase: "received",
    },
  };
  inject(tail, frame);
  inject(tail, { ...frame, seq: 2, id: "boot-2" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, [
    { method: "feed.exit_plan.reply", params: { request_id: "request-1", mode: "manual" } },
  ]);
  broker.stop();
  removeTempDir(directory);
});
