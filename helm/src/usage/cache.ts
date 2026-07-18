import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { asRecord, finiteNumber } from "./http.js";
import type { ProviderId, SnapshotSource, UsageBucket, UsageSnapshot } from "./types.js";
import { PROVIDER_ORDER, clampPercent } from "./types.js";

const CACHE_VERSION = 2;

export interface UsageCache {
  snapshots: UsageSnapshot[];
  checkedAt: Partial<Record<ProviderId, number>>;
}

export async function readUsageCache(path: string): Promise<UsageCache> {
  try {
    const root = asRecord(JSON.parse(await readFile(path, "utf8")));
    if ((root?.version !== 1 && root?.version !== CACHE_VERSION) || !Array.isArray(root.snapshots)) {
      return { snapshots: [], checkedAt: {} };
    }
    const snapshots = root.snapshots.map(parseSnapshot).filter((value): value is UsageSnapshot => value !== undefined);
    const checkedRecord = asRecord(root.checkedAt);
    const checkedAt: Partial<Record<ProviderId, number>> = {};
    for (const provider of PROVIDER_ORDER) {
      const value = finiteNumber(checkedRecord?.[provider]);
      if (value !== undefined) checkedAt[provider] = value;
    }
    // Version 1 had no attempt timestamps. Seed from snapshot age so upgrading
    // does not immediately refetch a still-fresh cache in every open session.
    if (root.version === 1) {
      for (const snapshot of snapshots) checkedAt[snapshot.provider] = snapshot.fetchedAt;
    }
    return { snapshots, checkedAt };
  } catch {
    return { snapshots: [], checkedAt: {} };
  }
}

export async function readSnapshotCache(path: string): Promise<UsageSnapshot[]> {
  return (await readUsageCache(path)).snapshots;
}

export async function writeSnapshotCache(
  path: string,
  snapshots: UsageSnapshot[],
  checkedAt: Partial<Record<ProviderId, number>> = {},
): Promise<void> {
  const safe = snapshots.map((snapshot) => ({ ...snapshot, source: "extension-cache" as SnapshotSource }));
  const payload = JSON.stringify({ version: CACHE_VERSION, snapshots: safe, checkedAt }, null, 2) + "\n";
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function parseSnapshot(value: unknown): UsageSnapshot | undefined {
  const record = asRecord(value);
  if (!record || !PROVIDER_ORDER.includes(record.provider as ProviderId) || !Array.isArray(record.buckets)) return undefined;
  const fetchedAt = finiteNumber(record.fetchedAt);
  if (fetchedAt === undefined) return undefined;
  const buckets = record.buckets.map(parseBucket).filter((bucket): bucket is UsageBucket => bucket !== undefined);
  if (buckets.length === 0) return undefined;
  return {
    provider: record.provider as ProviderId,
    source: "extension-cache",
    fetchedAt,
    buckets,
  };
}

function parseBucket(value: unknown): UsageBucket | undefined {
  const record = asRecord(value);
  const usedPercent = finiteNumber(record?.usedPercent);
  if (!record || typeof record.id !== "string" || typeof record.label !== "string" || usedPercent === undefined) {
    return undefined;
  }
  const resetsAt = finiteNumber(record.resetsAt);
  const windowMinutes = finiteNumber(record.windowMinutes);
  return {
    id: record.id.slice(0, 160),
    label: record.label.slice(0, 160),
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(record.affectsHealth === false ? { affectsHealth: false } : {}),
  };
}
