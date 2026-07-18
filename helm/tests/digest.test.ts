import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HelmApp, type TuiLike } from "../src/app.js";
import { MockDataSource, seedDigest } from "../src/data/mock.js";
import { renderDigest } from "../src/screens/digest.js";
import type { DigestData } from "../src/state/types.js";

const theme = { getColorMode: () => "256color" as const };
const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const strip = (lines: string[]) => lines.map(stripAnsi);
const XTERM = { success: 78, warning: 179, error: 203 };
const hasColor = (line: string, xterm: number) => line.includes(`\x1b[38;5;${xterm}m`);

function fakeTui(rows: number, columns: number): TuiLike {
  return { terminal: { rows, columns }, requestRender() {} };
}

// ── render safety ───────────────────────────────────────────────────────────
for (const width of [120, 90, 70, 40, 12, 1]) {
  for (const height of [40, 20, 8, 3, 1, 0]) {
    test(`render(${width}×${height}) stays within budget and never throws`, () => {
      let lines: string[] = [];
      assert.doesNotThrow(() => {
        lines = renderDigest(seedDigest(), theme, width, height);
      });
      assert.ok(lines.length <= height, `${lines.length} lines > height ${height}`);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `line too wide: ${line}`);
    });
  }
}

test("the four line types appear IN ORDER with the correct glyphs and colors", () => {
  const lines = renderDigest(seedDigest(), theme, 120, 40);
  const flat = strip(lines);
  const goalIdx = flat.findIndex((l) => l.includes("esm migration"));
  const loopIdx = flat.findIndex((l) => l.includes("gh-issues loop shipped"));
  const decIdx = flat.findIndex((l) => l.includes("decisions queued"));
  const failIdx = flat.findIndex((l) => l.includes("self-caught failure"));
  assert.ok(goalIdx >= 0 && loopIdx >= 0 && decIdx >= 0 && failIdx >= 0, "all four rows present");
  assert.ok(goalIdx < loopIdx && loopIdx < decIdx && decIdx < failIdx, "shipped → loops → decisions → failed order");

  // Glyphs (each row carries a 2-cell gutter before the glyph).
  assert.match(flat[goalIdx].trimStart(), /^✓/, "shipped goals glyph is ✓");
  assert.match(flat[loopIdx].trimStart(), /^✓/, "shipped-by-loops glyph is ✓");
  assert.match(flat[decIdx].trimStart(), /^▲/, "decisions-queued glyph is ▲");
  assert.match(flat[failIdx].trimStart(), /^✕/, "failed-and-handled glyph is ✕");

  // Colors: success / success / warning / error.
  assert.ok(hasColor(lines[goalIdx], XTERM.success), "goals row is success-colored");
  assert.ok(hasColor(lines[loopIdx], XTERM.success), "loops row is success-colored");
  assert.ok(hasColor(lines[decIdx], XTERM.warning), "decisions row is warning-colored");
  assert.ok(hasColor(lines[failIdx], XTERM.error), "failed row is error-colored");
});

test("the decisions-queued row notes nothing is hard-blocked", () => {
  const flat = strip(renderDigest(seedDigest(), theme, 120, 40));
  const dec = flat.find((l) => l.includes("decisions queued"));
  assert.match(dec!, /nothing is blocked-blocked/, "explicitly notes nothing is hard-blocked");
});

test("the footer line has the three key hints + the per-provider quota drain", () => {
  const flat = strip(renderDigest(seedDigest(), theme, 120, 40));
  const footer = flat.find((l) => l.includes("decisions first"));
  assert.ok(footer, "footer line present");
  assert.match(footer!, /d decisions first/);
  assert.match(footer!, /enter mission control/);
  assert.match(footer!, /l full log/);
  assert.match(footer!, /usage overnight:/);
  assert.match(footer!, /codex −9%/);
  assert.match(footer!, /claude −4%/);
  assert.match(footer!, /kimi untouched/, "a 0% provider renders 'untouched'");
});

test("an empty section is omitted but the relative order is preserved", () => {
  const data: DigestData = { ...seedDigest(), shippedByLoops: [], decisionsQueued: [] };
  const flat = strip(renderDigest(data, theme, 120, 40));
  assert.ok(!flat.some((l) => l.includes("gh-issues loop shipped")), "empty loops section omitted");
  assert.ok(!flat.some((l) => l.includes("decisions queued")), "empty decisions section omitted");
  const goalIdx = flat.findIndex((l) => l.includes("esm migration"));
  const failIdx = flat.findIndex((l) => l.includes("self-caught failure"));
  assert.ok(goalIdx >= 0 && failIdx >= 0 && goalIdx < failIdx, "surviving rows keep their order");
});

// ── app wiring (header span + $, d / enter / l keys) ─────────────────────────

test("the app header shows the span + $ spent for the digest", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {}, new MockDataSource({ shouldShowDigest: true }));
  const line0 = stripAnsi(app.render(120)[0]);
  assert.match(line0, /while you were away/);
  assert.match(line0, /9:40 pm → 7:15 am · \$9\.80 spent/);
});

test("'d' on the digest jumps into the decision queue (first escalation card)", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {}, new MockDataSource({ shouldShowDigest: true }));
  app.handleInput("d");
  const line0 = stripAnsi(app.render(120)[0]);
  assert.match(line0, /needs you 1\/2/, "landed on the first needs-you card");
  // esc is one hop to home (triage walk is replace-above-home).
  app.handleInput("\x1b");
  assert.match(stripAnsi(app.render(120)[0]), /mission control/);
});

test("'enter' on the digest goes to mission control (home)", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {}, new MockDataSource({ shouldShowDigest: true }));
  assert.match(stripAnsi(app.render(120)[0]), /while you were away/);
  app.handleInput("\r");
  assert.match(stripAnsi(app.render(120)[0]), /mission control/, "enter lands on home");
});

test("'l' (full log) is a no-op stub that stays on the digest", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {}, new MockDataSource({ shouldShowDigest: true }));
  app.handleInput("l");
  assert.match(stripAnsi(app.render(120)[0]), /while you were away/, "stays on the digest");
});
