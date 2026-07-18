import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { readUsageCache, writeSnapshotCache, type UsageCache } from "./cache.js";
import type { UsagePaths } from "./paths.js";
import { fetchClaudeUsage } from "./providers/claude.js";
import { fetchCodexUsage } from "./providers/codex.js";
import { fetchKimiUsage } from "./providers/kimi.js";
import type { ProviderId, ProviderViewState, UsageSnapshot, UsageViewModel } from "./types.js";
import { PROVIDER_ORDER } from "./types.js";

export type UsageFetcher = () => Promise<UsageSnapshot>;

export interface UsageServiceOptions {
  paths: UsagePaths;
  now?: () => number;
  fetchers?: Partial<Record<ProviderId, UsageFetcher>>;
  onUpdate?: () => void;
}

export class UsageService {
  private readonly paths: UsagePaths;
  private readonly now: () => number;
  private readonly fetchers: Record<ProviderId, UsageFetcher>;
  private readonly states = new Map<ProviderId, ProviderViewState>();
  private readonly checkedAt = new Map<ProviderId, number>();
  private readonly inFlight = new Map<ProviderId, Promise<void>>();
  private readonly onUpdate: () => void;
  private loaded = false;

  constructor(options: UsageServiceOptions) {
    this.paths = options.paths;
    this.now = options.now ?? Date.now;
    this.onUpdate = options.onUpdate ?? (() => {});
    this.fetchers = {
      codex: options.fetchers?.codex ?? (() => fetchCodexUsage({ paths: this.paths, now: this.now })),
      claude: options.fetchers?.claude ?? (() => fetchClaudeUsage({ paths: this.paths, now: this.now })),
      kimi: options.fetchers?.kimi ?? (() => fetchKimiUsage({ paths: this.paths, now: this.now })),
    };
    for (const provider of PROVIDER_ORDER) this.states.set(provider, { provider, refreshing: false });
  }

  getView(): UsageViewModel {
    return {
      providers: PROVIDER_ORDER.map((provider) => ({ ...(this.states.get(provider) as ProviderViewState) })),
      now: this.now(),
    };
  }

  async loadCache(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.mergeCache(await readUsageCache(this.paths.cacheFile));
    this.onUpdate();
  }

  /** Explicit user refresh. Cross-process lock prevents overlapping refreshes. */
  async refreshAll(): Promise<void> {
    await this.refreshDue(0, true);
  }

  /**
   * Refresh only when the persisted provider attempt is older than ageMs.
   * There is no timer: this runs on session start and agent settlement, and the
   * cross-process checkedAt cache caps automatic network calls across Pi sessions.
   */
  async refreshIfOlderThan(ageMs: number): Promise<void> {
    await this.refreshDue(ageMs, false);
  }

  async refreshProvider(provider: ProviderId): Promise<void> {
    const existing = this.inFlight.get(provider);
    if (existing) return existing;
    const operation = this.runRefresh(provider).finally(() => this.inFlight.delete(provider));
    this.inFlight.set(provider, operation);
    return operation;
  }

  private async refreshDue(ageMs: number, force: boolean): Promise<void> {
    await this.loadCache();
    const release = await this.acquireRefreshLock(force);
    if (!release) return;
    try {
      // Another Pi process may have refreshed while this process waited.
      this.mergeCache(await readUsageCache(this.paths.cacheFile));
      const now = this.now();
      const due = PROVIDER_ORDER.filter(
        (provider) => force || now - (this.checkedAt.get(provider) ?? 0) >= ageMs,
      );
      if (due.length === 0) return;
      await Promise.all(due.map((provider) => this.refreshProvider(provider)));
      await this.persistBestEffort();
    } finally {
      await release().catch(() => {});
    }
  }

  private async runRefresh(provider: ProviderId): Promise<void> {
    const current = this.states.get(provider) as ProviderViewState;
    this.states.set(provider, { ...current, refreshing: true, error: undefined });
    this.onUpdate();
    try {
      const snapshot = await this.fetchers[provider]();
      this.states.set(provider, { provider, snapshot, refreshing: false });
    } catch (error) {
      this.states.set(provider, {
        ...current,
        provider,
        refreshing: false,
        error: sanitizeError(error),
      });
    } finally {
      // Record failed attempts too, otherwise missing/expired credentials would
      // trigger a request after every message.
      this.checkedAt.set(provider, this.now());
    }
    this.onUpdate();
  }

  private mergeCache(cache: UsageCache): void {
    for (const snapshot of cache.snapshots) {
      const current = this.states.get(snapshot.provider);
      if (!current?.snapshot || snapshot.fetchedAt > current.snapshot.fetchedAt) {
        this.states.set(snapshot.provider, {
          ...current,
          provider: snapshot.provider,
          snapshot,
          refreshing: current?.refreshing ?? false,
        });
      }
    }
    for (const provider of PROVIDER_ORDER) {
      const diskCheckedAt = cache.checkedAt[provider];
      if (diskCheckedAt !== undefined) {
        this.checkedAt.set(provider, Math.max(this.checkedAt.get(provider) ?? 0, diskCheckedAt));
      }
    }
  }

  private async persistBestEffort(): Promise<void> {
    const snapshots = [...this.states.values()]
      .map((state) => state.snapshot)
      .filter((snapshot): snapshot is UsageSnapshot => snapshot !== undefined);
    const checkedAt = Object.fromEntries(this.checkedAt) as Partial<Record<ProviderId, number>>;
    try {
      await writeSnapshotCache(this.paths.cacheFile, snapshots, checkedAt);
    } catch {
      // The health bar remains useful in-memory when its optional cache is unwritable.
    }
  }

  private async acquireRefreshLock(force: boolean): Promise<(() => Promise<void>) | undefined> {
    const target = `${this.paths.cacheFile}.refresh`;
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, "", { flag: "a", mode: 0o600 });
      return await lockfile.lock(target, {
        retries: force ? { retries: 12, factor: 1, minTimeout: 250, maxTimeout: 500 } : 0,
        stale: 2 * 60_000,
        realpath: false,
      });
    } catch (error) {
      if (!force) return undefined;
      throw error;
    }
  }
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer <redacted>")
    .replace(/[A-Za-z0-9_-]{80,}/g, "<redacted>")
    .slice(0, 300);
}
