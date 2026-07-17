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

export async function isClaudeProcess(pid: number): Promise<boolean> {
  if (!isProcessAlive(pid)) return false;
  const result = await runCommand("ps", ["-p", String(pid), "-o", "command="], { timeoutMs: 2_000 });
  return result.code === 0 && /(?:^|\/)claude(?:\s|$)|Claude Code|2\.1\./i.test(result.stdout);
}
