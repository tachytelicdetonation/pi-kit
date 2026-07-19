import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HelmApp } from "../src/app.js";
import { MockDataSource, seedIntake } from "../src/data/mock.js";
import { renderIntake } from "../src/screens/intake.js";
import type { IntakeDraft } from "../src/state/types.js";
import { fakeTui, stripAnsi } from "./helpers/tui.js";

const theme = { getColorMode: () => "256color" as const };
const strip = (lines: string[]) => lines.map(stripAnsi);
const XTERM = { faint: 239, brand: 111, purple: 141 };
const hasColor = (line: string, xterm: number) => line.includes(`\x1b[38;5;${xterm}m`);


/** A DataSource whose intake draft answers can be flipped (openQuestions). */
class IntakeSource extends MockDataSource {
  constructor(private readonly overrides: Partial<IntakeDraft>) {
    super();
  }
  getIntake(id: string): IntakeDraft {
    return { ...seedIntake(id), ...this.overrides };
  }
}

// ── render safety ─────────────────────────────────────────────────────────────
for (const width of [120, 90, 70, 40, 12, 1]) {
  for (const height of [40, 20, 8, 3, 1, 0]) {
    test(`renderIntake(${width}×${height}) stays within budget and never throws`, () => {
      let lines: string[] = [];
      assert.doesNotThrow(() => {
        lines = renderIntake(seedIntake(), theme, width, height);
      });
      assert.ok(lines.length <= Math.max(0, height), `${lines.length} lines > height ${height}`);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `line too wide: ${line}`);
    });
  }
}

test("intake shows the goal request, NUMBERED questions, and the plan block", () => {
  const lines = strip(renderIntake(seedIntake(), theme, 120, 40));
  const joined = lines.join("\n");
  assert.match(joined, /❯ migrate the repo to ESM/, "the request is echoed");
  assert.match(joined, /1 scope: all 8 packages/, "questions are numbered");
  assert.match(joined, /3 merge policy/, "all questions render");
  assert.match(joined, /plan · 3 workflows/, "the plan block heads the workflows");
  assert.match(joined, /codemod\s+4 worktrees/, "a plan workflow row renders name + description");
});

test("a non-default plan workflow model is tagged PURPLE", () => {
  const lines = renderIntake(seedIntake(), theme, 120, 40);
  const docsRow = lines.find((l) => stripAnsi(l).includes("docs"));
  assert.ok(docsRow, "the docs workflow row renders");
  assert.ok(hasColor(docsRow!, XTERM.purple), "opus-mini is the purple model tag");
  assert.match(stripAnsi(docsRow!), /opus-mini/);
});

test("`g go` renders FAINT/disabled while open questions remain, BRAND once resolved", () => {
  const open = renderIntake({ ...seedIntake(), openQuestions: true }, theme, 120, 40);
  const openAction = open.find((l) => stripAnsi(l).includes("go"))!;
  assert.ok(hasColor(openAction, XTERM.faint), "g/go is faint (disabled) with open questions");
  assert.ok(!hasColor(openAction, XTERM.brand) || stripAnsi(openAction).includes("edit"), "not brand-keyed");

  const resolved = renderIntake({ ...seedIntake(), openQuestions: false }, theme, 120, 40);
  const resolvedAction = resolved.find((l) => stripAnsi(l).includes("go"))!;
  assert.ok(hasColor(resolvedAction, XTERM.brand), "g becomes brand (enabled) once resolved");
});

// ── app wiring ─────────────────────────────────────────────────────────────────
test("`n` on home opens the 6a intake (header shows 'new goal')", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  app.handleInput("n");
  const lines = strip(app.render(120));
  assert.match(lines[0], /new goal/, "the intake header breadcrumb");
  assert.ok(lines.some((l) => l.includes("migrate the repo to ESM")), "the intake body renders");
});

test("`g` is a NO-OP while pi has open questions (stays on intake, dim)", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  app.handleInput("n"); // → intake (seed has open questions)
  app.handleInput("g"); // go is disabled — must not navigate
  const lines = strip(app.render(120));
  assert.match(lines[0], /new goal/, "still on the intake card (g did nothing)");
});

test("`g` locks intent and returns home once questions are resolved", async () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {}, new IntakeSource({ openQuestions: false }));
  app.handleInput("n"); // → intake (resolved)
  assert.match(stripAnsi(app.render(120)[0]), /new goal/);
  app.handleInput("g"); // go is enabled — spawns + returns to mission control
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(stripAnsi(app.render(120)[0]), /mission control/, "g descends back to home");
});

test("`x` confirms before discarding the intake", async () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  app.handleInput("n");
  app.handleInput("x");
  assert.match(stripAnsi(app.render(120)[0]), /new goal/, "confirmation leaves the draft visible");
  app.handleInput("y");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(stripAnsi(app.render(120)[0]), /mission control/, "x pops back to home");
});
