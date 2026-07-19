import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HelmApp } from "../src/app.js";
import { MockDataSource, seedSession } from "../src/data/mock.js";
import { renderSession } from "../src/screens/session.js";
import { fakeTui, stripAnsi } from "./helpers/tui.js";

const theme = { getColorMode: () => "256color" as const };
const strip = (lines: string[]) => lines.map(stripAnsi);
const NONE = new Set<number>();

for (const width of [120, 90, 70, 40, 12, 1]) {
  for (const height of [40, 20, 8, 3, 1, 0]) {
    test(`render(${width}×${height}) stays within budget and never throws`, () => {
      let lines: string[] = [];
      assert.doesNotThrow(() => {
        lines = renderSession(seedSession("wt-1"), theme, width, height, 0, NONE);
      });
      assert.ok(lines.length <= height, `${lines.length} lines > height ${height}`);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `line too wide: ${line}`);
    });
  }
}

test("all four verbs render in the fixed 9-char left column", () => {
  const lines = strip(renderSession(seedSession("wt-1"), theme, 120, 40, 0, NONE));
  for (const verb of ["context", "parallel", "edit", "verify"]) {
    const row = lines.find((l) => l.includes(verb));
    assert.ok(row, `${verb} line present`);
    // Left column is the marker (1) + space + verb padded to 9. Find the verb and
    // assert it is followed by padding out to 9 cells before the two-space gap.
    assert.match(row!, new RegExp(`${verb}\\s`), `${verb} sits in a padded column`);
  }
});

test("the context line collapses reads/greps/bash into ONE line", () => {
  const lines = strip(renderSession(seedSession("wt-1"), theme, 120, 40, 0, NONE));
  const context = lines.filter((l) => l.includes("context"));
  assert.equal(context.length, 1, "exactly one context line");
  assert.match(context[0], /9 files/);
});

test("edit rows show +N −N (added success / removed error)", () => {
  const lines = renderSession(seedSession("wt-1"), theme, 120, 40, 0, NONE);
  const ratelimit = lines.find((l) => stripAnsi(l).includes("ratelimit.ts"));
  assert.match(stripAnsi(ratelimit!), /\+48/);
  assert.match(stripAnsi(ratelimit!), /−0/);
  const server = lines.find((l) => stripAnsi(l).includes("server.ts"));
  assert.match(stripAnsi(server!), /\+3 −1/);
});

test("verify is first-class (its own verb, never shown as bash)", () => {
  const lines = strip(renderSession(seedSession("wt-1"), theme, 120, 40, 0, NONE));
  const verify = lines.find((l) => l.includes("pnpm test"));
  assert.ok(verify, "verify line present");
  assert.match(verify!, /verify/);
  assert.doesNotMatch(verify!, /bash/);
});

test("expanding an edit shows the 3-line peek + '… N more · d full diff'", () => {
  const base = strip(renderSession(seedSession("wt-1"), theme, 120, 40, 2, NONE));
  assert.ok(!base.some((l) => l.includes("export function rateLimit")), "collapsed: no peek");

  const expanded = strip(renderSession(seedSession("wt-1"), theme, 120, 40, 2, new Set([2])));
  const peek = expanded.filter((l) => /^\s+\d+ [+−]/.test(l));
  assert.equal(peek.length, 3, "exactly three peek lines with line numbers + signs");
  assert.ok(expanded.some((l) => l.includes("… 45 more") && l.includes("d full diff")), "the more-hint is shown");
});

test("the ▌ marker stays visible when the selected activity line is below the fold", () => {
  const session = seedSession("wt-1");
  const last = session.lines.length - 1;
  const lines = strip(renderSession(session, theme, 120, 3, last, NONE));
  assert.ok(lines.length <= 3);
  assert.ok(lines.some((l) => l.startsWith("▌")), "the selected activity line is windowed into view");
});

test("the header receipts render ✓ build ✓ lint ✓ N tests", () => {
  // Receipts live in the app header; drive the session via HelmApp routing.
  const tui = fakeTui(30, 120);
  const source = new MockDataSource();
  const app = new HelmApp(tui, theme, () => {}, source);
  app.handleInput("j"); // move onto the first workflow
  app.handleInput("j");
  app.handleInput("\r"); // enter → drillin
  app.handleInput("\r"); // enter → session
  const header = stripAnsi(app.render(120)[0]);
  assert.match(header, /✓ build ✓ lint ✓ 142 tests/);
});

test("the turn ends with a claim + 'review diff d · merge m' actions", () => {
  const lines = strip(renderSession(seedSession("wt-1"), theme, 120, 40, 0, NONE));
  const claim = lines.find((l) => l.includes("token-bucket rate limiting"));
  assert.ok(claim, "claim sentence present");
  assert.match(claim!, /review diff d/);
  assert.match(claim!, /merge m/);
});

test("the session footer variant shows ctx (session), not burn (fleet)", () => {
  const tui = fakeTui(30, 120);
  const app = new HelmApp(tui, theme, () => {});
  app.handleInput("j");
  app.handleInput("j");
  app.handleInput("\r"); // drillin
  app.handleInput("\r"); // session
  const lines = app.render(120).map(stripAnsi);
  const footer = lines[lines.length - 1];
  assert.match(footer, /ctx/, "session footer shows the ctx meter");
  assert.doesNotMatch(footer, /burn/, "session footer does not show the fleet burn rate");
});
