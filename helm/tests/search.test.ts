import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HelmApp, type TuiLike } from "../src/app.js";
import { MockDataSource } from "../src/data/mock.js";
import { renderSearch } from "../src/screens/search.js";

const theme = { getColorMode: () => "256color" as const };
const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const strip = (lines: string[]) => lines.map(stripAnsi);

function fakeTui(rows: number, columns: number): TuiLike {
  return { terminal: { rows, columns }, requestRender() {} };
}

// ── render safety ─────────────────────────────────────────────────────────────
const source = new MockDataSource();
for (const width of [120, 90, 70, 40, 12, 1]) {
  for (const height of [40, 20, 8, 3, 1, 0]) {
    test(`renderSearch(${width}×${height}) stays within budget and never throws`, () => {
      let lines: string[] = [];
      assert.doesNotThrow(() => {
        lines = renderSearch("esm", source.search("esm"), theme, width, height, 0);
      });
      assert.ok(lines.length <= Math.max(0, height), `${lines.length} > ${height}`);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `too wide: ${line}`);
    });
  }
}

// ── the DataSource.search corpus ────────────────────────────────────────────────
test("search filters the corpus case-insensitively; empty query returns nothing", () => {
  assert.equal(source.search("").length, 0, "no query → no results");
  const esm = source.search("esm");
  assert.ok(esm.length >= 4, "esm spans goals + workflows + a precedent");
  assert.ok(esm.some((r) => r.kind === "workflow" && r.label === "codemod"));
  assert.equal(source.search("ESM").length, esm.length, "case-insensitive");
});

test("search is FOREVER — it finds an ARCHIVED goal", () => {
  const hits = source.search("auth");
  assert.equal(hits.length, 1, "the archived 'auth v2 rollout' is found");
  assert.equal(hits[0].kind, "goal");
  assert.match(hits[0].sublabel ?? "", /archived/);
});

test("search spans decisions, precedents, PRs and loop runs", () => {
  assert.ok(source.search("4312").some((r) => r.kind === "decision"), "a decision hit");
  assert.ok(source.search("conditional").some((r) => r.kind === "precedent"), "a precedent hit");
  assert.ok(source.search("4301").some((r) => r.kind === "pr"), "a PR hit");
  assert.ok(source.search("run #88").some((r) => r.kind === "loopRun"), "a loop-run hit");
});

// ── app wiring ──────────────────────────────────────────────────────────────────
test("`/` opens the search screen from anywhere; typing filters", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  app.handleInput("/");
  assert.match(stripAnsi(app.render(120)[0]), /search/, "the search header");
  for (const ch of "codemod") app.handleInput(ch);
  const lines = strip(app.render(120));
  assert.ok(lines.some((l) => l.includes("❯ codemod")), "the query echoes");
  assert.ok(lines.some((l) => l.includes("codemod") && l.includes("esm migration")), "a filtered result");
});

test("backspace edits the query and re-filters", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  app.handleInput("/");
  for (const ch of "esmx") app.handleInput(ch);
  assert.match(strip(app.render(120)).join("\n"), /no matches/, "'esmx' matches nothing");
  app.handleInput("\x7f"); // backspace → "esm"
  assert.ok(!strip(app.render(120)).some((l) => l.includes("no matches")), "'esm' matches again");
});

test("enter on a workflow result navigates to its 6c drill-in", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  app.handleInput("/");
  for (const ch of "codemod") app.handleInput(ch);
  app.handleInput("\r"); // enter on the codemod workflow result
  const lines = strip(app.render(120));
  assert.match(lines[0], /esm › codemod/, "descended into the codemod drill-in");
});

test("enter on the ARCHIVED goal navigates to its closeout (search reaches archived)", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  app.handleInput("/");
  for (const ch of "auth") app.handleInput(ch);
  app.handleInput("\r");
  assert.match(stripAnsi(app.render(120)[0]), /goal complete · auth v2 rollout/, "opened the archived goal's closeout");
});

test("esc pops the search screen back to where it opened (no dead end)", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  app.handleInput("/");
  app.handleInput("\x1b"); // esc
  assert.match(stripAnsi(app.render(120)[0]), /mission control/, "esc from search lands on home");
});

test("j / k are LITERAL query characters on search (arrows move the selection)", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  app.handleInput("/");
  app.handleInput("j");
  app.handleInput("k");
  assert.ok(strip(app.render(120)).some((l) => l.includes("❯ jk")), "j/k typed into the query");
});

test("down arrow moves the result selection marker", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  app.handleInput("/");
  for (const ch of "esm") app.handleInput(ch);
  const markerLine = () => strip(app.render(120)).findIndex((l) => l.startsWith("▌"));
  const start = markerLine();
  assert.ok(start >= 0, "a result is highlighted");
  app.handleInput("\x1b[B"); // down
  assert.ok(markerLine() > start, "the marker moved down");
});
