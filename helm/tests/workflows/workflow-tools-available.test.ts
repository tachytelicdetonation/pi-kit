/**
 * Tests for tools availability when workflows mode is triggered.
 *
 * The bug: when a user message contains "workflow" (trigger keyword),
 * installWorkflowEditor's input handler calls:
 *   pi.setActiveTools?.([WORKFLOW_TOOL_NAME]);
 * which restricts ALL tools to ONLY the workflow tool.
 * The model then cannot use read, bash, edit, write, web_search, etc.
 * and gets "Tool X not found" errors.
 *
 * The fix: preserve default Pi tools alongside the workflow tool.
 * These tests verify that default tools remain available after the
 * workflows-mode trigger fires.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { buildForcedWorkflowPrompt, WORKFLOW_TOOL_NAME } from "../../src/workflows/workflow-editor.js";
import { makeEventPi as createMockPi } from "./helpers/mock-pi.js";

// ---------------------------------------------------------------------------
// Default Pi tools that every Pi install provides (plugin-independent)
// ---------------------------------------------------------------------------
const DEFAULT_PI_TOOLS = [
  "bash",
  "read",
  "edit",
  "write",
  "ask_user_question",
  "todo",
  "web_search",
  "web_fetch",
  "advisor",
  "subagent",
  "workflow",
];

// Additional tools from context-mode plugin (common but not guaranteed)
// We do NOT include these in DEFAULT_PI_TOOLS for compatibility.
// Tools like ctx_execute, ctx_execute_file, ctx_index, ctx_search, etc.
// are from a plugin and may not be present.

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function testSettingsOptions(keywordTriggerEnabled = true, keywordTriggerWord?: string) {
  return {
    settingsStore: {
      load: () => ({ keywordTriggerEnabled, ...(keywordTriggerWord ? { keywordTriggerWord } : {}) }),
      save: () => {},
    },
  };
}

// ---------------------------------------------------------------------------
// Test: installWorkflowEditor keeps default tools available
// ---------------------------------------------------------------------------

describe("installWorkflowEditor - tool availability", () => {
  it("should include default Pi tools when input handler fires with 'workflow'", async () => {
    const { installWorkflowEditor } = await import("../../src/workflows/workflow-editor.js");

    const mockPi = createMockPi([...DEFAULT_PI_TOOLS]);

    const ui = {
      setEditorComponent: mock.fn(),
    };

    installWorkflowEditor(
      mockPi as unknown as ExtensionAPI,
      ui as unknown as ExtensionUIContext,
      undefined,
      testSettingsOptions(),
    );

    // Simulate user submitting a message with "workflow" keyword
    const inputHandlers = mockPi.handlers.input;
    assert.ok(inputHandlers, "input handler should be registered");
    assert.equal(inputHandlers.length, 1);

    const result = inputHandlers[0]({
      source: "interactive",
      text: "przetestuj to workflow zadanie",
    });

    // Verify transform result
    assert.deepEqual(result, {
      action: "transform",
      text: buildForcedWorkflowPrompt("przetestuj to workflow zadanie"),
    });

    // Verify getActiveTools was called
    assert.equal(mockPi.getActiveTools.mock.callCount(), 1);

    // Verify setActiveTools was called
    assert.equal(mockPi.setActiveTools.mock.callCount(), 1);

    const calledWith = mockPi.setActiveTools.mock.calls[0].arguments[0];
    assert.ok(Array.isArray(calledWith), "setActiveTools should be called with an array");

    // The critical assertion: the workflow tool must be present
    assert.ok(calledWith.includes(WORKFLOW_TOOL_NAME), `"${WORKFLOW_TOOL_NAME}" must be in active tools`);

    // The critical assertion: default Pi tools must still be available
    for (const tool of DEFAULT_PI_TOOLS) {
      assert.ok(
        calledWith.includes(tool),
        `"${tool}" should still be available when workflows mode is triggered (got: [${calledWith.join(", ")}])`,
      );
    }

    // Verify tools are not restricted to just workflow
    assert.ok(
      calledWith.length > 1,
      `More than one tool should be active, not just workflow (got: [${calledWith.join(", ")}])`,
    );
  });

  it("should handle getActiveTools returning undefined gracefully", async () => {
    const { installWorkflowEditor } = await import("../../src/workflows/workflow-editor.js");

    // Pi may not have getActiveTools in some hosts
    const mockPi = createMockPi(DEFAULT_PI_TOOLS);
    mockPi.getActiveTools = mock.fn(() => undefined as unknown as string[]);

    const ui = {
      setEditorComponent: mock.fn(),
    };

    installWorkflowEditor(
      mockPi as unknown as ExtensionAPI,
      ui as unknown as ExtensionUIContext,
      undefined,
      testSettingsOptions(),
    );

    const inputHandlers = mockPi.handlers.input;
    assert.doesNotThrow(() => {
      inputHandlers[0]({
        source: "interactive",
        text: "test workflow",
      });
    });
  });

  it("should handle setActiveTools throwing gracefully (best-effort)", async () => {
    const { installWorkflowEditor } = await import("../../src/workflows/workflow-editor.js");

    const mockPi = createMockPi(DEFAULT_PI_TOOLS);
    mockPi.setActiveTools = mock.fn(() => {
      throw new Error("host rejected tool restriction");
    });

    const ui = {
      setEditorComponent: mock.fn(),
    };

    installWorkflowEditor(
      mockPi as unknown as ExtensionAPI,
      ui as unknown as ExtensionUIContext,
      undefined,
      testSettingsOptions(),
    );

    const inputHandlers = mockPi.handlers.input;
    // Should not throw — the catch block handles it
    const result = inputHandlers[0]({
      source: "interactive",
      text: "test workflow",
    });

    // Should still return the transform action even if setActiveTools failed
    assert.equal(result.action, "transform");
  });

  it("should handle multiple trigger events and restore correctly", async () => {
    const { installWorkflowEditor } = await import("../../src/workflows/workflow-editor.js");

    const originalTools = ["bash", "read", "edit", "write"];
    const mockPi = createMockPi(originalTools);

    const ui = {
      setEditorComponent: mock.fn(),
    };

    installWorkflowEditor(
      mockPi as unknown as ExtensionAPI,
      ui as unknown as ExtensionUIContext,
      undefined,
      testSettingsOptions(),
    );

    // First trigger
    const inputHandlers = mockPi.handlers.input;
    inputHandlers[0]({
      source: "interactive",
      text: "test workflow 1",
    });

    // Second trigger (before turn_end)
    inputHandlers[0]({
      source: "interactive",
      text: "test workflow 2",
    });

    // setActiveTools should only have been called once (savedTools is already set)
    assert.equal(mockPi.setActiveTools.mock.callCount(), 1);

    // turn_end restores
    const turnEndHandlers = mockPi.handlers.turn_end;
    turnEndHandlers[0]();

    // Subsequent turn_end should NOT restore again (savedTools is now undefined)
    mockPi.setActiveTools.mock.resetCalls();
    turnEndHandlers[0]();
    assert.equal(mockPi.setActiveTools.mock.callCount(), 0, "second turn_end should not call setActiveTools");
  });

});
