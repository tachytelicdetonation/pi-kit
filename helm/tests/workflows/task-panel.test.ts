import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

type TaskPanelModule = {
  installResultDelivery: (pi: ExtensionAPI, manager: unknown, opts?: unknown) => void;
  installTaskPanel: (pi: ExtensionAPI | null, manager: unknown, ui: unknown) => void;
};

// Loaded once before all tests
let mod: TaskPanelModule;

before(async () => {
  mod = (await import("../../src/workflows/task-panel.js")) as TaskPanelModule;
});

// ─── Pure-function tests (tested indirectly via installResultDelivery) ─────────

describe("installResultDelivery", () => {
  function createMockManager(run?: unknown, runsDir?: string) {
    const manager = new EventEmitter() as ReturnType<typeof EventEmitter> & {
      getRun: (...args: unknown[]) => unknown;
      getPersistence?: () => { getRunsDir: () => string };
      __deliveryInstalled?: boolean;
      listRuns?: () => unknown[];
    };
    manager.getRun = () => run;
    if (runsDir) manager.getPersistence = () => ({ getRunsDir: () => runsDir });
    return manager;
  }

  function createMockPi(): ExtensionAPI & { _calls: { content: string; customType?: string }[] } {
    const calls: { content: string; customType?: string }[] = [];
    const obj = {
      sendMessage(msg: unknown, _opts?: unknown) {
        calls.push({
          content: (msg as { content?: string }).content ?? "",
          customType: (msg as { customType?: string }).customType,
        });
      },
      registerTool: () => {},
      on: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      reload: () => Promise.resolve(),
      _calls: calls,
    };
    return obj as unknown as ExtensionAPI & { _calls: { content: string; customType?: string }[] };
  }

  function makeRun(overrides: Record<string, unknown> = {}) {
    return {
      runId: "test-run-1",
      background: true,
      snapshot: {
        name: "test-workflow",
        agentCount: 3,
        agents: [
          { id: "a1", status: "done", step: "agent 1", phase: "phase-1" },
          { id: "a2", status: "done", step: "agent 2", phase: "phase-1" },
          { id: "a3", status: "done", step: "agent 3", phase: "phase-2" },
        ],
        phases: [{ title: "phase-1" }, { title: "phase-2" }],
        currentPhase: "phase-2",
        startedAt: new Date(),
        completedAt: new Date(),
      },
      result: {
        agentCount: 3,
        durationMs: 1500,
        tokenUsage: { total: 50000, input: 25000, output: 25000 },
        result: { verdict: "## All tests passed\n\nEverything looks good!" },
      },
      ...overrides,
    };
  }

  // ── deliverText: verdict path ──

  it("delivers verdict when result.result has verdict", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].customType, "workflow-result");
    assert.ok(calls[0].content.includes("All tests passed"), "should contain All tests passed");
    assert.ok(calls[0].content.includes("test-workflow"), "should contain test-workflow");
    assert.ok(calls[0].content.includes("3 agents"), "should contain 3 agents");
    // deliverText shows "N tok"; the cached segment is omitted with no cache reads.
    assert.ok(calls[0].content.includes("50.0K tok"), "should show the token count (input+output)");
    assert.ok(!calls[0].content.includes("cached"), "omits the cached segment when cacheRead is 0");
    assert.ok(calls[0].content.includes("1.5s"), "should contain 1.5s");
    // Honest outcome counts: an all-healthy run reads "N ok" with no failed segment.
    assert.ok(calls[0].content.includes("3 agents: 3 ok"), "shows honest ok count");
    assert.ok(!/failed/.test(calls[0].content), "no failed segment when nothing failed");
  });

  it("carries honest ok/failed counts in the completion line when agents failed", () => {
    const pi = createMockPi();
    // A run whose synthesis was built on silently-nulled failed agents must say so.
    const manager = createMockManager(
      makeRun({
        snapshot: {
          name: "test-workflow",
          agentCount: 3,
          agents: [
            { id: "a1", status: "done" },
            { id: "a2", status: "error" },
            { id: "a3", status: "error" },
          ],
        },
        result: { agentCount: 3, durationMs: 1500, result: { verdict: "done" } },
      }),
    );

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const content = (pi as unknown as { _calls: { content: string }[] })._calls[0].content;
    assert.ok(content.includes("3 agents: 1 ok, 2 failed"), `honest counts, got: ${content}`);
  });

  it("shows the fresh/cache split and cost in the delivery line", () => {
    const pi = createMockPi();
    // A caching model: little fresh input+output, most of the tokens are cheap cache reads.
    const manager = createMockManager(
      makeRun({
        result: {
          agentCount: 2,
          durationMs: 1000,
          tokenUsage: { input: 80000, output: 20000, total: 6100000, cacheRead: 6000000, cacheWrite: 0, cost: 6.7 },
          result: { verdict: "done" },
        },
      }),
    );

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const content = (pi as unknown as { _calls: { content: string }[] })._calls[0].content;
    assert.ok(content.includes("100.0K tok"), `fresh (input+output) should read as tok; got: ${content}`);
    assert.ok(content.includes("6.0M cached"), `cacheRead should read as cached; got: ${content}`);
    assert.ok(content.includes("$6.70"), `cost should be shown; got: ${content}`);
  });

  it("falls back to the estimated total when the provider reported no usage (#57 regression)", () => {
    const pi = createMockPi();
    // Estimate-only run: onUsage never fired, so the breakdown is all-zero while
    // run-level `total` carries the scalar estimate.
    const manager = createMockManager(
      makeRun({
        result: {
          agentCount: 2,
          durationMs: 1000,
          tokenUsage: { input: 0, output: 0, total: 800, cacheRead: 0, cacheWrite: 0, cost: 0 },
          result: { verdict: "done" },
        },
      }),
    );

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const content = (pi as unknown as { _calls: { content: string }[] })._calls[0].content;
    assert.ok(content.includes("800 tok"), `the estimate should survive as the token count; got: ${content}`);
    assert.ok(!/\b0 tok/.test(content), `must not render a zero breakdown; got: ${content}`);
  });

  it("suppresses the token segment when the run-level aggregate is all-zero (#57 regression)", () => {
    const pi = createMockPi();
    // e.g. a fully journal-replayed resume: every agent came from cache, nothing accrued.
    const manager = createMockManager(
      makeRun({
        result: {
          agentCount: 3,
          durationMs: 1500,
          tokenUsage: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          result: { verdict: "done" },
        },
      }),
    );

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const content = (pi as unknown as { _calls: { content: string }[] })._calls[0].content;
    assert.ok(!/\b0 tok/.test(content), `an all-zero aggregate must not render "0 tok"; got: ${content}`);
    assert.ok(content.includes("3 agents"), "the rest of the line is intact");
  });

  // ── deliverText: fallback chain ──

  it("falls back to report when verdict is absent", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: { report: "Report body", verdict: "" } } });
    const manager = createMockManager(run);

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.ok(calls[0].content.includes("Report body"), "should contain Report body");
  });

  it("falls back to summary when verdict and report are absent", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: { summary: "Short summary" } } });
    const manager = createMockManager(run);

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.ok(calls[0].content.includes("Short summary"), "should contain Short summary");
  });

  it("falls back to string result when result is a plain string", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: "Plain string result" } });
    const manager = createMockManager(run);

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.ok(calls[0].content.includes("Plain string result"), "should contain Plain string result");
  });

  it("falls back to truncated JSON when result is an object with no known key", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: { foo: "x".repeat(500), bar: "y".repeat(500) } } });
    const manager = createMockManager(run);

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.ok(calls[0].content.includes("foo"), "should contain foo");
    assert.ok(/…\(truncated [\d.]+ (B|KB|MB)\)/.test(calls[0].content), "should note the dropped size on truncation");
  });

  it("falls back gracefully when result is nullish", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: undefined } });
    const manager = createMockManager(run);

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    // Should not crash; should still deliver a message
    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 1);
    assert.ok(calls[0].content.includes("null"), "should contain null for undefined result");
  });

  // ── Full-result pointer + configurable threshold ──

  it("appends a Full result pointer to <runsDir>/<runId>.json when persistence exists", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun(), "/runs");

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const content = (pi as unknown as { _calls: { content: string }[] })._calls[0].content;
    assert.ok(content.includes("Full result:"), "should include the pointer label");
    assert.ok(content.includes(join("/runs", "test-run-1.json")), "should point at <runsDir>/<runId>.json");
    // The verdict summary itself is unchanged apart from the appended pointer.
    assert.ok(content.includes("All tests passed"), "verdict text preserved");
  });

  it("omits the pointer when the manager exposes no persistence layer", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun()); // no runsDir

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 1, "the result is still delivered");
    assert.ok(calls[0].content.includes("All tests passed"), "verdict body still intact");
    assert.ok(!calls[0].content.includes("Full result:"), "no pointer without a persisted path");
  });

  it("honors deliveredResultMaxChars from loadSettings for the JSON-dump branch", () => {
    const pi = createMockPi();
    // ~216-char JSON dump: under the default 400, so it would NOT truncate by default
    // — a truncation marker can therefore only come from the 50-char setting.
    const run = makeRun({ result: { result: { note: "z".repeat(200) } } });
    const manager = createMockManager(run, "/runs");

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager, {
      loadSettings: () => ({ deliveredResultMaxChars: 50 }),
    });
    manager.emit("complete", { runId: "test-run-1" });

    const content = (pi as unknown as { _calls: { content: string }[] })._calls[0].content;
    assert.ok(/…\(truncated [\d.]+ (B|KB|MB)\)/.test(content), "the 50-char setting truncates a sub-400 dump");
    assert.ok(!content.includes("z".repeat(200)), "the body is cut at the configured threshold");
    assert.ok(content.includes(join("/runs", "test-run-1.json")), "pointer still appended");
  });

  // ── installResultDelivery: guard / stale ctx ──

  it("installs delivery only once — second call skips listener registration", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    // Second call: should only refresh holder.pi, not add another listener
    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);

    manager.emit("complete", { runId: "test-run-1" });
    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 1); // exactly once, not twice
  });

  it("does not crash when sendMessage throws (stale ctx after reload)", () => {
    const pi = {
      sendMessage: (_msg: unknown, _opts?: unknown) => {
        throw new Error("This extension ctx is stale");
      },
      registerTool: () => {},
      on: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      reload: () => Promise.resolve(),
    };
    const manager = createMockManager(makeRun());

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    // Should not throw — stale ctx is silently swallowed
    manager.emit("complete", { runId: "test-run-1" });
    assert.ok(true, "should not throw"); // reached without crash
  });

  // ── Only background runs are delivered ──

  it("skips delivery for foreground runs (background=false)", () => {
    const pi = createMockPi();
    const run = makeRun({ background: false });
    const manager = createMockManager(run);

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 0);
  });

  // ── Error event ──

  it("delivers error message on error event for background runs", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("error", { runId: "test-run-1", error: { message: "Something went wrong" } });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 1);
    assert.ok(calls[0].content.includes("failed"), "should contain failed");
    assert.ok(calls[0].content.includes("Something went wrong"), "should contain Something went wrong");
  });

  it("skips error delivery for foreground runs", () => {
    const pi = createMockPi();
    const run = makeRun({ background: false });
    const manager = createMockManager(run);

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("error", { runId: "test-run-1", error: { message: "fail" } });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 0);
  });

  // ── Paused (usage-limit checkpoint) event ──

  it("delivers a resumable checkpoint message on a usage-limit paused event", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("paused", {
      runId: "test-run-1",
      reason: "usage_limit",
      error: { message: "Codex usage limit reached (plus plan)." },
      resetHint: "Resets in ~3h",
    });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 1);
    assert.ok(calls[0].content.includes("paused"), "should say paused");
    assert.ok(calls[0].content.includes("/workflows resume test-run-1"), "should name the resume command");
    assert.ok(calls[0].content.includes("Resets in ~3h"), "should include the reset hint");
    assert.ok(!calls[0].content.includes("failed"), "should not say failed");
  });

  it("ignores a manual pause (no reason) — no delivery", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("paused", { runId: "test-run-1" });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 0);
  });

  it("skips usage-limit pause delivery for foreground runs", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun({ background: false }));

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("paused", { runId: "test-run-1", reason: "usage_limit", error: { message: "usage limit" } });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 0);
  });

  // ── Holder refresh on re-call ──

  it("refreshes holder.pi on second call for stale ctx recovery", () => {
    const pi1 = createMockPi();
    const pi2 = createMockPi();
    const manager = createMockManager(makeRun());

    // Install with first pi
    mod.installResultDelivery(pi1 as unknown as ExtensionAPI, manager);
    // Re-call with second pi (fresh after reload)
    mod.installResultDelivery(pi2 as unknown as ExtensionAPI, manager);

    manager.emit("complete", { runId: "test-run-1" });

    const calls1 = (pi1 as unknown as { _calls: { content: string }[] })._calls;
    const calls2 = (pi2 as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls1.length, 0, "pi1 should not be used after refresh");
    assert.equal(calls2.length, 1, "pi2 should receive the delivery");
  });

  // ── Failure UX: abort suppression, coded failure text, notify ──

  it("suppresses the failure message for a user-stopped run (aborted status)", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun({ status: "aborted" }));

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("error", { runId: "test-run-1", error: { message: "workflow aborted", code: "WORKFLOW_ABORTED" } });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 0, "a manual stop is a user action, not a failure to report");
  });

  it("delivers the coded failure text with a resume hint for a real failure", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun({ status: "failed" }));

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.emit("error", {
      runId: "test-run-1",
      error: { message: "subagent timed out", code: "AGENT_TIMEOUT", recoverable: true },
    });

    const calls = (pi as unknown as { _calls: { content: string }[] })._calls;
    assert.equal(calls.length, 1);
    assert.ok(calls[0].content.includes("[AGENT_TIMEOUT]"), "machine error code shown");
    assert.ok(calls[0].content.includes("subagent timed out"), "message shown");
    assert.ok(calls[0].content.includes("/workflows resume test-run-1"), "resume is the named next action");
  });

  it("notifies on terminal states when a notify handler is provided", () => {
    const pi = createMockPi();
    const notes: Array<{ message: string; type?: string }> = [];
    const manager = createMockManager(makeRun({ status: "completed" }));

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager, {
      notify: (message: string, type?: string) => notes.push({ message, type }),
    });
    manager.emit("complete", { runId: "test-run-1" });

    assert.ok(
      notes.some((n) => n.type === "info" && n.message.includes("test-workflow")),
      `completion banner fired: ${JSON.stringify(notes)}`,
    );
  });

  it("falls back to notify when chat delivery fails (stale ctx)", () => {
    const pi = {
      sendMessage: () => {
        throw new Error("This extension ctx is stale");
      },
      registerTool: () => {},
      on: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      reload: () => Promise.resolve(),
    };
    const notes: Array<{ message: string; type?: string }> = [];
    const manager = createMockManager(makeRun({ status: "completed" }));

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager, {
      notify: (message: string, type?: string) => notes.push({ message, type }),
    });
    manager.emit("complete", { runId: "test-run-1" });

    assert.ok(
      notes.some((n) => n.type === "warning" && n.message.includes("could not be delivered")),
      `fallback warning fired: ${JSON.stringify(notes)}`,
    );
  });
});

// ─── installTaskPanel ─────────────────────────────────────────────────────────

describe("installTaskPanel", () => {
  it("registers a widget named workflow-tasks with belowEditor placement", () => {
    const manager = new EventEmitter() as ReturnType<typeof EventEmitter> & {
      getRun: (...args: unknown[]) => unknown;
      listRuns: () => unknown[];
    };
    manager.getRun = () => null;
    manager.listRuns = () => [];

    let registeredName = "";
    let registeredPlacement = "";
    const ui = {
      setWidget: (name: string, _factory: unknown, opts: { placement?: string }) => {
        registeredName = name;
        registeredPlacement = opts.placement ?? "";
      },
    };

    mod.installTaskPanel(null, manager, ui);
    assert.equal(registeredName, "workflow-tasks");
    assert.equal(registeredPlacement, "belowEditor");
  });

  it("passes the render width through to the task panel", () => {
    const manager = new EventEmitter() as ReturnType<typeof EventEmitter> & {
      getRun: (...args: unknown[]) => unknown;
      listRuns: () => unknown[];
    };
    manager.getRun = () => undefined;
    manager.listRuns = () => [
      {
        runId: "a",
        workflowName: "handle_gh_issues_11_12_with_a_long_suffix",
        status: "running",
        agents: [{ status: "done" }, { status: "running" }],
        logs: [],
      },
    ];

    let factory:
      | ((
          tui: { requestRender(): void },
          theme: { fg(color: string, text: string): string; bold(text: string): string },
        ) => { render(width: number): string[] })
      | undefined;
    const ui = {
      setWidget: (_name: string, registeredFactory: typeof factory) => {
        factory = registeredFactory;
      },
    };
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

    mod.installTaskPanel(null, manager, ui);
    const component = factory?.({ requestRender: () => {} }, theme);
    const lines = component?.render(24) ?? [];

    assert.ok(lines.length > 0, "panel should render active runs");
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= 24, `line exceeds width: ${visibleWidth(line)} > 24`);
    }
  });
});

describe("renderPanel", () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

  it("hints that finished runs are kept in /workflows history", async () => {
    const { renderPanel } = await import("../../src/workflows/task-panel.js");
    const manager = {
      listRuns: () => [
        { runId: "a", workflowName: "live", status: "running", agents: [{ status: "done" }], logs: [] },
        { runId: "b", workflowName: "old", status: "completed", agents: [], logs: [] },
        { runId: "c", workflowName: "older", status: "aborted", agents: [], logs: [] },
      ],
      getRun: () => undefined,
    };
    const lines = renderPanel(manager as never, theme as never);
    assert.ok(
      lines.some((l) => /2 finished kept in history/.test(l)),
      "hint should report the finished-run count",
    );
    assert.ok(
      lines.some((l) => l.includes("/workflows")),
      "hint should point at /workflows",
    );
  });

  it("renders nothing when no run is active", async () => {
    const { renderPanel } = await import("../../src/workflows/task-panel.js");
    const manager = {
      listRuns: () => [{ runId: "b", workflowName: "old", status: "completed", agents: [], logs: [] }],
      getRun: () => undefined,
    };
    assert.deepEqual(renderPanel(manager as never, theme as never), []);
  });

  it("truncates every rendered line to the requested visible width", async () => {
    const { renderPanel } = await import("../../src/workflows/task-panel.js");
    const ansiTheme = {
      fg: (_c: string, t: string) => `\x1b[2m${t}\x1b[22m`,
      bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
    };
    const manager = {
      listRuns: () => [
        {
          runId: "a",
          workflowName: "handle_gh_issues_11_12_中文_🙂_very_long_workflow_name",
          status: "running",
          agents: [{ status: "done" }, { status: "running" }],
          logs: [],
        },
        { runId: "b", workflowName: "old", status: "completed", agents: [], logs: [] },
      ],
      getRun: () => ({
        snapshot: {
          currentPhase: "Issue implementation phase with a very long suffix",
          agents: [{ status: "done" }, { status: "running" }],
        },
      }),
    };

    const lines = renderPanel(manager as never, ansiTheme as never, 42);

    assert.ok(lines.length > 0, "panel should render active runs");
    assert.ok(
      lines.some((line) => line.includes("...")),
      "at least one line should be truncated",
    );
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= 42, `line exceeds width: ${visibleWidth(line)} > 42`);
    }
  });

  it("appends a red '✗ N failed' line beneath a run with failed agents", async () => {
    const { renderPanel } = await import("../../src/workflows/task-panel.js");
    const agents = [
      { status: "done", label: "gather" },
      { status: "error", label: "verify_claims", error: "provider 500 after 3 retries" },
      { status: "error", label: "cross_check", error: "timeout" },
    ];
    const manager = {
      listRuns: () => [{ runId: "a", workflowName: "audit", status: "running", agents, logs: [] }],
      getRun: (id: string) => (id === "a" ? { snapshot: { agents } } : undefined),
    };
    const lines = renderPanel(manager as never, theme as never);
    const failLine = lines.find((l) => l.includes("failed")) ?? "";
    assert.match(failLine, /✗ 2 failed/);
    assert.ok(failLine.includes("verify_claims"), `names the first failed agent: ${failLine}`);
    assert.ok(failLine.includes("provider 500"), `carries the short error: ${failLine}`);
    // A healthy run renders no failed line.
    const healthy = {
      listRuns: () => [{ runId: "h", workflowName: "ok", status: "running", agents: [{ status: "done" }], logs: [] }],
      getRun: () => undefined,
    };
    assert.ok(
      !renderPanel(healthy as never, theme as never).some((l) => l.includes("failed")),
      "healthy run must not render a failed line",
    );
  });
});

// ─── per-agent stall flag ────────────────────────────────────────────────────────

describe("agentStallFlag", () => {
  it("flags a running agent quiet ≥90s and stays silent otherwise", async () => {
    const { agentStallFlag } = await import("../../src/workflows/task-panel.js");
    const now = 1_000_000;
    // Running + last event 2m ago → stalled.
    assert.match(agentStallFlag({ status: "running", lastEventAt: now - 120_000 }, now), /no activity 2m ago/);
    // Running but recent (30s) → no flag.
    assert.equal(agentStallFlag({ status: "running", lastEventAt: now - 30_000 }, now), "");
    // Not running → never flagged, even if old.
    assert.equal(agentStallFlag({ status: "done", lastEventAt: now - 600_000 }, now), "");
    // No event stamp yet → no flag.
    assert.equal(agentStallFlag({ status: "running" }, now), "");
  });
});

// ─── detailed progress panel ─────────────────────────────────────────────────────

describe("renderPanelDetailed", () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

  // `blueTokens` drives the first agent's live token count; the run aggregate and
  // token/s are summed from per-agent tokens (the run-level tokenUsage aggregate is
  // not live — see renderPanelDetailed), so growing blueTokens grows the rate.
  function detailedManager(blueTokens: number, status = "running") {
    const snapshot = {
      name: "auth_audit",
      phases: ["Scan", "Review"],
      currentPhase: "Scan",
      logs: [],
      agents: [
        {
          id: 1,
          label: "discover_routes",
          status: "done",
          phase: "Scan",
          tokens: blueTokens,
          model: "anthropic/claude-haiku-4-5",
        },
        { id: 2, label: "audit_auth", status: "running", phase: "Scan", tokens: 1800 },
        { id: 3, label: "scan_middleware", status: "queued", phase: "Scan" },
        { id: 4, label: "cross_check", status: "queued", phase: "Review" },
      ],
      // Only `cost` is read from the run-level aggregate (it lands when the run ends).
      tokenUsage: { total: 0, input: 0, output: 0, cost: 0.02 },
    };
    return {
      listRuns: () => [
        { runId: "r1", workflowName: "auth_audit", status, agents: snapshot.agents, tokenUsage: snapshot.tokenUsage },
      ],
      getRun: (id: string) => (id === "r1" ? { snapshot, status } : undefined),
    };
  }

  it("renders a per-agent fresh/cache split when tokenUsage is present", async () => {
    const { renderPanelDetailed } = await import("../../src/workflows/task-panel.js");
    const snapshot = {
      name: "wf",
      phases: ["Scan"],
      currentPhase: "Scan",
      logs: [],
      agents: [
        {
          id: 1,
          label: "cached_agent",
          status: "done",
          phase: "Scan",
          tokens: 3100000,
          // Opus-style: little fresh input+output, most of it cheap cache reads.
          tokenUsage: { input: 80000, output: 20000, total: 3100000, cacheRead: 3000000, cacheWrite: 0, cost: 0.4 },
          model: "github-copilot/claude-opus-4.8",
        },
      ],
      tokenUsage: { total: 0, input: 0, output: 0, cost: 0 },
    };
    const manager = {
      listRuns: () => [
        {
          runId: "r2",
          workflowName: "wf",
          status: "running",
          agents: snapshot.agents,
          tokenUsage: snapshot.tokenUsage,
        },
      ],
      getRun: (id: string) => (id === "r2" ? { snapshot, status: "running" } : undefined),
    };
    const lines = renderPanelDetailed(manager as never, theme as never, undefined, 8, 1000);
    assert.ok(
      lines.some((l) => l.includes("[1] ✓ cached_agent") && /100\.0K tok/.test(l) && /3\.0M cached/.test(l)),
      `expected a per-agent tok/cached row, got:\n${lines.join("\n")}`,
    );
  });

  it("keeps the scalar estimate for cost-only agents instead of a zero breakdown (#57 regression)", async () => {
    const { renderPanelDetailed } = await import("../../src/workflows/task-panel.js");
    const snapshot = {
      name: "wf3",
      phases: ["P"],
      currentPhase: "P",
      logs: [],
      agents: [
        {
          id: 1,
          label: "cost_only",
          status: "done",
          phase: "P",
          tokens: 384,
          // Provider billed cost but reported zero token counts.
          tokenUsage: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
        },
      ],
      tokenUsage: { total: 0, input: 0, output: 0, cost: 0.02 },
    };
    const manager = {
      listRuns: () => [
        {
          runId: "r3",
          workflowName: "wf3",
          status: "running",
          agents: snapshot.agents,
          tokenUsage: snapshot.tokenUsage,
        },
      ],
      getRun: (id: string) => (id === "r3" ? { snapshot, status: "running" } : undefined),
    };
    const lines = renderPanelDetailed(manager as never, theme as never, undefined, 8, 1000);
    assert.ok(
      lines.some((l) => l.includes("[1] ✓ cost_only") && /384 tok/.test(l)),
      `cost-only agent should show its scalar estimate, got:\n${lines.join("\n")}`,
    );
    // The run header guard must agree with the value it gates (no "0 tok" beside a real cost).
    assert.ok(
      lines.some((l) => /wf3/.test(l) && /384 tok/.test(l) && /\$0\.02/.test(l)),
      `run header should show the estimate and the cost, got:\n${lines.join("\n")}`,
    );
    assert.ok(!lines.some((l) => /\b0 tok/.test(l)), `no zero breakdown anywhere:\n${lines.join("\n")}`);
  });

  it("renders aggregate tokens, cost, phases, and per-agent rows", async () => {
    const { renderPanelDetailed } = await import("../../src/workflows/task-panel.js");
    // discover_routes 2100 + audit_auth 1800 = 3900 → "3.9K tok" aggregate.
    const lines = renderPanelDetailed(detailedManager(2100) as never, theme as never, undefined, 8, 1000);
    const text = lines.join("\n");

    assert.ok(/auth_audit/.test(text), "shows the run name");
    assert.ok(/1\/4 agents/.test(text), "shows done/total agents");
    assert.ok(/3\.9K tok/.test(text), "shows aggregate tokens summed from per-agent tokens");
    assert.ok(/\$0\.02/.test(text), "shows cost");
    // Phase headers
    assert.ok(
      lines.some((l) => l.includes("▶ Scan") && /1\/3 agents/.test(l) && /3\.9K tok/.test(l)),
      "Scan phase header with subtotal",
    );
    assert.ok(
      lines.some((l) => l.includes("Review") && /0\/1 agents/.test(l)),
      "Review phase header",
    );
    // Agent rows: status icons + label + tokens + model
    assert.ok(
      lines.some((l) => l.includes("[1] ✓ discover_routes") && /2\.1K tok/.test(l) && /claude-haiku-4-5/.test(l)),
      "done agent row with model",
    );
    assert.ok(
      lines.some((l) => l.includes("[2] ● audit_auth") && /1\.8K tok/.test(l)),
      "running agent row",
    );
    assert.ok(
      lines.some((l) => l.includes("[3] ○ scan_middleware")),
      "queued agent row",
    );
  });

  it("shows run elapsed instead of a token rate", async () => {
    const { renderPanelDetailed } = await import("../../src/workflows/task-panel.js");
    // The run started 3m12s before `now`; elapsed replaces the removed tok/s slot.
    const start = new Date(1000 - 192_000);
    const mgr = detailedManager(2100);
    const baseGetRun = mgr.getRun;
    mgr.getRun = (id: string) => {
      const run = baseGetRun(id) as { snapshot: unknown; status: string } | undefined;
      return run ? { ...run, startedAt: start } : undefined;
    };
    const lines = renderPanelDetailed(mgr as never, theme as never, undefined, 8, 1000);
    const text = lines.join("\n");
    assert.ok(/3m12s/.test(text), `expected run elapsed, got:\n${text}`);
    assert.ok(!/tok\/s/.test(text), "no token rate readout anymore");
  });

  it("flags a running agent that has gone quiet (no activity)", async () => {
    const { renderPanelDetailed } = await import("../../src/workflows/task-panel.js");
    const now = 1_000_000;
    const snapshot = {
      name: "wf",
      phases: ["P"],
      currentPhase: "P",
      logs: [],
      agents: [
        // Running but last event 2m ago → stalled.
        { id: 1, label: "stuck_agent", status: "running", phase: "P", lastEventAt: now - 120_000 },
      ],
      tokenUsage: { total: 0, input: 0, output: 0, cost: 0 },
    };
    const manager = {
      listRuns: () => [{ runId: "rs", workflowName: "wf", status: "running", agents: snapshot.agents }],
      getRun: (id: string) => (id === "rs" ? { snapshot, status: "running" } : undefined),
    };
    const lines = renderPanelDetailed(manager as never, theme as never, undefined, 8, now);
    assert.ok(
      lines.some((l) => l.includes("stuck_agent") && /no activity 2m ago/.test(l)),
      `expected a per-agent stall flag, got:\n${lines.join("\n")}`,
    );
  });

  it("caps agents per phase and reports the overflow", async () => {
    const { renderPanelDetailed } = await import("../../src/workflows/task-panel.js");
    const lines = renderPanelDetailed(detailedManager(12400) as never, theme as never, undefined, 2, 1000);
    const text = lines.join("\n");
    // Scan has 3 agents, cap 2 → most recent 2 shown + "… 1 earlier agents"
    assert.ok(/… 1 earlier agents/.test(text), "overflow line present");
    assert.ok(!/discover_routes/.test(text), "oldest agent hidden when capped");
    assert.ok(/audit_auth/.test(text) && /scan_middleware/.test(text), "most recent agents shown");
  });
});

// ─── mode selection in installTaskPanel ───────────────────────────────────────────

describe("installTaskPanel mode selection", () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

  function activeManager() {
    const manager = new EventEmitter() as ReturnType<typeof EventEmitter> & {
      getRun: (id: string) => unknown;
      listRuns: () => unknown[];
    };
    const snapshot = {
      name: "wf",
      phases: ["P1"],
      currentPhase: "P1",
      logs: [],
      agents: [{ id: 1, label: "a", status: "running", phase: "P1", tokens: 500 }],
      tokenUsage: { total: 500, input: 250, output: 250 },
    };
    manager.listRuns = () => [
      { runId: "r1", workflowName: "wf", status: "running", agents: snapshot.agents, tokenUsage: snapshot.tokenUsage },
    ];
    manager.getRun = (id: string) => (id === "r1" ? { snapshot, status: "running" } : undefined);
    return manager;
  }

  function captureRender(loadSettings?: () => Record<string, unknown>) {
    const manager = activeManager();
    let factory:
      | ((tui: { requestRender(): void }, theme: unknown) => { render(w: number): string[]; dispose?(): void })
      | undefined;
    const ui = {
      setWidget: (_n: string, f: typeof factory) => {
        factory = f;
      },
    };
    mod.installTaskPanel(null, manager as never, ui as never, { loadSettings } as never);
    const comp = factory?.({ requestRender: () => {} }, theme);
    const lines = comp?.render(120) ?? [];
    comp?.dispose?.();
    return lines;
  }

  it("uses compact rendering when no loadSettings is provided", () => {
    const lines = captureRender();
    assert.ok(
      lines.some((l) => /1 agents/.test(l)),
      "compact one-liner",
    );
    assert.ok(!lines.some((l) => /▶ P1/.test(l)), "no per-phase detail in compact");
  });

  it("uses compact rendering when the mode is compact", () => {
    const lines = captureRender(() => ({ progressPanelMode: "compact" }));
    assert.ok(!lines.some((l) => /▶ P1/.test(l)), "no per-phase detail in compact");
  });

  it("uses detailed rendering when the mode is detailed", () => {
    const lines = captureRender(() => ({ progressPanelMode: "detailed" }));
    assert.ok(
      lines.some((l) => /▶ P1/.test(l)),
      "per-phase detail in detailed mode",
    );
    assert.ok(
      lines.some((l) => /\[1\] ● a/.test(l)),
      "per-agent row in detailed mode",
    );
  });
});

// ─── deliverText: pointer + truncation threshold ─────────────────────────────────

describe("deliverText", () => {
  function makeResult(result: unknown) {
    return { snapshot: { name: "wf", agentCount: 1 }, result: { agentCount: 1, result } };
  }

  it("appends the Full result pointer to a verdict result without altering it", async () => {
    const { deliverText } = await import("../../src/workflows/task-panel.js");
    // A verdict longer than the default cap must still pass through in full: the
    // verdict branch is never subject to the JSON-dump truncation.
    const verdict = "V".repeat(600);
    const text = deliverText(makeResult({ verdict }) as never, { resultPath: "/r/x.json" });
    assert.ok(text.includes(verdict), "long verdict passed through in full");
    assert.ok(text.includes("↳ Full result: /r/x.json"), "pointer appended");
    assert.ok(!/truncated/.test(text), "verdict branch bypasses truncation");
  });

  it("does not append a pointer when no resultPath is given", async () => {
    const { deliverText } = await import("../../src/workflows/task-panel.js");
    const text = deliverText(makeResult("plain string") as never);
    assert.ok(text.includes("plain string"), "string result passed through");
    assert.ok(!text.includes("Full result:"), "no pointer without a resultPath");
  });

  it("leaves a small JSON dump untouched (no truncation marker)", async () => {
    const { deliverText } = await import("../../src/workflows/task-panel.js");
    const text = deliverText(makeResult({ ok: true, changed: 2 }) as never, { resultPath: "/r/x.json" });
    assert.ok(text.includes('"ok": true'), "full JSON shown");
    assert.ok(!/truncated/.test(text), "no truncation under the threshold");
    assert.ok(text.includes("↳ Full result: /r/x.json"), "pointer still appended");
  });

  it("truncates the JSON dump at maxChars and reports the dropped size", async () => {
    const { deliverText } = await import("../../src/workflows/task-panel.js");
    const text = deliverText(makeResult({ note: "x".repeat(500) }) as never, {
      resultPath: "/r/x.json",
      maxChars: 100,
    });
    assert.ok(/…\(truncated [\d.]+ (B|KB|MB)\)/.test(text), "size hint present");
    assert.ok(text.includes("↳ Full result: /r/x.json"), "pointer still appended");
    // Body is capped near maxChars, so the 500-char tail is not delivered in full.
    assert.ok(!text.includes("x".repeat(500)), "the full tail is not inlined");
  });

  it("defaults the JSON-dump threshold to 400 chars", async () => {
    const { deliverText } = await import("../../src/workflows/task-panel.js");
    // JSON length is note length + 16, so 380 → 396 (under 400) and 390 → 406 (over),
    // bracketing the default threshold tightly around 400.
    const under = deliverText(makeResult({ note: "y".repeat(380) }) as never);
    assert.ok(!/truncated/.test(under), "a 396-char dump is under the default 400");
    const over = deliverText(makeResult({ note: "y".repeat(390) }) as never);
    assert.ok(/…\(truncated/.test(over), "a 406-char dump exceeds the default 400");
  });
});

// ─── failureText ────────────────────────────────────────────────────────────────

describe("failureText", () => {
  it("names the error code and the resume command for recoverable failures", async () => {
    const { failureText } = await import("../../src/workflows/task-panel.js");
    const text = failureText("run-1", { message: "timed out", code: "AGENT_TIMEOUT", recoverable: true });
    assert.ok(text.includes("[AGENT_TIMEOUT]"), "machine code shown");
    assert.ok(text.includes("timed out"), "message shown");
    assert.ok(text.includes("/workflows resume run-1"), "resume is the named next action");
  });

  it("treats a missing recoverable flag as resumable", async () => {
    const { failureText } = await import("../../src/workflows/task-panel.js");
    const text = failureText("run-2", { message: "boom" });
    assert.ok(text.includes("/workflows resume run-2"));
  });

  it("says a non-recoverable failure won't resolve by re-running", async () => {
    const { failureText } = await import("../../src/workflows/task-panel.js");
    const text = failureText("run-3", {
      message: "bad script",
      code: "SCRIPT_VALIDATION_ERROR",
      recoverable: false,
    });
    assert.ok(text.includes("[SCRIPT_VALIDATION_ERROR]"));
    assert.ok(text.includes("won't resolve by re-running"));
    assert.ok(!text.includes("/workflows resume"), "no resume hint for a non-resumable failure");
  });

  it("omits the bracket for UNKNOWN codes", async () => {
    const { failureText } = await import("../../src/workflows/task-panel.js");
    const text = failureText("run-4", { message: "mystery", code: "UNKNOWN" });
    assert.ok(!text.includes("[UNKNOWN]"), "no meaningless bracket");
    assert.ok(text.includes("mystery"));
  });
});

// ─── fmtAgo ─────────────────────────────────────────────────────────────────────

describe("fmtAgo", () => {
  it("buckets sub-minute, minute, and hour ages", async () => {
    const { fmtAgo } = await import("../../src/workflows/task-panel.js");
    const t0 = 1_000_000;
    assert.equal(fmtAgo(t0, t0), "just now");
    assert.equal(fmtAgo(t0, t0 - 12_000), "12s ago");
    assert.equal(fmtAgo(t0, t0 - 3 * 60_000), "3m ago");
    assert.equal(fmtAgo(t0, t0 - 65 * 60_000), "1h5m ago");
  });
});

// ─── deliverText: confidence signals ────────────────────────────────────────────

describe("deliverText confidence signals", () => {
  function makeRunWith(resultExtra: Record<string, unknown>) {
    return {
      snapshot: { name: "wf", agentCount: 2 },
      result: { agentCount: 2, result: { verdict: "done" }, ...resultExtra },
    };
  }

  it("renders the cross-checks line when quality helpers ran", async () => {
    const { deliverText } = await import("../../src/workflows/task-panel.js");
    const text = deliverText(
      makeRunWith({
        quality: {
          verify: { checks: 7, confirmed: 5, votes: 14 },
          judge: { panels: 2, candidates: 6, bestScore: 0.83 },
          completeness: { runs: 1, incomplete: 1, gaps: 3 },
        },
      }) as never,
    );
    assert.ok(text.includes("Cross-checks: verify 5/7 confirmed (14 votes)"), `verify segment: ${text}`);
    assert.ok(text.includes("judge best 0.83 (2 panels)"), `judge segment: ${text}`);
    assert.ok(text.includes("completeness: 3 gaps flagged"), `completeness segment: ${text}`);
  });

  it("omits the cross-checks line when no quality helper ran", async () => {
    const { deliverText } = await import("../../src/workflows/task-panel.js");
    const text = deliverText(
      makeRunWith({
        quality: {
          verify: { checks: 0, confirmed: 0, votes: 0 },
          judge: { panels: 0, candidates: 0, bestScore: 0 },
          completeness: { runs: 0, incomplete: 0, gaps: 0 },
        },
      }) as never,
    );
    assert.ok(!text.includes("Cross-checks:"), "nothing to report");
  });

  it("warns about checkpoints that auto-approved in the background", async () => {
    const { deliverText } = await import("../../src/workflows/task-panel.js");
    const text = deliverText(
      makeRunWith({
        autoCheckpoints: [
          { prompt: "Delete the old table?", reply: true },
          { prompt: "Ship it?", reply: true },
        ],
      }) as never,
    );
    assert.ok(text.includes("⚠ 2 checkpoints auto-approved"), `warning line: ${text}`);
    assert.ok(text.includes('"Delete the old table?"'), "names the prompts");
  });

  it("stays silent when every checkpoint was human-approved", async () => {
    const { deliverText } = await import("../../src/workflows/task-panel.js");
    const text = deliverText(makeRunWith({}) as never);
    assert.ok(!text.includes("auto-approved"), "no warning without auto checkpoints");
  });
});

// ─── renderPanel compact meta: tokens / cost / liveness / auto-checkpoints ──────

describe("renderPanel compact meta", () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

  it("shows tokens, cost, liveness, and the auto-checkpoint marker", async () => {
    const { renderPanel, noteActivity, clearActivity } = await import("../../src/workflows/task-panel.js");
    const now = 1_000_000;
    clearActivity("ra");
    noteActivity("ra", now - 30_000);
    const agentRow = {
      status: "done",
      tokens: 2100,
      tokenUsage: { input: 1500, output: 600, total: 2100, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
    };
    const manager = {
      listRuns: () => [
        {
          runId: "ra",
          workflowName: "audit",
          status: "running",
          updatedAt: new Date(now - 90_000).toISOString(),
          agents: [agentRow, { status: "running" }],
          logs: [],
        },
      ],
      getRun: (id: string) =>
        id === "ra"
          ? {
              snapshot: {
                currentPhase: "Scan",
                autoCheckpointCount: 2,
                agents: [agentRow, { status: "running" }],
              },
            }
          : undefined,
    };
    const lines = renderPanel(manager as never, theme as never, undefined, now);
    clearActivity("ra");
    const row = lines.find((l) => l.includes("audit")) ?? "";
    assert.ok(row.includes("1/2 agents"), row);
    assert.ok(row.includes("Scan"), row);
    assert.ok(/2\.1K tok/.test(row), row);
    assert.ok(row.includes("$0.01"), row);
    assert.ok(row.includes("⚠2 auto-checkpoints"), row);
    assert.ok(row.includes("updated 30s ago"), `event-driven liveness beats the stale updatedAt: ${row}`);
  });

  it("falls back to the persisted updatedAt when no live event was seen", async () => {
    const { renderPanel, clearActivity } = await import("../../src/workflows/task-panel.js");
    const now = 1_000_000;
    clearActivity("rb");
    const manager = {
      listRuns: () => [
        {
          runId: "rb",
          workflowName: "stale",
          status: "running",
          updatedAt: new Date(now - 45_000).toISOString(),
          agents: [{ status: "running" }],
          logs: [],
        },
      ],
      getRun: () => undefined,
    };
    const lines = renderPanel(manager as never, theme as never, undefined, now);
    assert.ok((lines.find((l) => l.includes("stale")) ?? "").includes("updated 45s ago"), lines.join("\n"));
  });
});
