import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HelmApp, type TuiLike } from "../src/app.js";
import { MockDataSource, seedCloseout } from "../src/data/mock.js";
import { renderCloseout } from "../src/screens/closeout.js";

const theme = { getColorMode: () => "256color" as const };
const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const strip = (lines: string[]) => lines.map(stripAnsi);
const XTERM = { success: 78, error: 203, bright: 254 };
const hasColor = (line: string, xterm: number) => line.includes(`\x1b[38;5;${xterm}m`);

function fakeTui(rows: number, columns: number): TuiLike {
  return { terminal: { rows, columns }, requestRender() {} };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// ── render safety ─────────────────────────────────────────────────────────────
for (const width of [120, 90, 70, 40, 12, 1]) {
  for (const height of [40, 20, 8, 3, 1, 0]) {
    test(`renderCloseout(${width}×${height}) stays within budget and never throws`, () => {
      let lines: string[] = [];
      assert.doesNotThrow(() => {
        lines = renderCloseout(seedCloseout(), theme, width, height);
      });
      assert.ok(lines.length <= Math.max(0, height), `${lines.length} > ${height}`);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `too wide: ${line}`);
    });
  }
}

test("the big receipt shows the count, added/removed, and actual-vs-estimate cost", () => {
  const lines = renderCloseout(seedCloseout(), theme, 120, 40);
  const receipt = lines.find((l) => stripAnsi(l).includes("17/17 packages"))!;
  assert.ok(hasColor(receipt, XTERM.bright), "the count is bright");
  const text = stripAnsi(receipt);
  assert.match(text, /\+41\.2k/);
  assert.match(text, /−38\.7k/);
  assert.match(text, /611 commits · 100% green/);
  assert.match(text, /\$61\.40 \(est was ~\$40\)/);
});

test("the three summary rows render (your time / interventions / overrun why)", () => {
  const joined = strip(renderCloseout(seedCloseout(), theme, 120, 40)).join("\n");
  assert.match(joined, /your time\s+11 decisions · 24 min/);
  assert.match(joined, /interventions\s+2 escalations/);
  assert.match(joined, /overrun why\s+pkg\/api export-map detour/);
});

test("proposed precedents are NUMBERED (1, 2, …)", () => {
  const closeout = new MockDataSource().getCloseout("g-esm")!;
  const lines = strip(renderCloseout(closeout, theme, 120, 40));
  const numbered = lines.filter((l) => /^\s+\d\s\s\S/.test(l));
  assert.ok(numbered.length >= 2, "at least two numbered precedents render");
  assert.match(numbered[0], /^\s+1\s\s/, "the first precedent is numbered 1");
  assert.match(numbered[1], /^\s+2\s\s/, "the second precedent is numbered 2");
});

test("DECLINED precedents are FILTERED OUT — never re-proposed", () => {
  const closeout = new MockDataSource().getCloseout("g-esm")!;
  // The seed carries a declined `pc-deps` precedent; it must not be proposed.
  assert.ok(!closeout.proposedPrecedents.some((p) => p.declined), "no declined precedent survives");
  assert.ok(!closeout.proposedPrecedents.some((p) => p.id === "pc-deps"), "the declined one is gone");
  const rendered = strip(renderCloseout(closeout, theme, 120, 40)).join("\n");
  assert.doesNotMatch(rendered, /auto-bump all deps nightly/, "the declined text never renders");
  // The active ones survive.
  assert.match(rendered, /export maps are platform-owned/);
  assert.match(rendered, /timing-sensitive tests in pkg\/net/);
});

test("precedents recorded via decide (7b) also flow into the closeout proposal", () => {
  const source = new MockDataSource();
  source.decide("e-export-map", 0); // records a precedent through the SAME store
  const closeout = source.getCloseout("g-esm")!;
  assert.ok(
    closeout.proposedPrecedents.some((p) => p.id.startsWith("p-e-export-map")),
    "a decided precedent is proposed in the closeout",
  );
});

// ── app wiring ─────────────────────────────────────────────────────────────────
/** Reach the closeout via `/` search on a complete goal (no home row for it). */
function intoCloseout(app: HelmApp): void {
  app.handleInput("/");
  for (const ch of "migrate") app.handleInput(ch);
  app.handleInput("\r"); // enter on the goal result → closeout
}

test("a complete-goal search result opens the 7d closeout", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  intoCloseout(app);
  assert.match(stripAnsi(app.render(120)[0]), /goal complete · migrate repo to ESM/);
});

test("`a` asks for confirmation before applying precedents", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  intoCloseout(app);
  assert.ok(!strip(app.render(120)).some((l) => l.includes("applied to CLAUDE.md")));
  app.handleInput("a");
  const lines = strip(app.render(120));
  assert.ok(lines.some((l) => l.includes("confirm apply these precedents")), "a confirmation appears");
  assert.match(lines[0], /goal complete/, "still on the closeout card");
});

test("successful apply hides handed-off rows and stale number keys cannot decline them", async () => {
  const source = new MockDataSource();
  const app = new HelmApp(fakeTui(30, 120), theme, () => {}, source, undefined, () => {});
  intoCloseout(app);
  assert.match(strip(app.render(120)).join("\n"), /export maps are platform-owned/);

  app.handleInput("a");
  app.handleInput("y");
  await flush();

  const rendered = strip(app.render(120)).join("\n");
  assert.match(rendered, /precedents handed off for repository guidance/);
  assert.doesNotMatch(rendered, /export maps are platform-owned/);
  app.handleInput("1");
  const handedOff = source.precedents().find((item) => item.id === "pc-export-map");
  assert.equal(handedOff?.appliesTo, "handoff");
  assert.equal(handedOff?.declined, false);
});

test("failed apply keeps the action available and reports the command failure", async () => {
  class FailingApplySource extends MockDataSource {
    override async execute(command: Parameters<MockDataSource["execute"]>[0]) {
      if (command.type === "goal.applyPrecedents") return { ok: false, message: "handoff failed" };
      return super.execute(command);
    }
  }

  const app = new HelmApp(fakeTui(30, 120), theme, () => {}, new FailingApplySource());
  intoCloseout(app);
  app.handleInput("a");
  app.handleInput("y");
  await flush();

  const rendered = strip(app.render(120)).join("\n");
  assert.match(rendered, /a apply precedents/);
  assert.match(rendered, /handoff failed/);
  assert.doesNotMatch(rendered, /precedents handed off for repository guidance/);
});

test("`x` confirms, archives the goal, and ascends one hop", async () => {
  const source = new MockDataSource();
  const app = new HelmApp(fakeTui(30, 120), theme, () => {}, source);
  intoCloseout(app); // reached via search → the closeout sits above the search screen
  app.handleInput("x");
  assert.equal(source.snapshot().goals.find((g) => g.id === "g-esm")?.phase, "running", "not archived before confirmation");
  app.handleInput("y");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(source.snapshot().goals.find((g) => g.id === "g-esm")?.phase, "archived", "the goal is archived");
  assert.doesNotMatch(stripAnsi(app.render(120)[0]), /goal complete/, "left the closeout card");
  // The descend/ascend spine holds: one more esc reaches home, never a dead end.
  app.handleInput("\x1b");
  assert.match(stripAnsi(app.render(120)[0]), /mission control/, "esc from there lands on home");
});
