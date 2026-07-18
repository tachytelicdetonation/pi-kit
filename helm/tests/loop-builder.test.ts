import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HelmApp, type TuiLike } from "../src/app.js";
import { MockDataSource, seedLoopDraft } from "../src/data/mock.js";
import { renderLoopBuilder } from "../src/screens/loop-builder.js";
import type { TrialState } from "../src/state/types.js";

const theme = { getColorMode: () => "256color" as const };
const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const strip = (lines: string[]) => lines.map(stripAnsi);
const XTERM = { purple: 141, success: 78, error: 203 };
const hasColor = (line: string, xterm: number) => line.includes(`\x1b[38;5;${xterm}m`);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeTui(rows: number, columns: number): TuiLike {
  return { terminal: { rows, columns }, requestRender() {} };
}

/** A MockDataSource whose trial always FAILS (for the failed-trial path). */
class FailingTrialSource extends MockDataSource {
  trialLoop(): Promise<{ passed: boolean; evidence: string[]; ok: boolean }> {
    return Promise.resolve({ passed: false, evidence: ["fixture failure"], ok: false });
  }
}

// ── render safety ─────────────────────────────────────────────────────────────
for (const width of [120, 90, 70, 40, 12, 1]) {
  for (const height of [40, 20, 8, 3, 1, 0]) {
    for (const trial of ["idle", "trialing", "passed", "failed"] as const) {
      test(`renderLoopBuilder(${width}×${height}, ${trial}) stays in budget, never throws`, () => {
        let lines: string[] = [];
        assert.doesNotThrow(() => {
          lines = renderLoopBuilder(seedLoopDraft(), theme, width, height, trial);
        });
        assert.ok(lines.length <= Math.max(0, height), `${lines.length} > ${height}`);
        for (const line of lines) assert.ok(visibleWidth(line) <= width, `too wide: ${line}`);
      });
    }
  }
}

test("the builder structures the loop into trigger / steps / skips / guardrails", () => {
  const lines = strip(renderLoopBuilder(seedLoopDraft(), theme, 120, 40, "idle"));
  const joined = lines.join("\n");
  assert.match(joined, /❯ watch our github issues/, "the prose is echoed");
  assert.match(joined, /trigger\s+new issue labeled bug/);
  assert.match(joined, /steps\s+triage → reproduce/);
  assert.match(joined, /skips\s+feature requests/);
  assert.match(joined, /guardrails\s+never merges · \$3\/day cap · max 3 concurrent/);
});

test("a per-step guardrail model is tagged PURPLE", () => {
  const lines = renderLoopBuilder(seedLoopDraft(), theme, 120, 40, "idle");
  const row = lines.find((l) => stripAnsi(l).includes("guardrails"))!;
  assert.ok(hasColor(row, XTERM.purple), "haiku-5 renders purple");
  assert.match(stripAnsi(row), /haiku-5 for triage step/);
});

test("the action line follows the trial gate (idle → passed → failed)", () => {
  const idle = strip(renderLoopBuilder(seedLoopDraft(), theme, 120, 40, "idle")).join("\n");
  assert.match(idle, /t trial run · e edit · x discard/);

  const passed = strip(renderLoopBuilder(seedLoopDraft(), theme, 120, 40, "passed")).join("\n");
  assert.match(passed, /s accept schedule · r revise · x discard/);

  const failedLines = renderLoopBuilder(seedLoopDraft(), theme, 120, 40, "failed");
  const failedText = strip(failedLines).join("\n");
  assert.match(failedText, /trial failed under review/, "a failure line is shown");
  assert.match(failedText, /t trial run · e edit · x discard/, "the builder reopened (idle action set)");
  const failureLine = failedLines.find((l) => stripAnsi(l).includes("trial failed"))!;
  assert.ok(hasColor(failureLine, XTERM.error), "the failure line is error-colored");
});

// ── app wiring: the trial → s/r/x state machine ────────────────────────────────
function intoBuilder(app: HelmApp): void {
  app.handleInput("N"); // new loop → 7a loop builder
}

test("`N` on home opens the 7a loop builder", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  intoBuilder(app);
  const lines = strip(app.render(120));
  assert.match(lines[0], /new loop/, "the loop-builder header");
  assert.ok(lines.some((l) => l.includes("watch our github issues")), "the builder body renders");
});

test("`t` runs a trial that PASSES, then offers s/r/x; `r` revises back to the builder", async () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  intoBuilder(app);
  app.handleInput("t"); // trial run (mock passes)
  await flush();
  assert.match(strip(app.render(120)).join("\n"), /s accept schedule · r revise · x discard/, "passed → s/r/x");
  app.handleInput("r"); // revise → reopen the builder
  assert.match(strip(app.render(120)).join("\n"), /t trial run · e edit · x discard/, "revise reopens the idle builder");
});

test("`s` (accept schedule) after a passed trial returns to home", async () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  intoBuilder(app);
  app.handleInput("t");
  await flush();
  app.handleInput("s"); // accept schedule → the loop goes live
  await flush();
  assert.match(stripAnsi(app.render(120)[0]), /mission control/, "accepting returns to home");
});

test("a FAILED trial reports and REOPENS the builder (never auto-retries)", async () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {}, new FailingTrialSource());
  intoBuilder(app);
  app.handleInput("t"); // trial run (this source fails)
  await flush();
  const text = strip(app.render(120)).join("\n");
  assert.match(text, /trial failed under review/, "the failure is reported");
  assert.match(text, /t trial run · e edit · x discard/, "the builder reopened (no auto-retry)");
  assert.match(stripAnsi(app.render(120)[0]), /new loop/, "still on the builder, not scheduled");
});

test("`x` confirms before discarding the builder", async () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  intoBuilder(app);
  app.handleInput("x");
  assert.match(stripAnsi(app.render(120)[0]), /new loop/, "confirmation leaves the builder visible");
  app.handleInput("y");
  await flush();
  assert.match(stripAnsi(app.render(120)[0]), /mission control/, "x pops back to home");
});

test("a home LOOP row opens its 7a builder via enter", () => {
  const app = new HelmApp(fakeTui(40, 120), theme, () => {});
  // Selectable order: 2 escalations, then 4 workflows, then 3 loops. Step to the
  // first loop row (index 6) and descend.
  for (let i = 0; i < 6; i++) app.handleInput("j");
  app.handleInput("\r");
  assert.match(stripAnsi(app.render(120)[0]), /new loop/, "enter on a loop row opens the builder");
});

test("trialState renders default 'idle' when no explicit state is passed", () => {
  const idle: TrialState = "idle";
  const a = strip(renderLoopBuilder(seedLoopDraft(), theme, 120, 40));
  const b = strip(renderLoopBuilder(seedLoopDraft(), theme, 120, 40, idle));
  assert.deepEqual(a, b);
});

test("guardrails per-step model survives narrow widths (wrapped, not truncated)", () => {
  // seedLoopDraft's guardrailModel is "haiku-5 for triage"; at a narrow width the
  // row must WRAP and keep the model, never clip it away (regression: P5 review).
  const narrow = strip(renderLoopBuilder(seedLoopDraft(), theme, 60, 40));
  const joined = narrow.join("\n");
  assert.match(joined, /haiku-5/, "the per-step guardrail model is preserved when wrapped");
  for (const line of narrow) assert.ok(visibleWidth(line) <= 60, `line too wide: ${line}`);
});

test("'e' edit on the loop builder is consumed, not typed into the pi prompt", () => {
  const app = new HelmApp(fakeTui(40, 120), theme, () => {});
  intoBuilder(app);
  app.handleInput("e");
  const promptLine = strip(app.render(120)).find((l) => l.includes("❯"));
  assert.ok(promptLine);
  assert.doesNotMatch(promptLine!, /❯ e/, "e is an action key, never a prompt character");
});
