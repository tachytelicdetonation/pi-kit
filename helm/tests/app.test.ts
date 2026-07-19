import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HelmApp, type TuiLike } from "../src/app.js";
import { MockDataSource } from "../src/data/mock.js";
import type { DataSource } from "../src/data/source.js";
import { flush, stripAnsi, trackedTui as fakeTui } from "./helpers/tui.js";

const theme = { getColorMode: () => "256color" as const };

for (const rows of [30, 24, 18, 5, 4, 3]) {
  test(`render emits exactly ${rows} lines, each within width`, () => {
    const width = 100;
    const { tui } = fakeTui(rows, width);
    const app = new HelmApp(tui, theme, () => {});
    const lines = app.render(width);
    assert.equal(lines.length, rows, `expected ${rows} lines, got ${lines.length}`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `line too wide: ${line}`);
  });
}

test("the fleet footer is the last line", () => {
  const { tui } = fakeTui(20, 120);
  const app = new HelmApp(tui, theme, () => {});
  const lines = app.render(120);
  // The seeded fleet footer shows the burn rate, spend-today and the model.
  const last = stripAnsi(lines[lines.length - 1]);
  assert.match(last, /burn/);
  assert.match(last, /today/);
  assert.match(last, /gpt-5\.6-sol/);
});

test("render reads terminal.rows live (not snapshotted in the constructor)", () => {
  const { tui } = fakeTui(20, 80);
  const app = new HelmApp(tui, theme, () => {});
  assert.equal(app.render(80).length, 20);
  tui.terminal.rows = 12;
  assert.equal(app.render(80).length, 12);
});

test("a printable char appears in the prompt line after handleInput", () => {
  const { tui, renders } = fakeTui(20, 80);
  const app = new HelmApp(tui, theme, () => {});
  app.handleInput("h");
  app.handleInput("i");
  assert.ok(renders() >= 2, "each keystroke requests a render");
  const lines = app.render(80).map(stripAnsi);
  const promptLine = lines.find((l) => l.includes("❯"));
  assert.ok(promptLine, "prompt line present");
  assert.match(promptLine!, /❯ hi/);
});

test("esc clears a non-empty prompt buffer", () => {
  const { tui } = fakeTui(20, 80);
  const app = new HelmApp(tui, theme, () => {});
  app.handleInput("x");
  app.handleInput("y");
  app.handleInput("\x1b"); // esc
  const promptLine = app.render(80).map(stripAnsi).find((l) => l.includes("❯"));
  assert.ok(promptLine);
  assert.doesNotMatch(promptLine!, /xy/);
});

test("backspace deletes the last buffered char", () => {
  const { tui } = fakeTui(20, 80);
  const app = new HelmApp(tui, theme, () => {});
  for (const ch of "abc") app.handleInput(ch);
  app.handleInput("\x7f");
  const promptLine = app.render(80).map(stripAnsi).find((l) => l.includes("❯"));
  assert.match(promptLine!, /❯ ab$/);
});

test("esc at home with an empty buffer never quits", () => {
  const { tui } = fakeTui(20, 80);
  let closed = false;
  const app = new HelmApp(tui, theme, () => {
    closed = true;
  });
  app.handleInput("\x1b");
  assert.equal(closed, false);
});

test("'q' with an empty buffer types to the prompt; ctrl+q exits via done()", () => {
  const { tui } = fakeTui(20, 80);
  let closed = false;
  const app = new HelmApp(tui, theme, () => {
    closed = true;
  });
  app.handleInput("q");
  assert.equal(closed, false);
  const promptLine = app.render(80).map(stripAnsi).find((line) => line.includes("❯"));
  assert.match(promptLine!, /❯ q$/);
  app.handleInput("\x11");
  assert.equal(closed, true);
});

test("'?' is help on an empty prompt (not typed) but literal once a prompt is open", () => {
  const { tui } = fakeTui(20, 80);
  const app = new HelmApp(tui, theme, () => {});
  // Empty buffer: '?' is the help key, so it must NOT appear in the prompt.
  app.handleInput("?");
  let promptLine = app.render(80).map(stripAnsi).find((l) => l.includes("❯"));
  assert.doesNotMatch(promptLine!, /\?/);
  // Once typing, '?' is a literal character in the prompt.
  app.handleInput("w");
  app.handleInput("?");
  promptLine = app.render(80).map(stripAnsi).find((l) => l.includes("❯"));
  assert.match(promptLine!, /❯ w\?/);
});

test("j / k move the selection marker over the selectable rows", () => {
  const { tui } = fakeTui(30, 120);
  const app = new HelmApp(tui, theme, () => {});
  const markerLine = () => app.render(120).map(stripAnsi).findIndex((l) => l.startsWith("▌"));
  const start = markerLine();
  assert.ok(start >= 0, "a row is highlighted initially");
  app.handleInput("j");
  const down = markerLine();
  assert.ok(down > start, "j moves the marker down");
  app.handleInput("k");
  assert.equal(markerLine(), start, "k moves it back up");
  // k at the top clamps (never negative / off-screen).
  app.handleInput("k");
  assert.equal(markerLine(), start, "k clamps at the top");
});

test("p on a workflow row pauses that lane via the data source", () => {
  const { tui } = fakeTui(30, 120);
  const source = new MockDataSource();
  const app = new HelmApp(tui, theme, () => {}, source);
  // Two escalations and the first goal precede its workflows.
  app.handleInput("j");
  app.handleInput("j");
  app.handleInput("j");
  app.handleInput("p");
  const codemod = source.snapshot().workflows.find((w) => w.id === "w-codemod");
  assert.equal(codemod?.state, "paused");
});

test("ctrl+p toggles pause-all on the data source", () => {
  const { tui } = fakeTui(20, 80);
  const source = new MockDataSource();
  const app = new HelmApp(tui, theme, () => {}, source);
  assert.equal(source.snapshot().pausedAll, false);
  app.handleInput("\x10");
  assert.equal(source.snapshot().pausedAll, true);
  app.handleInput("\x10");
  assert.equal(source.snapshot().pausedAll, false);
});

test("tiny and zero terminals never throw and never overflow", () => {
  for (const rows of [2, 1, 0]) {
    const { tui } = fakeTui(rows, 40);
    const app = new HelmApp(tui, theme, () => {});
    assert.doesNotThrow(() => {
      const lines = app.render(40);
      assert.equal(lines.length, rows);
      for (const line of lines) assert.ok(visibleWidth(line) <= 40);
    });
  }
});

// ── Phase 3: the descend spine (enter descends / esc ascends) ──────────────

/** Navigate home → drillin (selecting the first workflow row) → session. */
function intoSession(app: HelmApp) {
  app.handleInput("j"); // two escalations and the goal precede the workflows
  app.handleInput("j");
  app.handleInput("j"); // now on the first workflow (w-codemod)
  app.handleInput("\r"); // enter → drillin
  app.handleInput("\r"); // enter → session (first worktree)
}

test("enter on a 6b workflow row pushes the 6c drill-in", () => {
  const { tui } = fakeTui(30, 120);
  const app = new HelmApp(tui, theme, () => {});
  app.handleInput("j");
  app.handleInput("j");
  app.handleInput("j"); // onto w-codemod
  app.handleInput("\r");
  const lines = app.render(120).map(stripAnsi);
  // Header breadcrumb + fleet counts change to the drill-in.
  assert.match(lines[0], /esm › codemod/);
  assert.match(lines[0], /16 lanes × 4 worktrees · 64 agents/);
  // Body is the 6c drill-in.
  assert.ok(lines.some((l) => l.includes("imports left")), "burn-down present");
  assert.ok(lines.some((l) => l.includes("wt-1")), "worktree rows present");
});

test("enter on a 6c worktree row pushes the 4a session", () => {
  const { tui } = fakeTui(30, 120);
  const app = new HelmApp(tui, theme, () => {});
  intoSession(app);
  const lines = app.render(120).map(stripAnsi);
  assert.match(lines[0], /task: add rate limiting to \/api/);
  assert.ok(lines.some((l) => l.includes("add per-user rate limiting")), "prompt echo present");
  assert.ok(lines.some((l) => l.includes("pnpm test")), "verify activity present");
});

test("esc ascends: session → drill-in → home, then stays at home", () => {
  const { tui } = fakeTui(30, 120);
  const app = new HelmApp(tui, theme, () => {});
  intoSession(app);
  // esc → back to 6c drill-in
  app.handleInput("\x1b");
  let lines = app.render(120).map(stripAnsi);
  assert.match(lines[0], /esm › codemod/, "back at the drill-in");
  // esc → back to 6b home
  app.handleInput("\x1b");
  lines = app.render(120).map(stripAnsi);
  assert.match(lines[0], /mission control/, "back at home");
  // esc at home is a no-op (never quits, stays at home).
  app.handleInput("\x1b");
  lines = app.render(120).map(stripAnsi);
  assert.match(lines[0], /mission control/, "esc at home stays at home");
});

test("esc at home with an empty buffer never quits (the descend spine)", () => {
  const { tui } = fakeTui(20, 80);
  let closed = false;
  const app = new HelmApp(tui, theme, () => {
    closed = true;
  });
  app.handleInput("\x1b");
  assert.equal(closed, false);
});

test("j/k selection is per-screen and clamps independently", () => {
  const { tui } = fakeTui(30, 120);
  const app = new HelmApp(tui, theme, () => {});
  const markerLine = () => app.render(120).map(stripAnsi).findIndex((l) => l.startsWith("▌"));

  // Advance the HOME selection, then drill into the drill-in.
  app.handleInput("j");
  app.handleInput("j");
  app.handleInput("j"); // home selection = 3 (first workflow)
  const homeMarker = markerLine();
  app.handleInput("\r"); // → drillin, its OWN selection starts at 0
  const drillStart = markerLine();
  app.handleInput("j"); // drillin selection = 1
  const drillDown = markerLine();
  assert.ok(drillDown > drillStart, "j moves the drill-in selection");

  // Pop back home: the home selection is preserved (per-screen).
  app.handleInput("\x1b");
  assert.equal(markerLine(), homeMarker, "home selection preserved across the round-trip");
});

test("j clamps at the bottom of the drill-in worktree list", () => {
  const { tui } = fakeTui(30, 120);
  const app = new HelmApp(tui, theme, () => {});
  app.handleInput("j");
  app.handleInput("j");
  app.handleInput("j");
  app.handleInput("\r"); // → drillin (4 worktrees)
  const markerLine = () => app.render(120).map(stripAnsi).findIndex((l) => l.startsWith("▌"));
  for (let i = 0; i < 10; i++) app.handleInput("j");
  const bottom = markerLine();
  app.handleInput("j");
  assert.equal(markerLine(), bottom, "j clamps at the last worktree");
});

test("a stored selection past a shrunk list clamps at read time (render + enter safe)", () => {
  // A DataSource whose drill-in worktree list can shrink between visits, so a
  // stale stored selection index would otherwise highlight nothing / no-op enter.
  const base = new MockDataSource();
  let shrink = false;
  const source: DataSource = {
    snapshot: () => base.snapshot(),
    subscribe: (cb: () => void) => base.subscribe(cb),
    pauseAll: () => base.pauseAll(),
    resumeAll: () => base.resumeAll(),
    pauseWorkflow: (id: string) => base.pauseWorkflow(id),
    getDrillIn: (id: string) => {
      const detail = base.getDrillIn(id);
      return detail && shrink ? { ...detail, worktrees: detail.worktrees.slice(0, 1) } : detail;
    },
    listLoopRuns: (id: string) => base.listLoopRuns(id),
    getSession: (id: string) => base.getSession(id),
    decide: (escalationId: string, option: number) => base.decide(escalationId, option),
    getEscalation: (id: string) => base.getEscalation(id),
    listEscalations: () => base.listEscalations(),
    precedents: () => base.precedents(),
    declinePrecedent: (id: string) => base.declinePrecedent(id),
    setPrecedentDeclined: (id: string, declined: boolean) => base.setPrecedentDeclined(id, declined),
    answerEscalationFollowUp: (id: string, at: number, answer: string) => base.answerEscalationFollowUp(id, at, answer),
    getDigest: () => base.getDigest(),
    shouldShowDigest: () => base.shouldShowDigest(),
    getIntake: (id: string) => base.getIntake(id),
    getLoopDraft: (id: string) => base.getLoopDraft(id),
    getCloseout: (id: string) => base.getCloseout(id),
    getUsageDetail: () => base.getUsageDetail(),
    addEscalation: (escalation) => base.addEscalation(escalation),
    archiveGoal: (id: string) => base.archiveGoal(id),
    trialLoop: (id: string) => base.trialLoop(id),
    search: (query: string) => base.search(query),
    execute: (command) => base.execute(command),
  };
  const { tui } = fakeTui(30, 120);
  const app = new HelmApp(tui, theme, () => {}, source);
  app.handleInput("j");
  app.handleInput("j");
  app.handleInput("j");
  app.handleInput("\r"); // → drillin (4 worktrees)
  for (let i = 0; i < 3; i++) app.handleInput("j"); // select the last worktree (index 3)

  // Shrink the list to a single worktree; the stored selection (3) is now stale.
  shrink = true;
  const markerLine = () => app.render(120).map(stripAnsi).findIndex((l) => l.startsWith("▌"));
  assert.doesNotThrow(() => app.render(120));
  assert.ok(markerLine() >= 0, "an in-range row is highlighted after the list shrinks");
  // enter must still target a valid worktree (the clamped index 0), not dead-end.
  assert.doesNotThrow(() => app.handleInput("\r"));
  const lines = app.render(120).map(stripAnsi);
  assert.match(lines[0], /task:/, "enter descended into a valid session");
});

test("o toggles activity-line expansion only on the session screen", () => {
  const { tui } = fakeTui(30, 120);
  const app = new HelmApp(tui, theme, () => {});
  intoSession(app);
  // Move onto the expandable ratelimit edit (line index 2).
  app.handleInput("j");
  app.handleInput("j");
  const peekVisible = () => app.render(120).map(stripAnsi).some((l) => l.includes("export function rateLimit"));
  assert.equal(peekVisible(), false, "collapsed by default");
  app.handleInput("o");
  assert.equal(peekVisible(), true, "o expands the selected edit");
  app.handleInput("o");
  assert.equal(peekVisible(), false, "o toggles it back closed");
});

test("handleInput swallows errors by closing the app, never leaving it stuck", () => {
  const brokenTui: TuiLike = {
    terminal: { rows: 20, columns: 80 },
    requestRender() {
      throw new Error("render pipe broke");
    },
  };
  let closed = false;
  const app = new HelmApp(brokenTui, theme, () => {
    closed = true;
  });
  // A printable triggers requestRender(), which throws — the app must close.
  assert.doesNotThrow(() => app.handleInput("a"));
  assert.equal(closed, true);
});

test("ctrl+u popover closes on ANY input, including a byte that decodes to no key", () => {
  const { tui } = fakeTui(30, 120);
  const app = new HelmApp(tui, theme, () => {});
  app.handleInput("\x15"); // ctrl+u opens the popover
  assert.ok(app.render(120).some((l) => stripAnsi(l).includes("usage")), "popover open");
  app.handleInput("\x01"); // ctrl+a decodes to null — must still close the popover
  assert.ok(!app.render(120).some((l) => stripAnsi(l).includes("reset")), "popover closed by a null-decoding key");
});

test("a search result for an already-resolved escalation never opens a blank card", async () => {
  const source = new MockDataSource();
  const { tui } = fakeTui(30, 120);
  const app = new HelmApp(tui, theme, () => {}, source);
  // Decide + resolve the export-map escalation (removes e-export-map from the queue).
  app.handleInput("1"); // open first needs-you card
  app.handleInput("1"); // decide it
  await flush();
  app.handleInput("\x1b"); // esc back toward home
  app.handleInput("\x1b");
  // Search for the (now stale) decision and try to open it.
  app.handleInput("/");
  for (const ch of "export map") app.handleInput(ch);
  app.handleInput("\r");
  const joined = app.render(120).map(stripAnsi).join("\n");
  // A blank escalation card would render an EMPTY body (header "needs you 1/1"
  // only). Staying on search — or a durable record — keeps the query text on
  // screen, so its presence proves we never descended into nothing.
  assert.match(joined, /export map/i, "never descends into an empty escalation card");
});
