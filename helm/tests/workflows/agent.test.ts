import { removeTempDir, tempDir } from "../helpers/tmp.js";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AgentRunOptions, AgentUsage } from "../../src/workflows/agent.js";
import { resolveAgentModelSpec, usageFromStats, WorkflowAgent } from "../../src/workflows/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../../src/workflows/errors.js";
import { resolveModelSpecWithThinking } from "../../src/workflows/model-spec.js";
import type { ModelTierConfig } from "../../src/workflows/model-tier-config.js";
import { runWorkflow } from "../../src/workflows/workflow.js";
import { withFakeHome } from "./helpers/fake-home.js";

// Private methods used for testing - cast to this type to access them without `any`
type WorkflowAgentPrivates = {
  buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string;
  lastAssistantText(messages: unknown[]): string;
  createSessionManager(): { isPersisted(): boolean; getCwd(): string };
};

// ═══════════════════════════════════════════════════════════════════════
// persistAgentSessions — in-memory by default, file-backed keyed by project cwd
// ═══════════════════════════════════════════════════════════════════════

test("WorkflowAgent uses an in-memory session manager by default", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const manager = (agent as unknown as WorkflowAgentPrivates).createSessionManager();
  assert.equal(manager.isPersisted(), false, "default must stay in-memory (back-compat)");
});

test("WorkflowAgent with persistAgentSessions=false explicitly stays in-memory", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", persistAgentSessions: false });
  const manager = (agent as unknown as WorkflowAgentPrivates).createSessionManager();
  assert.equal(manager.isPersisted(), false);
});

test("WorkflowAgent with persistAgentSessions=true creates a file-backed manager keyed by the project cwd", () => {
  const dir = tempDir("pi-dynamic-workflows-persist-agent-");
  const projectCwd = join(dir, "project");
  const fakeHome = join(dir, "home");
  try {
    withFakeHome(fakeHome, () => {
      const agent = new WorkflowAgent({ cwd: projectCwd, persistAgentSessions: true });
      const manager = (agent as unknown as WorkflowAgentPrivates).createSessionManager();
      assert.equal(manager.isPersisted(), true, "flag must yield a file-backed session manager");
      // Sessions must be keyed by the runner's project cwd — never a per-call
      // worktree cwd — so transcripts group under the project's session dir.
      // createSessionManager() takes no per-call cwd by design; assert the
      // manager saw the project cwd.
      assert.equal(manager.getCwd(), projectCwd);
    });
  } finally {
    removeTempDir(dir);
  }
});

test("WorkflowAgent degrades to in-memory when the session directory can't be created", () => {
  const dir = tempDir("pi-dynamic-workflows-persist-agent-fail-");
  const projectCwd = join(dir, "project");
  const fakeHome = join(dir, "home");
  try {
    withFakeHome(fakeHome, () => {
      // Pre-occupy the sessions directory with a plain file so the SDK's
      // mkdirSync(recursive) inside SessionManager.create() throws ENOTDIR —
      // simulating a permissions/disk-full failure at session-creation time.
      const sessionsPath = join(fakeHome, ".pi", "agent", "sessions");
      mkdirSync(dirname(sessionsPath), { recursive: true });
      writeFileSync(sessionsPath, "not a directory");

      const originalWarn = console.warn;
      const warnings: unknown[][] = [];
      console.warn = (...args: unknown[]) => warnings.push(args);
      try {
        const agent = new WorkflowAgent({ cwd: projectCwd, persistAgentSessions: true });
        const manager = (agent as unknown as WorkflowAgentPrivates).createSessionManager();
        assert.equal(manager.isPersisted(), false, "must degrade to in-memory rather than throw");
        assert.ok(
          warnings.some((args) => String(args[0]).includes("persistAgentSessions")),
          "should log a warning about the degradation",
        );
      } finally {
        console.warn = originalWarn;
      }
    });
  } finally {
    removeTempDir(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveAgentModelSpec — model precedence: explicit model > tier > main model
// ═══════════════════════════════════════════════════════════════════════════

const tierConfig: ModelTierConfig = {
  tiers: { small: "vendor/small", medium: "vendor/medium", big: "vendor/big" },
};
const loadCfg = () => tierConfig;
const noCfg = () => null;

test("resolveAgentModelSpec: explicit model wins over tier (the precedence bug fix)", () => {
  // Even with a tier set AND a config that resolves it, an explicit model wins.
  assert.equal(
    resolveAgentModelSpec({ model: "explicit/model", tier: "small" }, "main/model", loadCfg),
    "explicit/model",
  );
});

test("resolveAgentModelSpec: explicit model wins even when no config exists", () => {
  assert.equal(
    resolveAgentModelSpec({ model: "explicit/model", tier: "small" }, "main/model", noCfg),
    "explicit/model",
  );
});

test("resolveAgentModelSpec: tier resolves from config when no explicit model", () => {
  assert.equal(resolveAgentModelSpec({ tier: "big" }, "main/model", loadCfg), "vendor/big");
});

test("resolveAgentModelSpec: unconfigured tier falls back to the main model", () => {
  assert.equal(resolveAgentModelSpec({ tier: "small" }, "main/model", noCfg), "main/model");
  assert.equal(resolveAgentModelSpec({ tier: "unknown-tier" }, "main/model", loadCfg), "main/model");
});

test("resolveAgentModelSpec: untagged agent defaults to the configured medium tier", () => {
  // The "set tier but nothing changed" fix: an agent with no model and no tier
  // falls back to the user's medium tier when a config exists.
  assert.equal(resolveAgentModelSpec({}, "main/model", loadCfg), "vendor/medium");
});

test("resolveAgentModelSpec: untagged agent with NO config falls through to session default", () => {
  assert.equal(resolveAgentModelSpec({}, "main/model", noCfg), undefined);
});

test("resolveAgentModelSpec: untagged agent with a config lacking a medium tier => session default", () => {
  const noMedium = () => ({ tiers: { small: "vendor/small" } });
  assert.equal(resolveAgentModelSpec({}, "main/model", noMedium), undefined);
});

test("resolveAgentModelSpec: tier with no main model and no config yields undefined", () => {
  assert.equal(resolveAgentModelSpec({ tier: "small" }, undefined, noCfg), undefined);
});

test("WorkflowAgent reuses an injected ModelRegistry instead of building its own", () => {
  const mockModel = { provider: "mock", id: "shared" } as any;
  const registry = {
    find: (provider: string, id: string) => (provider === "mock" && id === "shared" ? mockModel : undefined),
    getAvailable: () => [mockModel],
    getAll: () => [mockModel],
  } as any;

  const agent = new WorkflowAgent({ cwd: "/tmp", modelRegistry: registry });
  const resolved = resolveModelSpecWithThinking("mock/shared", (agent as any).getRegistry());
  assert.equal(resolved.model, mockModel, "should resolve via the injected registry");
});

test("WorkflowAgent falls back to building a disk registry when no registry is injected", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  // Should not throw; getRegistry() lazily builds a ModelRegistry.
  assert.doesNotThrow(() => (agent as any).getRegistry());
});

test("WorkflowAgent.resolveModel resolves via a per-run registry when the constructor got none", () => {
  // Regression test for the per-run `modelRegistry` AgentRunOptions field: a
  // model present only in a registry passed to run() (not the constructor)
  // must still resolve.
  const perRunModel = { provider: "router", id: "per-run-only" } as any;
  const perRunRegistry = {
    find: (provider: string, id: string) => (provider === "router" && id === "per-run-only" ? perRunModel : undefined),
    getAvailable: () => [perRunModel],
    getAll: () => [perRunModel],
  } as any;

  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const resolved = resolveModelSpecWithThinking("router/per-run-only", (agent as any).getRegistry(perRunRegistry));
  assert.equal(resolved.model, perRunModel, "should resolve via the per-run registry, not a disk registry");
});

test("WorkflowAgent.resolveModel: per-run registry takes precedence over the constructor's shared registry", () => {
  const constructorModel = { provider: "ctor", id: "shared" } as any;
  const constructorRegistry = {
    find: (provider: string, id: string) => (provider === "ctor" && id === "shared" ? constructorModel : undefined),
    getAvailable: () => [constructorModel],
    getAll: () => [constructorModel],
  } as any;

  const perRunModel = { provider: "run", id: "override" } as any;
  const perRunRegistry = {
    find: (provider: string, id: string) => (provider === "run" && id === "override" ? perRunModel : undefined),
    getAvailable: () => [perRunModel],
    getAll: () => [perRunModel],
  } as any;

  const agent = new WorkflowAgent({ cwd: "/tmp", modelRegistry: constructorRegistry });
  // The per-run registry, not the constructor's, is consulted when both are set.
  const resolved = resolveModelSpecWithThinking("run/override", (agent as any).getRegistry(perRunRegistry));
  assert.equal(resolved.model, perRunModel, "per-run registry should win over the constructor's shared registry");
  // And the constructor registry is still used when no per-run registry is given.
  const fallback = resolveModelSpecWithThinking("ctor/shared", (agent as any).getRegistry());
  assert.equal(fallback.model, constructorModel, "constructor registry should still apply without a per-run override");
});

test("WorkflowAgent.getRegistry: per-run registry wins, then constructor's shared registry, then disk", () => {
  const constructorRegistry = { getAvailable: () => [], find: () => undefined, getAll: () => [] } as any;
  const perRunRegistry = { getAvailable: () => [], find: () => undefined, getAll: () => [] } as any;

  const agent = new WorkflowAgent({ cwd: "/tmp", modelRegistry: constructorRegistry });
  assert.equal((agent as any).getRegistry(perRunRegistry), perRunRegistry);
  assert.equal((agent as any).getRegistry(), constructorRegistry);

  const bareAgent = new WorkflowAgent({ cwd: "/tmp" });
  assert.doesNotThrow(() => (bareAgent as any).getRegistry());
});

// ═══════════════════════════════════════════════════════════════════════════
// buildPrompt — verifies that the agent's internal prompt assembly is correct
// ═══════════════════════════════════════════════════════════════════════════

test("buildPrompt includes base instructions, task label, and user prompt", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "You are a helper." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt(
    "analyze this",
    { label: "analyzer" },
    false,
  );
  assert.ok(built.includes("You are a helper."), "should include base instructions");
  assert.ok(built.includes("Task label: analyzer"), "should include task label");
  assert.ok(built.includes("analyze this"), "should include user prompt");
});

test("buildPrompt includes per-call instructions when provided", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "Base." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt(
    "do it",
    { label: "x", instructions: "Extra." },
    false,
  );
  assert.ok(built.includes("Base."), "base instructions");
  assert.ok(built.includes("Extra."), "per-call instructions");
  assert.ok(built.includes("do it"), "user prompt");
});

test("buildPrompt injects structured output contract when schema is used", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt("return result", { label: "t" }, true);
  assert.ok(built.includes("structured_output"), "should mention structured_output");
  assert.ok(built.includes("Final output contract:"), "should include contract header");
  assert.ok(built.includes("Do not emit a prose final answer"), "should discourage prose");
  assert.ok(built.includes("call structured_output exactly once"), "should enforce single call");
});

test("buildPrompt works without base instructions", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt("hello", { label: "greeter" }, false);
  assert.ok(built.includes("Task label: greeter"), "should contain Task label: greeter");
  assert.ok(built.includes("hello"), "should contain hello");
});

test("buildPrompt works without label", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "Help." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt("hello", {}, false);
  assert.ok(built.includes("Help."), "should contain Help.");
  assert.ok(built.includes("hello"), "should contain hello");
  assert.ok(!built.includes("Task label:"), "no label when omitted");
});

test("buildPrompt includes both instructions when both base and per-call are set", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "You are a code reviewer." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt(
    "check this file",
    { label: "reviewer", instructions: "Focus on security." },
    true,
  );
  // Order: base instructions, per-call instructions, label, prompt, structured contract
  assert.ok(built.indexOf("You are a code reviewer.") < built.indexOf("Focus on security."), "base before per-call");
  assert.ok(built.indexOf("Focus on security.") < built.indexOf("Task label: reviewer"), "per-call before label");
  assert.ok(built.indexOf("Task label: reviewer") < built.indexOf("check this file"), "label before prompt");
  assert.ok(
    built.indexOf("check this file") < built.indexOf("Final output contract:"),
    "prompt before structured contract",
  );
});

test("lastAssistantText preserves extraction edge cases", () => {
  const extract = (messages: unknown[]) =>
    (new WorkflowAgent({ cwd: "/tmp" }) as unknown as WorkflowAgentPrivates).lastAssistantText(messages);
  const cases: Array<{ name: string; messages: unknown[]; expected: string }> = [
    {
      name: "joins multiple text parts",
      messages: [{ role: "assistant", content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }] }],
      expected: "part1part2",
    },
    {
      name: "skips tool parts",
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1" }, { type: "text", text: "result" }] }],
      expected: "result",
    },
    { name: "returns empty for empty input", messages: [], expected: "" },
    {
      name: "ignores non-assistant messages",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      expected: "",
    },
    {
      name: "uses the last assistant message",
      messages: [
        { role: "assistant", content: [{ type: "text", text: "first" }] },
        { role: "user", content: [{ type: "text", text: "more" }] },
        { role: "assistant", content: [{ type: "text", text: "final" }] },
      ],
      expected: "final",
    },
  ];

  for (const { name, messages, expected } of cases) {
    assert.equal(extract(messages), expected, name);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Full agent() pipeline inside runWorkflow — verifies the agent() function
// in workflow.ts correctly invokes the runner with all options.
// ═══════════════════════════════════════════════════════════════════════════

/** A smart mock agent runner that records every call and validates options shape. */
class CallRecordingAgent {
  calls: Array<{
    prompt: string;
    options: Record<string, unknown>;
  }> = [];

  result: unknown = "mock-result";

  async run(prompt: string, options: any) {
    this.calls.push({ prompt, options: { ...options } });
    // Fire callbacks with synthetic data to test the full pipeline
    options.onUsage?.({
      input: 20,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      total: 30,
      cost: 0.001,
    } satisfies AgentUsage);
    options.onModelResolved?.("openai/gpt-4.1-mini");
    return this.result;
  }
}

for (const modelCase of [
  {
    name: "explicit opts.model",
    agentOptions: "{ label: 't', model: 'requested/explicit' }",
    mainModel: "session/default",
  },
  {
    name: "inherited default",
    agentOptions: "{ label: 't' }",
    mainModel: "session/default",
  },
]) {
  test(`agent() propagates onModelResolved for ${modelCase.name}`, async () => {
    const rec = new CallRecordingAgent();
    let recordedModel: string | undefined;
    await runWorkflow(
      `export const meta = { name: 'test', description: 't' }
       await agent('task', ${modelCase.agentOptions})
       return 1`,
      {
        agent: rec,
        mainModel: modelCase.mainModel,
        persistLogs: false,
        onAgentEnd: (event) => {
          recordedModel = event.model;
        },
      },
    );
    assert.equal(recordedModel, "openai/gpt-4.1-mini", `${modelCase.name} records the resolved model`);
  });
}

test("agent() in workflow passes prompt and label to runner", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('analyze this', { label: 'analyzer' })
     return r`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].prompt, "analyze this");
});

test("agent() in workflow forwards modelRegistry to the runner", async () => {
  const rec = new CallRecordingAgent();
  const fakeRegistry = { getAvailable: () => [], find: () => undefined, getAll: () => [] } as any;
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('task', { label: 't' })
     return r`,
    { agent: rec, persistLogs: false, modelRegistry: fakeRegistry },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal((rec.calls[0].options as { modelRegistry?: any }).modelRegistry, fakeRegistry);
});

test("agent() in workflow passes model spec to runner", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('task', { label: 't', model: 'fast-llm/model' })
     return r`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal((rec.calls[0].options as { model?: string }).model, "fast-llm/model");
});

test("agent() in workflow forwards modelRegistry for CLI-style model parsing", async () => {
  const rec = new CallRecordingAgent();
  const modelRegistry = { getAll: () => [] };
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('task', { label: 't', model: 'fast-llm/model:xhigh' })
     return r`,
    { agent: rec, modelRegistry: modelRegistry as never, persistLogs: false },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal((rec.calls[0].options as { modelRegistry?: unknown }).modelRegistry, modelRegistry);
  assert.equal((rec.calls[0].options as { model?: string }).model, "fast-llm/model:xhigh");
});

test("agent() in workflow returns runner result", async () => {
  const rec = new CallRecordingAgent();
  rec.result = { findings: ["issue1"] };
  const result = await runWorkflow<{ findings: string[] }>(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('analyze', { label: 'a' })
     return r`,
    { agent: rec, persistLogs: false },
  );
  assert.deepEqual(result.result, { findings: ["issue1"] });
});

test("agent() in workflow returns null for recoverable errors", async () => {
  const failer = {
    async run() {
      throw new Error("recoverable agent error");
    },
  };
  let end:
    | {
        result: unknown;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
      }
    | undefined;
  const result = await runWorkflow<unknown>(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('failing task', { label: 'f' })
     return r`,
    { agent: failer, persistLogs: false, onAgentEnd: (e) => (end = e) },
  );
  assert.equal(result.result, null);
  assert.equal(end?.result, null);
  assert.equal(end?.error, "recoverable agent error");
  assert.equal(end?.errorCode, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
  assert.equal(end?.recoverable, true);
});

test("agent() in workflow treats empty text output as a recoverable failure", async () => {
  const rec = new CallRecordingAgent();
  rec.result = "   ";
  let end:
    | {
        result: unknown;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
      }
    | undefined;
  const result = await runWorkflow<unknown>(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('empty task', { label: 'empty' })
     return r`,
    { agent: rec, persistLogs: false, onAgentEnd: (e) => (end = e) },
  );

  assert.equal(result.result, null);
  assert.equal(end?.result, null);
  assert.equal(end?.error, "Subagent produced no assistant output");
  assert.equal(end?.errorCode, WorkflowErrorCode.AGENT_EMPTY_OUTPUT);
  assert.equal(end?.recoverable, true);
});

test("agent() in workflow reports non-recoverable errors before throwing", async () => {
  const failer = {
    async run() {
      throw new WorkflowError("schema failed", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false });
    },
  };
  let end:
    | {
        result: unknown;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
      }
    | undefined;

  await assert.rejects(
    () =>
      runWorkflow<unknown>(
        `export const meta = { name: 'test', description: 't' }
         await agent('schema task', { label: 'schema' })
         return 1`,
        { agent: failer, persistLogs: false, onAgentEnd: (e) => (end = e) },
      ),
    (err) => err instanceof WorkflowError && err.code === WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
  );

  assert.equal(end?.result, null);
  assert.equal(end?.error, "schema failed");
  assert.equal(end?.errorCode, WorkflowErrorCode.SCHEMA_NONCOMPLIANCE);
  assert.equal(end?.recoverable, false);
});

test("agent() accumulates usage across multiple agents", async () => {
  const rec = new CallRecordingAgent();
  const usageEvents: Array<{ total: number }> = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('first', { label: 'a' })
     await agent('second', { label: 'b' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onTokenUsage: (u) => usageEvents.push({ total: u.total }),
    },
  );
  assert.equal(usageEvents.length, 1, "one final usage event");
  assert.equal(usageEvents[0].total, 60, "two agents × 30 tokens each");
});

test("agent() with timeout should handle gracefully (timeout returns null)", async () => {
  const slow = {
    async run() {
      await new Promise((r) => setTimeout(r, 50));
      return "slow";
    },
  };
  let errorMessage = "";
  const result = await runWorkflow<unknown>(
    `export const meta = { name: 'test', description: 't' }
     let val = null
     try { val = await agent('slow', { label: 's', timeoutMs: 5 }) } catch (e) { val = 'error:' + (e && e.message || e) }
     return { val }`,
    {
      agent: slow,
      persistLogs: false,
      onAgentEnd: (event) => {
        if (event.error) errorMessage = event.error;
      },
    },
  );
  const r = result.result as { val: unknown };
  // agent() catches timeout internally (recoverable) and returns null
  assert.equal(r.val, null, "timeout agent should return null (recoverable)");
  assert.match(errorMessage, /timed out after 5ms/);
  assert.match(errorMessage, /raise or omit timeoutMs\/agentTimeoutMs/);
});

test("agent() default timeout is unbounded", async () => {
  const slow = {
    async run() {
      await new Promise((r) => setTimeout(r, 25));
      return "slow";
    },
  };
  const result = await runWorkflow<{ val: string }>(
    `export const meta = { name: 'test', description: 't' }
     const val = await agent('slow', { label: 's' })
     return { val }`,
    { agent: slow, persistLogs: false },
  );

  assert.equal(result.result.val, "slow");
});

test("agent() timeoutMs null overrides a run-level timeout", async () => {
  const slow = {
    async run() {
      await new Promise((r) => setTimeout(r, 25));
      return "slow";
    },
  };
  const result = await runWorkflow<{ val: string }>(
    `export const meta = { name: 'test', description: 't' }
     const val = await agent('slow', { label: 's', timeoutMs: null })
     return { val }`,
    { agent: slow, agentTimeoutMs: 5, persistLogs: false },
  );

  assert.equal(result.result.val, "slow");
});

test("agent() with parallel invokes all agents", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const rs = await parallel(['a','b','c'].map(p => () => agent(p, { label: p })))
     return rs`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 3);
  const prompts = rec.calls.map((c) => c.prompt).sort();
  assert.deepEqual(prompts, ["a", "b", "c"]);
});

test("agent() with pipeline invokes agent per stage per item", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const rs = await pipeline(['x','y'],
       item => agent('stage1 ' + item, { label: 's1-' + item }),
       result => agent('stage2 ' + result, { label: 's2-' + result }),
     )
     return rs`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 4); // 2 items × 2 stages
});

// ═══════════════════════════════════════════════════════════════════════════
// usageFromStats — the guard between session stats and the onUsage callback.
// ═══════════════════════════════════════════════════════════════════════════

test("usageFromStats maps real stats to an AgentUsage", () => {
  const usage = usageFromStats({
    tokens: { input: 100, output: 50, cacheRead: 900, cacheWrite: 30, total: 1080 },
    cost: 0.42,
  });
  assert.deepEqual(usage, { input: 100, output: 50, cacheRead: 900, cacheWrite: 30, total: 1080, cost: 0.42 });
});

test("usageFromStats returns undefined for all-zero stats (provider reported nothing)", () => {
  const usage = usageFromStats({
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  });
  assert.equal(usage, undefined);
});

test("usageFromStats keeps cost-only stats (billed but tokens unreported)", () => {
  const usage = usageFromStats({
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0.01,
  });
  assert.equal(usage?.cost, 0.01);
});
