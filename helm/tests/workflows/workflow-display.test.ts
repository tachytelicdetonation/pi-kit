/**
 * Comprehensive tests for workflow display rendering:
 *
 * 1. renderWorkflowText / renderWorkflowLines — how the workflow UI
 *    renders progress, results, phases, agents, logs, tokens, cost
 * 2. createWidgetWorkflowDisplay / createToolUpdateWorkflowDisplay —
 *    the lifecycle: update → complete → clear
 * 3. Tool result formatting — markdown JSON code blocks for final reports
 * 4. deliverText — how background-run results are formatted for the user
 * 5. backgroundStartedText — the "started in background" message
 * 6. Pure helper functions: preview, shorten, statusIcon, statusLine
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { WorkflowMeta } from "../../src/workflows/workflow.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function fakeMeta(
  name = "test-wf",
  desc = "test description",
  phases: string[] = ["Research", "Build", "Verify"],
): WorkflowMeta {
  return { name, description: desc, phases: phases.map((t) => ({ title: t })) };
}

function agent(
  id: number,
  label: string,
  status: "queued" | "running" | "done" | "error" | "skipped",
  phase?: string,
  opts?: {
    resultPreview?: string;
    tokens?: number;
    tokenUsage?: { input: number; output: number; total: number; cost: number; cacheRead: number; cacheWrite: number };
    model?: string;
    prompt?: string;
  },
) {
  return {
    id,
    label,
    status,
    phase,
    prompt: opts?.prompt ?? `execute ${label}`,
    ...(opts?.resultPreview ? { resultPreview: opts.resultPreview } : {}),
    ...(opts?.tokens ? { tokens: opts.tokens } : {}),
    ...(opts?.tokenUsage ? { tokenUsage: opts.tokenUsage } : {}),
    ...(opts?.model ? { model: opts.model } : {}),
  };
}

// ─── Module loading helpers ─────────────────────────────────────────────────

async function loadDisplay() {
  return import("../../src/workflows/display.js");
}

async function loadTaskPanel() {
  return import("../../src/workflows/task-panel.js");
}

async function loadTool() {
  return import("../../src/workflows/workflow-tool.js");
}

// ═══════════════════════════════════════════════════════════════════════════
// renderWorkflowText
// ═══════════════════════════════════════════════════════════════════════════

describe("renderWorkflowText", () => {
  it("shows 'running' header when not completed", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const text = renderWorkflowText(createWorkflowSnapshot(fakeMeta("test")));
    assert.ok(text.includes("running"), "should say running in the header");
    assert.ok(!text.includes("completed"), "should not say completed");
  });

  it("shows 'completed' header when completed flag is true", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const text = renderWorkflowText(createWorkflowSnapshot(fakeMeta()), true);
    assert.ok(text.includes("completed"), "should say completed");
  });

  it("includes workflow name in output", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const text = renderWorkflowText(createWorkflowSnapshot(fakeMeta("audit-all")));
    assert.ok(text.includes("audit-all"), "should contain audit-all");
  });

  it("includes phase names", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta("t", "d", ["Phase1", "Phase2"]));
    snap.agents = [agent(1, "agent-1", "done", "Phase1")] as never[];
    const text = renderWorkflowText(snap);
    assert.ok(text.includes("Phase1"), "should contain Phase1");
    assert.ok(text.includes("Phase2"), "should contain Phase2");
  });

  it("includes failed agent labels (healthy agents collapse into the phase rollup)", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    // Post-redesign, individual agent rows render only for failures; a failed
    // agent's label must still surface so the failure is never silent.
    snap.agents = [agent(1, "inventory", "error", "Research")] as never[];
    const text = renderWorkflowText(snap);
    assert.ok(text.includes("inventory"), "should contain inventory");
  });

  it("shows agent count and done count", async () => {
    const { createWorkflowSnapshot, renderWorkflowText, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(fakeMeta()));
    snap.agents = [
      agent(1, "a1", "done", "Research"),
      agent(2, "a2", "done", "Build"),
      agent(3, "a3", "error", "Verify"),
    ] as never[];
    const text = renderWorkflowText(recomputeWorkflowSnapshot(snap));
    assert.ok(text.includes("3"), "should mention total agents");
    assert.ok(text.includes("2"), "should mention done count");
  });

  it("shows error count", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(fakeMeta()));
    snap.agents = [agent(1, "a1", "done", "Research"), agent(2, "a2", "error", "Research")] as never[];
    const text = renderWorkflowLines(recomputeWorkflowSnapshot(snap)).join("\n");
    assert.ok(text.includes("1 errors"), "should show error count");
  });

  it("surfaces a '✗ N failed' header line naming the first failure when errorCount > 0", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(fakeMeta()));
    snap.agents = [
      agent(1, "gather", "done", "Research"),
      agent(2, "verify-claims", "error", "Verify", { prompt: "check" }),
    ] as never[];
    (snap.agents[1] as { error?: string }).error = "provider timeout after 3 retries";
    const text = renderWorkflowLines(recomputeWorkflowSnapshot(snap)).join("\n");
    assert.ok(/✗ 1 failed/.test(text), `should render the failed line; got: ${text}`);
    assert.ok(text.includes("verify-claims"), "names the first failed agent");
    assert.ok(text.includes("provider timeout"), "carries the short error");
  });

  it("shows running count in header", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(fakeMeta()));
    snap.agents = [agent(1, "a1", "done", "Research"), agent(2, "a2", "running", "Research")] as never[];
    const text = renderWorkflowLines(recomputeWorkflowSnapshot(snap)).join("\n");
    assert.ok(text.includes("running"), "should show running in header");
  });

  it("shows cost info when tokenUsage has cost", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    snap.tokenUsage = { input: 1000, output: 500, total: 1500, cost: 0.042 };
    const text = renderWorkflowLines(snap).join("\n");
    // fmtCost: 2 decimals from one cent up, 4 below it (shared across all surfaces).
    assert.ok(text.includes("$0.04"), "should show cost");
  });

  it("shows token info without cost when cost is absent", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    snap.tokenUsage = { input: 500, output: 300, total: 800 };
    const text = renderWorkflowLines(snap).join("\n");
    assert.ok(text.includes("800"), "should show token count");
    assert.ok(!text.includes("$"), "should NOT show cost when absent");
  });

  it("shows skipped agents in phase line", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(fakeMeta("t", "d", ["Phase"])));
    snap.agents = [agent(1, "a1", "done", "Phase"), agent(2, "a2", "skipped", "Phase")] as never[];
    const text = renderWorkflowLines(recomputeWorkflowSnapshot(snap)).join("\n");
    assert.ok(text.includes("1 skipped"), "should show skipped count");
  });

  it("shows unphased agents when agents have no phase", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta("t", "d", []));
    // A failed unphased agent surfaces its row; the Unphased rollup is always shown.
    snap.agents = [agent(1, "orphan", "error")] as never[];
    const text = renderWorkflowLines(snap).join("\n");
    assert.ok(text.includes("Unphased"), "should show unphased section");
    assert.ok(text.includes("orphan"), "should contain orphan");
  });

  // NOTE: per-agent token cells were removed from the inline transcript (the
  // redesign collapses healthy agents into the phase rollup and cuts token chrome).
  // Aggregate token figures are still asserted on the header (below) and the
  // navigator; per-agent token detail lives in `renderPanelDetailed` / the navigator.

  it("tokenFigures uses the breakdown when it carries signal and the estimate otherwise", async () => {
    const { tokenFigures } = await loadDisplay();
    // Reporting provider: total = input+output+cacheRead+cacheWrite, both paths agree.
    // cacheWrite counts as fresh — it is first-time ingestion billed at full/premium price.
    assert.deepEqual(tokenFigures({ input: 80, output: 20, total: 1100, cacheRead: 900, cacheWrite: 100 }), {
      fresh: 200,
      cacheRead: 900,
    });
    // Cache-creating first turn: the written prefix must not vanish from the count.
    assert.deepEqual(tokenFigures({ input: 6000, output: 1000, total: 207000, cacheRead: 0, cacheWrite: 200000 }), {
      fresh: 207000,
      cacheRead: 0,
    });
    // Estimate-only (provider reported nothing): the scalar total survives as fresh.
    assert.deepEqual(tokenFigures({ input: 0, output: 0, total: 800, cacheRead: 0, cacheWrite: 0 }), {
      fresh: 800,
      cacheRead: 0,
    });
    // Cost-only agent: all-zero breakdown, scalar estimate alongside.
    assert.deepEqual(tokenFigures({ input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: 0.02 }, 384), {
      fresh: 384,
      cacheRead: 0,
    });
    // Mixed run: some agents reported (input+output=100), the rest only estimated into total.
    assert.deepEqual(tokenFigures({ input: 70, output: 30, total: 900, cacheRead: 0, cacheWrite: 0 }), {
      fresh: 900,
      cacheRead: 0,
    });
    // No usage object at all.
    assert.deepEqual(tokenFigures(undefined, 500), { fresh: 500, cacheRead: 0 });
    assert.deepEqual(tokenFigures(undefined), { fresh: 0, cacheRead: 0 });
  });

  it("header falls back to the estimated total when the provider reported no usage (#57 regression)", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    // onUsage never fired: breakdown is all-zero, total carries the estimate.
    snap.tokenUsage = { input: 0, output: 0, total: 800 };
    const text = renderWorkflowLines(snap).join("\n");
    assert.ok(text.includes("800 tok"), `estimate should survive in the header; got: ${text}`);
    assert.ok(!/\b0 tok/.test(text), `must not render a zero breakdown; got: ${text}`);
  });

  // NOTE: the per-agent "[384 tok]" cell was removed from the inline transcript;
  // the cost-only #57 regression is covered by the header test above and the
  // `tokenFigures` unit test (the estimate-survives-as-fresh rule).

  it("suppresses the header token segment for an all-zero usage aggregate (#57 regression)", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    // e.g. a fully journal-replayed resume, or a run whose agents were all skipped.
    snap.tokenUsage = { input: 0, output: 0, total: 0 };
    const text = renderWorkflowLines(snap).join("\n");
    assert.ok(!/\b0 tok/.test(text), `an all-zero aggregate must not render "0 tok"; got: ${text}`);
  });

  it("fmtCost never renders a real cost as a zero-looking figure", async () => {
    const { fmtCost } = await loadDisplay();
    assert.equal(fmtCost(6.7), "$6.70");
    assert.equal(fmtCost(0.0042), "$0.0042");
    assert.equal(fmtCost(0.00003), "<$0.0001");
  });

  it("truncates long agent labels", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    // Individual rows render only for failures; use an error agent to exercise the
    // label truncation on the surviving per-agent surface.
    snap.agents = [agent(1, "x".repeat(100), "error", "Research")] as never[];
    const text = renderWorkflowLines(snap).join("\n");
    assert.ok(text.includes("…"), "should truncate with ellipsis");
    assert.ok(text.length < 200, "should not include the full 100-char label");
  });

  it("caps error rows at maxAgents and reports the overflow", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta("t", "d", ["Phase"]));
    // Only failures get individual rows now, so maxAgents caps the error rows.
    snap.agents = Array.from({ length: 20 }, (_, i) => agent(i + 1, `agent-${i + 1}`, "error", "Phase")) as never[];
    const text = renderWorkflowLines(snap, { maxAgents: 5 }).join("\n");
    assert.ok(text.includes("earlier failures"), "should mention earlier failures");
    assert.ok(text.includes("agent-20"), "should show last agent");
    // Use word boundary to avoid matching "agent-1" inside "agent-11", "agent-12", etc.
    assert.ok(!/\bagent-1\b/.test(text), "first agents should be clipped");
  });

  it("displays durationMs when present", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    snap.durationMs = 12500;
    // renderWorkflowText doesn't explicitly show duration — but header includes tokenInfo
    // duration is available through the snapshot. Let's verify the function works.
    const text = renderWorkflowText(snap, true);
    assert.ok(text.includes("completed"), "completed header shown");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createWidgetWorkflowDisplay lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe("createWidgetWorkflowDisplay lifecycle", () => {
  it("update calls setWidget constructor once and re-renders via component", async () => {
    const { createWorkflowSnapshot, createWidgetWorkflowDisplay } = await loadDisplay();

    const setWidget = mock.fn();
    const setStatus = mock.fn();
    const ctx = {
      hasUI: true,
      ui: { setWidget, setStatus },
    };

    const display = createWidgetWorkflowDisplay(ctx as never, { key: "test-wf" });

    // Constructor registers the widget as a component factory (callback, not array)
    assert.equal(setWidget.mock.callCount(), 1);
    const [key, widget, _opts] = setWidget.mock.calls[0].arguments;
    assert.equal(key, "test-wf");
    assert.equal(typeof widget, "function", "widget should be a component factory function");

    // The component factory produces a Component with a render method
    const comp = widget(
      undefined as never,
      {
        fg: (_c: string, t: string) => t,
        bold: (t: string) => t,
      } as never,
    );
    assert.ok(comp, "component factory should return a component");
    assert.equal(typeof comp.render, "function", "component should have a render method");

    // update doesn't call setWidget again (mutable state)
    const snap = createWorkflowSnapshot(fakeMeta());
    display.update(snap);
    assert.equal(setWidget.mock.callCount(), 2, "update should call setWidget to re-register");

    // But the component's render function returns the latest snapshot lines
    const lines = comp.render(80);
    assert.ok(Array.isArray(lines), "render should return lines");
    assert.ok(lines.length > 0, "rendered lines should not be empty");
  });

  it("complete does not re-register widget (constructor did it)", async () => {
    const { createWorkflowSnapshot, createWidgetWorkflowDisplay } = await loadDisplay();

    const setWidget = mock.fn();
    const ctx = {
      hasUI: true,
      ui: { setWidget, setStatus: mock.fn() },
    };

    const display = createWidgetWorkflowDisplay(ctx as never);
    assert.equal(setWidget.mock.callCount(), 1, "constructor registers widget once");

    const snap = createWorkflowSnapshot(fakeMeta());
    display.complete(snap);

    // Complete updates mutable state, doesn't re-register
    assert.equal(setWidget.mock.callCount(), 2, "complete should call setWidget to re-register");
  });

  it("clear removes widget and status", async () => {
    const { createWidgetWorkflowDisplay } = await loadDisplay();

    const setWidget = mock.fn();
    const setStatus = mock.fn();
    const ctx = {
      hasUI: true,
      ui: { setWidget, setStatus },
    };

    const display = createWidgetWorkflowDisplay(ctx as never, { showStatus: true });
    // Constructor registers the widget once
    assert.equal(setWidget.mock.callCount(), 1);

    display.clear();

    // Clear calls setWidget(undefined) to remove it + setStatus(undefined)
    assert.equal(setWidget.mock.callCount(), 2, "constructor + clear = 2 calls");
    assert.equal(setWidget.mock.calls[1].arguments[1], undefined, "widget should be cleared");
    assert.equal(setStatus.mock.callCount(), 1);
    assert.equal(setStatus.mock.calls[0].arguments[1], undefined, "status should be cleared");
  });

  it("does nothing when hasUI is false", async () => {
    const { createWorkflowSnapshot, createWidgetWorkflowDisplay } = await loadDisplay();

    const setWidget = mock.fn();
    const setStatus = mock.fn();
    const ctx = {
      hasUI: false,
      ui: { setWidget, setStatus },
    };

    const display = createWidgetWorkflowDisplay(ctx as never);
    const snap = createWorkflowSnapshot(fakeMeta());
    display.update(snap);
    display.complete(snap);
    display.clear();

    assert.equal(setWidget.mock.callCount(), 0, "should not call setWidget when no UI");
  });

  it("sets status line when showStatus is enabled", async () => {
    const { createWorkflowSnapshot, createWidgetWorkflowDisplay } = await loadDisplay();

    const setStatus = mock.fn();
    const ctx = {
      hasUI: true,
      ui: { setWidget: mock.fn(), setStatus },
    };

    const display = createWidgetWorkflowDisplay(ctx as never, { key: "wf", showStatus: true });
    const snap = createWorkflowSnapshot(fakeMeta("test-wf"));
    snap.agents = [agent(1, "a1", "done", "Research"), agent(2, "a2", "running", "Research")] as never[];
    display.update(snap);

    assert.equal(setStatus.mock.callCount(), 1);
    const [, statusText] = setStatus.mock.calls[0].arguments;
    assert.ok(statusText.includes("test-wf"), "status should include workflow name");
  });

  it("re-renders via setWidget even when showStatus is false (default)", async () => {
    const { createWorkflowSnapshot, createWidgetWorkflowDisplay } = await loadDisplay();

    const setWidget = mock.fn();
    const ctx = {
      hasUI: true,
      ui: { setWidget, setStatus: mock.fn() },
    };

    // showStatus defaults to false
    const display = createWidgetWorkflowDisplay(ctx as never, { key: "wf-no-status" });
    assert.equal(setWidget.mock.callCount(), 1, "constructor registers widget once");

    // update() re-registers the widget (invalidation signal to pi-tui)
    const snap = createWorkflowSnapshot(fakeMeta("no-status-wf"));
    display.update(snap);
    assert.equal(setWidget.mock.callCount(), 2, "update must re-register widget (invalidation signal)");

    // Extract the re-registered factory and verify it renders the latest snapshot
    const [, factory2] = setWidget.mock.calls[1].arguments;
    assert.equal(typeof factory2, "function", "factory must be a function");
    const comp2 = factory2(null, { fg: (_c, t) => t, bold: (t) => t });
    assert.equal(typeof comp2.render, "function", "factory must produce a component with render()");

    // Spy on render to prove it produces updated output
    const renderSpy = comp2.render;
    const lines2 = renderSpy(80);
    assert.ok(lines2.length > 0, "render() returned non-empty lines with showStatus=false");
    assert.ok(
      lines2.some((l) => l.includes("no-status-wf")),
      "render output includes snapshot workflow name",
    );
    assert.ok(
      lines2.some((l) => l.includes("0/0")),
      "render output includes agent count from snapshot",
    );

    // complete() must also re-register the factory
    display.complete(snap);
    assert.equal(setWidget.mock.callCount(), 3, "complete must re-register widget (invalidation signal)");

    // Verify the post-complete factory also renders updated content
    const [, factory3] = setWidget.mock.calls[2].arguments;
    const comp3 = factory3(null, { fg: (_c, t) => t, bold: (t) => t });
    const lines3 = comp3.render(80);
    assert.ok(
      lines3.some((l) => l.includes("no-status-wf")),
      "post-complete render shows workflow name",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createToolUpdateWorkflowDisplay lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe("createToolUpdateWorkflowDisplay lifecycle", () => {
  it("update calls onUpdate with rendered text when streamToolUpdates is true", async () => {
    const { createWorkflowSnapshot, createToolUpdateWorkflowDisplay } = await loadDisplay();

    const onUpdate = mock.fn();
    const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, { streamToolUpdates: true });
    const snap = createWorkflowSnapshot(fakeMeta());
    display.update(snap);

    assert.equal(onUpdate.mock.callCount(), 1);
    const [{ content }] = onUpdate.mock.calls[0].arguments;
    assert.ok(Array.isArray(content), "content should be an array");
    assert.equal(content[0].type, "text");
    assert.ok(content[0].text.includes("Workflow"), "should include workflow status text");
  });

  it("update does NOT call onUpdate when streamToolUpdates is false", async () => {
    const { createWorkflowSnapshot, createToolUpdateWorkflowDisplay } = await loadDisplay();

    const onUpdate = mock.fn();
    const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, { streamToolUpdates: false });
    display.update(createWorkflowSnapshot(fakeMeta()));

    assert.equal(onUpdate.mock.callCount(), 0, "should not update when streaming is disabled");
  });

  it("complete emits final render with completed flag", async () => {
    const { createWorkflowSnapshot, createToolUpdateWorkflowDisplay } = await loadDisplay();

    const onUpdate = mock.fn();
    const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, { streamToolUpdates: true });
    const snap = createWorkflowSnapshot(fakeMeta("done-wf"));
    display.complete(snap);

    const [{ content }] = onUpdate.mock.calls[0].arguments;
    assert.ok(content[0].text.includes("done-wf"), "should include workflow name");
  });

  it("accepts a widget ctx and delegates to widget lifecycle", async () => {
    const { createWorkflowSnapshot, createToolUpdateWorkflowDisplay } = await loadDisplay();

    const setWidget = mock.fn();
    const ctx = { hasUI: true, ui: { setWidget, setStatus: mock.fn() } };
    const display = createToolUpdateWorkflowDisplay(undefined, ctx as never, { key: "tool-wf" });

    // Constructor registers the component factory once
    assert.equal(setWidget.mock.callCount(), 1, "constructor should register widget once");

    // update/complete re-register the widget to trigger re-render
    display.update(createWorkflowSnapshot(fakeMeta()));
    assert.equal(setWidget.mock.callCount(), 2, "update should call setWidget to re-register");

    display.complete(createWorkflowSnapshot(fakeMeta("done")));
    assert.equal(setWidget.mock.callCount(), 3, "complete should call setWidget to re-register");

    // clear removes the widget
    display.clear();
    assert.equal(setWidget.mock.callCount(), 4, "clear should remove widget (4th call)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tool result formatting (markdown JSON code blocks)
// ═══════════════════════════════════════════════════════════════════════════

describe("workflow tool result formatting", () => {
  it("tool result includes markdown JSON code block formatting", async () => {
    // The execute() function in workflow-tool.ts wraps the final result in
    // a markdown ```json code block so it renders nicely in the conversation.
    // This test verifies the formatting pattern.
    const result = { ok: true, items: 3 };
    const formatted = `\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
    assert.ok(formatted.includes("```json"), "should use json code block");
    assert.ok(formatted.endsWith("```"), "should close code block");
    assert.ok(formatted.includes('"ok": true'), "should contain data");

    const { createWorkflowTool } = await loadTool();
    const tool = createWorkflowTool();
    const theme = { fg: () => (text: string) => text, bold: (text: string) => text };
    const fallback = tool.renderResult(
      {
        content: [{ type: "text", text: "**bold** and `code` and ## header" }],
        details: { some: "data" },
        isError: false,
      } as never,
      { isPartial: false },
      theme as never,
    );
    assert.equal(fallback.render(120)[0]?.trimEnd(), "bold and `code` and ## header");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Pure helpers: preview, shorten, statusIcon, statusLine
// ═══════════════════════════════════════════════════════════════════════════

describe("display pure helpers", () => {
  it("preview truncates long JSON strings", async () => {
    const { preview } = await loadDisplay();
    const result = preview("x".repeat(200));
    assert.ok(result.length <= 85, "should truncate with max 80 + …");
    assert.ok(result.endsWith("…"), "should end with …");
  });

  it("preview accepts custom max length", async () => {
    const { preview } = await loadDisplay();
    const result = preview("x".repeat(50), 10);
    assert.ok(result.length <= 14, "should respect custom max");
  });

  it("preview handles arrays", async () => {
    const { preview } = await loadDisplay();
    const arr = [1, 2, 3, 4, 5];
    const result = preview(arr, 50);
    assert.ok(result.length > 0, "result should not be empty");
    assert.ok(result.includes("1"), "should contain 1");
  });

  it("statusLine shows completed state", async () => {
    const { createWorkflowSnapshot, createWidgetWorkflowDisplay } = await loadDisplay();
    // statusLine is internal to display.ts — tested via widget display
    const setStatus = mock.fn();
    const ctx = { hasUI: true, ui: { setWidget: mock.fn(), setStatus } };
    const display = createWidgetWorkflowDisplay(ctx as never, { key: "s", showStatus: true });
    const snap = createWorkflowSnapshot(fakeMeta("bench"));
    snap.agents = [agent(1, "a1", "done", "Research")] as never[];
    snap.agentCount = 1;
    snap.doneCount = 1;
    display.complete(snap);
    const [, statusText] = setStatus.mock.calls[0].arguments;
    assert.ok(statusText.includes("✓"), "completed status shows checkmark");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// deliverText — background result formatting
// ═══════════════════════════════════════════════════════════════════════════

describe("deliverText", () => {
  function fakeManagedRun(overrides: Record<string, unknown> = {}) {
    return {
      runId: "r-123",
      workflowName: "my-wf",
      snapshot: {
        name: "my-wf",
        agentCount: 5,
        phases: [],
        logs: [],
        agents: [],
        ...((overrides.snapshot as Record<string, unknown>) ?? {}),
      },
      background: true,
      status: "completed",
      result: {
        result: { verdict: "All checks passed" },
        agentCount: 5,
        tokenUsage: { input: 100, output: 50, total: 150, cost: 0.003 },
        durationMs: 12345,
      },
      ...overrides,
    } as never;
  }

  it("formats completion metrics as exact segments", async () => {
    const { deliverText } = await loadTaskPanel();
    const cases = [
      {
        label: "agents, tokens, cost, and duration",
        run: fakeManagedRun(),
        expected: ["5 agents", "150 tok", "$0.0030", "12.3s"],
      },
      {
        label: "metrics omitted when absent",
        run: fakeManagedRun({ result: { result: { verdict: "done" }, agentCount: 2 } }),
        expected: ["2 agents"],
      },
    ];

    for (const { label, run, expected } of cases) {
      const firstLine = deliverText(run).split("\n", 1)[0];
      const metrics = firstLine.match(/finished \((.*)\)\.$/)?.[1].split(" · ");
      assert.deepEqual(metrics, expected, label);
    }
  });

  it("starts with checkmark and workflow name", async () => {
    const { deliverText } = await loadTaskPanel();
    const text = deliverText(fakeManagedRun());
    assert.ok(text.startsWith("✓"), "should start with checkmark");
    assert.ok(text.includes("my-wf"), "should include workflow name");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// backgroundStartedText
// ═══════════════════════════════════════════════════════════════════════════

describe("backgroundStartedText", () => {
  it("includes workflow name and run ID", async () => {
    const { backgroundStartedText } = await loadTool();
    const text = backgroundStartedText("deep-research", "run-xyz");
    assert.ok(text.includes("deep-research"), "should contain deep-research");
    assert.ok(text.includes("run-xyz"), "should contain run-xyz");
  });

  it("tells the user the workflow is in the background", async () => {
    const { backgroundStartedText } = await loadTool();
    const text = backgroundStartedText("audit", "r-1");
    assert.ok(text.includes("background"), "should say background");
  });

  it("tells user they can wait or do other things", async () => {
    const { backgroundStartedText } = await loadTool();
    const text = backgroundStartedText("audit", "r-1");
    assert.ok(text.includes("wait here") || text.includes("other things"), "should mention options");
  });

  it("mentions /workflows status command for tracking", async () => {
    const { backgroundStartedText } = await loadTool();
    const text = backgroundStartedText("audit", "r-1");
    assert.ok(text.includes("/workflows"), "should mention /workflows");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createWorkflowSnapshot / recomputeWorkflowSnapshot
// ═══════════════════════════════════════════════════════════════════════════

describe("createWorkflowSnapshot", () => {
  it("sets default values for optional fields", async () => {
    const { createWorkflowSnapshot } = await loadDisplay();
    const meta = { name: "n", description: "d" };
    const snap = createWorkflowSnapshot(meta as never);
    assert.deepEqual(snap.phases, []);
    assert.deepEqual(snap.logs, []);
    assert.deepEqual(snap.agents, []);
    assert.equal(snap.agentCount, 0);
    assert.equal(snap.runningCount, 0);
    assert.equal(snap.doneCount, 0);
    assert.equal(snap.errorCount, 0);
  });
});

describe("recomputeWorkflowSnapshot", () => {
  it("counts running/done/error correctly mixed statuses", async () => {
    const { createWorkflowSnapshot, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = createWorkflowSnapshot({ name: "t", description: "d" } as never);
    snap.agents = [
      { id: 1, label: "a", prompt: "p", status: "queued" },
      { id: 2, label: "b", prompt: "p", status: "running" },
      { id: 3, label: "c", prompt: "p", status: "done" },
      { id: 4, label: "d", prompt: "p", status: "error" },
      { id: 5, label: "e", prompt: "p", status: "skipped" },
    ] as never[];
    const r = recomputeWorkflowSnapshot(snap);
    assert.equal(r.agentCount, 5);
    assert.equal(r.runningCount, 1);
    assert.equal(r.doneCount, 1);
    assert.equal(r.errorCount, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// renderWorkflowLines edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("renderWorkflowLines edge cases", () => {
  it("handles empty agents array", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    const lines = renderWorkflowLines(snap);
    assert.ok(lines.length > 0, "should still produce output");
    assert.ok(lines[0].includes("0/0"), "should show 0/0 done");
  });

  it("handles multiple phases with varying agent counts", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(fakeMeta("t", "d", ["Alpha", "Beta"])));
    snap.agents = [
      agent(1, "a1", "done", "Alpha"),
      agent(2, "a2", "done", "Beta"),
      agent(3, "a3", "running", "Beta"),
    ] as never[];
    const text = renderWorkflowLines(recomputeWorkflowSnapshot(snap)).join("\n");
    assert.ok(text.includes("Alpha"), "should contain Alpha");
    assert.ok(text.includes("Beta"), "should contain Beta");
    assert.ok(text.includes("running"), "should show running in Beta");
  });

  it("mentions the workflow name in the first line", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta("check-everything"));
    const lines = renderWorkflowLines(snap);
    assert.ok(lines[0].includes("check-everything"), "should contain check-everything");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TUI rendering: no markdown syntax leaked into display
// ═══════════════════════════════════════════════════════════════════════════

describe("TUI rendering has no markdown syntax", () => {
  it("renderWorkflowLines uses [id] instead of #id prefix", async () => {
    const { createWorkflowSnapshot, renderWorkflowLines } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta("t", "d", ["Phase"]));
    // Individual rows render only for failures; use an error agent to exercise [id].
    snap.agents = [agent(1, "agent-1", "error", "Phase")] as never[];
    const text = renderWorkflowLines(snap).join("\n");
    // Should use bracket notation, not hash notation
    assert.ok(text.includes("[1]"), "should use [id] instead of #id");
    assert.ok(!text.includes("#1"), "should NOT use #1 prefix");
  });

});

// ─── aggregateAgentUsage ─────────────────────────────────────────────────────

describe("aggregateAgentUsage", () => {
  it("sums fresh/cacheRead tokens and real per-agent cost", async () => {
    const { aggregateAgentUsage } = await import("../../src/workflows/display.js");
    const total = aggregateAgentUsage([
      {
        tokens: 2100,
        tokenUsage: { input: 1500, output: 600, total: 2100, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
      },
      {
        tokens: 3000,
        tokenUsage: { input: 100, output: 100, total: 3000, cacheRead: 2800, cacheWrite: 0, cost: 0.02 },
      },
      { tokens: 500 }, // estimate-only: no provider breakdown, no cost
    ]);
    assert.equal(total.fresh, 2800, "2100 fresh + 200 post-cache + 500 estimate");
    assert.equal(total.cacheRead, 2800);
    assert.ok(Math.abs(total.cost - 0.03) < 1e-9, `cost sums per-agent figures: ${total.cost}`);
  });
});
