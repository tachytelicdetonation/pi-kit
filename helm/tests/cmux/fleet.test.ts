import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeFleetManager } from "../../src/cmux/fleet-manager.js";
import type { RunTaskInput, RunTaskResult } from "../../src/cmux/types.js";

test("fleet preserves task order and enforces the configured concurrency cap", async () => {
  const manager = new ClaudeFleetManager({
    cmux: {} as never,
    events: {} as never,
    hooks: {} as never,
    audit: {} as never,
    state: {} as never,
    config: {
      maxConcurrency: 2,
      registrationTimeoutMs: 1,
      turnTimeoutMs: 1,
      settleMs: 1,
      permissionTimeoutMs: 1,
      recoveryGraceMs: 1,
      maxResumeAttempts: 1,
      strictCompatibility: false,
      autoRecover: false,
    },
  });
  let active = 0;
  let peak = 0;
  const testManager = manager as unknown as {
    ensureReady: () => Promise<void>;
    runTask: (input: RunTaskInput) => Promise<RunTaskResult>;
  };
  testManager.ensureReady = async () => {};
  testManager.runTask = async (input) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, input.prompt === "slow" ? 20 : 5));
    active--;
    return {
      output: input.prompt,
      elapsedMs: 1,
      run: {
        runId: input.prompt,
        name: input.prompt,
        cwd: input.cwd,
        state: "terminated",
        createdAt: 1,
        updatedAt: 1,
        keepOpen: false,
        permissionMode: "plan",
        lastEventSeq: 0,
        resumeAttempts: 0,
      },
    };
  };

  const results = await manager.runFleet(
    [
      { id: "a", prompt: "slow", cwd: "/tmp" },
      { id: "b", prompt: "fast-1", cwd: "/tmp" },
      { id: "c", prompt: "fast-2", cwd: "/tmp" },
    ],
    { concurrency: 8 },
  );
  assert.equal(peak, 2);
  assert.deepEqual(
    results.map((result) => [result.id, result.result?.output]),
    [
      ["a", "slow"],
      ["b", "fast-1"],
      ["c", "fast-2"],
    ],
  );
});
