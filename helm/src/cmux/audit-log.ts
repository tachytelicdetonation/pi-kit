import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface AuditRecord {
  at: string;
  event: string;
  runId?: string;
  sessionId?: string;
  workspaceId?: string;
  surfaceId?: string;
  data?: Record<string, unknown>;
}

export class AuditLog {
  constructor(private readonly path: string) {}

  async append(record: Omit<AuditRecord, "at">): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const handle = await open(this.path, "a", 0o600);
      try {
        await handle.appendFile(`${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
      } finally {
        await handle.close();
      }
    } catch {
      // Auditing must not make cleanup or fail-closed permission decisions impossible.
    }
  }
}

export function promptMetadata(prompt: string): Record<string, unknown> {
  return {
    promptLength: prompt.length,
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
  };
}

export function createRunId(): string {
  return randomUUID();
}
