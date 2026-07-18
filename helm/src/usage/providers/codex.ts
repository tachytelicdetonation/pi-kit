import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { asRecord, finiteNumber, HttpError, parseTimestamp, type FetchLike } from "../http.js";
import type { UsagePaths } from "../paths.js";
import type { UsageBucket, UsageSnapshot } from "../types.js";
import { clampPercent } from "../types.js";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

interface CodexCredential {
  access: string;
  accountId: string;
}

export interface CodexOptions {
  paths: UsagePaths;
  fetchImpl?: FetchLike;
  now?: () => number;
  executable?: string;
  timeoutMs?: number;
  usageUrl?: string;
}

export async function fetchCodexUsage(options: CodexOptions): Promise<UsageSnapshot> {
  const now = options.now ?? Date.now;
  const credentials = await readCodexCredentials(options.paths);
  const failures: string[] = [];

  for (const credential of credentials) {
    if (tokenExpired(credential.access, now())) continue;
    try {
      const response = await (options.fetchImpl ?? fetch)(options.usageUrl ?? CODEX_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${credential.access}`,
          "ChatGPT-Account-ID": credential.accountId,
          Accept: "application/json",
          "User-Agent": "pi-usage-health/0.1.0",
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
      });
      if (!response.ok) throw new HttpError(response.status, `Codex usage returned HTTP ${response.status}`);
      return parseCodexUsagePayload(await response.json(), now());
    } catch (error) {
      failures.push(describeError(error));
    }
  }

  try {
    return await fetchCodexUsageViaAppServer({
      executable: options.executable,
      timeoutMs: options.timeoutMs,
      now,
    });
  } catch (error) {
    failures.push(describeError(error));
  }

  throw new Error(failures.at(-1) ?? "No authenticated Codex credential found");
}

export async function readCodexCredentials(paths: UsagePaths): Promise<CodexCredential[]> {
  const credentials: CodexCredential[] = [];
  try {
    const auth = asRecord(JSON.parse(await readFile(join(paths.codexDir, "auth.json"), "utf8")));
    const tokens = asRecord(auth?.tokens);
    if (typeof tokens?.access_token === "string" && typeof tokens.account_id === "string") {
      credentials.push({ access: tokens.access_token, accountId: tokens.account_id });
    }
  } catch {
    // Codex CLI auth is optional.
  }
  try {
    const auth = asRecord(JSON.parse(await readFile(join(paths.piDir, "auth.json"), "utf8")));
    const codex = asRecord(auth?.["openai-codex"]);
    if (typeof codex?.access === "string" && typeof codex.accountId === "string") {
      credentials.push({ access: codex.access, accountId: codex.accountId });
    }
  } catch {
    // Pi Codex auth is optional.
  }
  return credentials;
}

export function parseCodexUsagePayload(payload: unknown, fetchedAt = Date.now()): UsageSnapshot {
  const root = asRecord(payload);
  if (!root) throw new Error("Codex usage response was not an object");
  const buckets: UsageBucket[] = [];

  addRateLimitBuckets(buckets, root.rate_limit, "Codex", "codex", true);
  addRateLimitBuckets(buckets, root.code_review_rate_limit, "Code review", "code-review", false);

  if (Array.isArray(root.additional_rate_limits)) {
    root.additional_rate_limits.forEach((item, index) => {
      const record = asRecord(item);
      if (!record) return;
      const label = stringValue(record.limit_name) ?? stringValue(record.metered_feature) ?? `Additional ${index + 1}`;
      const id = stringValue(record.metered_feature) ?? `additional-${index + 1}`;
      addRateLimitBuckets(buckets, record.rate_limit ?? record, label, id, true);
    });
  }

  if (buckets.length === 0) throw new Error("Codex usage response contained no rate-limit windows");
  return { provider: "codex", source: "live", fetchedAt, buckets };
}

export function parseCodexAppServerPayload(payload: unknown, fetchedAt = Date.now()): UsageSnapshot {
  const root = asRecord(payload);
  if (!root) throw new Error("Codex app-server returned an invalid response");
  const buckets: UsageBucket[] = [];
  const byId = asRecord(root.rateLimitsByLimitId);
  if (byId && Object.keys(byId).length > 0) {
    for (const [id, value] of Object.entries(byId)) {
      const record = asRecord(value);
      const label = stringValue(record?.limitName) ?? id;
      addRateLimitBuckets(buckets, value, label, id, true);
    }
  } else {
    addRateLimitBuckets(buckets, root.rateLimits, "Codex", "codex", true);
  }
  if (buckets.length === 0) throw new Error("Codex app-server returned no rate-limit windows");
  return { provider: "codex", source: "live", fetchedAt, buckets };
}

function addRateLimitBuckets(
  target: UsageBucket[],
  value: unknown,
  label: string,
  id: string,
  affectsHealth: boolean,
): void {
  const rateLimit = asRecord(value);
  if (!rateLimit) return;
  addWindow(target, rateLimit.primary_window ?? rateLimit.primary, `${label} · primary`, `${id}:primary`, affectsHealth);
  addWindow(target, rateLimit.secondary_window ?? rateLimit.secondary, `${label} · secondary`, `${id}:secondary`, affectsHealth);
}

function addWindow(target: UsageBucket[], value: unknown, label: string, id: string, affectsHealth: boolean): void {
  const window = asRecord(value);
  const used = finiteNumber(window?.used_percent ?? window?.usedPercent);
  if (!window || used === undefined) return;
  const windowSeconds = finiteNumber(window.limit_window_seconds);
  const windowMinutes = finiteNumber(window.windowDurationMins) ?? (windowSeconds === undefined ? undefined : windowSeconds / 60);
  const resetsAt = parseTimestamp(window.reset_at ?? window.resetsAt);
  target.push({
    id,
    label,
    usedPercent: clampPercent(used),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(affectsHealth ? {} : { affectsHealth: false }),
  });
}

async function fetchCodexUsageViaAppServer(options: {
  executable?: string;
  timeoutMs?: number;
  now: () => number;
}): Promise<UsageSnapshot> {
  const executable = options.executable?.trim() || process.env.PI_USAGE_HEALTH_CODEX_BIN?.trim() || "codex";
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise<UsageSnapshot>((resolve, reject) => {
    const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, snapshot?: UsageSnapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(snapshot as UsageSnapshot);
    };
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const processLine = (line: string) => {
      let message: Record<string, unknown> | undefined;
      try {
        message = asRecord(JSON.parse(line));
      } catch {
        return;
      }
      if (message?.id === 0 && message.result) {
        send({ method: "initialized", params: {} });
        send({ method: "account/rateLimits/read", id: 1, params: {} });
      } else if (message?.id === 1) {
        const error = asRecord(message.error);
        if (error) finish(new Error(stringValue(error.message) ?? "Codex app-server rate-limit request failed"));
        else {
          try {
            finish(undefined, parseCodexAppServerPayload(message.result, options.now()));
          } catch (parseError) {
            finish(parseError instanceof Error ? parseError : new Error(String(parseError)));
          }
        }
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) return finish(new Error("Codex app-server output exceeded 1MB"));
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line) processLine(line);
        newline = stdout.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) finish(new Error(stderr.trim().slice(0, 500) || `Codex app-server exited with code ${code ?? "unknown"}`));
    });
    const timer = setTimeout(() => finish(new Error("Codex app-server usage request timed out")), timeoutMs);
    send({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: { name: "pi_usage_health", title: "Pi Usage Health", version: "0.1.0" },
        capabilities: {},
      },
    });
  });
}

function tokenExpired(token: string, now: number): boolean {
  try {
    const segment = token.split(".")[1];
    if (!segment) return false;
    const payload = asRecord(JSON.parse(Buffer.from(segment, "base64url").toString("utf8")));
    const expires = finiteNumber(payload?.exp);
    return expires !== undefined && expires * 1_000 <= now + 30_000;
  } catch {
    return false;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 160) : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
