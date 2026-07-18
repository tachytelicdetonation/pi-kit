import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { asRecord, finiteNumber, parseTimestamp, type FetchLike } from "../http.js";
import type { UsagePaths } from "../paths.js";
import type { UsageBucket, UsageSnapshot } from "../types.js";
import { clampPercent } from "../types.js";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export interface ClaudeOptions {
  paths: UsagePaths;
  fetchImpl?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  usageUrl?: string;
}

export async function fetchClaudeUsage(options: ClaudeOptions): Promise<UsageSnapshot> {
  const now = options.now ?? Date.now;
  const cached = await readClaudeProviderCache(options.paths, now());
  const credential = await readClaudeCredential(options.paths);
  if (!credential || credential.expiresAt <= now() + 30_000) {
    if (cached) return cached;
    throw new Error(credential ? "Claude OAuth token is expired; open Claude Code to refresh it" : "Claude Code is not authenticated");
  }

  try {
    const response = await (options.fetchImpl ?? fetch)(options.usageUrl ?? CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });
    if (!response.ok) throw new Error(`Claude usage returned HTTP ${response.status}`);
    return parseClaudeUsagePayload(await response.json(), "live", now());
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}

export function parseClaudeUsagePayload(
  payload: unknown,
  source: "live" | "provider-cache" = "live",
  fetchedAt = Date.now(),
): UsageSnapshot {
  const root = asRecord(payload);
  if (!root) throw new Error("Claude usage response was not an object");
  const buckets: UsageBucket[] = [];
  const known: Array<[string, string, boolean]> = [
    ["five_hour", "5-hour", true],
    ["seven_day", "7-day", true],
    ["seven_day_opus", "7-day · Opus", true],
    ["seven_day_sonnet", "7-day · Sonnet", true],
    ["seven_day_oauth_apps", "7-day · OAuth apps", false],
  ];
  for (const [key, label, affectsHealth] of known) {
    addClaudeBucket(buckets, root[key], key, label, affectsHealth);
  }

  if (Array.isArray(root.limits)) {
    root.limits.forEach((item, index) => {
      const record = asRecord(item);
      if (!record || typeof record.kind !== "string") return;
      const scope = asRecord(record.scope);
      const model = asRecord(scope?.model);
      const displayName = typeof model?.display_name === "string" ? model.display_name : undefined;
      const id = `${record.kind}:${displayName ?? index}`;
      if (record.kind === "session" || record.kind === "weekly_all") return;
      addClaudeBucket(
        buckets,
        { utilization: record.percent, resets_at: record.resets_at },
        id,
        displayName ? `7-day · ${displayName}` : humanize(record.kind),
        record.is_active !== false,
      );
    });
  }

  if (buckets.length === 0) throw new Error("Claude usage response contained no rate-limit windows");
  return { provider: "claude", source, fetchedAt, buckets: dedupeBuckets(buckets) };
}

async function readClaudeProviderCache(paths: UsagePaths, now: number): Promise<UsageSnapshot | undefined> {
  try {
    const [content, info] = await Promise.all([readFile(paths.claudeState, "utf8"), stat(paths.claudeState)]);
    const root = asRecord(JSON.parse(content));
    const cachedUsage = asRecord(root?.cachedUsageUtilization);
    const utilization = cachedUsage?.utilization ?? root?.utilization;
    if (!utilization) return undefined;
    const cachedAt = finiteNumber(cachedUsage?.fetchedAtMs) ?? info.mtimeMs;
    return parseClaudeUsagePayload(utilization, "provider-cache", Math.min(cachedAt, now));
  } catch {
    return undefined;
  }
}

async function readClaudeCredential(paths: UsagePaths): Promise<{ accessToken: string; expiresAt: number } | undefined> {
  try {
    const root = asRecord(JSON.parse(await readFile(join(paths.claudeDir, ".credentials.json"), "utf8")));
    const oauth = asRecord(root?.claudeAiOauth);
    const expiresAt = finiteNumber(oauth?.expiresAt);
    if (typeof oauth?.accessToken !== "string" || expiresAt === undefined) return undefined;
    return { accessToken: oauth.accessToken, expiresAt };
  } catch {
    return undefined;
  }
}

function addClaudeBucket(
  target: UsageBucket[],
  value: unknown,
  id: string,
  label: string,
  affectsHealth: boolean,
): void {
  const record = asRecord(value);
  const utilization = finiteNumber(record?.utilization ?? record?.used_percentage ?? record?.percent);
  if (!record || utilization === undefined) return;
  const resetsAt = parseTimestamp(record.resets_at ?? record.resetsAt);
  target.push({
    id,
    label,
    // Anthropic's usage endpoint and Claude's cache both represent utilization in percentage points.
    usedPercent: clampPercent(utilization),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(affectsHealth ? {} : { affectsHealth: false }),
  });
}

function dedupeBuckets(buckets: UsageBucket[]): UsageBucket[] {
  const seen = new Set<string>();
  return buckets.filter((bucket) => {
    const key = `${bucket.label}:${bucket.resetsAt ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function humanize(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
