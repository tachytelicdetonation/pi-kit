import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import { findClaudePidsForSession, isClaudeProcess, isManagedClaudeProcess } from "../src/process.js";

// Spawn a real process whose ps command line is `argv0 30` (sleep with a forged
// argv[0] via bash's `exec -a`), so we can exercise the command-line matchers
// deterministically without a real Claude binary.
function spawnAs(argv0: string): ChildProcess {
  return spawn("/bin/bash", ["-c", `exec -a '${argv0}' sleep 30`], { stdio: "ignore" });
}

async function withProc(argv0: string, fn: (pid: number) => Promise<void>): Promise<void> {
  const child = spawnAs(argv0);
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(child.pid, "child should have a pid");
    await fn(child.pid as number);
  } finally {
    child.kill("SIGKILL");
  }
}

test("isClaudeProcess matches a claude command but not a look-alike version string", async () => {
  await withProc("claude --resume abc", async (pid) => assert.equal(await isClaudeProcess(pid), true));
  // Regression: an earlier regex matched any command containing "2.1.".
  await withProc("python train_v2.1.0.py", async (pid) => assert.equal(await isClaudeProcess(pid), false));
  await withProc("claude-cmux-helper foo", async (pid) => assert.equal(await isClaudeProcess(pid), false));
});

test("isManagedClaudeProcess additionally requires the session id in the command", async () => {
  await withProc("claude --resume SIDTEST999", async (pid) => {
    assert.equal(await isManagedClaudeProcess(pid, "SIDTEST999"), true);
    assert.equal(await isManagedClaudeProcess(pid, "OTHER-SESSION"), false);
  });
  // A non-claude process carrying the session id must not match either.
  await withProc("python worker SIDTEST999", async (pid) => {
    assert.equal(await isManagedClaudeProcess(pid, "SIDTEST999"), false);
  });
  // A real claude that merely MENTIONS the id in a prompt (not as --resume/
  // --session-id) must not match — otherwise the duplicate sweep could SIGTERM
  // an unrelated user session.
  await withProc("claude tell me about SIDTEST999", async (pid) => {
    assert.equal(await isManagedClaudeProcess(pid, "SIDTEST999"), false);
  });
});

test("findClaudePidsForSession finds the claude process for a session, ignores others", async () => {
  await withProc("claude --resume FINDME-42", async (pid) => {
    const pids = await findClaudePidsForSession("FINDME-42");
    assert.ok(pids.includes(pid), "should find the claude process bound to the session");
  });
  assert.deepEqual(await findClaudePidsForSession("no-such-session-uuid-zzz"), []);
});
