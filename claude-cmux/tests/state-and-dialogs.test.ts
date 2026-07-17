import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateStore } from "../src/state-store.js";
import { isKnownOnboardingDialog, isTrustDialog } from "../src/session-controller.js";
import { findRequestId } from "../src/permission-broker.js";
import type { ManagedSession } from "../src/types.js";

const run: ManagedSession = {
  runId: "run-1",
  name: "test",
  cwd: "/tmp",
  state: "ready",
  createdAt: 1,
  updatedAt: 2,
  keepOpen: false,
  permissionMode: "plan",
  lastEventSeq: 3,
  resumeAttempts: 0,
};

test("state store atomically round-trips managed sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-cmux-state-"));
  const path = join(directory, "nested", "state.json");
  try {
    const store = new StateStore(path);
    await store.save([run]);
    assert.deepEqual(await store.load(), [run]);
    assert.match(await readFile(path, "utf8"), /"version": 1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup dialog classifiers recognize only known gates", () => {
  assert.equal(isTrustDialog("Yes, I trust this folder"), true);
  assert.equal(isTrustDialog("normal Claude prompt ❯"), false);
  assert.equal(isKnownOnboardingDialog("Choose the text style that looks best"), true);
  assert.equal(isKnownOnboardingDialog("Welcome back"), false);
});

test("permission request IDs are found in direct and nested payloads", () => {
  assert.equal(findRequestId({ request_id: "direct" }), "direct");
  assert.equal(findRequestId({ data: { requestId: "nested" } }), "nested");
  assert.equal(findRequestId({}), undefined);
});
