import assert from "node:assert/strict";
import test from "node:test";
import { HelmApp, type TuiLike } from "../src/app.js";
import { MockDataSource } from "../src/data/mock.js";

const theme = { getColorMode: () => "256color" as const };
const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const text = (app: HelmApp) => app.render(120).map(stripAnsi).join("\n");
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function tui(): TuiLike {
  return { terminal: { rows: 34, columns: 120 }, requestRender() {} };
}

function type(app: HelmApp, value: string): void {
  for (const ch of value) app.handleInput(ch);
}

function intoDrillIn(app: HelmApp): void {
  app.handleInput("j");
  app.handleInput("j");
  app.handleInput("j");
  app.handleInput("\r");
}

function intoSession(app: HelmApp): void {
  intoDrillIn(app);
  app.handleInput("\r");
}

test("typing a normal prompt on home and pressing enter creates a real intake draft", async () => {
  const app = new HelmApp(tui(), theme, () => {});
  type(app, "ship the docs site");
  app.handleInput("\r");
  await flush();
  assert.match(text(app), /new goal/);
  assert.match(text(app), /ship the docs site/);
});

test("intake plan editing uses e, j/k, enter, then persists the rewritten line", async () => {
  const app = new HelmApp(tui(), theme, () => {});
  type(app, "ship the docs site");
  app.handleInput("\r");
  await flush();
  app.handleInput("e");
  assert.match(text(app), /plan line 1\/3/);
  app.handleInput("j");
  app.handleInput("\r");
  type(app, "run the complete verification matrix");
  app.handleInput("\r");
  await flush();
  assert.match(text(app), /run the complete verification matrix/);
});

test("loop editing, supervised trial, and schedule form one working path", async () => {
  const app = new HelmApp(tui(), theme, () => {});
  app.handleInput("N");
  app.handleInput("e");
  type(app, "every 2 hours check the docs and verify links");
  app.handleInput("\r");
  await flush();
  assert.match(text(app), /every 2 hours check the docs and verify links/);
  app.handleInput("t");
  await flush();
  assert.match(text(app), /accept schedule/);
  app.handleInput("s");
  await flush();
  assert.match(text(app), /mission control/);
});

test("drill-in test details open an in-Helm document", async () => {
  const app = new HelmApp(tui(), theme, () => {});
  intoDrillIn(app);
  app.handleInput("t");
  await flush();
  assert.match(stripAnsi(app.render(120)[0]!), /test race/);
  assert.match(text(app), /green/);
});

test("session steer submits typed input to Pi's normal agent", async () => {
  let handoff = "";
  let closed = false;
  const app = new HelmApp(
    tui(),
    theme,
    () => { closed = true; },
    new MockDataSource(),
    undefined,
    (prompt) => { handoff = prompt; },
  );
  intoSession(app);
  app.handleInput("i");
  type(app, "preserve the accepted tests and fix only the retry path");
  app.handleInput("\r");
  await flush();
  assert.equal(closed, true);
  assert.match(handoff, /preserve the accepted tests/);
});

test("merge requires confirmation before Pi receives the scoped handoff", async () => {
  let handoff = "";
  const app = new HelmApp(
    tui(),
    theme,
    () => {},
    new MockDataSource(),
    undefined,
    (prompt) => { handoff = prompt; },
  );
  intoSession(app);
  app.handleInput("m");
  assert.match(text(app), /confirm merge/);
  assert.equal(handoff, "");
  app.handleInput("y");
  await flush();
  assert.match(handoff, /Merge/);
});

test("digest full log and closeout report open read-only document screens", async () => {
  const digest = new HelmApp(tui(), theme, () => {}, new MockDataSource({ shouldShowDigest: true }));
  digest.handleInput("l");
  await flush();
  assert.match(stripAnsi(digest.render(120)[0]!), /full activity log/);

  const closeout = new HelmApp(tui(), theme, () => {});
  closeout.handleInput("/");
  type(closeout, "migrate");
  closeout.handleInput("\r");
  closeout.handleInput("r");
  await flush();
  assert.match(stripAnsi(closeout.render(120)[0]!), /goal report/);
});

test("escalation follow-up persists on the active card without handing off out of Helm", async () => {
  let handoff = "";
  const source = new MockDataSource();
  const app = new HelmApp(tui(), theme, () => {}, source, undefined, (prompt) => { handoff = prompt; });
  app.handleInput("\r");
  app.handleInput("?");
  type(app, "what breaks if I choose option two");
  app.handleInput("\r");
  await flush();
  assert.equal(handoff, "", "follow-up stays in Helm instead of taking the exit handoff");
  assert.equal(source.listEscalations()[0]?.followUps?.[0]?.question, "what breaks if I choose option two");
  assert.equal(source.listEscalations().length, 2, "asking does not resolve the decision");
});
