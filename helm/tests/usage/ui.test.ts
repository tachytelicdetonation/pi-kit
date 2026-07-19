import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { computeCtxMeter, computeStackedBar, formatUsageDetails, renderFooter } from "../../src/usage/ui.js";
import type { FooterViewModel } from "../../src/usage/ui.js";
import type { ProviderViewState, UsageViewModel } from "../../src/usage/types.js";
import { stripAnsi } from "../helpers/tui.js";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  getColorMode: () => "256color" as const,
};

const now = Date.parse("2026-07-17T12:00:00Z");

/** Build a provider state whose single bucket yields the given remaining percent. */
function providerState(provider: ProviderViewState["provider"], remaining: number): ProviderViewState {
  return {
    provider,
    refreshing: false,
    snapshot: { provider, source: "live", fetchedAt: now, buckets: [{ id: "main", label: "7-day", usedPercent: 100 - remaining }] },
  };
}

const footer: FooterViewModel = {
  now,
  cwd: "~/pi-kit",
  branch: "main",
  ctxPercent: 60,
  costUsd: 0.012,
  model: "gpt-5.6-sol",
  effort: "high",
  providers: [providerState("codex", 83), providerState("claude", 91), providerState("kimi", 16)],
};

for (const width of [140, 110, 109, 90, 89, 70, 69, 40, 8]) {
  test(`footer never exceeds ${width} columns`, () => {
    const lines = renderFooter(footer, plainTheme, width);
    assert.equal(lines.length, 1);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
  });
}

test("stacked bar splits 90/100/60 into 9/10/6 colored cells with an 83% label", () => {
  const states = [providerState("codex", 90), providerState("claude", 100), providerState("kimi", 60)];
  const full = computeStackedBar(states, 30);
  assert.deepEqual(full.colored, [9, 10, 6]);
  assert.equal(full.empty, 5);
  assert.equal(full.totalPercent, 83);

  const compact = computeStackedBar(states, 20);
  assert.deepEqual(compact.colored, [6, 7, 4]);

  // The rendered percent label survives to the row.
  const wide = stripAnsi(renderFooter({ ...footer, providers: states }, plainTheme, 140)[0]);
  assert.match(wide, /83%/);
});

test("colored run is clamped to the cell budget when rounding overflows", () => {
  const states = [providerState("codex", 100), providerState("claude", 100), providerState("kimi", 100)];
  const bar = computeStackedBar(states, 30);
  assert.equal(bar.colored.reduce((sum, count) => sum + count, 0) + bar.empty, 30);
  assert.ok(bar.colored.reduce((sum, count) => sum + count, 0) <= 30);
});

test("ctx meter fills round(percent/100 * 8) cells", () => {
  assert.deepEqual(computeCtxMeter(60), { filled: 5, empty: 3 });
  assert.deepEqual(computeCtxMeter(0), { filled: 0, empty: 8 });
  assert.deepEqual(computeCtxMeter(100), { filled: 8, empty: 0 });

  const compactTier = stripAnsi(renderFooter(footer, plainTheme, 80)[0]);
  assert.match(compactTier, /ctx ▮{8} 60%/);
  const undefinedCtx = stripAnsi(renderFooter({ ...footer, ctxPercent: undefined }, plainTheme, 140)[0]);
  assert.match(undefinedCtx, /ctx --/);
});

test("width tiers drop cwd, branch, cost, and effort as space shrinks", () => {
  const wide = stripAnsi(renderFooter(footer, plainTheme, 140)[0]);
  assert.match(wide, /~\/pi-kit/);
  assert.match(wide, /main/);
  assert.match(wide, /\$0\.012/);
  assert.match(wide, /gpt-5\.6-sol high/);

  const mid = stripAnsi(renderFooter(footer, plainTheme, 100)[0]);
  assert.doesNotMatch(mid, /~\/pi-kit/);
  assert.match(mid, /main/);
  assert.match(mid, /\$0\.012/);

  const narrow = stripAnsi(renderFooter(footer, plainTheme, 80)[0]);
  assert.doesNotMatch(narrow, /main/);
  assert.doesNotMatch(narrow, /\$0\.012/);
  assert.match(narrow, /gpt-5\.6-sol/);
  assert.doesNotMatch(narrow, /gpt-5\.6-sol high/);
});

test("all providers unknown renders '--', not a misleading 0%", () => {
  const unknown: ProviderViewState[] = [
    { provider: "codex", refreshing: false },
    { provider: "claude", refreshing: false },
    { provider: "kimi", refreshing: false },
  ];
  const bar = computeStackedBar(unknown, 30);
  assert.equal(bar.known, 0);
  assert.equal(bar.colored.reduce((sum, count) => sum + count, 0), 0);
  const line = stripAnsi(renderFooter({ ...footer, providers: unknown }, plainTheme, 140)[0]);
  assert.match(line, /▮ --/); // bar followed by "--" label
  assert.doesNotMatch(line, /▮ 0%/); // never the misleading "quota spent" reading
});

test("non-finite width is handled without throwing or overflowing", () => {
  for (const bad of [Infinity, -Infinity, NaN]) {
    assert.doesNotThrow(() => renderFooter(footer, plainTheme, bad));
    assert.deepEqual(renderFooter(footer, plainTheme, bad), [""]);
  }
});

test("a long cwd never crowds out the usage bar at wide widths", () => {
  const longCwd = "~/Projects/company/monorepo/packages/services/api-gateway/internal";
  for (const width of [110, 120, 140]) {
    const line = stripAnsi(renderFooter({ ...footer, cwd: longCwd }, plainTheme, width)[0]);
    assert.match(line, /▮/, `bar missing at ${width}: ${line}`);
    assert.match(line, /83%|91%|16%|%/, `percent label missing at ${width}: ${line}`);
    assert.ok(visibleWidth(line) <= width);
  }
});

test("a corrupt (non-finite) provider bucket is treated as unknown, not 100%", () => {
  const corrupt: ProviderViewState[] = [
    { provider: "codex", refreshing: false, snapshot: { provider: "codex", source: "live", fetchedAt: now, buckets: [{ id: "main", label: "7-day", usedPercent: NaN }] } },
    providerState("claude", 100),
    providerState("kimi", 100),
  ];
  const bar = computeStackedBar(corrupt, 30);
  assert.equal(bar.known, 2); // codex dropped as unknown
  assert.equal(bar.colored[0], 0); // no colored cells for the corrupt provider
});

const detailView: UsageViewModel = {
  now,
  providers: [
    { provider: "codex", refreshing: false, snapshot: { provider: "codex", source: "live", fetchedAt: now, buckets: [{ id: "main", label: "7-day", usedPercent: 17 }] } },
    { provider: "claude", refreshing: false, snapshot: { provider: "claude", source: "provider-cache", fetchedAt: now, buckets: [{ id: "weekly", label: "7-day", usedPercent: 9 }] } },
    { provider: "kimi", refreshing: false, snapshot: { provider: "kimi", source: "live", fetchedAt: now, buckets: [{ id: "weekly", label: "Weekly", usedPercent: 84 }] } },
  ],
};

test("detail output exposes all buckets without credentials or raw responses", () => {
  const details = formatUsageDetails(detailView);
  assert.match(details, /Codex — 83% left \(live\)/);
  assert.match(details, /Claude — 91% left \(provider-cache\)/);
  assert.match(details, /Kimi — 16% left \(live\)/);
  assert.doesNotMatch(details, /Bearer|access.token|refresh.token/i);
});
