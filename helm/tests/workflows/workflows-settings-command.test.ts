/**
 * Tests for workflows-settings-command.ts
 *
 * pi.registerCommand and ctx.ui are only available inside Pi at runtime, so the
 * tests fake them the same way tests/workflows-models-command.test.ts does: capture
 * the handler from a mock pi, drive ctx.ui.select with a scripted answer queue, and
 * inject an in-memory settings store so no real ~/.pi files are touched.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

async function loadCommand() {
  return import("../../src/workflows/workflows-settings-command.js");
}

type Handler = (args: string, ctx: unknown) => Promise<void>;

function fakePi() {
  const sent: { customType: string; content: string; display?: boolean }[] = [];
  const captured: { name?: string; description?: string; handler?: Handler } = {};
  const pi = {
    registerCommand: mock.fn((name: string, opts: { description?: string; handler: Handler }) => {
      captured.name = name;
      captured.description = opts.description;
      captured.handler = opts.handler;
    }),
    sendMessage: mock.fn(async (message: { customType: string; content: string; display?: boolean }) => {
      sent.push(message);
    }),
  };
  return { pi, sent, captured };
}

/** In-memory WorkflowSettingsStore; `settings` reflects every save. */
function fakeStore(initial: Record<string, unknown> = {}) {
  const settings: Record<string, unknown> = { ...initial };
  const store = {
    load: () => ({ ...settings }),
    save: (next: Record<string, unknown>) => {
      Object.assign(settings, next);
    },
  };
  return { settings, store };
}

/** ctx with a scripted select(): each call shifts one answer; undefined = Esc. */
function fakeCtx(answers: (string | undefined)[]) {
  const queue = [...answers];
  const selectCalls: { title: string; options: string[] }[] = [];
  const notifications: { message: string; type?: string }[] = [];
  const ctx = {
    hasUI: true,
    model: undefined,
    ui: {
      select: mock.fn(async (title: string, options: string[]) => {
        selectCalls.push({ title, options });
        return queue.shift();
      }),
      notify: mock.fn((message: string, type?: string) => {
        notifications.push({ message, type });
      }),
    },
  };
  return { ctx, selectCalls, notifications };
}

describe("workflows-settings-command", () => {
  it("registers the workflows-settings command with a description", async () => {
    const { registerWorkflowSettingsCommand } = await loadCommand();
    const { pi, captured } = fakePi();

    registerWorkflowSettingsCommand(pi as never);

    assert.equal(captured.name, "workflows-settings");
    assert.ok(captured.description && captured.description.length > 0, "description should not be empty");
  });

  it("prints a summary with current values and change commands when headless", async () => {
    const { registerWorkflowSettingsCommand } = await loadCommand();
    const { pi, sent, captured } = fakePi();
    const { store } = fakeStore({
      keywordTriggerEnabled: true,
      keywordTriggerWord: "deploy",
      progressPanelMode: "detailed",
      progressPanelMaxAgents: 42,
    });
    const effort = { level: "high" as const };
    registerWorkflowSettingsCommand(pi as never, { effort, settingsStore: store as never });

    const ctx = { hasUI: false, model: undefined, ui: { notify: mock.fn() } };
    await captured.handler?.("", ctx as never);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].customType, "workflows-settings");
    assert.equal(sent[0].display, true);
    const text = sent[0].content;
    assert.match(text, /Model tiers —/);
    assert.match(text, /\/workflows-models/);
    assert.match(text, /Keyword trigger — on \("deploy"\)/);
    assert.match(text, /\/workflows-trigger on \| off \| set <word>/);
    assert.match(text, /Progress panel — detailed/);
    assert.match(text, /\/workflows-progress compact \| detailed/);
    assert.match(text, /Progress max agents — 42/);
    assert.match(text, /\/workflows-progress-max <1-1000>/);
    assert.match(text, /Effort — high/);
    assert.match(text, /\/effort off \| high \| ultra/);
  });

  it("switches the progress panel mode inline and re-renders the refreshed menu", async () => {
    const { registerWorkflowSettingsCommand } = await loadCommand();
    const { pi, captured } = fakePi();
    const { settings, store } = fakeStore();
    registerWorkflowSettingsCommand(pi as never, { settingsStore: store as never });

    const { ctx, selectCalls, notifications } = fakeCtx(["Progress panel — compact", "detailed", "Close"]);
    await captured.handler?.("", ctx as never);

    assert.equal(settings.progressPanelMode, "detailed");
    const mainMenus = selectCalls.filter((c) => c.title === "Workflow settings");
    assert.equal(mainMenus.length, 2, "menu loops back after a change");
    assert.ok(mainMenus[1].options.includes("Progress panel — detailed"), "refreshed menu shows the new value");
    assert.ok(
      notifications.some((n) => n.message.includes("detailed")),
      "change is notified",
    );
  });

  it("applies effort via the shared state and exits on Esc", async () => {
    const { registerWorkflowSettingsCommand } = await loadCommand();
    const { pi, captured } = fakePi();
    const effort = { level: "off" as "off" | "high" | "ultra" };
    registerWorkflowSettingsCommand(pi as never, { effort, settingsStore: fakeStore().store as never });

    const { ctx, selectCalls } = fakeCtx(["Effort — off", "ultra", undefined]);
    await captured.handler?.("", ctx as never);

    assert.equal(effort.level, "ultra");
    const mainMenus = selectCalls.filter((c) => c.title === "Workflow settings");
    assert.equal(mainMenus.length, 2, "second render happens before Esc");
    assert.ok(mainMenus[1].options.includes("Effort — ultra"));
  });

  it("defers custom trigger words to /workflows-trigger set", async () => {
    const { registerWorkflowSettingsCommand } = await loadCommand();
    const { pi, captured } = fakePi();
    const { settings, store } = fakeStore();
    registerWorkflowSettingsCommand(pi as never, { settingsStore: store as never });

    const { ctx, notifications } = fakeCtx(['Keyword trigger — on ("workflow")', "Set custom trigger word", "Close"]);
    await captured.handler?.("", ctx as never);

    assert.ok(
      notifications.some((n) => n.type === "info" && n.message.includes("/workflows-trigger set <word>")),
      "points at the dedicated command",
    );
    assert.deepEqual(settings, {}, "nothing persisted for a deferred edit");
  });
});
