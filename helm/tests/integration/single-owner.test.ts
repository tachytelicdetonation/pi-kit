/**
 * SINGLE-PANEL OWNERSHIP + composition-root guards.
 *
 * helm is the one UI owner on top of pi: the usage footer is the default in the
 * normal REPL, `/helm` suspends it and owns the full screen, and on exit the USAGE
 * footer is restored (never the built-in, never setFooter(undefined)). Workflow /
 * cmux permission prompts route INTO helm's escalation queue rather than drawing a
 * second ctx.ui surface. Capabilities probe once and degrade gracefully.
 *
 * Imports are intentionally static: a missing host module fails this suite instead
 * of silently removing its behavioral tests from registration.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import helmExtension from "../../extensions/helm.js";
import { RealDataSource } from "../../src/data/real.js";
import { probeCapabilities, resetCapabilities } from "../../src/host/capabilities.js";
import { bridgePermissionRequest } from "../../src/host/escalation-bridge.js";
import { FooterController } from "../../src/host/footer-controller.js";
import { withTempProject } from "../helpers/tmp.js";
import { fakeTui, theme256 } from "../helpers/tui.js";

// ── Wiring guards ──

test("production wiring: /helm constructs the app with RealDataSource", () =>
  withTempProject(async () => {
    let helmHandler: ((args: string, context: ExtensionContext) => Promise<void>) | undefined;
    const handlers = new Map<string, unknown>();
    const pi = new Proxy(
      {
        on: (event: string, handler: unknown) => handlers.set(event, handler),
        getCommands: () => [],
        getActiveTools: () => [],
        setActiveTools: () => {},
        registerTool: () => {},
        registerCommand: (name: string, command: { handler: typeof helmHandler }) => {
          if (name === "helm") helmHandler = command.handler;
        },
        exec: async () => ({ code: 1, stdout: "", stderr: "" }),
      },
      { get: (target, key) => Reflect.get(target, key) },
    ) as unknown as ExtensionAPI;

    helmExtension(pi);
    assert.ok(helmHandler, "the production extension registered /helm");

    let component: unknown;
    const context = {
      mode: "tui",
      ui: {
        notify: () => {},
        setFooter: () => {},
        custom: async (factory: (...args: unknown[]) => unknown) => {
          component = factory(fakeTui(), theme256, undefined, () => {});
        },
      },
    } as unknown as ExtensionContext;
    await helmHandler!("", context);

    const source = (component as { dataSource?: unknown }).dataSource;
    assert.ok(source instanceof RealDataSource, "the app received the production RealDataSource instance");
  }, { fakeHome: true }));

// ── FooterController behavioral spec ──

const spyUi = () => {
  const calls: unknown[] = [];
  return { calls, ui: { setFooter: (f: unknown) => { calls.push(f); } } };
};

test("usage footer installs as default; suspend hides; restore returns the USAGE footer (never undefined/built-in)", () => {
  const { calls, ui } = spyUi();
  const usageFooter = () => ({ render: () => ["usage"], invalidate: () => {} });
  const fc = new FooterController(ui);
  fc.installUsageFooter(usageFooter);
  assert.equal(calls.at(-1), usageFooter, "install → the usage footer factory is set");
  fc.suspendForFullScreen();
  assert.notEqual(calls.at(-1), usageFooter, "suspend → helm owns the screen (zero-line footer)");
  assert.notEqual(calls.at(-1), undefined, "suspend must not fall back to the built-in footer");
  fc.restore();
  assert.equal(calls.at(-1), usageFooter, "restore → the SAME usage footer factory, by reference");
  assert.ok(!calls.includes(undefined), "setFooter(undefined) is forbidden for the controller's lifetime");
});

test("suspend is reentrant; one restore returns the usage footer; double restore is idempotent", () => {
  const { calls, ui } = spyUi();
  const usageFooter = () => ({ render: () => ["usage"], invalidate: () => {} });
  const fc = new FooterController(ui);
  fc.installUsageFooter(usageFooter);
  fc.suspendForFullScreen();
  fc.suspendForFullScreen();
  fc.restore();
  assert.equal(calls.at(-1), usageFooter);
  const n = calls.length;
  fc.restore();
  assert.ok(calls.length <= n + 1 && calls.at(-1) === usageFooter, "restore stays on the usage footer");
});

// ── Escalation routing: dw/cmux approval prompts become helm escalations, not a second UI ──

test("a permission request surfaces as a helm escalation and resolves when the operator decides — no ctx.ui call", async () => {
  const { MockDataSource } = await import("../../src/data/mock.js");
  const ds = new MockDataSource();
  const before = ds.listEscalations().length;
  // The bridge receives NO ui handle — routing INTO helm is structural, not disciplined.
  const pending = bridgePermissionRequest(ds, {
    source: { kind: "workflow", label: "dw › task-panel" },
    question: "workflow wants to run `git push --force`",
    options: ["allow once", "deny"],
  });
  const queue = ds.listEscalations();
  assert.equal(queue.length, before + 1, "the prompt joined the needs-you queue");
  const item = queue.find((e: { question: string }) => e.question.includes("git push --force"));
  assert.ok(item, "escalation carries the request's question");
  assert.equal(item!.options.length, 2, "request options become numbered card options");
  await ds.decide(item!.id, 0);
  assert.equal(await pending, 0, "deciding option 1 resolves the bridged promise with that index");
});

// ── Capabilities: probe once, degrade gracefully ──

test("a missing cmux binary probes to false — resolves, never throws; probe is memoized", async () => {
  resetCapabilities();
  let execs = 0;
  const deps = { exec: async () => { execs += 1; throw new Error("ENOENT"); } };
  const caps = await probeCapabilities(deps);
  assert.equal(caps.cmux, false, "absent binary → capability false, not a crash");
  await probeCapabilities(deps);
  assert.ok(execs <= 3, "probe once per session (memoized), not per call"); // ~one exec per probed capability
  resetCapabilities();
});
