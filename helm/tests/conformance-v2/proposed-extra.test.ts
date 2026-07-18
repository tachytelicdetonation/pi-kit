import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HelmApp } from "../../src/app.js";
import { renderHelmFooter } from "../../src/footer.js";
import { createWorkflowPort } from "../../src/host/adapters.js";
import type { PersistedRunState } from "../../src/workflows/run-persistence.js";
import type { WorkflowManager } from "../../src/workflows/workflow-manager.js";
import { fakeTui, makePersistentSource, stripLines, theme256, withTempProject } from "./helpers.js";

// PROPOSED: hostile terminal geometry -----------------------------------------

test("PROPOSED terminal: zero-width and non-finite widths never throw or emit visible cells", () => {
  const app = new HelmApp(fakeTui(12, 0), theme256, () => {});
  for (const width of [0, -1, Number.NaN, Number.NEGATIVE_INFINITY]) {
    let lines: string[] = [];
    assert.doesNotThrow(() => { lines = app.render(width); });
    assert.equal(lines.length, 12);
    for (const line of lines) assert.equal(visibleWidth(line), 0);
  }
});

// PROPOSED: hostile activity volume ------------------------------------------

test("PROPOSED history: one thousand consecutive context entries still adapt to one bounded row", () => {
  const run: PersistedRunState = {
    runId: "run-1000",
    workflowName: "history",
    script: "",
    args: { helmGoalId: "goal-1000" },
    status: "running",
    phases: ["Inspect"],
    agents: [{
      id: 1,
      label: "reader",
      prompt: "inspect",
      status: "running",
      history: Array.from({ length: 1_000 }, (_, index) => ({
        role: "assistant" as const,
        kind: "toolCall" as const,
        toolName: index % 2 ? "Grep" : "Read",
        text: JSON.stringify({ path: `src/file-${index}.ts` }),
        timestamp: index,
      })),
    }],
    logs: [],
    startedAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:01:00.000Z",
  };
  const manager = {
    listAllRuns: () => [run], listRuns: () => [run], on() {}, off() {},
  } as unknown as WorkflowManager;
  const port = createWorkflowPort(manager, () => ({ listRuns: () => [] }) as never);
  const session = port.getSession("run-1000::1");
  assert.ok(session);
  assert.equal(session.lines.length, 1);
  assert.equal(session.lines[0]?.verb, "context");
  assert.match(`${session.lines[0]?.target} ${session.lines[0]?.result}`, /1000/);
});

// PROPOSED: hostile prompt text ----------------------------------------------

test("PROPOSED input: unicode prompt text survives key dispatch and rendering intact", () => {
  const app = new HelmApp(fakeTui(), theme256, () => {});
  const value = "修复 café e\u0301 🧪 مرحبا";
  for (const character of value) app.handleInput(character);
  const prompt = stripLines(app.render(120)).find((line) => line.includes("❯")) ?? "";
  assert.match(prompt, /修复 café é 🧪 مرحبا/);
});

// PROPOSED: missing provider configuration -----------------------------------

test("PROPOSED usage: an empty provider list is explicit, bounded, and never masquerades as 0%", () => {
  const line = renderHelmFooter({ providers: [], model: "gpt-contract" }, theme256, 120, "fleet");
  assert.match(line.replace(/\x1b\[[0-9;]*m/g, ""), /--/);
  assert.doesNotMatch(line.replace(/\x1b\[[0-9;]*m/g, ""), /\b0%\b/);
  assert.ok(visibleWidth(line) <= 120);
});

// PROPOSED: clock skew during pause ------------------------------------------

test("PROPOSED pause: backward clock skew never moves a loop deadline backward", async () => {
  await withTempProject(async (root) => {
    const realNow = Date.now;
    let now = 1_900_000_000_000;
    Date.now = () => now;
    try {
      const { source } = makePersistentSource(root);
      const created = await source.execute({ type: "loop.createDraft", prompt: "every hour verify", draftId: "clock-skew" });
      await source.trialLoop(created.id!);
      await source.execute({ type: "loop.schedule", loopId: created.id! });
      const before = source.snapshot().loops.find((loop) => loop.id === created.id)?.nextRunAtMs;
      assert.ok(before);
      source.pauseAll();
      now -= 10 * 60_000;
      source.resumeAll();
      const after = source.snapshot().loops.find((loop) => loop.id === created.id)?.nextRunAtMs;
      assert.ok(after !== undefined && after >= before);
    } finally {
      Date.now = realNow;
    }
  });
});

// PROPOSED: request/design gaps ----------------------------------------------

test("PROPOSED gap: a bound action remains literal after prompt focus (Gmail rule precedence)", () => {
  const app = new HelmApp(fakeTui(), theme256, () => {});
  app.handleInput("z");
  for (const character of "gpd?N") app.handleInput(character);
  const prompt = stripLines(app.render(120)).find((line) => line.includes("❯")) ?? "";
  assert.match(prompt, /❯ zgpd\?N$/);
});
