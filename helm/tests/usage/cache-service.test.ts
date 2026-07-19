import { removeTempDir, tempDir } from "../helpers/tmp.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readSnapshotCache, writeSnapshotCache } from "../../src/usage/cache.js";
import { resolveUsagePaths } from "../../src/usage/paths.js";
import { UsageService } from "../../src/usage/service.js";
import type { UsageSnapshot } from "../../src/usage/types.js";

const snapshot: UsageSnapshot = {
  provider: "codex",
  source: "live",
  fetchedAt: 1234,
  buckets: [{ id: "main", label: "Codex", usedPercent: 17, resetsAt: 5678 }],
};

test("sanitized cache round-trips normalized snapshots only", async () => {
  const directory = tempDir("usage-health-");
  const path = join(directory, "nested", "cache.json");
  try {
    await writeSnapshotCache(path, [snapshot]);
    const raw = await readFile(path, "utf8");
    assert.doesNotMatch(raw, /access|refresh|accountId|Bearer/i);
    const loaded = await readSnapshotCache(path);
    assert.equal(loaded[0]?.source, "extension-cache");
    assert.equal(loaded[0]?.buckets[0]?.usedPercent, 17);
  } finally {
    removeTempDir(directory);
  }
});

test("automatic refresh is capped across session events by persisted checkedAt timestamps", async () => {
  const directory = tempDir("usage-health-throttle-");
  const paths = resolveUsagePaths({ HOME: directory, PI_CODING_AGENT_DIR: join(directory, "pi") });
  let currentNow = 10_000_000;
  const checkedAt = { codex: currentNow, claude: currentNow, kimi: currentNow };
  const calls = { codex: 0, claude: 0, kimi: 0 };
  const makeFetcher = (provider: keyof typeof calls) => async (): Promise<UsageSnapshot> => {
    calls[provider] += 1;
    return {
      provider,
      source: "live",
      fetchedAt: currentNow,
      buckets: [{ id: "main", label: provider, usedPercent: 10 }],
    };
  };
  try {
    await writeSnapshotCache(paths.cacheFile, [snapshot], checkedAt);
    const service = new UsageService({
      paths,
      now: () => currentNow,
      fetchers: {
        codex: makeFetcher("codex"),
        claude: makeFetcher("claude"),
        kimi: makeFetcher("kimi"),
      },
    });
    await service.refreshIfOlderThan(30 * 60_000);
    assert.deepEqual(calls, { codex: 0, claude: 0, kimi: 0 });

    currentNow += 31 * 60_000;
    await service.refreshIfOlderThan(30 * 60_000);
    assert.deepEqual(calls, { codex: 1, claude: 1, kimi: 1 });

    // A message settling immediately afterwards must not call any endpoint again.
    await service.refreshIfOlderThan(30 * 60_000);
    assert.deepEqual(calls, { codex: 1, claude: 1, kimi: 1 });
  } finally {
    removeTempDir(directory);
  }
});

test("service preserves cached data when a provider refresh fails", async () => {
  const directory = tempDir("usage-health-service-");
  const paths = resolveUsagePaths({ HOME: directory, PI_CODING_AGENT_DIR: join(directory, "pi") });
  try {
    await writeSnapshotCache(paths.cacheFile, [snapshot]);
    const service = new UsageService({
      paths,
      fetchers: {
        codex: async () => {
          throw new Error("offline");
        },
        claude: async () => {
          throw new Error("not configured");
        },
        kimi: async () => {
          throw new Error("not configured");
        },
      },
    });
    await service.loadCache();
    await service.refreshProvider("codex");
    const codex = service.getView().providers.find((state) => state.provider === "codex");
    assert.equal(codex?.snapshot?.buckets[0]?.usedPercent, 17);
    assert.equal(codex?.error, "offline");
  } finally {
    removeTempDir(directory);
  }
});
