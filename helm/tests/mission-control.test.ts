import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderMissionControl } from "../src/screens/mission-control.js";
import { seedState } from "../src/data/mock.js";
import { selectableCount } from "../src/state/selectors.js";
import type { HelmState } from "../src/state/types.js";
import { stripAnsi } from "./helpers/tui.js";

const theme = { getColorMode: () => "256color" as const };
const strip = (lines: string[]) => lines.map(stripAnsi);

/** Index of the currently-highlighted row (marked with the ▌ gutter glyph). */
function selectedLineIndex(lines: string[]): number {
  return strip(lines).findIndex((line) => line.startsWith("▌"));
}

for (const width of [120, 90, 70, 40, 12, 1]) {
  for (const height of [40, 20, 8, 3, 1, 0]) {
    test(`render(${width}×${height}) stays within budget and never throws`, () => {
      let lines: string[] = [];
      assert.doesNotThrow(() => {
        lines = renderMissionControl(seedState(), theme, width, height, 0);
      });
      assert.ok(lines.length <= height, `${lines.length} lines > height ${height}`);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `line too wide: ${line}`);
    });
  }
}

test("the three strata appear in fixed order: needs-you, goals, loops", () => {
  const lines = strip(renderMissionControl(seedState(), theme, 120, 40, 0));
  const needs = lines.findIndex((l) => l.includes("needs you"));
  const goal = lines.findIndex((l) => l.includes("goal migrate repo to ESM"));
  const loops = lines.findIndex((l) => l.includes("loops"));
  assert.ok(needs >= 0 && goal >= 0 && loops >= 0, "all strata present");
  assert.ok(needs < goal, "needs-you before goals");
  assert.ok(goal < loops, "goals before loops");
});

test("the needs-you header count matches the escalation count", () => {
  const state = seedState();
  const lines = strip(renderMissionControl(state, theme, 120, 40, 0));
  const header = lines.find((l) => l.includes("needs you"));
  assert.ok(header);
  assert.match(header!, new RegExp(`\\(${state.escalations.length}\\)`));
});

test("tree glyphs ├ and └ render under goals", () => {
  const lines = strip(renderMissionControl(seedState(), theme, 120, 40, 0));
  assert.ok(lines.some((l) => l.includes("├")), "a mid branch is present");
  assert.ok(lines.some((l) => l.includes("└")), "an end branch is present");
});

test("a purple model tag renders ONLY for lanes whose model differs from main", () => {
  const state: HelmState = {
    ...seedState(),
    mainModel: "gpt-5.6-sol",
    goals: [{ id: "g1", name: "g", phase: "running", progress: 0.5 }],
    workflows: [
      { id: "w-same", goalId: "g1", name: "same", state: "running", summary: "s", modelTag: "gpt-5.6-sol" },
      { id: "w-diff", goalId: "g1", name: "diff", state: "running", summary: "s", modelTag: "opus-mini" },
      { id: "w-none", goalId: "g1", name: "none", state: "running", summary: "s" },
    ],
    escalations: [],
    loops: [],
  };
  const lines = strip(renderMissionControl(state, theme, 120, 40, 0));
  const sameRow = lines.find((l) => l.includes("same"));
  const diffRow = lines.find((l) => l.includes("diff"));
  const noneRow = lines.find((l) => l.includes("none"));
  // The differing lane shows its tag; the same-model and untagged lanes do not.
  assert.match(diffRow!, /opus-mini/);
  assert.doesNotMatch(sameRow!, /gpt-5\.6-sol/);
  assert.doesNotMatch(noneRow!, /opus-mini/);
});

test("the selection highlight moves as the cursor advances (j/k)", () => {
  const state = seedState();
  const at0 = selectedLineIndex(renderMissionControl(state, theme, 120, 40, 0));
  const at1 = selectedLineIndex(renderMissionControl(state, theme, 120, 40, 1));
  const at2 = selectedLineIndex(renderMissionControl(state, theme, 120, 40, 2));
  assert.ok(at0 >= 0 && at1 >= 0 && at2 >= 0, "a row is highlighted at each index");
  assert.ok(at0 < at1, "advancing selection moves the marker down");
  assert.ok(at1 < at2, "and again across the goal boundary");
});

test("the ▌ marker stays visible when the selected row is below the fold", () => {
  // Select the LAST row on a terminal far too short to hold the whole list: the
  // top-clip of old would drop it, but windowing must scroll it into view.
  const state = seedState();
  const last = selectableCount(state) - 1;
  const lines = strip(renderMissionControl(state, theme, 120, 3, last));
  assert.ok(lines.length <= 3);
  assert.ok(lines.some((l) => l.startsWith("▌")), "the selected row is windowed into view");
});

test("overflowing content windows with a '↓ N' hidden-below hint", () => {
  // Selection 0 anchors at the top, so the window fills from the first line and
  // reports the hidden lines below with a dim "↓ N" hint on the last row.
  const lines = strip(renderMissionControl(seedState(), theme, 120, 4, 0));
  assert.ok(lines.length <= 4);
  assert.match(lines[lines.length - 1], /↓ \d+/);
});
