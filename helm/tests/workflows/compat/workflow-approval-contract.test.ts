import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalWorkflowApprovalIdentity,
  createWorkflowApprovalStore,
  workflowLaunchApprovalRequirement,
} from "../../../src/workflows/workflow-approval.js";

const base = {
  hasUI: true,
  ultracode: false,
  permanentlyApproved: false,
  autoConsentRecorded: false,
} as const;

test("APP-01 default and acceptEdits ask on each unapproved launch", () => {
  for (const permissionMode of ["default", "acceptEdits"] as const) {
    assert.deepEqual(workflowLaunchApprovalRequirement({ ...base, permissionMode }), {
      required: true,
      reason: "untrusted-launch",
    });
  }
  assert.deepEqual(
    workflowLaunchApprovalRequirement({ ...base, permissionMode: "default", permanentlyApproved: true }),
    { required: false, reason: "permanent" },
  );
});

test("APP-02 auto asks once and Ultracode skips launch approval", () => {
  assert.deepEqual(workflowLaunchApprovalRequirement({ ...base, permissionMode: "auto" }), {
    required: true,
    reason: "auto-first-launch",
  });
  assert.deepEqual(workflowLaunchApprovalRequirement({ ...base, permissionMode: "auto", autoConsentRecorded: true }), {
    required: false,
    reason: "auto-consent",
  });
  assert.deepEqual(workflowLaunchApprovalRequirement({ ...base, permissionMode: "auto", ultracode: true }), {
    required: false,
    reason: "ultracode",
  });
});

test("APP-03 headless and bypass never request UI", () => {
  assert.deepEqual(workflowLaunchApprovalRequirement({ ...base, permissionMode: "headless", hasUI: false }), {
    required: false,
    reason: "headless",
  });
  assert.deepEqual(workflowLaunchApprovalRequirement({ ...base, permissionMode: "bypassPermissions" }), {
    required: false,
    reason: "bypass",
  });
});

test("permanent approval store survives recreation and remains scoped to project/source/name", () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-approvals-"));
  const path = join(directory, "approvals.json");
  const approved = { projectCwd: directory, workflowName: "audit", sourceLocation: join(directory, "audit.js") };
  try {
    const store = createWorkflowApprovalStore(path);
    assert.equal(store.has(approved), false);
    store.approve(approved);
    assert.equal(createWorkflowApprovalStore(path).has(approved), true);
    assert.equal(createWorkflowApprovalStore(path).has({ ...approved, workflowName: "other" }), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("permanent approval key includes canonical project, source, and workflow name without script contents", () => {
  const approval = canonicalWorkflowApprovalIdentity({
    projectCwd: process.cwd(),
    workflowName: "audit",
    sourceLocation: "./workflow.js",
  });
  assert.equal(approval.schemaVersion, 1);
  assert.equal(approval.workflowName, "audit");
  assert.match(approval.key, /^[a-f0-9]{64}$/);
  assert.ok(!("script" in approval));
});
