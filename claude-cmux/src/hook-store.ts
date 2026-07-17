import { readFile, stat } from "node:fs/promises";
import type { HookSessionRecord, HookSessionStore } from "./types.js";
import { sleep } from "./process.js";

export class ClaudeHookStore {
  constructor(readonly path: string) {}

  async read(): Promise<HookSessionStore> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<HookSessionStore>;
      return {
        version: parsed.version,
        sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
        activeSessionsBySurface: parsed.activeSessionsBySurface,
        activeSessionsByWorkspace: parsed.activeSessionsByWorkspace,
      };
    } catch {
      return { sessions: {} };
    }
  }

  async modifiedAt(): Promise<number> {
    try {
      return (await stat(this.path)).mtimeMs;
    } catch {
      return 0;
    }
  }

  async findBySurface(surfaceId: string): Promise<HookSessionRecord | undefined> {
    const store = await this.read();
    const active = store.activeSessionsBySurface?.[surfaceId]?.sessionId;
    if (active && store.sessions[active]) return store.sessions[active];
    return Object.values(store.sessions).find((session) => session.surfaceId === surfaceId);
  }

  async findByWorkspace(workspaceId: string): Promise<HookSessionRecord | undefined> {
    const store = await this.read();
    const active = store.activeSessionsByWorkspace?.[workspaceId]?.sessionId;
    if (active && store.sessions[active]) return store.sessions[active];
    return Object.values(store.sessions).find((session) => session.workspaceId === workspaceId);
  }

  async findBySession(sessionId: string): Promise<HookSessionRecord | undefined> {
    return (await this.read()).sessions[sessionId];
  }

  async waitForSurface(
    surfaceId: string,
    timeoutMs: number,
    options: { signal?: AbortSignal; onTick?: (elapsedMs: number) => Promise<void> } = {},
  ): Promise<HookSessionRecord> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (options.signal?.aborted) throw abortError();
      const match = await this.findBySurface(surfaceId);
      if (match) return match;
      await options.onTick?.(Date.now() - started);
      await sleep(500, options.signal);
    }
    throw new Error(`Claude did not register surface ${surfaceId} within ${timeoutMs}ms`);
  }
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}
