import assert from "node:assert/strict";
import test from "node:test";
import { seedCloseout, seedLoopDraft, seedState } from "../../src/data/mock.js";
import { renderCloseout } from "../../src/screens/closeout.js";
import { renderLoopBuilder } from "../../src/screens/loop-builder.js";
import { renderMissionControl } from "../../src/screens/mission-control.js";
import { stripLines, theme256 } from "./helpers.js";

function assertOnlyAtomicSegments(line: string, allowed: string[]): void {
  const segments = line.trim().split(" · ").filter(Boolean);
  for (const segment of segments) {
    assert.ok(allowed.includes(segment), `truncated action segment: ${JSON.stringify(segment)}`);
  }
}

test("Rendering contract: closeout hotkey-label pairs drop atomically at narrow widths", () => {
  const allowed = ["a apply precedents", "r full report", "x archive"];
  for (const width of [120, 60, 40, 35, 30, 27, 24]) {
    const lines = stripLines(renderCloseout(seedCloseout(), theme256, width, 80));
    const action = lines.find((line) => /^\s*a(?:\s|$)/.test(line));
    if (action) assertOnlyAtomicSegments(action, allowed);
  }
});

test("Rendering contract: loop-builder hotkey-label pairs drop atomically at narrow widths", () => {
  const allowed = ["t trial run", "e edit", "x discard"];
  for (const width of [120, 60, 40, 35, 30, 27, 24]) {
    const lines = stripLines(renderLoopBuilder(seedLoopDraft(), theme256, width, 80, "idle"));
    const action = lines.find((line) => /^\s*t(?:\s|$)/.test(line));
    if (action) assertOnlyAtomicSegments(action, allowed);
  }
});

test("Rendering contract: a model tag matching the default is suppressed; a differing tag is shown", () => {
  const state = seedState();
  state.escalations = [];
  state.loops = [];
  state.workflows = state.workflows.slice(0, 1).map((workflow) => ({ ...workflow, modelTag: state.mainModel }));
  const same = stripLines(renderMissionControl(state, theme256, 140, 30, 0)).join("\n");
  assert.doesNotMatch(same, new RegExp(state.mainModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  state.workflows = state.workflows.map((workflow) => ({ ...workflow, modelTag: "different-model" }));
  const different = stripLines(renderMissionControl(state, theme256, 140, 30, 0)).join("\n");
  assert.match(different, /different-model/);
});
