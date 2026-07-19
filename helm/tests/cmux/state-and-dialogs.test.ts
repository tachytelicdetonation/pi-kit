import { removeTempDir, tempDir } from "../helpers/tmp.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { StateStore } from "../../src/cmux/state-store.js";
import { isKnownOnboardingDialog, isTrustDialog } from "../../src/cmux/session-controller.js";
import { findRequestId } from "../../src/cmux/permission-broker.js";
import type { ManagedSession } from "../../src/cmux/types.js";

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
  const directory = tempDir("claude-cmux-state-");
  const path = join(directory, "nested", "state.json");
  try {
    const store = new StateStore(path);
    await store.save([run]);
    assert.deepEqual(await store.load(), [run]);
    assert.match(await readFile(path, "utf8"), /"version": 1/);
  } finally {
    removeTempDir(directory);
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
