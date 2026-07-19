import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { column, divider, header, spring, treePrefix, windowLines } from "../src/chrome.js";
import { stripAnsi } from "./helpers/tui.js";

const theme = { getColorMode: () => "256color" as const };

for (const width of [120, 90, 70, 40, 10, 1, 0]) {
  test(`spring never exceeds ${width}`, () => {
    const out = spring(theme, "left group here", "right · group", width);
    assert.ok(visibleWidth(out) <= width, `${visibleWidth(out)} > ${width}`);
  });
  test(`header never exceeds ${width}`, () => {
    const out = header(theme, "home", "3 needs you", width);
    assert.ok(visibleWidth(out) <= width);
  });
  test(`divider never exceeds ${width}`, () => {
    assert.ok(visibleWidth(divider(theme, width)) <= width);
  });
}

test("divider is exactly width filled cells", () => {
  assert.equal(visibleWidth(divider(theme, 40)), 40);
  assert.match(stripAnsi(divider(theme, 5)), /^─{5}$/);
});

test("column pads to exactly width (left align)", () => {
  const out = column("hi", 8);
  assert.equal(visibleWidth(out), 8);
  assert.equal(stripAnsi(out), "hi      ");
});

test("column right-aligns by padding the left edge", () => {
  const out = column("42", 6, "right");
  assert.equal(visibleWidth(out), 6);
  assert.equal(stripAnsi(out), "    42");
});

test("column truncates overflow to exactly width", () => {
  const out = column("a very long value", 8);
  assert.equal(visibleWidth(out), 8);
});

test("spring right-aligns the right group with a real gap", () => {
  const out = stripAnsi(spring(theme, "goal alpha", "42%", 30));
  assert.equal(visibleWidth(out), 30);
  assert.ok(out.startsWith("goal alpha"), out);
  assert.ok(out.endsWith("42%"), out);
});

test("spring truncates a long left group, never the right group", () => {
  const longLeft = "an extremely long left-hand context label that will not fit";
  const out = stripAnsi(spring(theme, longLeft, "9 needs you", 30));
  assert.ok(visibleWidth(out) <= 30);
  assert.ok(out.endsWith("9 needs you"), `right group preserved: ${out}`);
});

test("header places 'pi · <context>' on the left", () => {
  const out = stripAnsi(header(theme, "home", "", 40));
  assert.match(out, /^pi · home/);
  assert.ok(visibleWidth(out) <= 40);
});

test("treePrefix builds tree indentation", () => {
  assert.equal(treePrefix(0, false), "");
  assert.equal(treePrefix(1, false), "├ ");
  assert.equal(treePrefix(1, true), "└ ");
  assert.equal(treePrefix(2, true), "│ └ ");
});

// ── windowLines: selection-aware windowing ─────────────────────────────────

const rows = (n: number) => Array.from({ length: n }, (_, i) => `row${i}`);
const stripArr = (ls: string[]) => ls.map(stripAnsi);

test("windowLines returns the lines unchanged when they fit", () => {
  const ls = rows(5);
  assert.deepEqual(windowLines(theme, ls, 0, 10, 40), ls);
  assert.deepEqual(windowLines(theme, ls, 2, 5, 40), ls);
});

test("windowLines returns [] for a non-positive height", () => {
  assert.deepEqual(windowLines(theme, rows(20), 3, 0, 40), []);
});

test("windowLines keeps an anchor near the TOP visible, with only a bottom hint", () => {
  const out = stripArr(windowLines(theme, rows(20), 1, 10, 40));
  assert.ok(out.length <= 10);
  assert.ok(out.includes("row1"), "the anchor row is visible");
  assert.equal(out[0], "row0", "no top hint when the window starts at the first line");
  assert.match(out[out.length - 1], /↓ 11/, "the bottom hint reports the 11 hidden below");
});

test("windowLines keeps a MIDDLE anchor visible, with both hints + correct counts", () => {
  const out = stripArr(windowLines(theme, rows(20), 10, 10, 40));
  assert.ok(out.length <= 10);
  assert.ok(out.includes("row10"), "the anchor row is visible");
  assert.match(out[0], /↑ 7/, "the top hint reports the 7 hidden above");
  assert.match(out[out.length - 1], /↓ 5/, "the bottom hint reports the 5 hidden below");
});

test("windowLines keeps an anchor near the BOTTOM visible, with only a top hint", () => {
  const out = stripArr(windowLines(theme, rows(20), 19, 10, 40));
  assert.ok(out.length <= 10);
  assert.ok(out.includes("row19"), "the anchor row is visible");
  assert.match(out[0], /↑ 11/, "the top hint reports the 11 hidden above");
  assert.equal(out[out.length - 1], "row19", "no bottom hint when the window ends at the last line");
});

test("windowLines keeps EVERY anchor visible and never exceeds height", () => {
  const ls = rows(30);
  for (const h of [1, 2, 3, 7, 15, 29]) {
    for (let a = 0; a < ls.length; a++) {
      const out = stripArr(windowLines(theme, ls, a, h, 40));
      assert.ok(out.length <= h, `length ${out.length} exceeds height ${h}`);
      assert.ok(out.includes(`row${a}`), `anchor row${a} not visible at height ${h}`);
    }
  }
});

test("windowLines clamps an out-of-range anchor defensively", () => {
  const ls = rows(20);
  assert.doesNotThrow(() => windowLines(theme, ls, 999, 10, 40));
  assert.doesNotThrow(() => windowLines(theme, ls, -5, 10, 40));
  assert.ok(stripArr(windowLines(theme, ls, 999, 10, 40)).includes("row19"), "an over-large anchor clamps to the last line");
  assert.ok(stripArr(windowLines(theme, ls, -5, 10, 40)).includes("row0"), "a negative anchor clamps to the first line");
});

test("windowLines hint lines stay ANSI-safe within width", () => {
  for (const w of [40, 12, 5, 1]) {
    const out = windowLines(theme, rows(50), 25, 8, w).map(stripAnsi);
    for (const line of out) {
      if (/[↑↓]/.test(line)) assert.ok(visibleWidth(line) <= w, `hint too wide at ${w}: ${line}`);
    }
  }
});
