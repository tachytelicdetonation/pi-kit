import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HelmApp, type TuiLike } from "../src/app.js";
import { MockDataSource, seedApiRenameEscalation } from "../src/data/mock.js";
import type { Escalation } from "../src/state/types.js";

const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const strip = (lines: string[]) => lines.map(stripAnsi);
const theme256 = { getColorMode: () => "256color" as const };
const themeTrue = { getColorMode: () => "truecolor" as const };

function fakeTui(rows: number, columns: number) {
  let renders = 0;
  const tui: TuiLike = {
    terminal: { rows, columns },
    requestRender() {
      renders += 1;
    },
  };
  return { tui, renders: () => renders };
}

// ── resize reflow: render reads terminal.rows/width live, on EVERY screen ────────
test("a rows change reflows every screen to the new exact line count", async () => {
  const { tui } = fakeTui(24, 120);
  const app = new HelmApp(tui, theme256, () => {});
  // Walk each reachable screen and assert it reflows on a rows change.
  const visit = (label: RegExp) => {
    assert.match(stripAnsi(app.render(120)[0]), label);
    for (const rows of [30, 18, 8, 3, 1]) {
      tui.terminal.rows = rows;
      const lines = app.render(120);
      assert.equal(lines.length, rows, `reflow to ${rows} rows on ${label}`);
      for (const line of lines) assert.ok(visibleWidth(line) <= 120);
    }
    tui.terminal.rows = 24;
  };

  visit(/mission control/); // home
  app.handleInput("\r"); // → escalation card (first needs-you row)
  visit(/needs you/);
  app.handleInput("\r"); // → session
  visit(/task:/);
  app.handleInput("\x1b");
  app.handleInput("\x1b"); // back home
  app.handleInput("n"); // → intake
  visit(/new goal/);
  app.handleInput("x");
  app.handleInput("y");
  await new Promise<void>((resolve) => setImmediate(resolve));
  app.handleInput("N"); // → loop builder
  visit(/new loop/);
  app.handleInput("x");
  app.handleInput("y");
  await new Promise<void>((resolve) => setImmediate(resolve));
  app.handleInput("/"); // → search
  for (const ch of "esm") app.handleInput(ch);
  visit(/search/);
});

test("a width change reflows the body (narrower keeps the width invariant)", () => {
  const { tui } = fakeTui(24, 120);
  const app = new HelmApp(tui, theme256, () => {});
  for (const width of [120, 90, 70, 40, 10, 1]) {
    const lines = app.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `line too wide at ${width}: ${line}`);
  }
});

// ── 256-color degradation: no truecolor escapes leak ─────────────────────────────
test("in 256color mode NO truecolor (\\x1b[38;2) escape leaks on any screen", () => {
  const { tui } = fakeTui(30, 120);
  const app = new HelmApp(tui, theme256, () => {});
  const noTruecolor = () => {
    for (const line of app.render(120)) assert.ok(!line.includes("\x1b[38;2"), `truecolor leaked: ${line}`);
  };
  noTruecolor(); // home
  app.handleInput("\r"); // escalation
  noTruecolor();
  app.handleInput("\x15"); // popover overlay
  noTruecolor();
  app.handleInput("x"); // close
  app.handleInput("\x1b"); // home
  app.handleInput("N"); // loop builder
  noTruecolor();
  app.handleInput("t"); // trialing state
  noTruecolor();
});

test("truecolor mode DOES emit truecolor escapes (sanity: the probe is honored)", () => {
  const { tui } = fakeTui(20, 120);
  const app = new HelmApp(tui, themeTrue, () => {});
  assert.ok(app.render(120).some((line) => line.includes("\x1b[38;2")), "truecolor is used when probed");
});

// ── bell on a NEW needs-you item ────────────────────────────────────────────────
function freshEscalation(): Escalation {
  // A unique id + signature so it neither duplicates nor auto-resolves.
  return { ...seedApiRenameEscalation(), id: "e-brand-new", signature: "unique:brand-new" };
}

test("the bell rings when a NEW escalation is added (mockable, no timers)", () => {
  const source = new MockDataSource();
  let bells = 0;
  new HelmApp(fakeTui(20, 80).tui, theme256, () => {}, source, () => {
    bells += 1;
  });
  assert.equal(bells, 0, "no bell at rest");
  source.addEscalation(freshEscalation());
  assert.equal(bells, 1, "adding a needs-you item rings the bell once");
});

test("the bell does NOT ring when an escalation is DECIDED (the count drops)", () => {
  const source = new MockDataSource();
  let bells = 0;
  new HelmApp(fakeTui(20, 80).tui, theme256, () => {}, source, () => {
    bells += 1;
  });
  source.decide("e-export-map", 0); // resolves + removes → count drops
  assert.equal(bells, 0, "resolving never rings the bell");
});

test("no onBell sink is safe (never throws when a new escalation is added)", () => {
  const source = new MockDataSource();
  new HelmApp(fakeTui(20, 80).tui, theme256, () => {}, source); // no onBell
  assert.doesNotThrow(() => source.addEscalation(freshEscalation()));
});

// ── `?` per-screen help hint ─────────────────────────────────────────────────────
test("`?` toggles a per-screen key-help hint on the prompt line (no literal '?')", () => {
  const { tui } = fakeTui(20, 120);
  const app = new HelmApp(tui, theme256, () => {});
  const prompt = () => strip(app.render(120)).find((l) => l.includes("❯"))!;
  assert.match(prompt(), /new goal, or steer/, "placeholder by default");
  app.handleInput("?");
  assert.match(prompt(), /n new goal · N new loop/, "help hint shown");
  assert.doesNotMatch(prompt(), /\?/, "the hint carries no literal '?'");
  app.handleInput("?");
  assert.match(prompt(), /new goal, or steer/, "toggled back off");
});

test("the help hint is per-screen and clears on navigation", () => {
  const { tui } = fakeTui(24, 120);
  const app = new HelmApp(tui, theme256, () => {});
  app.handleInput("?"); // help on home
  assert.match(strip(app.render(120)).find((l) => l.includes("❯"))!, /new goal · N new loop/);
  app.handleInput("j");
  app.handleInput("j");
  app.handleInput("\r"); // descend → drill-in (help cleared)
  assert.doesNotMatch(strip(app.render(120)).find((l) => l.includes("❯"))!, /new goal · N new loop/);
});
