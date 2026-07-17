import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";

export interface WorkflowSandboxRequestContext {
  readonly signal?: AbortSignal;
}

export interface WorkflowSandboxHandlers {
  agent(prompt: string, options?: Record<string, unknown>): Promise<unknown>;
  workflow(nameOrScript: string, args?: unknown): Promise<unknown>;
  checkpoint(promptText: string, options?: Record<string, unknown>): Promise<unknown>;
  phase(title: string, options?: { budget?: number }): void;
  log(message: string): void;
  budgetSpent(): number;
}

export interface WorkflowSandboxRunOptions {
  body: string;
  filename: string;
  args?: unknown;
  cwd: string;
  initialPhase?: string;
  budgetTotal: number | null;
  budgetSpent: number;
  signal?: AbortSignal;
  handlers: WorkflowSandboxHandlers;
  /** Primarily for tests and packaged-host overrides. */
  childModulePath?: string;
  maximumOldSpaceMb?: number;
  /** Expose only Claude-compatible globals; Pi additions live under globalThis.pi. */
  compatibilityMode?: boolean;
}

interface SandboxRequest {
  type: "request";
  nonce: string;
  id: number;
  method: string;
  args: unknown[];
}

interface SandboxNotification {
  type: "notification";
  nonce: string;
  method: string;
  args: unknown[];
}

interface SandboxResult {
  type: "result";
  nonce: string;
  ok: boolean;
  value?: unknown;
  error?: SerializedError;
}

interface SerializedError {
  message: string;
  name?: string;
  code?: string;
  recoverable?: boolean;
  agentLabel?: string;
  resetHint?: string;
}

/**
 * Execute orchestration JavaScript in a dedicated, permission-restricted Node
 * process. No executable host function is injected into the vm realm: every
 * capability crosses a validated IPC method boundary.
 */
export function runWorkflowSandbox<T = unknown>(options: WorkflowSandboxRunOptions): Promise<T> {
  const childModulePath = realpathSync(options.childModulePath ?? resolveSandboxChildModule());
  const packageJsonPath = realpathSync(join(dirname(childModulePath), "..", "package.json"));
  // Clone before spawning so an unsupported API argument cannot leak an idle child.
  const clonedArgs = structuredClone(options.args);
  const nonce = randomBytes(32).toString("hex");
  const child = spawn(
    process.execPath,
    [
      `--max-old-space-size=${normalizeMemoryLimit(options.maximumOldSpaceMb)}`,
      "--permission",
      `--allow-fs-read=${childModulePath}`,
      `--allow-fs-read=${packageJsonPath}`,
      childModulePath,
    ],
    {
      cwd: existsSync(options.cwd) ? options.cwd : process.cwd(),
      env: Object.freeze({}),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    },
  );

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      child.removeAllListeners();
      if (child.connected) child.disconnect();
      if (!child.killed) child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = () => finish(new Error("Workflow sandbox aborted"));

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 32_768) stderr += chunk.toString("utf8").slice(0, 32_768 - stderr.length);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (!settled) {
        finish(
          new Error(
            `Workflow sandbox exited before returning a result (code=${String(code)}, signal=${String(signal)})${stderr ? `: ${stderr.trim()}` : ""}`,
          ),
        );
      }
    });
    child.on("message", (message: SandboxRequest | SandboxNotification | SandboxResult) => {
      if (!message || typeof message !== "object" || message.nonce !== nonce) return;
      if (message.type === "result") {
        if (message.ok) finish(undefined, message.value);
        else finish(deserializeError(message.error));
        return;
      }
      if (message.type === "notification") {
        handleNotification(message, options.handlers);
        return;
      }
      if (message.type === "request") void handleRequest(child, message, options.handlers, nonce);
    });

    if (options.signal?.aborted) return abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    sendIfConnected(child, {
      type: "init",
      nonce,
      body: options.body,
      filename: options.filename,
      args: clonedArgs,
      cwd: options.cwd,
      compatibilityMode: options.compatibilityMode ?? false,
      initialPhase: options.initialPhase,
      budgetTotal: options.budgetTotal,
      budgetSpent: options.budgetSpent,
    });
  });
}

async function handleRequest(
  child: ChildProcess,
  request: SandboxRequest,
  handlers: WorkflowSandboxHandlers,
  nonce: string,
): Promise<void> {
  try {
    let value: unknown;
    switch (request.method) {
      case "agent":
        value = await handlers.agent(assertString(request.args[0], "agent prompt"), asRecord(request.args[1]));
        break;
      case "workflow":
        value = await handlers.workflow(assertString(request.args[0], "workflow name or script"), request.args[1]);
        break;
      case "checkpoint":
        value = await handlers.checkpoint(
          assertString(request.args[0], "checkpoint prompt"),
          asRecord(request.args[1]),
        );
        break;
      default:
        throw new Error(`Sandbox requested unknown bridge method: ${request.method}`);
    }
    sendIfConnected(child, {
      type: "response",
      nonce,
      id: request.id,
      ok: true,
      value: structuredClone(value),
      budgetSpent: handlers.budgetSpent(),
    });
  } catch (error) {
    sendIfConnected(child, {
      type: "response",
      nonce,
      id: request.id,
      ok: false,
      error: serializeError(error),
      budgetSpent: handlers.budgetSpent(),
    });
  }
}

function handleNotification(notification: SandboxNotification, handlers: WorkflowSandboxHandlers): void {
  switch (notification.method) {
    case "phase":
      handlers.phase(assertString(notification.args[0], "phase title"), asRecord(notification.args[1]));
      break;
    case "log":
      handlers.log(assertString(notification.args[0], "log message"));
      break;
    default:
      throw new Error(`Sandbox sent unknown notification: ${notification.method}`);
  }
}

function resolveSandboxChildModule(): string {
  const adjacent = fileURLToPath(new URL("./workflow-sandbox-child.js", import.meta.url));
  if (existsSync(adjacent)) return adjacent;
  // Source-mode test/dev execution (tsx) still uses the compiled child because the
  // restricted process deliberately has no TypeScript loader or node_modules access.
  const built = fileURLToPath(new URL("../dist/workflow-sandbox-child.js", import.meta.url));
  if (existsSync(built)) return built;
  throw new Error(
    `Workflow sandbox child module is unavailable: ${adjacent}. Build the package before running workflows.`,
  );
}

function normalizeMemoryLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 128;
  return Math.min(512, Math.max(32, Math.floor(value)));
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function sendIfConnected(child: ChildProcess, message: unknown): void {
  if (!child.connected) return;
  try {
    child.send(message as Parameters<ChildProcess["send"]>[0], () => {});
  } catch {
    // The sandbox may have settled and disconnected between the check and send.
  }
}

function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) return { message: String(error) };
  const value = error as Error & { code?: string; recoverable?: boolean; agentLabel?: string; resetHint?: string };
  return {
    message: value.message,
    name: value.name,
    code: value.code,
    recoverable: value.recoverable,
    agentLabel: value.agentLabel,
    resetHint: value.resetHint,
  };
}

function deserializeError(value: SerializedError | undefined): Error {
  if (value?.name === "WorkflowError" && isWorkflowErrorCode(value.code)) {
    return new WorkflowError(value.message, value.code, {
      recoverable: value.recoverable,
      agentLabel: value.agentLabel,
      resetHint: value.resetHint,
    });
  }
  const error = new Error(value?.message ?? "Workflow sandbox failed");
  error.name = value?.name ?? "Error";
  Object.assign(error, { code: value?.code, recoverable: value?.recoverable });
  return error;
}

function isWorkflowErrorCode(value: string | undefined): value is WorkflowErrorCode {
  return value !== undefined && (Object.values(WorkflowErrorCode) as string[]).includes(value);
}
