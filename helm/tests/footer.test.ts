import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { computeCtxMeter, computeStackedBar, renderHelmFooter } from "../src/footer.js";
import type { HelmFooterModel } from "../src/state/types.js";
import { stripAnsi } from "./helpers/tui.js";

const theme = { getColorMode: () => "256color" as const };

const model: HelmFooterModel = {
  cwd: "~/pi-kit",
  branch: "main",
  providers: [
    { id: "codex", remaining: 90 },
    { id: "claude", remaining: 100 },
    { id: "kimi", remaining: 60 },
  ],
  ctxPercent: 60,
  costUsd: 0.012,
  burnRatePerMin: 41_000,
  spendTodayUsd: 18.4,
  model: "gpt-5.6-sol",
  effort: "auto",
};

test("computeStackedBar splits [90,100,60] into 9/10/6 cells at 83%", () => {
  const { colored, empty, totalPercent, known } = computeStackedBar(model.providers, 30);
  assert.deepEqual(colored, [9, 10, 6]);
  assert.equal(empty, 5);
  assert.equal(totalPercent, 83);
  assert.equal(known, 3);
});

test("computeStackedBar reports 0 known when no provider has a value", () => {
  const { known } = computeStackedBar([{ id: "codex" }, { id: "claude" }, { id: "kimi" }], 30);
  assert.equal(known, 0);
});

test("footer shows '--' when no providers are known", () => {
  const blank: HelmFooterModel = { ...model, providers: [{ id: "codex" }, { id: "claude" }, { id: "kimi" }] };
  assert.match(stripAnsi(renderHelmFooter(blank, theme, 140, "fleet")), /--/);
});

test("computeCtxMeter fills round(percent/100*8) cells", () => {
  assert.deepEqual(computeCtxMeter(60), { filled: 5, empty: 3 });
  assert.deepEqual(computeCtxMeter(0), { filled: 0, empty: 8 });
  assert.deepEqual(computeCtxMeter(100), { filled: 8, empty: 0 });
});

test("session variant renders ctx and $cost", () => {
  const line = stripAnsi(renderHelmFooter(model, theme, 140, "session"));
  assert.match(line, /ctx/);
  assert.match(line, /\$0\.012/);
  assert.doesNotMatch(line, /burn/);
});

test("fleet variant shows burn, tok/min and today", () => {
  const line = stripAnsi(renderHelmFooter(model, theme, 140, "fleet"));
  assert.match(line, /burn/);
  assert.match(line, /tok\/min/);
  assert.match(line, /today/);
  assert.match(line, /41k/);
  assert.match(line, /\$18\.40 today/);
});

for (const variant of ["session", "fleet"] as const) {
  for (const width of [140, 110, 90, 89, 70, 60]) {
    test(`${variant} footer never exceeds width ${width}`, () => {
      const line = renderHelmFooter(model, theme, width, variant);
      assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
    });
  }
}

test("footer degrades cwd below 110 cols, drops middle meter below 70", () => {
  assert.doesNotMatch(stripAnsi(renderHelmFooter(model, theme, 100, "fleet")), /pi-kit/);
  assert.doesNotMatch(stripAnsi(renderHelmFooter(model, theme, 60, "fleet")), /burn/);
});

test("non-positive and tiny widths never throw", () => {
  for (const width of [0, -5, 3]) {
    assert.doesNotThrow(() => renderHelmFooter(model, theme, width, "fleet"));
    assert.ok(visibleWidth(renderHelmFooter(model, theme, width, "fleet")) <= Math.max(0, width));
  }
});

// ── Phase 5: ctrl+p pause tint ────────────────────────────────────────────────
const WARNING_XTERM = 179;
const hasWarning = (line: string) => line.includes(`\x1b[38;5;${WARNING_XTERM}m`);

test("paused footer turns warning-yellow with a '⏸ paused' indicator", () => {
  const paused = renderHelmFooter(model, theme, 140, "fleet", true);
  assert.ok(hasWarning(paused), "the paused footer carries the warning color");
  assert.match(stripAnsi(paused), /⏸ paused/, "the far-left paused indicator is shown");
});

test("an un-paused footer carries NO warning color (so warning cleanly signals pause)", () => {
  for (const variant of ["session", "fleet"] as const) {
    const normal = renderHelmFooter(model, theme, 140, variant, false);
    assert.ok(!hasWarning(normal), `${variant} footer is not warning-colored when un-paused`);
    // The default (no paused arg) matches the explicit false.
    assert.equal(renderHelmFooter(model, theme, 140, variant), normal);
  }
});

for (const variant of ["session", "fleet"] as const) {
  for (const width of [140, 110, 90, 89, 70, 60, 40, 8, 3, 0]) {
    test(`paused ${variant} footer holds the width invariant at ${width}`, () => {
      const line = renderHelmFooter(model, theme, width, variant, true);
      assert.ok(visibleWidth(line) <= Math.max(0, width), `${visibleWidth(line)} > ${width}`);
    });
  }
}
