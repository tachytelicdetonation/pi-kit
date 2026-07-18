import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HelmApp, type TuiLike } from "../src/app.js";
import { MockDataSource, seedUsageDetail } from "../src/data/mock.js";
import { overlayPopover, usagePopoverLines } from "../src/screens/popover.js";

const theme = { getColorMode: () => "256color" as const };
const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const strip = (lines: string[]) => lines.map(stripAnsi);

function fakeTui(rows: number, columns: number): TuiLike {
  return { terminal: { rows, columns }, requestRender() {} };
}

// ── usagePopoverLines: bounded box with the detail ──────────────────────────────
for (const width of [120, 90, 70, 40, 20, 8, 4, 1, 0]) {
  test(`usagePopoverLines never exceeds width ${width}`, () => {
    let box: string[] = [];
    assert.doesNotThrow(() => {
      box = usagePopoverLines(seedUsageDetail(), theme, width);
    });
    for (const line of box) assert.ok(visibleWidth(line) <= width, `too wide: ${line}`);
  });
}

test("the popover box shows per-provider %, reset dates, spend, and the per-goal split", () => {
  const joined = strip(usagePopoverLines(seedUsageDetail(), theme, 120)).join("\n");
  assert.match(joined, /usage/, "the titled box");
  assert.match(joined, /codex\s+.*90%\s+resets in 3d/);
  assert.match(joined, /claude\s+.*100%\s+resets in 5d/);
  assert.match(joined, /today \$18\.40 · week \$96\.20/);
  assert.match(joined, /migrate repo to ESM \$4\.20/);
});

// ── overlayPopover: composite over the body ─────────────────────────────────────
test("overlayPopover returns the SAME number of lines, all within width", () => {
  const body = new Array(20).fill("x".repeat(50));
  const box = usagePopoverLines(seedUsageDetail(), theme, 80);
  const out = overlayPopover(body, box, 80);
  assert.equal(out.length, body.length, "the body line count is preserved");
  for (const line of out) assert.ok(visibleWidth(line) <= 80, `too wide: ${line}`);
  // The box is centered vertically — the top and bottom body rows are untouched.
  assert.equal(out[0], body[0]);
  assert.equal(out[out.length - 1], body[body.length - 1]);
  // Somewhere in the middle the box border appears.
  assert.ok(strip(out).some((l) => l.includes("usage")), "the box is composited in");
});

test("overlayPopover clips a box taller than the body without overflowing", () => {
  const body = new Array(3).fill("row");
  const box = usagePopoverLines(seedUsageDetail(), theme, 80); // ~12 lines
  const out = overlayPopover(body, box, 80);
  assert.equal(out.length, 3, "never grows beyond the body height");
});

// ── app wiring: the overlay slot (not a stack frame) ────────────────────────────
test("ctrl+u opens the usage popover composited OVER the current body", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  assert.ok(!strip(app.render(120)).some((l) => l.includes("resets in")), "closed by default");
  app.handleInput("\x15"); // ctrl+u
  const lines = strip(app.render(120));
  assert.ok(lines.some((l) => l.includes("usage")), "the popover box is drawn");
  assert.ok(lines.some((l) => l.includes("resets in 3d")), "with the usage detail");
  // The frame is intact: exactly `rows` lines, none wider than the width.
  assert.equal(app.render(120).length, 30);
  for (const line of app.render(120)) assert.ok(visibleWidth(line) <= 120);
});

test("ANY key closes the popover FIRST and is consumed (navigation undisturbed)", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  const header = () => stripAnsi(app.render(120)[0]);
  assert.match(header(), /mission control/);
  app.handleInput("\x15"); // open
  assert.ok(strip(app.render(120)).some((l) => l.includes("resets in")));
  // A key that would normally descend (enter) instead just closes the popover.
  app.handleInput("\r");
  assert.ok(!strip(app.render(120)).some((l) => l.includes("resets in")), "closed");
  assert.match(header(), /mission control/, "still on home — the key did NOT descend");
});

test("the popover does not change the nav stack (esc still one hop to home from deep)", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  app.handleInput("j");
  app.handleInput("j"); // onto a workflow row
  app.handleInput("\r"); // → drill-in
  assert.match(stripAnsi(app.render(120)[0]), /esm › codemod/);
  app.handleInput("\x15"); // open popover over the drill-in
  assert.ok(strip(app.render(120)).some((l) => l.includes("resets in")), "popover over the drill-in");
  app.handleInput("x"); // any key closes it (x is not a drill-in nav key)
  assert.match(stripAnsi(app.render(120)[0]), /esm › codemod/, "still on the drill-in (stack intact)");
  app.handleInput("\x1b"); // esc → home
  assert.match(stripAnsi(app.render(120)[0]), /mission control/);
});

test("ctrl+u opening the popover keeps the exact-rows + footer-last guarantees", () => {
  for (const rows of [30, 12, 5, 3, 2, 1]) {
    const app = new HelmApp(fakeTui(rows, 100), theme, () => {});
    app.handleInput("\x15");
    const lines = app.render(100);
    assert.equal(lines.length, rows, `exact rows at height ${rows}`);
    for (const line of lines) assert.ok(visibleWidth(line) <= 100);
  }
});
