import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHostWorkflowContext } from "../../src/host-workflow-context.js";
import { InheritedToolHost } from "../../src/inherited-tool-host.js";
import { saveModelTierConfig } from "../../src/model-tier-config.js";
import { ProcessWorkflowAgent } from "../../src/process-agent.js";
import { ParentRoutedPermissionBroker } from "../../src/workflow-permission-broker.js";
import { runWorkflowSandbox } from "../../src/workflow-sandbox.js";
import { withFakeHomeAsync } from "../helpers/fake-home.js";

function fakeTool(name: string, calls: string[]): ToolDefinition {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({ value: Type.String() }),
    async execute(_id, input) {
      calls.push(`${name}:${input.value}`);
      return { content: [{ type: "text", text: `ok:${input.value}` }], details: { name } };
    },
  };
}

test("RUN-04 process sandbox cannot read host environment, filesystem, network, or spawn children", async () => {
  process.env.WORKFLOW_SANDBOX_SECRET_TEST = "must-not-cross";
  try {
    const result = await runWorkflowSandbox<Record<string, unknown>>({
      body: `
const escapedProcess = (() => { try { return agent.constructor('return process')() } catch { return null } })()
const attempt = (fn) => { try { return String(fn()) } catch (error) { return 'blocked:' + String(error && error.message || error) } }
return {
  secret: escapedProcess && escapedProcess.env.WORKFLOW_SANDBOX_SECRET_TEST,
  fs: attempt(() => escapedProcess.getBuiltinModule('node:fs').readFileSync('/etc/passwd', 'utf8').slice(0, 4)),
  child: attempt(() => escapedProcess.getBuiltinModule('node:child_process').execFileSync('/bin/echo', ['bad']).toString()),
  net: await new Promise((resolve) => {
    const socket = escapedProcess.getBuiltinModule('node:net').connect(9)
    socket.once('error', (error) => resolve('blocked:' + String(error && error.message || error)))
  }),
}`,
      filename: "security.js",
      cwd: process.cwd(),
      budgetTotal: null,
      budgetSpent: 0,
      handlers: {
        agent: async () => "unused",
        workflow: async () => "unused",
        checkpoint: async () => true,
        phase: () => {},
        log: () => {},
        budgetSpent: () => 0,
      },
    });
    assert.ok(result.secret == null);
    assert.match(String(result.fs), /^blocked:/);
    assert.match(String(result.child), /^blocked:/);
    assert.match(String(result.net), /^blocked:/);
  } finally {
    delete process.env.WORKFLOW_SANDBOX_SECRET_TEST;
  }
});

test("RUN-01 compatibility sandbox exposes Pi additions only through the pi namespace", async () => {
  const result = await runWorkflowSandbox<Record<string, string>>({
    body: `return {
  agent: typeof agent,
  parallel: typeof parallel,
  pipeline: typeof pipeline,
  phase: typeof phase,
  args: typeof args,
  pi: typeof pi,
  directWorkflow: typeof workflow,
  directCheckpoint: typeof checkpoint,
  namespacedWorkflow: typeof pi.workflow,
  namespacedCheckpoint: typeof pi.checkpoint,
  process: typeof process,
}`,
    filename: "globals.js",
    cwd: process.cwd(),
    budgetTotal: null,
    budgetSpent: 0,
    compatibilityMode: true,
    handlers: {
      agent: async () => "unused",
      workflow: async () => "unused",
      checkpoint: async () => true,
      phase: () => {},
      log: () => {},
      budgetSpent: () => 0,
    },
  });
  assert.deepEqual(result, {
    agent: "function",
    parallel: "function",
    pipeline: "function",
    phase: "function",
    args: "undefined",
    pi: "object",
    directWorkflow: "undefined",
    directCheckpoint: "undefined",
    namespacedWorkflow: "function",
    namespacedCheckpoint: "function",
    process: "undefined",
  });
});

test("PERM-01 parent-routed broker denies inactive tools and asks through retained parent UI", async () => {
  const prompts: string[] = [];
  const broker = new ParentRoutedPermissionBroker({
    activeToolNames: ["custom"],
    policy: () => "ask",
    ui: {
      confirm: async (title, message) => {
        prompts.push(`${title}\n${message}`);
        return true;
      },
    },
  });
  assert.deepEqual(await broker.authorize({ runId: "r", agentId: "a", toolName: "denied", input: {}, cwd: "/tmp" }), {
    allowed: false,
    reason: "Tool was not active when workflow r launched",
  });
  assert.deepEqual(
    await broker.authorize({ runId: "r", agentId: "a", toolName: "custom", input: { x: 1 }, cwd: "/tmp" }),
    { allowed: true },
  );
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /custom/);
});

test("HOST-01 inherited executable tools are permission-gated and never reconstructed from metadata", async () => {
  const calls: string[] = [];
  const custom = fakeTool("custom", calls);
  const denied = fakeTool("denied", calls);
  const context = createHostWorkflowContext({
    sessionId: "session",
    cwd: process.cwd(),
    inputOrigin: "interactive",
    mode: "tui",
    thinkingLevel: "high",
    activeToolNames: ["custom"],
    activeToolDefinitions: [custom, denied],
    projectTrusted: true,
    permissionMode: "default",
    permissionBroker: { authorize: async () => ({ allowed: true }) },
    toolExecutionContext: {} as never,
  });
  const host = new InheritedToolHost(context);
  const result = await host.execute({
    runId: "r",
    agentId: "a",
    toolCallId: "call",
    toolName: "custom",
    input: { value: "yes" },
    cwd: process.cwd(),
  });
  assert.deepEqual(result, { content: [{ type: "text", text: "ok:yes" }], details: { name: "custom" } });
  assert.deepEqual(calls, ["custom:yes"]);
  await assert.rejects(
    host.execute({
      runId: "r",
      agentId: "a",
      toolCallId: "call",
      toolName: "denied",
      input: { value: "no" },
      cwd: process.cwd(),
    }),
    /TOOL_NOT_ALLOWED/,
  );
  assert.deepEqual(calls, ["custom:yes"]);
});

test("HOST-01 inherited custom tools receive the requested child cwd in their execution context", async () => {
  let observedCwd: string | undefined;
  const tool: ToolDefinition = {
    name: "cwd_tool",
    label: "cwd_tool",
    description: "cwd fixture",
    parameters: Type.Object({}),
    async execute(_id, _input, _signal, _update, ctx) {
      observedCwd = ctx.cwd;
      return { content: [{ type: "text", text: ctx.cwd }], details: {} };
    },
  };
  const context = createHostWorkflowContext({
    sessionId: "session",
    cwd: "/parent",
    inputOrigin: "interactive",
    mode: "tui",
    thinkingLevel: "high",
    activeToolNames: [tool.name],
    activeToolDefinitions: [tool],
    projectTrusted: true,
    permissionMode: "default",
    permissionBroker: { authorize: async () => ({ allowed: true }) },
    toolExecutionContext: { cwd: "/parent" } as never,
  });

  await new InheritedToolHost(context).execute({
    runId: "run",
    agentId: "agent",
    toolCallId: "call",
    toolName: tool.name,
    input: {},
    cwd: "/worktree",
  });
  assert.equal(observedCwd, "/worktree");
});

test("AGT-02 process agent resolves tiers and forwards per-agent effort", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-process-model-"));
  const childPath = join(directory, "fake-agent.cjs");
  writeFileSync(
    childPath,
    `process.on('message', (m) => {
      if (m.type === 'init') process.send({ type: 'result', nonce: m.nonce, ok: true, value: { model: m.model, thinkingLevel: m.thinkingLevel } });
    });`,
  );
  const context = createHostWorkflowContext({
    sessionId: "session",
    cwd: process.cwd(),
    inputOrigin: "interactive",
    mode: "tui",
    model: { provider: "parent", id: "main" } as never,
    thinkingLevel: "medium",
    activeToolNames: [],
    activeToolDefinitions: [],
    projectTrusted: true,
    permissionMode: "default",
    permissionBroker: { authorize: async () => ({ allowed: true }) },
    toolExecutionContext: {} as never,
  });
  try {
    await withFakeHomeAsync(directory, async () => {
      saveModelTierConfig({ tiers: { small: "provider/small", medium: "provider/medium", big: "provider/big" } });
      const agent = new ProcessWorkflowAgent({ hostContext: context, runId: "run", childModulePath: childPath });
      const result = (await agent.run("test", { tier: "small", thinkingLevel: "xhigh" })) as unknown as {
        model: string;
        thinkingLevel: string;
      };
      assert.deepEqual(result, { model: "provider/small", thinkingLevel: "xhigh" });
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HOST-02 process agent executes inherited tools only through the parent permission boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-process-agent-"));
  const childPath = join(directory, "fake-agent.cjs");
  writeFileSync(
    childPath,
    `process.on('message', (m) => {
      if (m.type === 'init') process.send({ type: 'tool-request', nonce: m.nonce, id: 1, toolCallId: 'tc', toolName: 'custom', input: { value: 'child' } });
      if (m.type === 'tool-response') process.send({ type: 'result', nonce: m.nonce, ok: m.ok, value: { childPid: process.pid, tool: m.value }, error: m.error });
    });`,
  );
  const calls: string[] = [];
  const custom = fakeTool("custom", calls);
  const context = createHostWorkflowContext({
    sessionId: "session",
    cwd: process.cwd(),
    inputOrigin: "interactive",
    mode: "tui",
    thinkingLevel: "high",
    activeToolNames: ["custom"],
    activeToolDefinitions: [custom],
    projectTrusted: true,
    permissionMode: "default",
    permissionBroker: { authorize: async () => ({ allowed: true }) },
    toolExecutionContext: {} as never,
  });
  try {
    const agent = new ProcessWorkflowAgent({ hostContext: context, runId: "run", childModulePath: childPath });
    const result = (await agent.run("test", { label: "worker" })) as unknown as {
      childPid: number;
      tool: { content: Array<{ text: string }> };
    };
    assert.notEqual(result.childPid, process.pid);
    assert.equal(result.tool.content[0]?.text, "ok:child");
    assert.deepEqual(calls, ["custom:child"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
