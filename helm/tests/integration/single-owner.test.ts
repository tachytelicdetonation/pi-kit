/**
 * SINGLE-PANEL OWNERSHIP + composition-root guards.
 *
 * helm is the one UI owner on top of pi: the usage footer is the default in the
 * normal REPL, `/helm` suspends it and owns the full screen, and on exit the USAGE
 * footer is restored (never the built-in, never setFooter(undefined)). Workflow /
 * cmux permission prompts route INTO helm's escalation queue rather than drawing a
 * second ctx.ui surface. Capabilities probe once and degrade gracefully.
 *
 * The two wiring guards run TODAY and are RED against the current extensions/helm.ts;
 * the FooterController / escalation-bridge / capabilities specs are RED until those
 * host modules exist (loaded via a non-analyzable specifier so tsc stays green).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, "..", "..", rel), "utf8");
const load = (rel: string): Promise<any> => import(rel).catch(() => undefined);

// ── Wiring guards: runnable TODAY, RED against current helm/extensions/helm.ts ──

test("production wiring: /helm must NOT construct MockDataSource (the #1 disconnect)", () => {
  const src = read("extensions/helm.ts");
  assert.ok(
    !src.includes("MockDataSource"),
    "extensions/helm.ts still wires MockDataSource — the entry must consume the composition root's RealDataSource",
  );
});

test("production wiring: exit must restore the USAGE footer, never setFooter(undefined)", () => {
  const src = read("extensions/helm.ts");
  assert.ok(
    !/setFooter\(\s*undefined\s*\)/.test(src),
    "extensions/helm.ts restores the BUILT-IN footer via setFooter(undefined) — it must hand back the usage footer through FooterController.restore()",
  );
});

// ── FooterController behavioral spec (RED until src/host/footer-controller.ts exists) ──

const fcModule = await load("../../src/host/footer-controller.js");

test("FooterController module exists (RED until built)", () => {
  assert.ok(fcModule?.FooterController, "helm/src/host/footer-controller.ts must export class FooterController");
});

if (fcModule?.FooterController) {
  const spyUi = () => {
    const calls: unknown[] = [];
    return { calls, ui: { setFooter: (f: unknown) => { calls.push(f); } } };
  };

  test("usage footer installs as default; suspend hides; restore returns the USAGE footer (never undefined/built-in)", () => {
    const { calls, ui } = spyUi();
    const usageFooter = () => ({ render: () => ["usage"], invalidate: () => {} });
    const fc = new fcModule.FooterController(ui);
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
    const fc = new fcModule.FooterController(ui);
    fc.installUsageFooter(usageFooter);
    fc.suspendForFullScreen();
    fc.suspendForFullScreen();
    fc.restore();
    assert.equal(calls.at(-1), usageFooter);
    const n = calls.length;
    fc.restore();
    assert.ok(calls.length <= n + 1 && calls.at(-1) === usageFooter, "restore stays on the usage footer");
  });
}

// ── Escalation routing: dw/cmux approval prompts become helm escalations, not a second UI ──

const bridgeModule = await load("../../src/host/escalation-bridge.js");

test("escalation bridge module exists (RED until built)", () => {
  assert.ok(
    bridgeModule?.bridgePermissionRequest,
    "helm/src/host/escalation-bridge.ts must export bridgePermissionRequest(dataSource, request): Promise<number>",
  );
});

if (bridgeModule?.bridgePermissionRequest) {
  test("a permission request surfaces as a helm escalation and resolves when the operator decides — no ctx.ui call", async () => {
    const { MockDataSource } = await import("../../src/data/mock.js");
    const ds = new MockDataSource();
    const before = ds.listEscalations().length;
    // The bridge receives NO ui handle — routing INTO helm is structural, not disciplined.
    const pending = bridgeModule.bridgePermissionRequest(ds, {
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
}

// ── Capabilities: probe once, degrade gracefully ──

const capsModule = await load("../../src/host/capabilities.js");

test("capabilities module exists (RED until built)", () => {
  assert.ok(
    capsModule?.probeCapabilities,
    "helm/src/host/capabilities.ts must export probeCapabilities(deps): Promise<Capabilities>, memoized per session",
  );
});

if (capsModule?.probeCapabilities) {
  test("a missing cmux binary probes to false — resolves, never throws; probe is memoized", async () => {
    let execs = 0;
    const deps = { exec: async () => { execs += 1; throw new Error("ENOENT"); } };
    const caps = await capsModule.probeCapabilities(deps);
    assert.equal(caps.cmux, false, "absent binary → capability false, not a crash");
    await capsModule.probeCapabilities(deps);
    assert.ok(execs <= 3, "probe once per session (memoized), not per call"); // ~one exec per probed capability
  });
}
