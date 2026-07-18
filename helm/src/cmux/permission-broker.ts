import type { AuditLog } from "./audit-log.js";
import type { CmuxClient } from "./cmux-client.js";
import type { CmuxEventTail } from "./event-tail.js";
import { eventSessionId } from "./event-tail.js";
import type {
  CmuxEventFrame,
  ManagedSession,
  PermissionDecider,
  PermissionDecision,
  PermissionDecisionContext,
} from "./types.js";

export class PermissionBroker {
  private readonly handled = new Set<string>();
  private decisionChain = Promise.resolve();
  private unsubscribe?: () => void;

  constructor(
    private readonly options: {
      cmux: CmuxClient;
      events: CmuxEventTail;
      audit: AuditLog;
      timeoutMs: number;
      resolveRun: (sessionId: string) => ManagedSession | undefined;
      resolveDecider: (runId: string) => PermissionDecider | undefined;
      onStateChange?: (run: ManagedSession) => void;
    },
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.options.events.onEvent((event) => {
      if (event.name !== "agent.hook.PermissionRequest") return;
      const enqueuedAt = Date.now();
      // Pi's TUI can display only one blocking decision dialog at a time. Serialize
      // fleet approvals while retaining the original Feed deadline for each item.
      this.decisionChain = this.decisionChain
        .catch(() => {})
        .then(() => this.handle(event, enqueuedAt));
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async handle(event: CmuxEventFrame, enqueuedAt: number): Promise<void> {
    const payload = event.payload ?? {};
    if (payload.phase === "completed") return;
    const sessionId = eventSessionId(event);
    if (!sessionId) return;
    const run = this.options.resolveRun(sessionId);
    if (!run) return;
    const requestId = findRequestId(payload);
    if (!requestId || this.handled.has(requestId)) return;
    this.handled.add(requestId);
    if (this.handled.size > 8_192) {
      const oldest = this.handled.values().next().value as string | undefined;
      if (oldest) this.handled.delete(oldest);
    }

    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
    const kind = classify(toolName, payload);
    const context: PermissionDecisionContext = { run: { ...run }, kind, requestId, toolName, payload };
    const previousState = run.state;
    run.state = "permission-pending";
    run.updatedAt = Date.now();
    this.options.onStateChange?.(run);
    await this.options.audit.append({
      event: "permission.received",
      runId: run.runId,
      sessionId,
      surfaceId: run.surfaceId,
      data: { requestId, kind, toolName },
    });

    let decision: PermissionDecision = { action: "deny" };
    try {
      const decider = this.options.resolveDecider(run.runId);
      const remainingMs = Math.max(0, this.options.timeoutMs - (Date.now() - enqueuedAt));
      if (decider && remainingMs > 0) decision = await withTimeout(decider(context), remainingMs);
    } catch {
      decision = { action: "deny" };
    }

    try {
      await this.deliver(context, decision);
      await this.options.audit.append({
        event: "permission.resolved",
        runId: run.runId,
        sessionId,
        data: { requestId, kind, action: decision.action },
      });
    } catch (error) {
      await this.options.audit.append({
        event: "permission.delivery_failed",
        runId: run.runId,
        sessionId,
        data: { requestId, error: message(error) },
      });
      // The Feed timeout falls through to Claude's TUI. Do not send blind keystrokes.
    } finally {
      run.state = previousState === "permission-pending" ? "running" : previousState;
      run.updatedAt = Date.now();
      this.options.onStateChange?.(run);
    }
  }

  private async deliver(context: PermissionDecisionContext, decision: PermissionDecision): Promise<void> {
    if (context.kind === "exit-plan") {
      const mode =
        decision.action === "plan-manual"
          ? "manual"
          : decision.action === "plan-auto"
            ? "autoAccept"
            : "deny";
      await this.options.cmux.rpc("feed.exit_plan.reply", { request_id: context.requestId, mode });
      return;
    }

    // AskUserQuestion needs structured selections that are redacted from the event
    // stream. Unknown questions and permissions therefore fail closed. A future
    // feed.list adapter can safely expose explicit question choices.
    const mode = decision.action === "allow-once" && context.kind === "permission" ? "once" : "deny";
    await this.options.cmux.rpc("feed.permission.reply", { request_id: context.requestId, mode });
  }
}

export function findRequestId(payload: Record<string, unknown>): string | undefined {
  const preferred = ["request_id", "requestId", "_request_id", "_opencode_request_id"];
  for (const key of preferred) {
    const value = payload[key];
    if (typeof value === "string" && value) return value;
  }
  for (const value of Object.values(payload)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const nested = findRequestId(value as Record<string, unknown>);
    if (nested) return nested;
  }
  return undefined;
}

function classify(toolName: string | undefined, payload: Record<string, unknown>): PermissionDecisionContext["kind"] {
  const hookName = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  if (toolName === "ExitPlanMode" || hookName === "ExitPlanMode") return "exit-plan";
  if (toolName === "AskUserQuestion") return "question";
  if (hookName === "PermissionRequest" || toolName) return "permission";
  return "unknown";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Permission decision timed out")), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
