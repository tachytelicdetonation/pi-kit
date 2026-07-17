import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { CmuxAckFrame, CmuxEventFrame, CmuxStreamFrame } from "./types.js";
import { scrubCmuxTargetEnv, spawnStreaming } from "./process.js";

export interface EventWaitOptions {
  afterSeq?: number;
  bootId?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

type EventListener = (event: CmuxEventFrame) => void;
type AckListener = (ack: CmuxAckFrame, bootChanged: boolean) => void;

export class CmuxEventTail {
  private child?: ChildProcessWithoutNullStreams;
  private stopped = true;
  private buffer = "";
  private restartTimer?: NodeJS.Timeout;
  private readonly listeners = new Set<EventListener>();
  private readonly ackListeners = new Set<AckListener>();
  private readonly epochListeners = new Set<(bootId: string) => void>();
  private readonly gapListeners = new Set<() => void>();
  private readonly history: CmuxEventFrame[] = [];
  private startPromise?: Promise<void>;
  private startResolve?: () => void;
  private startReject?: (error: Error) => void;
  private lastStderr = "";

  bootId?: string;
  latestSeq = 0;
  lastHeartbeatAt = 0;

  constructor(
    private readonly options: {
      cmuxBin: string;
      cursorFile: string;
      env?: NodeJS.ProcessEnv;
      categories?: string[];
    },
  ) {}

  async start(): Promise<void> {
    if (!this.stopped && this.child) return this.startPromise;
    this.stopped = false;
    await mkdir(dirname(this.options.cursorFile), { recursive: true, mode: 0o700 });
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
      const timer = setTimeout(() => reject(new Error("cmux event stream did not acknowledge within 10s")), 10_000);
      timer.unref();
      const wrappedResolve = this.startResolve;
      this.startResolve = () => {
        clearTimeout(timer);
        wrappedResolve?.();
      };
      const wrappedReject = this.startReject;
      this.startReject = (error) => {
        clearTimeout(timer);
        wrappedReject?.(error);
      };
    });
    this.spawn();
    return this.startPromise;
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.child?.kill("SIGTERM");
    this.child = undefined;
    this.startPromise = undefined;
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onAck(listener: AckListener): () => void {
    this.ackListeners.add(listener);
    return () => this.ackListeners.delete(listener);
  }

  async waitFor(predicate: (event: CmuxEventFrame) => boolean, options: EventWaitOptions): Promise<CmuxEventFrame> {
    const fromHistory = this.history.find(
      (event) =>
        event.seq > (options.afterSeq ?? 0) &&
        (!options.bootId || event.boot_id === options.bootId) &&
        predicate(event),
    );
    if (fromHistory) return fromHistory;

    return new Promise<CmuxEventFrame>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, event?: CmuxEventFrame) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(listener);
        this.epochListeners.delete(epochChanged);
        this.gapListeners.delete(gapDetected);
        options.signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(event as CmuxEventFrame);
      };
      const listener = (event: CmuxEventFrame) => {
        if (event.seq <= (options.afterSeq ?? 0)) return;
        if (options.bootId && event.boot_id !== options.bootId) {
          finish(new Error("cmux event epoch changed while waiting for turn completion"));
          return;
        }
        if (predicate(event)) finish(undefined, event);
      };
      const epochChanged = (nextBootId: string) => {
        if (options.bootId && nextBootId !== options.bootId) {
          finish(new Error("cmux event epoch changed while waiting for turn completion"));
        }
      };
      const gapDetected = () => {
        finish(new Error("cmux event stream reported a sequence gap while waiting for turn completion"));
      };
      const abort = () => {
        const error = new Error("Operation aborted");
        error.name = "AbortError";
        finish(error);
      };
      const timer = setTimeout(
        () => finish(new Error(`Timed out waiting for cmux event after ${options.timeoutMs}ms`)),
        options.timeoutMs,
      );
      this.listeners.add(listener);
      this.epochListeners.add(epochChanged);
      this.gapListeners.add(gapDetected);
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private spawn(): void {
    if (this.stopped) return;
    const categories = this.options.categories ?? ["agent", "feed", "workspace", "surface"];
    const args = ["events", "--cursor-file", this.options.cursorFile, "--reconnect"];
    for (const category of categories) args.push("--category", category);
    const child = spawnStreaming(this.options.cmuxBin, args, {
      env: scrubCmuxTargetEnv(this.options.env ?? process.env),
    });
    this.child = child;
    this.buffer = "";
    this.lastStderr = "";

    child.stdout.on("data", (chunk) => this.consume(chunk.toString()));
    child.stderr.on("data", (chunk) => {
      this.lastStderr = `${this.lastStderr}${chunk.toString()}`.slice(-4_000);
    });
    child.on("error", (error) => {
      this.startReject?.(error);
    });
    child.on("close", () => {
      if (this.child === child) this.child = undefined;
      if (this.stopped) return;
      this.startReject?.(new Error(`cmux event stream exited: ${this.lastStderr.trim()}`));
      this.restartTimer = setTimeout(() => this.spawn(), 1_000);
      this.restartTimer.unref();
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame: CmuxStreamFrame;
      try {
        frame = JSON.parse(line) as CmuxStreamFrame;
      } catch {
        continue;
      }
      this.handleFrame(frame);
    }
  }

  // A cmux restart always mints a new boot_id. The change can surface on ANY
  // frame type (ack, heartbeat, or event) — whichever arrives first after
  // reconnect — so boot-epoch detection is centralized here rather than only in
  // the ack branch. On change we reset the sequence high-water mark (an
  // empirically confirmed crash rolls the counter back below its prior value)
  // and clear stale-epoch history before any Math.max runs.
  private observeBootId(bootId: string): boolean {
    const previous = this.bootId;
    const changed = previous !== undefined && previous !== bootId;
    this.bootId = bootId;
    if (changed) {
      this.latestSeq = 0;
      this.history.length = 0;
      for (const listener of this.epochListeners) listener(bootId);
    }
    return changed;
  }

  private handleFrame(frame: CmuxStreamFrame): void {
    if (frame.type === "ack") {
      const changed = this.observeBootId(frame.boot_id);
      this.latestSeq = changed
        ? frame.resume?.latest_seq ?? 0
        : Math.max(this.latestSeq, frame.resume?.latest_seq ?? 0);
      this.startResolve?.();
      this.startResolve = undefined;
      this.startReject = undefined;
      for (const listener of this.ackListeners) listener(frame, changed);
      // A sequence gap (retention eviction, or a crash that rolled the counter
      // back) means events may have been lost even when boot_id looks unchanged.
      // Waiters relying on a Stop event that fell in the lost window must abort
      // rather than burn the full turn timeout.
      if (frame.resume?.gap) for (const listener of this.gapListeners) listener();
      return;
    }
    if (frame.type === "heartbeat") {
      this.observeBootId(frame.boot_id);
      this.latestSeq = Math.max(this.latestSeq, frame.latest_seq ?? 0);
      this.lastHeartbeatAt = Date.now();
      return;
    }
    this.observeBootId(frame.boot_id);
    this.latestSeq = Math.max(this.latestSeq, frame.seq);
    this.history.push(frame);
    if (this.history.length > 1_024) this.history.splice(0, this.history.length - 1_024);
    for (const listener of this.listeners) listener(frame);
  }
}

export function eventSessionId(event: CmuxEventFrame): string | undefined {
  const payload = event.payload;
  const value = payload?.session_id ?? payload?.sessionId;
  if (typeof value !== "string") return undefined;
  // Claude hook events use workstream IDs (`claude-<conversation UUID>`), while
  // the hook session store and `claude --resume` use the bare UUID.
  return value.startsWith("claude-") ? value.slice("claude-".length) : value;
}

export function isTopLevelStop(event: CmuxEventFrame, sessionId: string): boolean {
  return event.name === "agent.hook.Stop" && eventSessionId(event) === sessionId;
}

export function isUserPromptSubmit(event: CmuxEventFrame, sessionId: string): boolean {
  return event.name === "agent.hook.UserPromptSubmit" && eventSessionId(event) === sessionId;
}
