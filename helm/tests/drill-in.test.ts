import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderDrillIn } from "../src/screens/drill-in.js";
import { seedCodemodDrillIn } from "../src/data/mock.js";
import { stripAnsi } from "./helpers/tui.js";

const theme = { getColorMode: () => "256color" as const };
const strip = (lines: string[]) => lines.map(stripAnsi);

/** 256-color xterm codes for the semantic palette (as emitted by paint()). */
const XTERM = { warning: 179, purple: 141, success: 78, error: 203 };
const hasColor = (line: string, xterm: number) => line.includes(`\x1b[38;5;${xterm}m`);
const markerIndex = (lines: string[]) => strip(lines).findIndex((l) => l.startsWith("▌"));

for (const width of [120, 90, 70, 40, 12, 1]) {
  for (const height of [40, 20, 8, 3, 1, 0]) {
    test(`render(${width}×${height}) stays within budget and never throws`, () => {
      let lines: string[] = [];
      assert.doesNotThrow(() => {
        lines = renderDrillIn(seedCodemodDrillIn(), theme, width, height, 0);
      });
      assert.ok(lines.length <= height, `${lines.length} lines > height ${height}`);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `line too wide: ${line}`);
    });
  }
}

test("the word 'loops' NEVER appears (internal pipelines are 'lanes')", () => {
  const lines = strip(renderDrillIn(seedCodemodDrillIn(), theme, 120, 40, 0));
  for (const line of lines) assert.doesNotMatch(line, /loops/i, `unexpected "loops" in: ${line}`);
});

test("the burn-down line shows the count, unit and all four labels", () => {
  const lines = strip(renderDrillIn(seedCodemodDrillIn(), theme, 120, 40, 0));
  const burn = lines.find((l) => l.includes("1,204"));
  assert.ok(burn, "burn-down line present");
  assert.match(burn!, /imports left/);
  assert.match(burn!, /from 16,000/);
  assert.match(burn!, /burn 410\/hr/);
  assert.match(burn!, /done ~03:40/);
});

test("worktree rows show fix→review→apply chips with the correct stage colors", () => {
  const lines = renderDrillIn(seedCodemodDrillIn(), theme, 120, 40, 0);
  const row = lines.find((l) => stripAnsi(l).includes("wt-1"));
  assert.ok(row, "wt-1 row present");
  // The chip glyph + the arrow structure.
  assert.match(stripAnsi(row!), /▪ → ▪▪ → ▪/);
  // fix=warning (yellow), review=purple, apply=success (green).
  assert.ok(hasColor(row!, XTERM.warning), "fix chip is warning-colored");
  assert.ok(hasColor(row!, XTERM.purple), "review chip is purple");
  assert.ok(hasColor(row!, XTERM.success), "apply chip is success-colored");
});

test("race-to-green strips render ▊ ticks in red/green with a right status", () => {
  const lines = renderDrillIn(seedCodemodDrillIn(), theme, 120, 40, 0);
  const strip1 = lines.find((l) => stripAnsi(l).includes("pkg/core") && l.includes("▊"));
  assert.ok(strip1, "pkg/core race strip present");
  assert.ok(hasColor(strip1!, XTERM.error), "a red tick is present");
  assert.ok(hasColor(strip1!, XTERM.success), "a green tick is present");
  // Statuses: green (✓ + time, no word), wobbling, red across the three strips.
  assert.match(stripAnsi(strip1!), /✓\s*14:02/, "the green race strip shows the check + time");
  assert.doesNotMatch(stripAnsi(strip1!), /green/, "the race strip drops the 'green' word");
  const flat = strip(lines);
  assert.ok(flat.some((l) => l.includes("pkg/cli") && l.includes("wobbling")));
  assert.ok(flat.some((l) => l.includes("pkg/api") && l.includes("red")));
});

test("the pkg/http worktree (no ticks) gets no race strip", () => {
  const lines = strip(renderDrillIn(seedCodemodDrillIn(), theme, 120, 40, 0));
  const httpRace = lines.find((l) => l.includes("pkg/http") && l.includes("▊"));
  assert.equal(httpRace, undefined, "pkg/http has no race strip");
});

test("a purple model tag renders on the non-default-model worktree", () => {
  const lines = renderDrillIn(seedCodemodDrillIn(), theme, 120, 40, 0);
  const row = lines.find((l) => stripAnsi(l).includes("wt-4"));
  assert.match(stripAnsi(row!), /haiku-5/);
  assert.ok(hasColor(row!, XTERM.purple), "the model tag is purple");
});

test("the selection highlight moves as the worktree cursor advances", () => {
  const detail = seedCodemodDrillIn();
  const at0 = markerIndex(renderDrillIn(detail, theme, 120, 40, 0));
  const at1 = markerIndex(renderDrillIn(detail, theme, 120, 40, 1));
  const at2 = markerIndex(renderDrillIn(detail, theme, 120, 40, 2));
  assert.ok(at0 >= 0 && at1 >= 0 && at2 >= 0, "a row is highlighted at each index");
  assert.ok(at0 < at1 && at1 < at2, "advancing the selection moves the marker down");
});

test("the ▌ marker stays visible when the selected worktree is below the fold", () => {
  const detail = seedCodemodDrillIn();
  const last = detail.worktrees.length - 1;
  const lines = strip(renderDrillIn(detail, theme, 120, 3, last));
  assert.ok(lines.length <= 3);
  assert.ok(lines.some((l) => l.startsWith("▌")), "the selected worktree is windowed into view");
});

test("overflowing content windows with a '↓ N' hidden-below hint", () => {
  // Selection 0 anchors at the top, so the window fills from the first line and
  // reports the hidden lines below with a dim "↓ N" hint on the last row.
  const lines = strip(renderDrillIn(seedCodemodDrillIn(), theme, 120, 4, 0));
  assert.ok(lines.length <= 4);
  assert.match(lines[lines.length - 1], /↓ \d+/);
});
