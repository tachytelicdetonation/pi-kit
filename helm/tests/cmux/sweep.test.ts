import { removeTempDir, tempDir } from "../helpers/tmp.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ClaudeFleetManager } from "../../src/cmux/fleet-manager.js";
import { isProcessAlive } from "../../src/cmux/process.js";

// Spawn a real process whose argv0 looks like `claude --resume <id>` (sleep with a
// forged argv0), so the sweeps operate on genuine OS processes.
function spawnClaude(sessionId: string): Promise<number> {
  const child = spawn("/bin/bash", ["-c", `exec -a 'claude --resume ${sessionId}' sleep 60`], { stdio: "ignore" });
  return new Promise((resolve) => setTimeout(() => resolve(child.pid as number), 250));
}

function makeManager(audits: unknown[], extra: Record<string, unknown> = {}) {
  return new ClaudeFleetManager({
    cmux: { closeWorkspace: async () => {} } as never,
    events: {} as never,
    hooks: {} as never,
    audit: { append: async (e: unknown) => void audits.push(e) } as never,
    state: {} as never,
    config: {} as never,
    ...extra,
  } as never);
}

function runRecord(sessionId: string, pid: number) {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    sessions: [
      { runId: "r", name: "n", cwd: "/tmp", state: "ready", createdAt: 0, updatedAt: 0, keepOpen: true, permissionMode: "plan", sessionId, pid, workspaceId: "ws" },
    ],
  };
}

const settle = () => new Promise((r) => setTimeout(r, 400));

test("duplicate sweep terminates the twin and keeps the bound pid", async () => {
  const audits: any[] = [];
  const sessionId = "SWEEP-DUP-0001";
  const boundPid = await spawnClaude(sessionId);
  const twinPid = await spawnClaude(sessionId);
  try {
    const mgr = makeManager(audits);
    (mgr as any).runs.set("run1", {
      runId: "run1", name: "t", cwd: "/tmp", state: "ready", createdAt: 0, updatedAt: 0, keepOpen: true,
      permissionMode: "plan", sessionId, pid: boundPid, lastEventSeq: 0, resumeAttempts: 0,
    });
    await (mgr as any).sweepDuplicateResumes();
    await settle();
    assert.equal(isProcessAlive(boundPid), true, "bound pid must survive");
    assert.equal(isProcessAlive(twinPid), false, "twin must be terminated");
    assert.ok(audits.some((a) => a.event === "reconcile.duplicate_closed" && a.data?.strayPid === twinPid));
  } finally {
    for (const p of [boundPid, twinPid]) try { process.kill(p, "SIGKILL"); } catch {}
  }
});

test("orphan sweep kills a dead-owner instance's claude but spares a live-owner peer", async () => {
  const audits: any[] = [];
  const root = tempDir("sweep-inst-");
  const orphanSession = "SWEEP-ORPH-0002";
  const peerSession = "SWEEP-LIVE-0003";
  const orphanPid = await spawnClaude(orphanSession);
  const peerPid = await spawnClaude(peerSession);
  try {
    const dead = join(root, "dead-peer");
    await mkdir(dead, { recursive: true });
    await writeFile(join(dead, "owner.pid"), "999999"); // not alive
    await writeFile(join(dead, "state.json"), JSON.stringify(runRecord(orphanSession, orphanPid)));

    const live = join(root, "live-peer");
    await mkdir(live, { recursive: true });
    await writeFile(join(live, "owner.pid"), String(process.pid)); // alive
    await writeFile(join(live, "state.json"), JSON.stringify(runRecord(peerSession, peerPid)));

    const mgr = makeManager(audits, { instanceId: "me", instancesRoot: root });
    await (mgr as any).sweepOrphanInstances();
    await settle();
    assert.equal(isProcessAlive(orphanPid), false, "dead-owner orphan must be terminated");
    assert.equal(isProcessAlive(peerPid), true, "live-owner peer must be spared");
    assert.ok(audits.some((a) => a.event === "orphan.terminated" && a.data?.pids?.includes(orphanPid)));
  } finally {
    for (const p of [orphanPid, peerPid]) try { process.kill(p, "SIGKILL"); } catch {}
    removeTempDir(root);
  }
});

test("orphan sweep does not sweep an instance with a missing owner.pid (fail safe)", async () => {
  const audits: any[] = [];
  const root = tempDir("sweep-noowner-");
  const sessionId = "SWEEP-NOOWNER-0004";
  const pid = await spawnClaude(sessionId);
  try {
    const dir = join(root, "no-owner");
    await mkdir(dir, { recursive: true });
    // deliberately no owner.pid file
    await writeFile(join(dir, "state.json"), JSON.stringify(runRecord(sessionId, pid)));
    const mgr = makeManager(audits, { instanceId: "me", instancesRoot: root });
    await (mgr as any).sweepOrphanInstances();
    await settle();
    assert.equal(isProcessAlive(pid), true, "missing owner.pid must NOT trigger a sweep");
  } finally {
    try { process.kill(pid, "SIGKILL"); } catch {}
    removeTempDir(root);
  }
});
