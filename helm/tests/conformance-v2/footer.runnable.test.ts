import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import fc from "fast-check";
import { computeStackedBar, renderHelmFooter } from "../../src/footer.js";
import type { HelmFooterModel } from "../../src/state/types.js";
import { stripAnsi, theme256 } from "./helpers.js";

const base: HelmFooterModel = {
  cwd: "/repo/contract-probe",
  branch: "contract-branch",
  providers: [
    { id: "codex", remaining: 90 },
    { id: "claude", remaining: 100 },
    { id: "kimi", remaining: 60 },
  ],
  ctxPercent: 60,
  costUsd: 1.23,
  burnRatePerMin: 41_000,
  spendTodayUsd: 18.4,
  model: "gpt-contract",
  effort: "high",
};

function ctxGlyphs(line: string): number {
  const plain = stripAnsi(line);
  const start = plain.indexOf("ctx");
  if (start < 0) return 0;
  const end = plain.indexOf("%", start);
  return (plain.slice(start, end).match(/▮/g) ?? []).length;
}

test("Footer row: responsive boundaries keep the wider form at 110, 90, and 70", () => {
  const at110 = stripAnsi(renderHelmFooter(base, theme256, 110, "session"));
  const at109 = stripAnsi(renderHelmFooter(base, theme256, 109, "session"));
  assert.match(at110, /\/repo/);
  assert.doesNotMatch(at109, /\/repo/);

  const at90 = stripAnsi(renderHelmFooter(base, theme256, 90, "session"));
  const at89 = stripAnsi(renderHelmFooter(base, theme256, 89, "session"));
  assert.match(at90, /\$1\.23/);
  assert.doesNotMatch(at89, /\$1\.23/);

  const raw70 = renderHelmFooter(base, theme256, 70, "session");
  const raw69 = renderHelmFooter(base, theme256, 69, "session");
  assert.equal(ctxGlyphs(raw70), 8, "70 columns retains the eight-cell context bar");
  assert.doesNotMatch(stripAnsi(raw69), /ctx/);
});

test("Footer row: the context meter remains an eight-cell bar throughout 70-89 columns", () => {
  for (const width of [70, 71, 79, 88, 89]) {
    const line = renderHelmFooter(base, theme256, width, "session");
    assert.equal(ctxGlyphs(line), 8, `ctx bar at width ${width}`);
    assert.ok(visibleWidth(line) <= width);
  }
});

test("Footer row: canonical provider vectors produce a clamped fixed-width budget bar", () => {
  const cases = [
    { values: [90, 100, 60], percent: 83 },
    { values: [100, 100, 100], percent: 100 },
    { values: [0, 0, 0], percent: 0 },
  ];
  for (const { values, percent } of cases) {
    for (const cells of [20, 30]) {
      const ids = ["codex", "claude", "kimi"] as const;
      const result = computeStackedBar(ids.map((id, index) => ({ id, remaining: values[index] })), cells);
      assert.equal(result.totalPercent, percent);
      assert.ok(result.colored.reduce((sum, value) => sum + value, 0) <= cells);
      assert.equal(result.colored.reduce((sum, value) => sum + value, 0) + result.empty, cells);
    }
  }
  const unknown = computeStackedBar([
    { id: "codex", remaining: 50 },
    { id: "claude" },
    { id: "kimi", remaining: 50 },
  ], 30);
  assert.ok(unknown.colored.reduce((sum, value) => sum + value, 0) <= 30);
  assert.equal(unknown.colored.length, 3, "unknown providers retain their stable position");
});

test("Footer row EXTRA invariant: bar allocation never exceeds its width for arbitrary remaining vectors", () => {
  fc.assert(fc.property(
    fc.tuple(
      fc.option(fc.double({ noNaN: false, noDefaultInfinity: false }), { nil: undefined }),
      fc.option(fc.double({ noNaN: false, noDefaultInfinity: false }), { nil: undefined }),
      fc.option(fc.double({ noNaN: false, noDefaultInfinity: false }), { nil: undefined }),
    ),
    fc.integer({ min: 0, max: 300 }),
    (remaining, cells) => {
      const ids = ["codex", "claude", "kimi"] as const;
      const result = computeStackedBar(ids.map((id, index) => ({ id, remaining: remaining[index] })), cells);
      const colored = result.colored.reduce((sum, value) => sum + value, 0);
      assert.ok(Number.isInteger(colored));
      assert.ok(colored >= 0 && colored <= cells, `${colored} colored cells for width ${cells}`);
      assert.ok(result.empty >= 0);
      assert.equal(colored + result.empty, cells);
    },
  ), { numRuns: 1_000 });
});

test("Footer row: paused visible text uses warning yellow exclusively", () => {
  for (const variant of ["session", "fleet"] as const) {
    for (const width of [140, 110, 90, 89, 70, 69, 30]) {
      const line = renderHelmFooter(base, theme256, width, variant, true);
      assert.match(stripAnsi(line), /⏸ paused/);
      const foregrounds = [...line.matchAll(/\x1b\[38;5;(\d+)m/g)].map((match) => Number(match[1]));
      assert.ok(foregrounds.length > 0);
      assert.deepEqual([...new Set(foregrounds)], [179], `${variant} ${width} has no nested normal foreground`);
    }
  }
});

test("Footer row: session and fleet variants expose their contracted strings", () => {
  const session = stripAnsi(renderHelmFooter(base, theme256, 140, "session"));
  assert.match(session, /ctx/);
  assert.match(session, /\$1\.23/);
  assert.doesNotMatch(session, /burn|tok\/min|today/);

  const fleet = stripAnsi(renderHelmFooter(base, theme256, 140, "fleet"));
  assert.match(fleet, /burn/);
  assert.match(fleet, /41k tok\/min/);
  assert.match(fleet, /\$18\.40 today/);
  assert.doesNotMatch(fleet, /ctx/);
});
