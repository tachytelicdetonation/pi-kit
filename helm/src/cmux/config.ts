import { homedir } from "node:os";
import { join } from "node:path";
import type { OrchestratorConfig } from "./types.js";

export const DEFAULT_CONFIG: OrchestratorConfig = {
  maxConcurrency: 4,
  registrationTimeoutMs: 45_000,
  turnTimeoutMs: 10 * 60_000,
  settleMs: 750,
  permissionTimeoutMs: 100_000,
  // cmux may take ~30s to restore and re-register an interactive Claude TUI.
  recoveryGraceMs: 35_000,
  maxResumeAttempts: 3,
  strictCompatibility: true,
  autoRecover: true,
};

export interface RuntimePaths {
  root: string;
  stateFile: string;
  cursorFile: string;
  auditFile: string;
  hookStoreFile: string;
}

export function resolveRuntimePaths(env: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const piRoot = env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? homedir(), ".pi", "agent");
  const root = env.PI_CLAUDE_CMUX_STATE_DIR ?? join(piRoot, "claude-cmux");
  const home = env.HOME ?? homedir();
  return {
    root,
    stateFile: join(root, "state.json"),
    cursorFile: join(root, "events.seq"),
    auditFile: join(root, "audit.jsonl"),
    hookStoreFile: join(home, ".cmuxterm", "claude-hook-sessions.json"),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  const integer = (key: string, fallback: number): number => {
    const raw = env[key];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const boolean = (key: string, fallback: boolean): boolean => {
    const raw = env[key]?.trim().toLowerCase();
    if (!raw) return fallback;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    return fallback;
  };

  return {
    maxConcurrency: Math.min(8, integer("PI_CLAUDE_CMUX_CONCURRENCY", DEFAULT_CONFIG.maxConcurrency)),
    registrationTimeoutMs: integer("PI_CLAUDE_CMUX_REGISTRATION_TIMEOUT_MS", DEFAULT_CONFIG.registrationTimeoutMs),
    turnTimeoutMs: integer("PI_CLAUDE_CMUX_TURN_TIMEOUT_MS", DEFAULT_CONFIG.turnTimeoutMs),
    settleMs: integer("PI_CLAUDE_CMUX_SETTLE_MS", DEFAULT_CONFIG.settleMs),
    permissionTimeoutMs: Math.min(
      110_000,
      integer("PI_CLAUDE_CMUX_PERMISSION_TIMEOUT_MS", DEFAULT_CONFIG.permissionTimeoutMs),
    ),
    recoveryGraceMs: integer("PI_CLAUDE_CMUX_RECOVERY_GRACE_MS", DEFAULT_CONFIG.recoveryGraceMs),
    maxResumeAttempts: integer("PI_CLAUDE_CMUX_MAX_RESUMES", DEFAULT_CONFIG.maxResumeAttempts),
    strictCompatibility: boolean("PI_CLAUDE_CMUX_STRICT_COMPAT", DEFAULT_CONFIG.strictCompatibility),
    autoRecover: boolean("PI_CLAUDE_CMUX_AUTO_RECOVER", DEFAULT_CONFIG.autoRecover),
  };
}
