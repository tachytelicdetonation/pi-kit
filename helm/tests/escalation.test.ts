import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HelmApp, type TuiLike } from "../src/app.js";
import { MockDataSource, seedExportMapEscalation } from "../src/data/mock.js";
import { renderEscalation } from "../src/screens/escalation.js";

const theme = { getColorMode: () => "256color" as const };
const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const strip = (lines: string[]) => lines.map(stripAnsi);
const XTERM = { success: 78, error: 203, brand: 111, warning: 179 };
const hasColor = (line: string, xterm: number) => line.includes(`\x1b[38;5;${xterm}m`);

function fakeTui(rows: number, columns: number): TuiLike {
  return { terminal: { rows, columns }, requestRender() {} };
}

// ── render safety ───────────────────────────────────────────────────────────
for (const width of [120, 90, 70, 40, 12, 1]) {
  for (const height of [40, 20, 8, 3, 1, 0]) {
    test(`render(${width}×${height}) stays within budget and never throws`, () => {
      let lines: string[] = [];
      assert.doesNotThrow(() => {
        lines = renderEscalation(seedExportMapEscalation(), theme, width, height);
      });
      assert.ok(lines.length <= height, `${lines.length} lines > height ${height}`);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `line too wide: ${line}`);
    });
  }
}

test("the body is a ONE-sentence problem statement (wrapped, single sentence)", () => {
  const lines = strip(renderEscalation(seedExportMapEscalation(), theme, 120, 40));
  const joined = lines.join(" ");
  assert.match(joined, /pkg\/api's ESM rewrite requires touching exports\.map\.json/);
  // A single sentence: no mid-sentence period-space break (dots inside the
  // filename don't count — they are not followed by a space).
  const problem = seedExportMapEscalation().problem;
  const sentenceBreaks = (problem.match(/\.\s/g) ?? []).length;
  assert.equal(sentenceBreaks, 0, "the problem statement is a single sentence");
});

test("the evidence block is present and SMALL (never the full file)", () => {
  const esc = seedExportMapEscalation();
  const lines = strip(renderEscalation(esc, theme, 120, 40));
  const framed = lines.filter((l) => l.trimStart().startsWith("│"));
  assert.equal(framed.length, esc.evidence.length, "exactly the seeded evidence lines are framed");
  assert.ok(framed.length <= 4, "the evidence block is minimal (<= 4 lines)");
  assert.ok(lines.some((l) => l.includes('"./dist/api.cjs"')), "the conflicting line is shown");
  assert.ok(lines.some((l) => l.includes('"./dist/api.mjs"')), "the migration line is shown");
});

test("options are numbered with EXACTLY ONE recommended highlighted green", () => {
  const lines = renderEscalation(seedExportMapEscalation(), theme, 120, 40);
  const optionRows = lines.filter((l) => /^[1-9]\s\s\S/.test(stripAnsi(l).trimStart()));
  assert.equal(optionRows.length, 3, "three numbered options render");
  const greenRows = optionRows.filter((l) => hasColor(l, XTERM.success));
  assert.equal(greenRows.length, 1, "exactly one option is success-colored");
  assert.match(stripAnsi(greenRows[0]).trimStart(), /^1\s/, "the recommended (green) option is #1");
  // The other options are NOT success-colored.
  const others = optionRows.filter((l) => !hasColor(l, XTERM.success));
  assert.equal(others.length, 2);
});

test("the key-hint line advertises 1-N decide · ? ask · enter open", () => {
  const lines = strip(renderEscalation(seedExportMapEscalation(), theme, 120, 40));
  const hint = lines.find((l) => l.includes("decide"));
  assert.ok(hint, "hint line present");
  assert.match(hint!, /1-3 decide/);
  assert.match(hint!, /\? ask pi more/);
  assert.match(hint!, /enter open full session/);
});

test("an auto-resolved escalation leads with a green precedent flag", () => {
  const esc = { ...seedExportMapEscalation(), precedentNote: "auto-resolved by precedent: keep both" };
  const lines = renderEscalation(esc, theme, 120, 40);
  const flag = lines.find((l) => stripAnsi(l).includes("auto-resolved by precedent"));
  assert.ok(flag, "the auto-resolved flag renders");
  assert.ok(hasColor(flag!, XTERM.success), "the flag is success-colored");
});

// ── app wiring (header, [ ] cycle, 1-9 decide, enter session) ────────────────

/** Open the first needs-you card from home (enter on the first escalation row). */
function intoCard(app: HelmApp) {
  app.handleInput("\r"); // selection starts on the first needs-you row → its card
}

test("the app header shows 'blocked N min' + the idle note for the card", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  intoCard(app);
  const line0 = stripAnsi(app.render(120)[0]);
  assert.match(line0, /needs you 1\/2 · esm › codemod/);
  assert.match(line0, /blocked 12 min · wt-3 idle while you decide/);
});

test("'[' / ']' cycle prev/next escalation IN PLACE (stack stays [home, card])", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  intoCard(app);
  const header = () => stripAnsi(app.render(120)[0]);
  assert.match(header(), /needs you 1\/2/);
  app.handleInput("]");
  assert.match(header(), /needs you 2\/2/, "] advances to the next card");
  app.handleInput("]");
  assert.match(header(), /needs you 1\/2/, "] wraps back to the first");
  app.handleInput("[");
  assert.match(header(), /needs you 2\/2/, "[ goes back (wraps)");
  // esc is one hop to home — proof the cycle never grew the stack.
  app.handleInput("\x1b");
  assert.match(header(), /mission control/, "esc from a cycled card lands on home");
});

// The card advance after a decision awaits the (possibly async) DataSource, so
// flush pending microtasks before asserting the post-decide stack/render.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("'1'-'9' decides the Nth option, recording a precedent with the right decision", async () => {
  const source = new MockDataSource();
  const app = new HelmApp(fakeTui(30, 120), theme, () => {}, source);
  intoCard(app);
  assert.equal(source.precedents().length, 0);
  app.handleInput("2"); // choose option 2 on the export-map card
  const precedents = source.precedents();
  assert.equal(precedents.length, 1, "a precedent was recorded");
  assert.match(precedents[0].decision, /skip pkg\/api's export map/, "records the chosen option text");
  assert.equal(precedents[0].rationale, "operator override", "option 2 is not the recommendation");
  // The decided escalation is gone; the card advanced to the remaining one.
  assert.ok(!source.listEscalations().some((e) => e.id === "e-export-map"));
  await flush();
  assert.match(stripAnsi(app.render(120)[0]), /needs you 1\/1/, "advanced to the next unresolved card");
});

test("deciding the last escalation returns to home (no dead end)", async () => {
  const source = new MockDataSource();
  const app = new HelmApp(fakeTui(30, 120), theme, () => {}, source);
  intoCard(app);
  app.handleInput("1"); // decide the first card
  await flush();
  app.handleInput("1"); // decide the (now only) card
  await flush();
  assert.equal(source.listEscalations().length, 0);
  assert.match(stripAnsi(app.render(120)[0]), /mission control/, "empty queue lands on home");
});

test("enter on a card opens the full 4a session (its associated worktree)", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  intoCard(app);
  app.handleInput("\r"); // enter → session
  const lines = strip(app.render(120));
  assert.match(lines[0], /task:/, "descended into a session view");
  assert.ok(lines.some((l) => l.includes("add per-user rate limiting")), "session transcript present");
});

test("'?' appends a follow-up stub line without leaving the card", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  intoCard(app);
  assert.ok(!strip(app.render(120)).some((l) => l.includes("follow-up")));
  app.handleInput("?");
  const lines = strip(app.render(120));
  assert.ok(lines.some((l) => /follow-up/.test(l)), "a follow-up stub line appears");
  assert.match(lines[0], /needs you 1\/2/, "still on the card (a no-op stub)");
});
