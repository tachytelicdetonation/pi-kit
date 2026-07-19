import assert from "node:assert/strict";
import test from "node:test";
import { HelmApp } from "../../src/app.js";
import { MockDataSource, seedState } from "../../src/data/mock.js";
import type { HelmState } from "../../src/state/types.js";
import { fakeTui, stripLines, theme256 } from "../conformance-v2/helpers.js";

test("M3: mission control suppresses tool output and subagent-tree detail", () => {
  const state = seedState() as HelmState & {
    toolOutputs: Array<{ tool: string; output: string }>;
    subagentTree: Array<{ id: string; label: string; children: Array<{ label: string }> }>;
  };
  state.toolOutputs = [{ tool: "bash", output: "TOOL-LEVEL-SECRET-ROW" }];
  state.subagentTree = [{
    id: "agent-root",
    label: "SUBAGENT-TREE-ROOT",
    children: [{ label: "SUBAGENT-TREE-CHILD" }],
  }];
  Object.assign(state.workflows[0]!, {
    toolRows: [{ output: "NESTED-TOOL-OUTPUT" }],
    subagents: [{ name: "NESTED-SUBAGENT-NODE" }],
  });

  class DetailRichSource extends MockDataSource {
    override snapshot(): HelmState {
      return state;
    }
  }

  const app = new HelmApp(fakeTui(40, 140), theme256, () => {}, new DetailRichSource());
  const home = stripLines(app.render(140)).join("\n");

  assert.match(home, /needs you/i, "the needs-you stratum remains visible");
  assert.match(home, /goal migrate repo to ESM/i, "top-level goals remain visible");
  assert.match(home, /codemod/i, "top-level workflow lanes remain visible");
  assert.match(home, /loops/i, "scheduled loops remain visible");
  assert.doesNotMatch(
    home,
    /TOOL-LEVEL-SECRET-ROW|SUBAGENT-TREE-ROOT|SUBAGENT-TREE-CHILD|NESTED-TOOL-OUTPUT|NESTED-SUBAGENT-NODE/,
    "home never leaks tool-grain or subagent-tree payloads",
  );
  app.dispose();
});
