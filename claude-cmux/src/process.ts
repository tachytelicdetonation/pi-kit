import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  input?: string;
}

export function scrubCmuxTargetEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, CMUX_QUIET: "1" };
  delete next.CMUX_WORKSPACE_ID;
  delete next.CMUX_SURFACE_ID;
  delete next.CMUX_TAB_ID;
  return next;
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killed = false;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const terminate = () => {
      if (child.exitCode !== null) return;
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1_500).unref();
    };
    const abort = () => terminate();
    const timer = options.timeoutMs
      ? setTimeout(() => terminate(), options.timeoutMs)
      : undefined;
    timer?.unref();

    if (options.signal?.aborted) terminate();
    else options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      finish({ stdout, stderr, code: code ?? (killed ? 143 : 1), killed });
    });

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

export function spawnStreaming(
  command: string,
  args: readonly string[],
  options: Pick<RunCommandOptions, "cwd" | "env"> = {},
): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

export function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Matches a Claude Code process command line. Intentionally narrow: an earlier
// version also matched the bare version fragment `2.1.`, which matched ANY
// process carrying "2.1." in its command line (e.g. `python train_v2.1.py`) — a
// PID reused by such a process could then be SIGKILLed by terminate(). The
// binary name (optionally path-prefixed) or the "Claude Code" banner is required.
const CLAUDE_COMMAND = /(?:^|\/)claude(?:\s|$)|Claude Code/i;

export async function processCommand(pid: number): Promise<string> {
  if (!isProcessAlive(pid)) return "";
  const result = await runCommand("ps", ["-p", String(pid), "-o", "command="], { timeoutMs: 2_000 });
  return result.code === 0 ? result.stdout.trim() : "";
}

export async function isClaudeProcess(pid: number): Promise<boolean> {
  const command = await processCommand(pid);
  return command.length > 0 && CLAUDE_COMMAND.test(command);
}

// Stronger identity than isClaudeProcess: the process is a Claude process AND its
// command line carries this exact session id (cmux launches with `--session-id
// <id>` and restores with `--resume <id>`, so the id is always present). Guards
// SIGKILL and resume/failed decisions against PID reuse by an unrelated Claude.
export async function isManagedClaudeProcess(pid: number, sessionId: string | undefined): Promise<boolean> {
  const command = await processCommand(pid);
  if (!command || !CLAUDE_COMMAND.test(command)) return false;
  return sessionId ? command.includes(sessionId) : true;
}

// Every live Claude PID whose command line references this session id. cmux can
// spawn several `claude --resume <id>` instances for one session when the session
// owned multiple restored surfaces after a restart; reconciliation uses this to
// find duplicates that no run is tracking.
export async function findClaudePidsForSession(sessionId: string): Promise<number[]> {
  if (!sessionId) return [];
  const result = await runCommand("ps", ["-axo", "pid=,command="], { timeoutMs: 3_000 });
  if (result.code !== 0) return [];
  const pids: number[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pidText, command] = match;
    if (CLAUDE_COMMAND.test(command) && command.includes(sessionId)) {
      const pid = Number(pidText);
      if (Number.isSafeInteger(pid) && pid > 1) pids.push(pid);
    }
  }
  return pids;
}
