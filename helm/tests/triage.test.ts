import assert from "node:assert/strict";
import test from "node:test";
import { HelmApp, type TuiLike } from "../src/app.js";
import { MockDataSource } from "../src/data/mock.js";
import { nextNeedsYouId } from "../src/state/selectors.js";
import { seedState } from "../src/data/mock.js";

const theme = { getColorMode: () => "256color" as const };
const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

function fakeTui(rows: number, columns: number): TuiLike {
  return { terminal: { rows, columns }, requestRender() {} };
}

const header = (app: HelmApp) => stripAnsi(app.render(120)[0]);

/** Navigate home → drillin → session (three-deep) to prove tab replaces above home. */
function intoSession(app: HelmApp) {
  app.handleInput("j"); // past the two escalation rows
  app.handleInput("j");
  app.handleInput("\r"); // → drillin
  app.handleInput("\r"); // → session
}

// ── the selector ────────────────────────────────────────────────────────────

test("nextNeedsYouId: first item with no current, next (wrapping) from a current", () => {
  const state = seedState();
  const [first, second] = state.escalations;
  assert.equal(nextNeedsYouId(state), first.id, "no current → first");
  assert.equal(nextNeedsYouId(state, first.id), second.id, "current → next");
  assert.equal(nextNeedsYouId(state, second.id), first.id, "wraps at the end");
  assert.equal(nextNeedsYouId(state, "unknown"), first.id, "unknown current → first");
  assert.equal(nextNeedsYouId({ ...state, escalations: [] }, first.id), undefined, "empty queue → undefined");
});

// ── the tab triage walk (global) ─────────────────────────────────────────────

test("tab from HOME jumps to the first needs-you card as [home, escalation]", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  app.handleInput("\t");
  assert.match(header(app), /needs you 1\/2/, "on the first card");
  app.handleInput("\x1b");
  assert.match(header(app), /mission control/, "esc is ONE hop to home");
});

test("tab from a DEEP screen (session) resets to [home, escalation] — never grows the stack", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  intoSession(app);
  assert.match(header(app), /task:/, "three-deep in a session");
  app.handleInput("\t");
  assert.match(header(app), /needs you 1\/2/, "tab jumped to the first card");
  app.handleInput("\x1b");
  assert.match(header(app), /mission control/, "esc from there is a single hop to home");
});

test("tab from an escalation advances to the NEXT needs-you item, wrapping", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  app.handleInput("\t");
  assert.match(header(app), /needs you 1\/2/);
  app.handleInput("\t");
  assert.match(header(app), /needs you 2\/2/, "tab cycles to the next item");
  app.handleInput("\t");
  assert.match(header(app), /needs you 1\/2/, "and wraps back to the first");
});

test("tab cycles through EVERY escalation in the queue", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {});
  const seen = new Set<string>();
  for (let i = 0; i < 2; i++) {
    app.handleInput("\t");
    seen.add(header(app).match(/needs you (\d)\/2/)?.[1] ?? "");
  }
  assert.deepEqual([...seen].sort(), ["1", "2"], "both queue positions were reached");
});

test("tab with an EMPTY needs-you queue is a no-op (stays put, never dead-ends)", () => {
  const source = new MockDataSource();
  source.decide("e-export-map", 0);
  source.decide("e-api-rename", 0);
  const app = new HelmApp(fakeTui(30, 120), theme, () => {}, source);
  assert.match(header(app), /mission control/);
  app.handleInput("\t");
  assert.match(header(app), /mission control/, "no escalations → tab stays on home");
});

// ── digest-on-launch wiring ──────────────────────────────────────────────────

test("initial stack is [home, digest] when shouldShowDigest() is true", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {}, new MockDataSource({ shouldShowDigest: true }));
  assert.match(header(app), /while you were away/, "the digest is shown on launch");
  app.handleInput("\x1b"); // esc from the digest
  assert.match(header(app), /mission control/, "esc lands on home (stack was [home, digest])");
});

test("initial stack is [home] when shouldShowDigest() is false (the default)", () => {
  const app = new HelmApp(fakeTui(30, 120), theme, () => {}, new MockDataSource());
  assert.match(header(app), /mission control/, "no digest → straight to home");
});
