export type PermissionMode = "plan" | "manual" | "acceptEdits" | "dontAsk";

export type SessionState =
  | "created"
  | "launching"
  | "registering"
  | "trust-required"
  | "ready"
  | "submitting"
  | "running"
  | "permission-pending"
  | "recovering"
  | "exiting"
  | "terminated"
  | "failed";

export interface ManagedSession {
  runId: string;
  name: string;
  cwd: string;
  state: SessionState;
  createdAt: number;
  updatedAt: number;
  keepOpen: boolean;
  permissionMode: PermissionMode;
  workspaceRef?: string;
  workspaceId?: string;
  surfaceId?: string;
  sessionId?: string;
  pid?: number;
  transcriptPath?: string;
  bootId?: string;
  lastEventSeq: number;
  resumeAttempts: number;
  error?: string;
}

export interface HookSessionRecord {
  sessionId: string;
  workspaceId?: string;
  surfaceId?: string;
  cwd?: string;
  pid?: number;
  transcriptPath?: string;
  agentLifecycle?: "running" | "idle" | "needsInput" | "unknown" | string;
  lastPermissionMode?: string;
  isRestorable?: boolean;
  updatedAt?: number;
  lastBody?: string;
}

export interface HookSessionStore {
  version?: number;
  sessions: Record<string, HookSessionRecord>;
  activeSessionsBySurface?: Record<string, { sessionId: string; updatedAt?: number }>;
  activeSessionsByWorkspace?: Record<string, { sessionId: string; updatedAt?: number }>;
}

export interface CmuxCapabilities {
  access_mode?: string;
  methods: string[];
  protocol?: string;
  socket_path?: string;
  version?: number;
}

export interface CmuxAckFrame {
  type: "ack";
  boot_id: string;
  resume?: {
    after_seq?: number;
    requested_after_seq?: number;
    oldest_seq?: number;
    latest_seq?: number;
    next_seq?: number;
    gap?: boolean;
  };
}

export interface CmuxEventFrame {
  type: "event";
  boot_id: string;
  seq: number;
  id: string;
  name: string;
  category: string;
  source?: string;
  occurred_at?: string;
  workspace_id?: string | null;
  surface_id?: string | null;
  pane_id?: string | null;
  window_id?: string | null;
  payload?: Record<string, unknown>;
}

export interface CmuxHeartbeatFrame {
  type: "heartbeat";
  boot_id: string;
  latest_seq?: number;
  occurred_at?: string;
}

export type CmuxStreamFrame = CmuxAckFrame | CmuxEventFrame | CmuxHeartbeatFrame;

export interface RunTaskInput {
  prompt: string;
  cwd: string;
  name?: string;
  permissionMode?: PermissionMode;
  keepOpen?: boolean;
  timeoutMs?: number;
}

export interface RunTaskResult {
  run: ManagedSession;
  output: string;
  elapsedMs: number;
  /**
   * True when the turn's completion could not be confirmed by a live Stop event
   * (the cmux event epoch changed or reported a sequence gap mid-turn) and the
   * output was instead recovered read-only from the durable Claude transcript.
   */
  recovered?: boolean;
}

export interface FleetTaskInput extends RunTaskInput {
  id?: string;
}

export interface FleetTaskResult {
  id?: string;
  ok: boolean;
  result?: RunTaskResult;
  error?: string;
}

export interface CompatibilityReport {
  ok: boolean;
  cmuxVersion?: string;
  claudeVersion?: string;
  socketPath?: string;
  warnings: string[];
  errors: string[];
}

export interface OrchestratorConfig {
  maxConcurrency: number;
  registrationTimeoutMs: number;
  turnTimeoutMs: number;
  settleMs: number;
  permissionTimeoutMs: number;
  recoveryGraceMs: number;
  maxResumeAttempts: number;
  strictCompatibility: boolean;
  autoRecover: boolean;
}

export interface PermissionDecisionContext {
  run: ManagedSession;
  kind: "exit-plan" | "permission" | "question" | "unknown";
  requestId: string;
  toolName?: string;
  payload: Record<string, unknown>;
}

export type PermissionDecision =
  | { action: "deny" }
  | { action: "allow-once" }
  | { action: "plan-manual" }
  | { action: "plan-auto" };

export type PermissionDecider = (context: PermissionDecisionContext) => Promise<PermissionDecision>;
export type TrustDecider = (run: ManagedSession, screen: string) => Promise<boolean>;
