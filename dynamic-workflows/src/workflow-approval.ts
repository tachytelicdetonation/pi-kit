import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ClaudeWorkflowPermissionMode } from "./claude-workflow-contract.js";

export type WorkflowLaunchApprovalAction = "run-once" | "always" | "view-script" | "edit-prompt" | "deny";
export type WorkflowLaunchApprovalRequirement =
  | { readonly required: false; readonly reason: "permanent" | "auto-consent" | "ultracode" | "headless" | "bypass" }
  | { readonly required: true; readonly reason: "untrusted-launch" | "auto-first-launch" };

export interface WorkflowLaunchApprovalContext {
  readonly permissionMode: ClaudeWorkflowPermissionMode;
  readonly hasUI: boolean;
  readonly ultracode: boolean;
  readonly permanentlyApproved: boolean;
  readonly autoConsentRecorded: boolean;
}

export interface WorkflowApprovalIdentity {
  readonly projectCwd: string;
  readonly workflowName: string;
  readonly sourceLocation: string;
}

export interface StoredWorkflowApproval {
  readonly schemaVersion: 1;
  readonly key: string;
  readonly projectIdentity: string;
  readonly workflowName: string;
  readonly sourceIdentity: string;
  readonly approvedAt: string;
}

export interface WorkflowApprovalStore {
  has(identity: WorkflowApprovalIdentity): boolean;
  approve(identity: WorkflowApprovalIdentity): StoredWorkflowApproval;
}

/** User-scoped durable approvals; malformed files fail closed. */
export function createWorkflowApprovalStore(
  path = join(homedir(), ".pi/workflows/approvals.json"),
): WorkflowApprovalStore {
  const read = (): StoredWorkflowApproval[] => {
    if (!existsSync(path)) return [];
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      return Array.isArray(value) ? value.filter(isStoredApproval) : [];
    } catch {
      return [];
    }
  };
  return {
    has(identity) {
      const candidate = canonicalWorkflowApprovalIdentity(identity);
      return read().some((approval) => approval.key === candidate.key);
    },
    approve(identity) {
      const approval = canonicalWorkflowApprovalIdentity(identity);
      const approvals = read().filter((entry) => entry.key !== approval.key);
      approvals.push(approval);
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(approvals, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, path);
      return approval;
    },
  };
}

/** Determine whether a workflow launch needs interactive approval. */
export function workflowLaunchApprovalRequirement(
  context: WorkflowLaunchApprovalContext,
): WorkflowLaunchApprovalRequirement {
  if (!context.hasUI || context.permissionMode === "headless") return { required: false, reason: "headless" };
  if (context.permissionMode === "bypassPermissions") return { required: false, reason: "bypass" };
  if (context.permanentlyApproved) return { required: false, reason: "permanent" };
  if (context.ultracode) return { required: false, reason: "ultracode" };
  if (context.permissionMode === "auto") {
    return context.autoConsentRecorded
      ? { required: false, reason: "auto-consent" }
      : { required: true, reason: "auto-first-launch" };
  }
  return { required: true, reason: "untrusted-launch" };
}

/** Build a stable, canonical identity for a persisted workflow approval. */
export function canonicalWorkflowApprovalIdentity(identity: WorkflowApprovalIdentity): StoredWorkflowApproval {
  const projectIdentity = canonicalPath(identity.projectCwd);
  const sourceIdentity = canonicalPath(identity.sourceLocation);
  const workflowName = identity.workflowName.trim();
  if (!workflowName) throw new Error("Workflow approval requires a non-empty workflow name");
  const key = createHash("sha256")
    .update(JSON.stringify({ projectIdentity, sourceIdentity, workflowName }))
    .digest("hex");
  return {
    schemaVersion: 1,
    key,
    projectIdentity,
    workflowName,
    sourceIdentity,
    approvedAt: new Date().toISOString(),
  };
}

function isStoredApproval(value: unknown): value is StoredWorkflowApproval {
  if (!value || typeof value !== "object") return false;
  const approval = value as Partial<StoredWorkflowApproval>;
  return (
    approval.schemaVersion === 1 &&
    typeof approval.key === "string" &&
    typeof approval.projectIdentity === "string" &&
    typeof approval.workflowName === "string" &&
    typeof approval.sourceIdentity === "string" &&
    typeof approval.approvedAt === "string"
  );
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}
