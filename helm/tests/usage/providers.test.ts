import { removeTempDir, tempDir } from "../helpers/tmp.js";
import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseClaudeUsagePayload } from "../../src/usage/providers/claude.js";
import { parseCodexAppServerPayload, parseCodexUsagePayload } from "../../src/usage/providers/codex.js";
import { ensureFreshKimiCredential, parseKimiUsagePayload } from "../../src/usage/providers/kimi.js";
import { resolveUsagePaths } from "../../src/usage/paths.js";
import { providerRemaining } from "../../src/usage/types.js";

const NOW = Date.parse("2026-07-17T12:00:00Z");

test("Codex parser includes primary, additional-model, and informational code-review windows", () => {
  const snapshot = parseCodexUsagePayload(
    {
      rate_limit: { primary_window: { used_percent: 17, reset_at: 1_784_781_541, limit_window_seconds: 604_800 } },
      code_review_rate_limit: { primary_window: { used_percent: 99, reset_at: 1_784_781_541 } },
      additional_rate_limits: [
        {
          limit_name: "GPT-5.3-Codex-Spark",
          metered_feature: "codex_spark",
          rate_limit: { primary_window: { used_percent: 0, reset_at: 1_784_909_911 } },
        },
      ],
    },
    NOW,
  );
  assert.equal(snapshot.buckets.length, 3);
  assert.equal(snapshot.buckets.find((bucket) => bucket.id === "code-review:primary")?.affectsHealth, false);
  assert.equal(providerRemaining(snapshot), 83);
});

test("Codex app-server parser supports multi-bucket camelCase payloads", () => {
  const snapshot = parseCodexAppServerPayload(
    {
      rateLimits: { primary: { usedPercent: 50, resetsAt: 1_784_781_541, windowDurationMins: 300 } },
      rateLimitsByLimitId: {
        codex: { limitName: "Codex", primary: { usedPercent: 20, resetsAt: 1_784_781_541 } },
        spark: { limitName: "Spark", primary: { usedPercent: 4, resetsAt: 1_784_781_541 } },
      },
    },
    NOW,
  );
  assert.deepEqual(snapshot.buckets.map((bucket) => bucket.label), ["Codex · primary", "Spark · primary"]);
  assert.equal(providerRemaining(snapshot), 80);
});

test("Claude parser keeps active core and model-scoped windows", () => {
  const snapshot = parseClaudeUsagePayload(
    {
      five_hour: { utilization: 3, resets_at: "2026-07-17T20:50:00Z" },
      seven_day: { utilization: 9, resets_at: "2026-07-20T20:00:00Z" },
      limits: [
        {
          kind: "weekly_scoped",
          percent: 5,
          resets_at: "2026-07-20T20:00:00Z",
          scope: { model: { display_name: "Fable" } },
          is_active: true,
        },
      ],
    },
    "provider-cache",
    NOW,
  );
  assert.equal(snapshot.source, "provider-cache");
  assert.equal(snapshot.buckets.length, 3);
  assert.equal(providerRemaining(snapshot), 91);
});

test("Kimi OAuth refresh uses the shared lock and atomically rotates expired credentials", async () => {
  const home = tempDir("usage-health-kimi-");
  const paths = resolveUsagePaths({ HOME: home, KIMI_CODE_HOME: join(home, ".kimi-code") });
  const credentialPath = join(paths.kimiDir, "credentials", "kimi-code.json");
  await mkdir(join(paths.kimiDir, "credentials"), { recursive: true });
  await writeFile(
    credentialPath,
    JSON.stringify({
      access_token: "expired-access",
      refresh_token: "old-refresh",
      expires_at: 1,
      scope: "scope",
      token_type: "Bearer",
      expires_in: 3600,
    }),
  );
  let calls = 0;
  const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
    calls += 1;
    assert.match(String(init?.body), /refresh_token=old-refresh/);
    return new Response(
      JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        scope: "scope",
        token_type: "Bearer",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    const token = await ensureFreshKimiCredential(paths, () => NOW, fetchImpl);
    assert.equal(token, "new-access");
    assert.equal(calls, 1);
    const saved = JSON.parse(await readFile(credentialPath, "utf8"));
    assert.equal(saved.refresh_token, "new-refresh");
    assert.equal(saved.expires_at, Math.floor(NOW / 1000) + 3600);
    await assert.rejects(access(join(paths.kimiDir, "oauth", "kimi-code.lock")));
  } finally {
    removeTempDir(home);
  }
});

test("Kimi parser derives used percentage and rolling-window label", () => {
  const snapshot = parseKimiUsagePayload(
    {
      usage: { name: "Weekly limit", used: 840, limit: 1000, resetAt: "2026-07-23T18:51:56Z" },
      limits: [
        {
          detail: { remaining: 53, limit: 100, resetAt: "2026-07-17T19:51:56Z" },
          window: { duration: 300, timeUnit: "MINUTE" },
        },
      ],
    },
    NOW,
  );
  assert.equal(snapshot.buckets[0]?.usedPercent, 84);
  assert.equal(snapshot.buckets[1]?.label, "5-hour");
  assert.equal(snapshot.buckets[1]?.usedPercent, 47);
  assert.equal(providerRemaining(snapshot), 16);
});
