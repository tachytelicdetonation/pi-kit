import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createHostWorkflowContext,
  HostWorkflowCapabilityError,
  type WorkflowPermissionBroker,
} from "../../../src/workflows/host-workflow-context.js";

function fakeTool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `${name} fixture`,
    parameters: Type.Object({ value: Type.String() }),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: `${name}:${params.value}` }], details: {} };
    },
  };
}

const allowBroker: WorkflowPermissionBroker = {
  async authorize() {
    return { allowed: true };
  },
};

test("host snapshot retains executable custom and MCP-like tools without adding denied tools", async () => {
  const custom = fakeTool("custom_fixture");
  const mcp = fakeTool("mcp_fixture");
  const denied = fakeTool("denied_fixture");
  const parentDefinitions = [custom, mcp, denied];
  const parentActiveNames = [custom.name, mcp.name];

  const context = createHostWorkflowContext({
    sessionId: "session-fixture",
    cwd: process.cwd(),
    inputOrigin: "interactive",
    mode: "tui",
    thinkingLevel: "high",
    activeToolNames: parentActiveNames,
    activeToolDefinitions: parentDefinitions,
    projectTrusted: true,
    permissionMode: "accept-edits",
    permissionBroker: allowBroker,
  });

  parentActiveNames.push(denied.name);
  parentDefinitions.length = 0;

  assert.deepEqual(context.activeToolNames, [custom.name, mcp.name]);
  assert.deepEqual(
    context.activeToolDefinitions.map(({ name }) => name),
    [custom.name, mcp.name],
  );
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.activeToolDefinitions));

  for (const definition of context.activeToolDefinitions) {
    const decision = await context.permissionBroker.authorize({
      runId: "run-fixture",
      agentId: "agent-fixture",
      toolName: definition.name,
      input: { value: "ok" },
      cwd: context.cwd,
    });
    assert.equal(decision.allowed, true);
    const result = await definition.execute("call-fixture", { value: "ok" }, undefined, undefined, {} as never);
    assert.equal(result.content[0]?.type, "text");
  }
});

test("host snapshot fails closed when metadata has no executable definition", () => {
  assert.throws(
    () =>
      createHostWorkflowContext({
        sessionId: "session-fixture",
        cwd: process.cwd(),
        inputOrigin: "interactive",
        mode: "tui",
        thinkingLevel: "high",
        activeToolNames: ["metadata_only_tool"],
        activeToolDefinitions: [],
        projectTrusted: true,
        permissionMode: "accept-edits",
        permissionBroker: allowBroker,
      }),
    (error) => error instanceof HostWorkflowCapabilityError && error.code === "HOST_CAPABILITY_UNAVAILABLE",
  );
});
